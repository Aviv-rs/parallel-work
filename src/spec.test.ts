import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import {
  descriptiveTail,
  findSpec,
  parseDesign,
  parseSpec,
  viewportFor,
} from './spec';

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

const DESIGN_PLAN = `# EROS-425 Candidate resume

Status: planned

## Design

Figma file: WdGzjurMa53pyVeu1cU5I9
Mobile 390x844 unless a row says otherwise. Desktop 1440x900.

| node | url | component | viewport | state |
| --- | --- | --- | --- | --- |
| 4263-32210 | /candidate/resume | CandidateResumeSection | mobile | default |
| 4263:33001 | /candidate/resume | CandidateResumeSection | mobile | setup:resume-filled |
| 4263:33002 | /candidate/resume | CandidateResumeSection | mobile | hover:button[type=submit] |
| 2917:57231 | | MobileHeader | | reference |

### Assets

| node | file |
| --- | --- |
| 4263:32215 | src/assets/images/resume-empty-state-illustration.png |
| | src/assets/images/orphan.png |

## Reuse

- nothing here is a manifest row
`;

describe('parseDesign', () => {
  it('returns null when the plan has no Design section', () => {
    expect(parseDesign(PLAN)).toBeNull();
  });

  it('reads the file key and the named viewports', () => {
    const design = parseDesign(DESIGN_PLAN)!;
    expect(design.fileKey).toBe('WdGzjurMa53pyVeu1cU5I9');
    expect(design.viewports.mobile).toEqual({ width: 390, height: 844 });
    expect(design.viewports.desktop).toEqual({ width: 1440, height: 900 });
  });

  it('normalises a url-style node id to the API form', () => {
    expect(parseDesign(DESIGN_PLAN)!.rows[0]!.nodeId).toBe('4263:32210');
  });

  it('reads every state kind', () => {
    const states = parseDesign(DESIGN_PLAN)!.rows.map((row) => row.state);
    expect(states).toEqual([
      { kind: 'default' },
      { kind: 'setup', module: 'resume-filled' },
      { kind: 'hover', selector: 'button[type=submit]' },
      { kind: 'reference' },
    ]);
  });

  it('leaves empty cells null instead of empty strings', () => {
    const reference = parseDesign(DESIGN_PLAN)!.rows[3]!;
    expect(reference.url).toBeNull();
    expect(reference.viewport).toBeNull();
    expect(reference.component).toBe('MobileHeader');
  });

  it('stops at the next section, so later tables are not manifest rows', () => {
    expect(parseDesign(DESIGN_PLAN)!.rows).toHaveLength(4);
  });

  it('keeps an asset row with no node id, so qa can call it out', () => {
    const assets = parseDesign(DESIGN_PLAN)!.assets;
    expect(assets).toEqual([
      {
        nodeId: '4263:32215',
        file: 'src/assets/images/resume-empty-state-illustration.png',
      },
      { nodeId: null, file: 'src/assets/images/orphan.png' },
    ]);
  });

  it('falls back to the only viewport when a row names none', () => {
    const design = parseDesign(
      '## Design\n\nMobile 390x844\n\n| node | url |\n| --- | --- |\n| 1:2 | /a |\n',
    )!;
    expect(viewportFor(design, design.rows[0]!)).toEqual({
      width: 390,
      height: 844,
    });
  });

  it('still counts the checklist of a plan that has a Design section', () => {
    expect(parseSpec(DESIGN_PLAN).total).toBe(0);
  });
});
