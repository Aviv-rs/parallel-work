import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { parkPrompt } from './prompt-park';
import { run, tryRun } from './shell';
import { STATE_DIR } from './state';

/**
 * herdr addresses workspaces/tabs/panes by opaque ids handed back from
 * `create`, not by the name pw gave them, so pw is the registry: the id a
 * `create` call returns is cached here, keyed by the same session/name pair
 * tmux.ts addresses by convention alone. Every read re-checks the cached id
 * with `pane get`/`workspace get` rather than trusting the file, so a pane
 * closed by hand or a stale cache from a killed server both self-heal to
 * "not running" instead of pw acting on a dead id.
 */
interface Cache {
  workspaceId?: string;
  panes: Record<string, string>;
}

function cachePath(session: string) {
  return join(STATE_DIR, 'herdr', `${session}.json`);
}

function readCache(session: string): Cache {
  const path = cachePath(session);
  if (!existsSync(path)) return { panes: {} };
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Cache;
  } catch {
    return { panes: {} };
  }
}

function writeCache(session: string, cache: Cache) {
  mkdirSync(join(STATE_DIR, 'herdr'), { recursive: true });
  writeFileSync(cachePath(session), `${JSON.stringify(cache, null, 2)}\n`);
}

export function herdrSessionName(repoName: string) {
  return `pw-${repoName}`;
}

function workspaceAlive(id: string) {
  return tryRun('herdr', ['workspace', 'get', id]).ok;
}

function paneAlive(id: string) {
  return tryRun('herdr', ['pane', 'get', id]).ok;
}

/** herdr's CLI answers every call with one JSON line on stdout. */
function parseJson(output: string): any {
  try {
    return JSON.parse(output);
  } catch {
    return null;
  }
}

function ensureWorkspace(session: string, cwd: string) {
  const cache = readCache(session);
  if (cache.workspaceId && workspaceAlive(cache.workspaceId)) {
    return cache.workspaceId;
  }

  const id = parseJson(
    run('herdr', [
      'workspace',
      'create',
      '--cwd',
      cwd,
      '--label',
      session,
      '--no-focus',
    ]),
  )?.result?.workspace?.workspace_id as string | undefined;
  if (!id) throw new Error(`herdr did not return a workspace id for ${session}`);
  writeCache(session, { workspaceId: id, panes: {} });
  return id;
}

function findWorkspaceId(session: string) {
  const cache = readCache(session);
  return cache.workspaceId && workspaceAlive(cache.workspaceId)
    ? cache.workspaceId
    : null;
}

export function hasSession(session: string) {
  return findWorkspaceId(session) !== null;
}

export function listWindows(session: string) {
  const cache = readCache(session);
  return Object.entries(cache.panes)
    .filter(([, paneId]) => paneAlive(paneId))
    .map(([name]) => name);
}

export function resolveTarget(session: string, name: string, worktreePath?: string) {
  void worktreePath;
  const cache = readCache(session);
  const paneId = cache.panes[name];
  return paneId && paneAlive(paneId) ? paneId : null;
}

export function startWindow(
  session: string,
  name: string,
  cwd: string,
  command: string,
) {
  const cache = readCache(session);
  if (cache.panes[name] && paneAlive(cache.panes[name]!)) {
    throw new Error(`window '${name}' is already running in ${session}`);
  }

  const workspaceId = ensureWorkspace(session, cwd);
  const tabResult = parseJson(
    run('herdr', [
      'tab',
      'create',
      '--workspace',
      workspaceId,
      '--cwd',
      cwd,
      '--label',
      name,
      '--no-focus',
    ]),
  )?.result;
  const tabId = tabResult?.tab?.tab_id as string | undefined;
  if (!tabId) throw new Error(`herdr did not return a tab id for ${name}`);

  const paneId = tabResult?.root_pane?.pane_id as string | undefined;
  if (!paneId) throw new Error(`herdr created tab '${name}' with no pane`);

  tryRun('herdr', ['pane', 'rename', paneId, name]);
  run('herdr', ['pane', 'run', paneId, command]);

  const nextCache = readCache(session);
  nextCache.workspaceId = workspaceId;
  nextCache.panes[name] = paneId;
  writeCache(session, nextCache);
}

export function killWindow(session: string, name: string, worktreePath?: string) {
  const target = resolveTarget(session, name, worktreePath);
  if (!target) return false;
  const ok = tryRun('herdr', ['pane', 'close', target]).ok;
  if (ok) {
    const cache = readCache(session);
    delete cache.panes[name];
    writeCache(session, cache);
  }
  return ok;
}

export function capturePane(
  session: string,
  name: string,
  lines: number,
  worktreePath?: string,
) {
  const target = resolveTarget(session, name, worktreePath);
  if (!target) return null;
  return tryRun('herdr', [
    'pane',
    'read',
    target,
    '--source',
    'recent',
    '--lines',
    String(lines),
  ]).stdout;
}

/**
 * `pane send-text` writes the argument straight to the pty as one argv
 * element (no shell, no line-by-line re-typing), so unlike tmux's
 * `send-keys -l` a multi-line prompt does not risk submitting itself
 * halfway through. The `.pw-prompts/` park file is kept as a fallback path
 * (parkPrompt is exported for callers that want it) but is not needed here.
 */
export function sendPrompt(
  session: string,
  name: string,
  prompt: string,
  worktreePath: string,
) {
  const target = resolveTarget(session, name, worktreePath);
  if (!target) return null;

  run('herdr', ['pane', 'send-keys', target, 'escape']);
  run('herdr', ['pane', 'send-keys', target, 'ctrl+u']);
  run('herdr', ['pane', 'send-text', target, prompt]);
  return {
    target,
    submit: () => run('herdr', ['pane', 'send-keys', target, 'enter']),
  };
}

export { parkPrompt };

const PROMPT_READY = ['? for shortcuts', 'Bypassing Permissions'];
const PROMPT_BLOCKED = [
  /do you trust/i,
  /safety check/i,
  /is this a project you/i,
  /yes, proceed/i,
];

export type PromptState = 'ready' | 'blocked' | 'timeout';

export async function waitForPrompt(
  session: string,
  name: string,
  worktreePath: string,
  timeoutMs = 30_000,
): Promise<PromptState> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const screen = capturePane(session, name, 40, worktreePath) ?? '';
    if (PROMPT_BLOCKED.some((marker) => marker.test(screen))) return 'blocked';
    if (PROMPT_READY.some((marker) => screen.includes(marker))) return 'ready';
    await Bun.sleep(500);
  }
  return 'timeout';
}

export interface TileTarget {
  name: string;
  cwd: string;
}

const TILE_TAB = 'tiles';

/**
 * A pane per worktree, in one tab, each an ordinary shell already in the
 * right directory. `pane split` builds the row/column itself, alternating
 * right/down so it stays roughly grid-shaped instead of one long strip.
 */
export function tileShells(
  session: string,
  targets: TileTarget[],
  shell = process.env.SHELL || '/bin/sh',
) {
  const workspaceId = ensureWorkspace(session, targets[0]!.cwd);

  const cache = readCache(session);
  for (const [key, paneId] of Object.entries(cache.panes)) {
    if (key.startsWith(`${TILE_TAB}:`) && paneAlive(paneId)) {
      tryRun('herdr', ['pane', 'close', paneId]);
    }
  }

  const tabResult = parseJson(
    run('herdr', [
      'tab', 'create',
      '--workspace', workspaceId,
      '--cwd', targets[0]!.cwd,
      '--label', TILE_TAB,
      '--no-focus',
    ]),
  )?.result;
  const tabId = tabResult?.tab?.tab_id as string | undefined;
  if (!tabId) throw new Error(`herdr did not return a tab id for '${TILE_TAB}'`);

  const firstPane = tabResult?.root_pane?.pane_id as string | undefined;
  if (!firstPane) throw new Error(`herdr created tab '${TILE_TAB}' with no pane`);

  tryRun('herdr', ['pane', 'rename', firstPane, targets[0]!.name]);
  run('herdr', ['pane', 'run', firstPane, shell]);

  const paneIds = [firstPane];
  targets.slice(1).forEach((target, index) => {
    const direction = index % 2 === 0 ? 'right' : 'down';
    const newPaneId = parseJson(
      run('herdr', [
        'pane', 'split', paneIds.at(-1)!,
        '--direction', direction,
        '--cwd', target.cwd,
      ]),
    )?.result?.pane?.pane_id as string | undefined;
    if (!newPaneId) {
      throw new Error(`herdr did not return a pane id splitting for '${target.name}'`);
    }
    tryRun('herdr', ['pane', 'rename', newPaneId, target.name]);
    run('herdr', ['pane', 'run', newPaneId, shell]);
    paneIds.push(newPaneId);
  });

  const nextCache = readCache(session);
  nextCache.workspaceId = workspaceId;
  targets.forEach((target, index) => {
    nextCache.panes[`${TILE_TAB}:${target.name}`] = paneIds[index]!;
  });
  writeCache(session, nextCache);

  return { session, window: TILE_TAB };
}

/**
 * tmux hides every agent behind its own window, so gridWindows earns its
 * keep by merging them into one screen of panes. herdr already shows every
 * tab/pane as its own clickable, always-visible target, so there is nothing
 * to merge: an agent's tab is already one click away. Both are no-ops here.
 */
export function gridWindows(session: string, names: string[]) {
  void session;
  void names;
}

export function ungridWindows(session: string) {
  void session;
}
