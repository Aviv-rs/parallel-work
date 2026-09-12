import { resolve } from 'node:path';

import { parkPrompt } from './prompt-park';
import { run, tryRun } from './shell';

export function tmuxSessionName(repoName: string) {
  return `pw-${repoName}`;
}

export function hasSession(session: string) {
  return tryRun('tmux', ['has-session', '-t', session]).ok;
}

export function listWindows(session: string) {
  const result = tryRun('tmux', ['list-windows', '-t', session, '-F', '#W']);
  return result.ok ? result.stdout.split('\n').filter(Boolean) : [];
}

const GRID_WINDOW = 'grid';
const GRID_MAP_OPTION = '@pw_grid_map';

function gridMap(session: string) {
  const raw = tryRun('tmux', [
    'show-option',
    '-qv',
    '-t',
    session,
    GRID_MAP_OPTION,
  ]).stdout;
  return Object.fromEntries(
    raw
      .split(' ')
      .filter(Boolean)
      .map((pair) => pair.split('=') as [string, string]),
  );
}

/**
 * The Claude TUI overwrites #{pane_title} with its own activity line seconds
 * after a task starts, so a title lookup works right after tgrid and then
 * silently stops resolving. Pane ids survive the TUI, layout changes and
 * rotation, so the grid map is keyed on those.
 */
export function resolveTarget(
  session: string,
  name: string,
  worktreePath?: string,
) {
  if (listWindows(session).includes(name)) return `${session}:${name}`;

  const paneId = gridMap(session)[name];
  const livePanes = tryRun('tmux', [
    'list-panes',
    '-s',
    '-t',
    session,
    '-F',
    '#{pane_id}',
  ]).stdout.split('\n');
  if (paneId && livePanes.includes(paneId)) return paneId;

  return worktreePath ? paneInDirectory(session, worktreePath) : null;
}

/**
 * The window name is a convention, not a guarantee: a session started by hand
 * or by another driver sits in the same tmux session under whatever name its
 * author chose. The directory a pane is running in is the durable identity, so
 * a worktree's agent is findable however its window was named.
 */
function paneInDirectory(session: string, worktreePath: string) {
  const panes = tryRun('tmux', [
    'list-panes',
    '-s',
    '-t',
    session,
    '-F',
    '#{pane_id}\t#{pane_current_path}',
  ]).stdout.split('\n');

  const wanted = resolve(worktreePath);
  const hit = panes.find((pane) => {
    const [, paneDirectory] = pane.split('\t');
    return paneDirectory ? resolve(paneDirectory) === wanted : false;
  });
  return hit?.split('\t')[0] ?? null;
}

export function startWindow(
  session: string,
  name: string,
  cwd: string,
  command: string,
) {
  if (!hasSession(session)) {
    run('tmux', [
      'new-session',
      '-d',
      '-s',
      session,
      '-n',
      name,
      '-c',
      cwd,
      '-x',
      '200',
      '-y',
      '50',
      command,
    ]);
    return;
  }
  if (listWindows(session).includes(name)) {
    throw new Error(`window '${name}' is already running in ${session}`);
  }
  run('tmux', ['new-window', '-t', session, '-n', name, '-c', cwd, command]);
}

export function killWindow(
  session: string,
  name: string,
  worktreePath?: string,
) {
  const target = resolveTarget(session, name, worktreePath);
  return target ? tryRun('tmux', ['kill-window', '-t', target]).ok : false;
}

export function capturePane(
  session: string,
  name: string,
  lines: number,
  worktreePath?: string,
) {
  const target = resolveTarget(session, name, worktreePath);
  if (!target) return null;
  return tryRun('tmux', ['capture-pane', '-t', target, '-p', '-S', `-${lines}`])
    .stdout;
}

/**
 * A newline inside send-keys submits the prompt, so a multi-line message would
 * fire as several half-prompts. Anything multi-line is parked in a file and the
 * pane gets one line pointing at it.
 */
export function sendPrompt(
  session: string,
  name: string,
  prompt: string,
  worktreePath: string,
) {
  const target = resolveTarget(session, name, worktreePath);
  if (!target) return null;

  const text = prompt.includes('\n')
    ? `Read ${parkPrompt(worktreePath, name, prompt)} in full and do what it says.`
    : prompt;

  clearInputLine(target);
  run('tmux', ['send-keys', '-t', target, '-l', text]);
  return { target, submit: () => run('tmux', ['send-keys', '-t', target, 'Enter']) };
}

/**
 * Whatever is sitting in the input box is discarded before anything is typed.
 *
 * The CLI autocompletes the box with a suggested next message, and a pane
 * capture cannot tell that ghost text apart from something the human typed.
 * Appending to it once turned a suggestion reading "commit all of it" into a
 * real instruction, and the agent committed a working tree the human was still
 * reviewing. Escape drops the suggestion, Ctrl-U clears any real text, and the
 * prompt that follows is the only thing the agent sees.
 *
 * Losing a half typed human line is the cheaper mistake. It is visible, and the
 * human can retype it. A phantom instruction is invisible and already executed.
 */
function clearInputLine(target: string) {
  run('tmux', ['send-keys', '-t', target, 'Escape']);
  run('tmux', ['send-keys', '-t', target, 'C-u']);
}

/** The TUI is listening: its input box and its shortcut hint are both up. */
const PROMPT_READY = ['? for shortcuts', 'Bypassing Permissions'];

/**
 * A dialog, not a prompt. Typing here would answer a question pw did not ask,
 * and the Enter that follows would pick whatever option is highlighted, which
 * is how a freshly launched session gets dismissed before it starts.
 */
const PROMPT_BLOCKED = [
  /do you trust/i,
  /safety check/i,
  /is this a project you/i,
  /yes, proceed/i,
];

export type PromptState = 'ready' | 'blocked' | 'timeout';

/**
 * Waits for a freshly launched agent to be listening. A fixed sleep is not
 * enough: a TUI that is slow, or parked on a trust dialog, silently eats both
 * the message and the Enter.
 */
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

const TILE_WINDOW = 'tiles';

export interface TileTarget {
  name: string;
  cwd: string;
}

/**
 * A pane per worktree, each an ordinary shell already in the right directory.
 * This is the terminal-only way to work several tickets at once: no editor, no
 * agent, just the folders side by side.
 */
export function tileShells(
  session: string,
  targets: TileTarget[],
  shell = process.env.SHELL || '/bin/sh',
) {
  if (!hasSession(session)) {
    run('tmux', [
      'new-session', '-d', '-s', session, '-n', TILE_WINDOW,
      '-c', targets[0]!.cwd, '-x', '200', '-y', '50', shell,
    ]);
  } else if (listWindows(session).includes(TILE_WINDOW)) {
    run('tmux', ['kill-window', '-t', `${session}:${TILE_WINDOW}`]);
    run('tmux', [
      'new-window', '-t', session, '-n', TILE_WINDOW, '-c', targets[0]!.cwd, shell,
    ]);
  } else {
    run('tmux', [
      'new-window', '-t', session, '-n', TILE_WINDOW, '-c', targets[0]!.cwd, shell,
    ]);
  }

  const firstPane = run('tmux', [
    'display-message', '-p', '-t', `${session}:${TILE_WINDOW}`, '#{pane_id}',
  ]);
  run('tmux', ['select-pane', '-t', firstPane, '-T', targets[0]!.name]);

  for (const target of targets.slice(1)) {
    // Re-tile after every split, or tmux runs out of room around the fourth
    // pane and refuses with "no space for new pane".
    run('tmux', ['select-layout', '-t', `${session}:${TILE_WINDOW}`, 'tiled']);
    const paneId = run('tmux', [
      'split-window', '-t', `${session}:${TILE_WINDOW}`,
      '-c', target.cwd, '-P', '-F', '#{pane_id}', shell,
    ]);
    run('tmux', ['select-pane', '-t', paneId, '-T', target.name]);
  }

  run('tmux', ['select-layout', '-t', `${session}:${TILE_WINDOW}`, 'tiled']);
  tryRun('tmux', ['set-option', '-t', session, '-w', 'pane-border-status', 'top']);
  return { session, window: TILE_WINDOW };
}

export function gridWindows(session: string, names: string[]) {
  let gridTarget = '';
  const map: string[] = [];

  for (const name of names) {
    let paneId: string;
    if (!gridTarget) {
      run('tmux', ['rename-window', '-t', `${session}:${name}`, GRID_WINDOW]);
      gridTarget = GRID_WINDOW;
      paneId = run('tmux', [
        'display-message',
        '-p',
        '-t',
        `${session}:${GRID_WINDOW}.0`,
        '#{pane_id}',
      ]);
    } else {
      // tmux 3.x join-pane has no -P/-F, the joined pane lands as the active one.
      run('tmux', [
        'join-pane',
        '-s',
        `${session}:${name}`,
        '-t',
        `${session}:${GRID_WINDOW}`,
      ]);
      paneId = run('tmux', [
        'display-message',
        '-p',
        '-t',
        `${session}:${GRID_WINDOW}`,
        '#{pane_id}',
      ]);
    }
    run('tmux', ['select-pane', '-t', paneId, '-T', name]);
    map.push(`${name}=${paneId}`);
  }

  run('tmux', ['set-option', '-t', session, GRID_MAP_OPTION, map.join(' ')]);

  // A wide, short terminal stacks badly under `tiled`: each pane loses half its
  // rows while keeping full width.
  const windowWidth = Number(
    run('tmux', [
      'display-message',
      '-p',
      '-t',
      `${session}:${GRID_WINDOW}`,
      '#{window_width}',
    ]),
  );
  const layout = windowWidth >= names.length * 100 ? 'even-horizontal' : 'tiled';
  run('tmux', ['select-layout', '-t', `${session}:${GRID_WINDOW}`, layout]);
  tryRun('tmux', ['set-option', '-t', session, '-w', 'pane-border-status', 'top']);
}

export function ungridWindows(session: string) {
  const nameByPane = Object.fromEntries(
    Object.entries(gridMap(session)).map(([name, pane]) => [pane, name]),
  );

  for (;;) {
    const panes = tryRun('tmux', [
      'list-panes',
      '-t',
      `${session}:${GRID_WINDOW}`,
      '-F',
      '#{pane_id}',
    ]).stdout.split('\n').filter(Boolean);
    if (panes.length <= 1) break;

    const paneId = panes[panes.length - 1]!;
    const name = nameByPane[paneId];
    run('tmux', ['break-pane', '-d', '-s', paneId, ...(name ? ['-n', name] : [])]);
  }

  const firstPane = run('tmux', [
    'display-message',
    '-p',
    '-t',
    `${session}:${GRID_WINDOW}.0`,
    '#{pane_id}',
  ]);
  const firstName = nameByPane[firstPane];
  if (firstName) {
    run('tmux', ['rename-window', '-t', `${session}:${GRID_WINDOW}`, firstName]);
  }
  tryRun('tmux', ['set-option', '-u', '-t', session, GRID_MAP_OPTION]);
}
