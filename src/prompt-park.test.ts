import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  PROMPT_READY_MARKERS,
  shouldParkPrompt,
  typedPromptText,
} from './prompt-park';

describe('shouldParkPrompt', () => {
  it('types a short single line as is', () => {
    expect(shouldParkPrompt('continue')).toBe(false);
  });

  it('parks anything with a newline', () => {
    expect(shouldParkPrompt('first\nsecond')).toBe(true);
  });

  it('parks a long single line', () => {
    expect(shouldParkPrompt('x'.repeat(301))).toBe(true);
  });
});

describe('typedPromptText', () => {
  it('returns a short prompt unchanged and writes no file', () => {
    const worktree = mkdtempSync(join(tmpdir(), 'pw-park-'));
    expect(typedPromptText(worktree, 'task', 'continue')).toBe('continue');
  });

  it('points at a park file holding the whole long prompt', () => {
    const worktree = mkdtempSync(join(tmpdir(), 'pw-park-'));
    const longPrompt = `start of prompt\n${'line\n'.repeat(200)}end of prompt`;
    const typed = typedPromptText(worktree, 'task', longPrompt);
    const parkedPath = typed.replace(/^Read /, '').replace(/ in full.*$/, '');
    expect(typed).toStartWith(`Read ${worktree}/.pw-prompts/task-`);
    expect(readFileSync(parkedPath, 'utf8')).toBe(`${longPrompt}\n`);
  });
});

describe('PROMPT_READY_MARKERS', () => {
  it('recognises the auto mode footer', () => {
    expect(
      PROMPT_READY_MARKERS.some((marker) =>
        '⏵⏵ auto mode on (shift+tab to cycle)'.includes(marker),
      ),
    ).toBe(true);
  });
});
