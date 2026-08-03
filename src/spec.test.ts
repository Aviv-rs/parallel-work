import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import { descriptiveTail, findSpec, parseSpec } from './spec';

const MULTI_TICKET_PLAN = `# EROS-642 Two refinements

Status: planned

# EROS-782 Delete review

## Checklist

- [x] ~~hide the icons~~
- [ ] server guard

## Manual tests

- [ ] share with two members

# EROS-781 Mobile

## Checklist

- [ ] shared draft hook
- [ ] dock component
- [ ] mobile screen

## Manual tests

- [ ] open it on a phone
`;

const PLAN = `# EROS-696 Work area step

Status: in progress
Branch: feature/EROS-696-work-area

## Checklist

- [x] ~~failing tests~~
- [x] ~~migration~~
- [ ] step visibility
- [ ] persistence

## Manual tests

- [ ] open the wizard, reach the work area step
- [ ] pick two areas, refresh, they survive
`;

describe('parseSpec', () => {
  it('reads the status line', () => {
    expect(parseSpec(PLAN).status).toBe('in progress');
  });

  it('counts only the checklist, not the human manual tests', () => {
    expect(parseSpec(PLAN)).toMatchObject({ done: 2, total: 4 });
  });

  it('handles a bold status line', () => {
    expect(parseSpec('**Status:** merged').status).toBe('merged');
  });

  it('reports nothing for a plan with no boxes', () => {
    expect(parseSpec('# just prose')).toEqual({
      status: null,
      done: 0,
      total: 0,
    });
  });

  it('counts an unticked plan as zero done', () => {
    expect(parseSpec('- [ ] a\n- [ ] b')).toMatchObject({ done: 0, total: 2 });
  });

  it('keeps counting checklists that come after a manual tests section', () => {
    expect(parseSpec(MULTI_TICKET_PLAN)).toMatchObject({ done: 1, total: 5 });
  });
});

describe('descriptiveTail', () => {
  it('drops a single task id', () => {
    expect(descriptiveTail('EROS-747-job-opening-qa')).toBe('job-opening-qa');
  });

  it('drops a chained task id', () => {
    expect(descriptiveTail('EROS-787-792-job-opening-qa')).toBe(
      'job-opening-qa',
    );
  });

  it('leaves an id-less name alone', () => {
    expect(descriptiveTail('refactor-query-keys')).toBe('refactor-query-keys');
  });
});

function specFixture(folders: string[]) {
  const root = mkdtempSync(join(tmpdir(), 'pw-spec-'));
  for (const folder of folders) {
    mkdirSync(join(root, 'spec', folder), { recursive: true });
    writeFileSync(join(root, 'spec', folder, 'plan.md'), '- [ ] a\n');
  }
  return root;
}

describe('findSpec', () => {
  it('matches on the task id', () => {
    const root = specFixture(['EROS-638-ai-job-sub-title']);
    expect(findSpec(root, 'EROS-638', 'EROS-638-ai-job-sub-title')).toContain(
      'EROS-638-ai-job-sub-title/plan.md',
    );
  });

  it('falls back to the descriptive tail when the ids differ', () => {
    const root = specFixture(['EROS-747-job-opening-qa']);
    expect(
      findSpec(root, 'EROS-787', 'EROS-787-792-job-opening-qa'),
    ).toContain('EROS-747-job-opening-qa/plan.md');
  });

  it('reports nothing when neither the id nor the tail match', () => {
    const root = specFixture(['EROS-747-job-opening-qa']);
    expect(findSpec(root, 'EROS-900', 'EROS-900-something-else')).toBeNull();
  });
});
