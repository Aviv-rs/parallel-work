import { randomUUID } from 'node:crypto';

import type { RepoConfig } from './config';
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
 * dontAsk denies every tool that is not on --allowedTools, the file writing
 * ones included, so a session sent to implement a ticket is declined on its
 * first Write and stops. A tmux session has nobody at its keyboard, so a
 * prompt would park forever, which is why the answer is grants rather than a
 * softer mode.
 */
function claudeCommand(model: string | null) {
  const mcpServers = (process.env.PW_MCP ?? DEFAULT_MCP_SERVERS.join(' ')).trim();
  const editTools =
    process.env.PW_EDIT_TOOLS ?? 'Write Edit MultiEdit NotebookEdit';
  const permissionMode = process.env.PW_MODE ?? 'dontAsk';

  return [
    'claude',
    model ? `--model ${model}` : '',
    `--permission-mode ${permissionMode}`,
    `--allowedTools ${mcpServers} ${editTools} Task Skill TodoWrite WebFetch WebSearch`,
  ]
    .filter(Boolean)
    .join(' ');
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

export function agentStatus(config: RepoConfig, name: string): AgentStatus {
  const session = tmuxSessionName(config.name);
  if (!hasSession(session) || !resolveTarget(session, name)) {
    return { name, running: false, busy: false, lastLine: '' };
  }

  const screen = capturePane(session, name, 40) ?? '';
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

  const session = tmuxSessionName(config.name);
  startWindow(session, worktreeName, record.path, claudeCommand(model));
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
  return capturePane(tmuxSessionName(config.name), worktreeName, lines);
}

export function killAgent(config: RepoConfig, worktreeName: string) {
  return killWindow(tmuxSessionName(config.name), worktreeName);
}

export function runningAgents(config: RepoConfig) {
  const session = tmuxSessionName(config.name);
  return hasSession(session) ? listWindows(session) : [];
}
