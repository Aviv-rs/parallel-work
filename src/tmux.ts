import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

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
 * fire as several half-prompts. Anything multi-line goes to a file inside the
 * worktree (reading outside it re-triggers a permission dialog) and the pane
 * gets one line pointing at it.
 */
export function sendPrompt(
  session: string,
  name: string,
  prompt: string,
  worktreePath: string,
) {
  const target = resolveTarget(session, name, worktreePath);
  if (!target) return null;

  let text = prompt;
  if (prompt.includes('\n')) {
    const promptDirectory = join(worktreePath, '.pw-prompts');
    mkdirSync(promptDirectory, { recursive: true });
    const promptFile = join(promptDirectory, `${name}-${Bun.nanoseconds()}.md`);
    writeFileSync(promptFile, `${prompt}\n`);
    text = `Read ${promptFile} in full and do what it says.`;
  }

  run('tmux', ['send-keys', '-t', target, '-l', text]);
  return { target, submit: () => run('tmux', ['send-keys', '-t', target, 'Enter']) };
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
