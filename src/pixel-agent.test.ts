import { describe, expect, it } from 'bun:test';

import type { TaskStatus } from './actions';
import {
  captionFor,
  moodFor,
  spriteFrame,
  statusBoard,
  truncate,
} from './pixel-agent';

function task(patch: Partial<TaskStatus> = {}): TaskStatus {
  return {
    name: 'sweft-eros-1-thing',
    path: '/tmp/sweft-eros-1-thing',
    branch: 'feature/EROS-1-thing',
    taskId: 'EROS-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    exists: true,
    devRunning: true,
    devUrl: 'http://localhost:3001/',
    uncommitted: 2,
    unmerged: 0,
    agent: { name: 'a', running: true, busy: true, lastLine: '' },
    spec: { file: '/tmp/plan.md', status: 'planned', done: 3, total: 10 },
    pullRequest: null,
    needsYou: false,
    ...patch,
  };
}

const openPullRequest = {
  number: 163,
  url: 'https://github.com/org/repo/pull/163',
  title: 'a thing',
  isDraft: false,
};

const STRIP_ANSI = new RegExp(String.raw`\x1b\[[0-9;]*m`, 'g');
const plain = (line: string) => line.replace(STRIP_ANSI, '');

describe('moodFor', () => {
  it('is empty with no worktrees', () => {
    expect(moodFor([])).toBe('empty');
  });

  it('prefers waiting over working when anything needs you', () => {
    expect(moodFor([task(), task({ needsYou: true, agent: { name: 'b', running: true, busy: false, lastLine: '' } })])).toBe('waiting');
  });

  it('is working while an agent is busy', () => {
    expect(moodFor([task()])).toBe('working');
  });

  it('raises the alarm when a worktree folder is gone', () => {
    expect(moodFor([task(), task({ exists: false })])).toBe('alert');
  });

  it('stays calm about a stopped dev server, which the row already shows', () => {
    expect(moodFor([task({ devRunning: false })])).toBe('working');
  });

  it('puts the alarm ahead of waiting', () => {
    expect(moodFor([task({ exists: false }), task({ needsYou: true })])).toBe(
      'alert',
    );
  });

  it('is asleep when agents are stopped', () => {
    expect(
      moodFor([
        task({ agent: { name: 'a', running: false, busy: false, lastLine: '' } }),
      ]),
    ).toBe('asleep');
  });
});

describe('captionFor', () => {
  it('reports how the work is going, not the plumbing', () => {
    expect(captionFor([task({ spec: { file: 'p', status: null, done: 3, total: 10 } })], 'working')).toBe('3/10 done');
    expect(captionFor([task(), task()], 'asleep')).toBe('6/20 done');
  });

  it('adds up progress across every plan', () => {
    const tasks = [
      task({ spec: { file: 'a', status: null, done: 2, total: 4 } }),
      task({ spec: { file: 'b', status: null, done: 1, total: 6 } }),
    ];
    expect(captionFor(tasks, 'working')).toBe('3/10 done');
  });

  it('says in review once the work is finished and a PR is open', () => {
    const finished = task({
      spec: { file: 'p', status: null, done: 5, total: 5 },
      pullRequest: openPullRequest,
    });
    expect(captionFor([finished], 'asleep')).toBe('in review');
  });

  it('says all done when finished with no PR yet', () => {
    const finished = task({ spec: { file: 'p', status: null, done: 5, total: 5 } });
    expect(captionFor([finished], 'asleep')).toBe('all done');
  });

  it('says review when a waiting task already has a PR', () => {
    const waiting = task({ needsYou: true, pullRequest: openPullRequest });
    expect(captionFor([waiting], 'waiting')).toBe('needs review');
  });

  it('falls back to needs you when nothing points at review', () => {
    expect(captionFor([task({ needsYou: true })], 'waiting')).toBe('needs you');
  });

  it('only shouts about a folder that is gone', () => {
    expect(captionFor([task({ exists: false })], 'alert')).toBe('folder gone');
    expect(moodFor([task({ devRunning: false })])).not.toBe('alert');
  });

  it('handles worktrees with no plan at all', () => {
    expect(captionFor([task({ spec: null })], 'asleep')).toBe('no plans');
  });
});

describe('spriteFrame', () => {
  it('cycles frames and never changes height', () => {
    const frames = [0, 1, 2, 3, 4].map((tick) => spriteFrame('working', tick));
    expect(new Set(frames.map((frame) => frame.length))).toEqual(new Set([4]));
    expect(plain(frames[0]!.join())).toBe(plain(frames[4]!.join()));
    expect(plain(frames[0]!.join())).not.toBe(plain(frames[1]!.join()));
  });
});

describe('truncate', () => {
  it('measures visible characters, not colour codes', () => {
    const coloured = `\x1b[36mhello world\x1b[0m`;
    expect(plain(truncate(coloured, 5))).toBe('hello');
  });

  it('leaves a short line alone', () => {
    expect(plain(truncate('abc', 10))).toBe('abc');
  });
});

describe('statusBoard', () => {
  it('never exceeds the given width', () => {
    const lines = statusBoard([task(), task({ name: 'b'.repeat(120) })], 0, 60);
    for (const line of lines) expect(plain(line).length).toBeLessThanOrEqual(60);
  });

  it('keeps a stable height between animation ticks', () => {
    const tasks = [task()];
    const heights = [0, 1, 2, 3].map((tick) => statusBoard(tasks, tick, 80).length);
    expect(new Set(heights).size).toBe(1);
  });

  it('says so when there are no worktrees', () => {
    expect(plain(statusBoard([], 0, 80).join('\n'))).toContain('no worktrees yet');
  });
});
