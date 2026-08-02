export interface ParsedSlug {
  taskId: string | null;
  title: string;
  branch: string;
  directoryName: string;
}

const TASK_ID_PATTERN = /^([A-Za-z]+-\d+|\d+)-(.+)$/;

export const BRANCH_TYPES = [
  'feature',
  'bugfix',
  'chore',
  'refactor',
  'docs',
] as const;

export type BranchType = (typeof BRANCH_TYPES)[number];

interface ParseSlugOptions {
  repoName: string;
  branchType: BranchType;
  taskPrefix?: string;
}

export function parseSlug(
  rawSlug: string,
  { repoName, branchType, taskPrefix }: ParseSlugOptions,
): ParsedSlug {
  const slug = rawSlug.trim().replace(/^\/+|\/+$/g, '');
  if (!slug) throw new Error('slug is empty');

  const match = slug.match(TASK_ID_PATTERN);
  if (!match) {
    return {
      taskId: null,
      title: slug.toLowerCase(),
      branch: `${branchType}/${slug.toLowerCase()}`,
      directoryName: `${repoName}-${slug.toLowerCase()}`,
    };
  }

  const rawTaskId = match[1] ?? '';
  const title = (match[2] ?? '').toLowerCase();
  const isBareNumber = /^\d+$/.test(rawTaskId);
  if (isBareNumber && !taskPrefix) {
    throw new Error(
      `"${rawSlug}" starts with a bare number and no taskPrefix is configured. ` +
        `Write the full id (ABC-${rawTaskId}-...) or set taskPrefix in .parallel-work.json`,
    );
  }

  const taskId = isBareNumber
    ? `${taskPrefix ?? ''}-${rawTaskId}`
    : rawTaskId.toUpperCase();

  return {
    taskId,
    title,
    branch: `${branchType}/${taskId}-${title}`,
    directoryName: `${repoName}-${taskId.toLowerCase()}-${title}`,
  };
}
