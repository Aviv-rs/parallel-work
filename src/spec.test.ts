import { describe, expect, it } from 'bun:test';

import { parseSpec } from './spec';

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
});
