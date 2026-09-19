import * as herdr from './herdr';
import { parkPrompt } from './prompt-park';
import { readSettings, type Backend } from './settings';
import { tryRun } from './shell';
import * as tmux from './tmux';

const BACKEND_BINARIES: Record<Backend, string> = {
  tmux: 'tmux',
  herdr: 'herdr',
};

export function isBackendInstalled(backend: Backend) {
  return tryRun('which', [BACKEND_BINARIES[backend]]).ok;
}

export type { PromptState } from './tmux';
export type { TileTarget } from './tmux';
export { parkPrompt };

/**
 * Every other file calls these, never tmux.ts/herdr.ts directly, so switching
 * `settings.backend` changes what a running `pw` talks to without anything
 * upstream knowing which multiplexer is behind it.
 */
function impl() {
  return readSettings().backend === 'herdr' ? herdr : tmux;
}

export function sessionName(repoName: string) {
  return readSettings().backend === 'herdr'
    ? herdr.herdrSessionName(repoName)
    : tmux.tmuxSessionName(repoName);
}

export function attachHint(session: string) {
  return readSettings().backend === 'herdr'
    ? `herdr session attach ${session}`
    : `tmux attach -t ${session}`;
}

export function hasSession(session: string) {
  return impl().hasSession(session);
}

export function listWindows(session: string) {
  return impl().listWindows(session);
}

export function resolveTarget(session: string, name: string, worktreePath?: string) {
  return impl().resolveTarget(session, name, worktreePath);
}

export function startWindow(
  session: string,
  name: string,
  cwd: string,
  command: string,
) {
  return impl().startWindow(session, name, cwd, command);
}

export function killWindow(session: string, name: string, worktreePath?: string) {
  return impl().killWindow(session, name, worktreePath);
}

export function capturePane(
  session: string,
  name: string,
  lines: number,
  worktreePath?: string,
) {
  return impl().capturePane(session, name, lines, worktreePath);
}

export function sendPrompt(
  session: string,
  name: string,
  prompt: string,
  worktreePath: string,
  isWorking = false,
) {
  return impl().sendPrompt(session, name, prompt, worktreePath, isWorking);
}

export function waitForPrompt(
  session: string,
  name: string,
  worktreePath: string,
  timeoutMs?: number,
) {
  return impl().waitForPrompt(session, name, worktreePath, timeoutMs);
}

export function tileShells(
  session: string,
  targets: tmux.TileTarget[],
  shell?: string,
) {
  return impl().tileShells(session, targets, shell);
}

export function gridWindows(session: string, names: string[]) {
  return impl().gridWindows(session, names);
}

export function ungridWindows(session: string) {
  return impl().ungridWindows(session);
}

export function describeGrouping(count: number) {
  return readSettings().backend === 'herdr'
    ? `herdr already shows ${count} agents as separate clickable tabs, nothing to group`
    : `tiled ${count} agents into one window`;
}

export function describeUngrouping() {
  return readSettings().backend === 'herdr'
    ? 'herdr agents were already in their own tabs'
    : 'agents split back into their own windows';
}
