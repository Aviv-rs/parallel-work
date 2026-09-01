import { randomUUID } from 'node:crypto';

import type { RepoConfig } from './config';
import { readSettings, type AgentCli } from './settings';
import { tryRun } from './shell';
import { readState, upsertWorktree } from './state';
import {
  capturePane,
  hasSession,
  killWindow,
  listWindows,
  resolveTarget,
  sendPrompt,
  startWindow,
  tmuxSessionName,
} from './tmux';

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
 * The QA reviewer reads: the plan, the diff, the findings file and the images
 * beside it. It gets no file writing tools at all, because a reviewer that can
 * edit the code it is judging will fix what it finds instead of reporting it,
 * and the worker owns those files.
 */
export function qaAgentCommand(model: string | null) {
  const mcpServers = (process.env.PW_MCP ?? DEFAULT_MCP_SERVERS.join(' ')).trim();
  return [
    'claude',
    model ? `--model ${model}` : '',
    `--permission-mode ${process.env.PW_MODE ?? 'auto'}`,
    `--allowedTools ${mcpServers} Bash Read Glob Grep Task Skill TodoWrite WebFetch WebSearch`,
  ]
    .filter(Boolean)
    .join(' ');
}

/** Its own window, so the worker's session is not interrupted mid-task. */
export function qaWindowName(worktreeName: string) {
  return `${worktreeName}-qa`;
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
  const session = tmuxSessionName(config.name);
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
  { qa = false } = {},
) {
  const record = readState(config.name).worktrees[worktreeName];
  if (!record) throw new Error(`no worktree '${worktreeName}'`);

  const session = tmuxSessionName(config.name);
  const window = qa ? qaWindowName(worktreeName) : worktreeName;
  const command =
    qa && readSettings().agentCli === 'claude'
      ? qaAgentCommand(model)
      : agentCommand(model);
  startWindow(session, window, record.path, command);
  if (qa) return { session, attachWith: `tmux attach -t ${session}` };
  upsertWorktree(config.name, {
    name: worktreeName,
    agentSessionId: record.agentSessionId ?? randomUUID(),
  });

  return { session, attachWith: `tmux attach -t ${session}` };
}

export async function sendToAgent(
  config: RepoConfig,
  worktreeName: string,
  prompt: string,
) {
  const record = readState(config.name).worktrees[worktreeName];
  if (!record) throw new Error(`no worktree '${worktreeName}'`);

  const sent = sendPrompt(
    tmuxSessionName(config.name),
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
    tmuxSessionName(config.name),
    worktreeName,
    lines,
    record?.path,
  );
}

export function killAgent(config: RepoConfig, worktreeName: string) {
  const record = readState(config.name).worktrees[worktreeName];
  return killWindow(tmuxSessionName(config.name), worktreeName, record?.path);
}

export function runningAgents(config: RepoConfig) {
  const session = tmuxSessionName(config.name);
  return hasSession(session) ? listWindows(session) : [];
}
