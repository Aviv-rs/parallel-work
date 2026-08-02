import { describe, expect, it } from 'bun:test';

import { parseSlug } from './slug';

const base = { repoName: 'sweft', branchType: 'feature' as const };

describe('parseSlug', () => {
  it('keeps the task id first and lowercases the directory', () => {
    expect(parseSlug('EROS-696-onboarding-work-area', base)).toEqual({
      taskId: 'EROS-696',
      title: 'onboarding-work-area',
      branch: 'feature/EROS-696-onboarding-work-area',
      directoryName: 'sweft-eros-696-onboarding-work-area',
    });
  });

  it('expands a bare number using the configured prefix', () => {
    const parsed = parseSlug('696-work-area', { ...base, taskPrefix: 'EROS' });
    expect(parsed.taskId).toBe('EROS-696');
    expect(parsed.branch).toBe('feature/EROS-696-work-area');
  });

  it('refuses a bare number with no prefix configured', () => {
    expect(() => parseSlug('696-work-area', base)).toThrow(/taskPrefix/);
  });

  it('leads with the change type when there is no ticket', () => {
    const parsed = parseSlug('query-keys-cleanup', {
      ...base,
      branchType: 'refactor',
    });
    expect(parsed.taskId).toBeNull();
    expect(parsed.branch).toBe('refactor/query-keys-cleanup');
    expect(parsed.directoryName).toBe('sweft-query-keys-cleanup');
  });

  it('uppercases a lowercase ticket id', () => {
    expect(parseSlug('eros-700-more-results', base).taskId).toBe('EROS-700');
  });
});
