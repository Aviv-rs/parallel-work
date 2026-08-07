import type { TaskStatus } from './actions';
import type { PullRequest } from './pull-request';

export type Mood = 'alert' | 'waiting' | 'working' | 'asleep' | 'empty';

const RESET = '\x1b[0m';
const ANSI = new RegExp(String.raw`\x1b\[[0-9;]*m`, 'g');
const COLORS = {
  dim: '\x1b[2m',
  grey: '\x1b[90m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  red: '\x1b[31m',
  bold: '\x1b[1m',
} as const;

export function paint(text: string, ...styles: (keyof typeof COLORS)[]) {
  return `${styles.map((style) => COLORS[style]).join('')}${text}${RESET}`;
}

const MOOD_COLOR: Record<Mood, keyof typeof COLORS> = {
  alert: 'red',
  waiting: 'yellow',
  working: 'cyan',
  asleep: 'blue',
  empty: 'grey',
};

/**
 * Every frame is the same width and height, so the board never jumps between
 * ticks. The top row is the thought bubble: the mood has to read at a glance
 * from across the room, which is the whole point of the sprite.
 */
const SPRITES: Record<Mood, string[][]> = {
  alert: [
    ['  ▄█▄ !', ' ▟███▙ ', ' │✕ ✕│ ', ' └┴─┴┘ '],
    ['  ▄█▄ ‼', ' ▟███▙ ', ' │✕ ✕│ ', ' └┴─┴┘ '],
  ],
  waiting: [
    ['  ▄█▄  ', '╲▟███▙ ', ' │◉ ◉│ ', ' └┴─┴┘ '],
    ['╲ ▄█▄  ', ' ▟███▙ ', ' │◉ ◉│ ', ' └┴─┴┘ '],
  ],
  working: [
    ['  ▄█▄  ', ' ▟███▙ ', ' │● ●│ ', ' └┬─┬┘ '],
    ['  ▄█▄  ', ' ▟███▙ ', ' │◕ ◕│ ', ' └┴─┴┘ '],
    ['  ▄█▄  ', ' ▟███▙ ', ' │● ●│ ', ' └┴─┴┘ '],
    ['  ▄█▄  ', ' ▟███▙ ', ' │─ ─│ ', ' └┬─┬┘ '],
  ],
  asleep: [
    ['  ▄█▄ z', ' ▟███▙ ', ' │─ ─│ ', ' └┴─┴┘ '],
    ['  ▄█▄ z', ' ▟███▙ ', ' │─ ─│ ', ' └┴─┴┘ '],
    ['  ▄█▄ Z', ' ▟███▙ ', ' │─ ─│ ', ' └┴─┴┘ '],
  ],
  empty: [['  ▄█▄  ', ' ▟███▙ ', ' │· ·│ ', ' └┴─┴┘ ']],
};

/**
 * The caption names the condition rather than the sprite's feelings: the point
 * is to say what happened, so "dev stopped" beats anything the robot thinks.
 */
export function captionFor(tasks: TaskStatus[], mood: Mood): string {
  if (mood === 'empty') return 'nothing yet';
  if (mood === 'alert') return 'folder gone';

  if (mood === 'waiting') {
    const waiting = tasks.filter((task) => task.needsYou);
    return waiting.some(isInReview) ? 'needs review' : 'needs you';
  }

  // A task with an open PR is in review whatever its last checklist box says,
  // so the state wins over the arithmetic. "43/44 done" is technically true and
  // tells you nothing about what to do next.
  const inReview = tasks.filter(isInReview);
  if (inReview.length === tasks.length) return 'in review';
  if (inReview.length > 0) return `${inReview.length} in review`;

  const { done, total } = totalProgress(tasks);
  if (!total) return mood === 'working' ? 'working' : 'no plans';
  if (done === total) return 'all done';
  return `${done}/${total} done`;
}

function isInReview(task: TaskStatus) {
  return Boolean(task.pullRequest) || /review/i.test(task.spec?.status ?? '');
}

/**
 * Reserved for a worktree that is gone from under the registry. A stopped dev
 * server is on the row already and is not worth a red robot: the sprite is
 * about how the work is going, not about the plumbing.
 */
function needsAttention(task: TaskStatus) {
  return !task.exists;
}

/** Checklist boxes across every plan, which is what "how is it going" means. */
export function totalProgress(tasks: TaskStatus[]) {
  return tasks.reduce(
    (running, task) => ({
      done: running.done + (task.spec?.done ?? 0),
      total: running.total + (task.spec?.total ?? 0),
    }),
    { done: 0, total: 0 },
  );
}

export function moodFor(tasks: TaskStatus[]): Mood {
  if (!tasks.length) return 'empty';
  if (tasks.some(needsAttention)) return 'alert';
  if (tasks.some((task) => task.needsYou)) return 'waiting';
  if (tasks.some((task) => task.agent.busy)) return 'working';
  return 'asleep';
}

export function spriteFrame(mood: Mood, tick: number) {
  const frames = SPRITES[mood];
  const frame = frames[tick % frames.length] ?? frames[0]!;
  const color = MOOD_COLOR[mood];
  return frame.map((line) => paint(centre(line, SPRITE_COLUMN), color));
}

function agentLabel(task: TaskStatus) {
  if (!task.agent.running) return paint('no agent', 'grey');
  return task.agent.busy
    ? paint('working', 'cyan')
    : paint('waiting on you', 'yellow');
}

function specLabel(task: TaskStatus) {
  if (!task.spec) return paint('no spec', 'grey');
  const { done, total, status } = task.spec;
  const bar = progressBar(done, total);
  const counts = `${done}/${total}`;
  const tail = status ? paint(` ${status}`, 'dim') : '';
  return `${bar} ${counts}${tail}`;
}

function progressBar(done: number, total: number, width = 10) {
  if (!total) return paint('─'.repeat(width), 'grey');
  const complete = done === total;
  // Floor, so one box short of finished never paints as a full bar.
  const filled = complete ? width : Math.min(width - 1, Math.floor((done / total) * width));
  return (
    paint('█'.repeat(filled), complete ? 'green' : 'magenta') +
    paint('░'.repeat(width - filled), 'grey')
  );
}

export function pullRequestLabel(pullRequest: PullRequest) {
  const tag = pullRequest.isDraft ? 'draft' : 'PR';
  return `${paint(`${tag} #${pullRequest.number}`, 'magenta')} ${paint(pullRequest.url, 'dim')}`;
}

function devLabel(task: TaskStatus) {
  if (!task.devRunning) return paint('dev stopped', 'grey');
  return paint(task.devUrl ?? 'dev running', 'green');
}

/** Wide enough for the sprite and for the longest caption under it. */
const SPRITE_COLUMN = 12;

export function visibleLength(line: string) {
  return line.replace(ANSI, '').length;
}

/** Pads after any trailing reset, so the padding carries no colour of its own. */
function padVisible(line: string, width: number) {
  const missing = width - visibleLength(line);
  return missing > 0 ? `${line}${' '.repeat(missing)}` : line;
}

/**
 * The board is the sprite on the left and one row per worktree on the right,
 * so a glance answers "is anyone waiting on me" before any key is pressed.
 */
export function statusBoard(
  tasks: TaskStatus[],
  tick: number,
  width: number,
): string[] {
  const mood = moodFor(tasks);
  const color = MOOD_COLOR[mood];
  const spriteColumn = [
    ...spriteFrame(mood, tick),
    paint(centre(captionFor(tasks, mood), SPRITE_COLUMN), color, 'dim'),
  ];

  const rows = tasks.length
    ? tasks.flatMap((task) => [
        `${bullet(task)} ${paint(task.name, 'bold')}`,
        `  ${agentLabel(task)}  ${specLabel(task)}`,
        `  ${devLabel(task)}  ${paint(`${task.uncommitted} uncommitted, ${task.unmerged} unmerged`, 'dim')}`,
        ...(task.pullRequest ? [`  ${pullRequestLabel(task.pullRequest)}`] : []),
      ])
    : [paint('no worktrees yet, pick New worktree below', 'dim')];

  // The sprite is a margin note, so it sits against the right edge and the
  // status rows keep the natural reading position on the left.
  const bodyWidth = Math.max(20, width - SPRITE_COLUMN - 1);
  const height = Math.max(spriteColumn.length, rows.length);

  const lines: string[] = [];
  for (let row = 0; row < height; row++) {
    const body = padVisible(truncate(rows[row] ?? '', bodyWidth), bodyWidth);
    const sprite = spriteColumn[row];
    lines.push(sprite ? `${body}${sprite}` : body.trimEnd());
  }
  return lines;
}

function bullet(task: TaskStatus) {
  if (!task.exists) return paint('●', 'red');
  if (task.needsYou) return paint('●', 'yellow');
  return paint('●', 'grey');
}

function centre(text: string, width: number) {
  const trimmed = text.slice(0, width);
  const left = Math.floor((width - trimmed.length) / 2);
  return `${' '.repeat(left)}${trimmed}${' '.repeat(width - trimmed.length - left)}`;
}

/** Truncates on visible width, so colour codes never count toward the limit. */
export function truncate(line: string, width: number) {
  let visible = 0;
  let output = '';
  let index = 0;

  while (index < line.length) {
    if (line[index] === '\x1b') {
      const end = line.indexOf('m', index);
      if (end === -1) break;
      output += line.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    if (visible >= width) return `${output}${RESET}`;
    output += line[index];
    visible += 1;
    index += 1;
  }
  return output;
}
