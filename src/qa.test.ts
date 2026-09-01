import { describe, expect, it } from 'bun:test';

import type { FigmaNode } from './figma';
import {
  assetScale,
  classifyRow,
  qaBrief,
  renderFindings,
  rowsNeedingReview,
  type QaReport,
} from './qa';
import { parseDesign, viewportFor } from './spec';

const MANIFEST = parseDesign(`## Design

Figma file: KEY
Mobile 390x844

| node | url | component | viewport | state |
| --- | --- | --- | --- | --- |
| 4263:32210 | /candidate/resume | CandidateResumeSection | mobile | default |
| 2917:57231 | | MobileHeader | | reference |
| 4264:47291 | /candidate/resume | Banner | mobile | default |
| 5000:1 | | Nothing | mobile | default |
`)!;

function node(type: string, width: number, height: number): FigmaNode {
  return {
    id: 'n',
    name: 'n',
    type,
    absoluteBoundingBox: { x: 0, y: 0, width, height },
  };
}

function classify(index: number, figmaNode: FigmaNode | undefined) {
  const row = MANIFEST.rows[index]!;
  return classifyRow(row, figmaNode, viewportFor(MANIFEST, row));
}

describe('classifyRow', () => {
  it('diffs a FRAME that is exactly the row viewport', () => {
    expect(classify(0, node('FRAME', 390, 844))).toEqual({ kind: 'diff' });
  });

  it('never diffs a reference row, whatever its node is', () => {
    expect(classify(1, node('COMPONENT_SET', 390, 844)).kind).toBe('reference');
  });

  it('refuses a diffable row pointing at a variants board', () => {
    const verdict = classify(2, node('COMPONENT_SET', 390, 844));
    expect(verdict.kind).toBe('refused');
    expect(verdict).toHaveProperty('reason', expect.stringContaining('COMPONENT_SET'));
  });

  it('refuses a frame whose size is not the viewport', () => {
    const verdict = classify(2, node('FRAME', 9662, 170));
    expect(verdict.kind).toBe('refused');
    expect(verdict).toHaveProperty(
      'reason',
      expect.stringContaining('9662x170, not the mobile viewport 390x844'),
    );
  });

  it('refuses a diffable row with no url', () => {
    expect(classify(3, node('FRAME', 390, 844))).toEqual({
      kind: 'refused',
      reason: 'diffable row has no url',
    });
  });

  it('refuses a row whose node did not come back', () => {
    expect(classify(0, undefined).kind).toBe('refused');
  });
});

describe('assetScale', () => {
  it('reads a whole-number export off the file width', () => {
    expect(assetScale(80, 160)).toBe(2);
    expect(assetScale(80, 80)).toBe(1);
  });

  it('refuses a size that is not a whole multiple of the node', () => {
    expect(assetScale(80, 120)).toBeNull();
    expect(assetScale(80, 41)).toBeNull();
  });
});

const REPORT: QaReport = {
  task: 'EROS-425-candidate-resume',
  worktree: '/tmp/wt',
  planFile: '/tmp/wt/spec/EROS-425-candidate-resume/plan.md',
  status: 'in progress',
  checklist: [
    { text: 'route wired', checked: true },
    { text: 'replace drawer', checked: false },
  ],
  changedFiles: ['src/routes/_app/candidate/resume.tsx'],
  checks: [{ name: 'tests', command: 'bun test', ok: true, output: '56 pass' }],
  rows: [
    {
      nodeId: '4263:32210',
      url: '/candidate/resume',
      component: 'CandidateResumeSection',
      state: 'default',
      status: 'diffed',
      ratio: 0.031,
      sizeMismatch: null,
      message: null,
      driftRatio: 0,
      images: { design: '/a.png', app: '/b.png', diff: '/c.png' },
    },
  ],
  assets: [
    { file: 'src/assets/x.png', nodeId: '1:2', ok: false, message: 'does not match' },
  ],
  failures: ['src/assets/x.png does not match'],
  notes: ['4263:32210 /candidate/resume: 3.1% of pixels differ'],
  findingsFile: null,
};

describe('renderFindings', () => {
  it('leads with the gate, so the first line says whether to act', () => {
    expect(renderFindings(REPORT)).toContain('Gate: FAILED');
  });

  it('separates what fails the run from what is only reported', () => {
    const text = renderFindings(REPORT);
    expect(text).toContain('## Failures');
    expect(text).toContain('## Reported, not fatal');
  });

  it('names the three images of a failing pair so the agent can read them', () => {
    const text = renderFindings(REPORT);
    expect(text).toContain('- diff: /c.png');
  });

  it('says the gate passed when nothing failed', () => {
    expect(renderFindings({ ...REPORT, failures: [] })).toContain('Gate: passed');
  });
});

const CLEAN: QaReport = {
  ...REPORT,
  rows: [{ ...REPORT.rows[0]!, ratio: 0.004, driftRatio: 0 }],
  assets: [{ file: 'src/assets/x.png', nodeId: '1:2', ok: true, message: 'matches' }],
  failures: [],
  notes: [],
};

describe('rowsNeedingReview', () => {
  it('leaves out a row that matched its design', () => {
    expect(rowsNeedingReview(CLEAN)).toEqual([]);
  });

  it('picks up a row over the layout threshold', () => {
    expect(rowsNeedingReview(REPORT)).toHaveLength(1);
  });

  it('picks up a refused row, which has no ratio at all', () => {
    const refused: QaReport = {
      ...CLEAN,
      rows: [{ ...CLEAN.rows[0]!, status: 'refused', ratio: null, message: 'is a COMPONENT_SET' }],
    };
    expect(rowsNeedingReview(refused)).toHaveLength(1);
  });

  it('picks up a row whose design moved since the plan', () => {
    const drifted: QaReport = {
      ...CLEAN,
      rows: [{ ...CLEAN.rows[0]!, driftRatio: 0.4 }],
    };
    expect(rowsNeedingReview(drifted)).toHaveLength(1);
  });
});

describe('qaBrief', () => {
  it('is null on a clean run, which is what stops an agent being launched', () => {
    expect(qaBrief(CLEAN)).toBeNull();
  });

  it('hands over the failing row with all three of its images', () => {
    const brief = qaBrief(REPORT)!;
    expect(brief).toContain('4263:32210');
    expect(brief).toContain('read the diff: /c.png');
  });

  it('tells the reviewer it cannot fix what it finds', () => {
    expect(qaBrief(REPORT)!).toContain('do not fix it');
  });

  it('carries failures that are not rows, like a bad asset', () => {
    expect(qaBrief(REPORT)!).toContain('src/assets/x.png does not match');
  });

  it('is not null when only a non-row check failed', () => {
    const assetOnly: QaReport = { ...CLEAN, failures: ['tests failed: bun test'] };
    expect(qaBrief(assetOnly)).toContain('tests failed');
  });
});
