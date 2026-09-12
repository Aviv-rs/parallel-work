import { randomUUID } from 'node:crypto';

import type { RepoConfig } from './config';
import { readSettings, type AgentCli } from './settings';
import { tryRun } from './shell';
import { readState, upsertWorktree } from './state';
import {
  attachHint,
  capturePane,
  hasSession,
  killWindow,
  listWindows,
  resolveTarget,
  parkPrompt,
  sendPrompt,
  sessionName,
  startWindow,
  waitForPrompt,
} from './backend';

const DEFAULT_MCP_SERVERS = [
  'mcp__plugin_atlassian_atlassian',
  'mcp__plugin_figma_figma',
];

/**
 * A tmux session has nobody at its keyboard, so any prompt parks forever. auto
 * keeps a session moving on its own; the file writing tools stay on
 * --allowedTools so a stricter mode set through PW_MODE still gets them.
 * Destructive commands are held back by the deny list in settings, which is
 * checked before any allow and survives every mode.
 */
function claudeCommand(model: string | null) {
  const mcpServers = (process.env.PW_MCP ?? DEFAULT_MCP_SERVERS.join(' ')).trim();
  const editTools =
    process.env.PW_EDIT_TOOLS ?? 'Write Edit MultiEdit NotebookEdit';
  const permissionMode = process.env.PW_MODE ?? 'auto';

  return [
    'claude',
    model ? `--model ${model}` : '',
    `--permission-mode ${permissionMode}`,
    `--allowedTools ${mcpServers} ${editTools} Task Skill TodoWrite WebFetch WebSearch`,
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * The reviewer reads and reports: the plan, the diff, the findings file and the
 * images beside it. It launches with `PW_EDIT_TOOLS=` empty, so it cannot edit
 * the worktree it is judging. A reviewer that can edit fixes what it finds
 * instead of reporting it, and those files belong to the worker.
 *
 * Bash is on, because half of reviewing a branch is reading its diff.
 */
export function qaAgentCommand(model: string | null) {
  const mcpServers = (process.env.PW_MCP ?? DEFAULT_MCP_SERVERS.join(' ')).trim();
  const editTools = (process.env.PW_EDIT_TOOLS ?? '').trim();
  return [
    'claude',
    model ? `--model ${model}` : '',
    `--permission-mode ${process.env.PW_MODE ?? 'auto'}`,
    `--allowedTools ${mcpServers} Bash Read Glob Grep ${editTools} Task Skill TodoWrite WebFetch WebSearch`.replace(
      /\s+/g,
      ' ',
    ),
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * Its own window in the worker's own session, so `Ctrl-b w` reaches both and
 * the worker is never interrupted mid-task by its own review.
 */
export function qaWindowName(worktreeName: string) {
  return `${worktreeName}-qa`;
}

/**
 * Starts the reviewer and hands it its brief. The brief is multi-line, so
 * sendPrompt parks it in `.pw-prompts/` and types one line pointing at it.
 *
 * Nothing is typed until the TUI is actually listening. A session launched in a
 * directory the agent has not seen before opens a trust dialog first, and
 * typing into that answers a question pw did not ask: the Enter that follows
 * picks whatever is highlighted, which kills the session it just started.
 */
export async function startQaAgent(
  config: RepoConfig,
  worktreeName: string,
  model: string | null,
  brief: string,
) {
  const record = readState(config.name).worktrees[worktreeName];
  if (!record) throw new Error(`no worktree '${worktreeName}'`);

  const session = sessionName(config.name);
  const window = qaWindowName(worktreeName);
  const settings = readSettings();
  const command =
    settings.agentCli === 'claude' ? qaAgentCommand(model) : agentCommand(model);

  startWindow(session, window, record.path, command);

  const state = await waitForPrompt(session, window, record.path);
  if (state !== 'ready') {
    // The brief is still written, so the human can hand it over by hand once
    // they have cleared whatever the window is sitting on.
    return {
      session,
      window,
      briefed: false,
      state,
      briefFile: parkPrompt(record.path, window, brief),
    };
  }

  const sent = sendPrompt(session, window, brief, record.path);
  if (sent) {
    await Bun.sleep(400);
    sent.submit();
  }
  return { session, window, briefed: Boolean(sent), state, briefFile: null };
}

/**
 * Every agent needs the same thing from pw: start in this directory and keep
 * working without a human to approve each step. Only claude's flags are ones
 * pw depends on; the others are best-effort defaults, which is why
 * `agentCommands` in settings can replace them outright when a CLI changes.
 */
export const AGENT_BINARIES: Record<AgentCli, string> = {
  claude: 'claude',
  codex: 'codex',
  cursor: 'cursor-agent',
};

export function agentCommand(model: string | null, settings = readSettings()) {
  const override = settings.agentCommands[settings.agentCli]?.trim();
  if (override) return model ? `${override} ${model}` : override;

  if (settings.agentCli === 'claude') return claudeCommand(model);
  if (settings.agentCli === 'codex') {
    return ['codex', '--full-auto', model ? `-m ${model}` : '']
      .filter(Boolean)
      .join(' ');
  }
  return ['cursor-agent', '--force', model ? `-m ${model}` : '']
    .filter(Boolean)
    .join(' ');
}

export function isAgentCliInstalled(cli: AgentCli) {
  return tryRun('which', [AGENT_BINARIES[cli]]).ok;
}

export interface AgentStatus {
  name: string;
  running: boolean;
  busy: boolean;
  lastLine: string;
}

/**
 * The Claude TUI prints an interrupt hint while it is working, which is the
 * only reliable "still thinking" signal available from outside the process.
 */
const BUSY_MARKERS = ['esc to interrupt', 'Running…', 'tokens'];

export function agentStatus(
  config: RepoConfig,
  name: string,
  worktreePath?: string,
): AgentStatus {
  const session = sessionName(config.name);
  if (!hasSession(session) || !resolveTarget(session, name, worktreePath)) {
    return { name, running: false, busy: false, lastLine: '' };
  }

  const screen = capturePane(session, name, 40, worktreePath) ?? '';
  const lines = screen.split('\n').filter((line) => line.trim());
  const lastLine = lines.at(-1)?.trim() ?? '';
  const busy = BUSY_MARKERS.some((marker) => screen.includes(marker));

  return { name, running: true, busy, lastLine };
}

export function startAgent(
  config: RepoConfig,
  worktreeName: string,
  model: string | null,
) {
  const record = readState(config.name).worktrees[worktreeName];
  if (!record) throw new Error(`no worktree '${worktreeName}'`);

  const session = sessionName(config.name);
  startWindow(session, worktreeName, record.path, agentCommand(model));
  upsertWorktree(config.name, {
    name: worktreeName,
    agentSessionId: record.agentSessionId ?? randomUUID(),
  });

  return { session, attachWith: attachHint(session) };
}

export async function sendToAgent(
  config: RepoConfig,
  worktreeName: string,
  prompt: string,
) {
  const record = readState(config.name).worktrees[worktreeName];
  if (!record) throw new Error(`no worktree '${worktreeName}'`);

  const sent = sendPrompt(
    sessionName(config.name),
    worktreeName,
    prompt,
    record.path,
  );
  if (!sent) throw new Error(`no running agent for '${worktreeName}'`);

  // The TUI needs a beat to register the text before a newline submits it.
  await Bun.sleep(400);
  sent.submit();
}

export function seeAgent(config: RepoConfig, worktreeName: string, lines: number) {
  const record = readState(config.name).worktrees[worktreeName];
  return capturePane(
    sessionName(config.name),
    worktreeName,
    lines,
    record?.path,
  );
}

export function killAgent(config: RepoConfig, worktreeName: string) {
  const record = readState(config.name).worktrees[worktreeName];
  return killWindow(sessionName(config.name), worktreeName, record?.path);
}

export function runningAgents(config: RepoConfig) {
  const session = sessionName(config.name);
  return hasSession(session) ? listWindows(session) : [];
}
