import { tryRun } from './shell';

export interface PullRequest {
  number: number;
  url: string;
  title: string;
  isDraft: boolean;
}

interface CacheEntry {
  value: PullRequest | null;
  at: number;
}

/**
 * A network call per worktree cannot run on the status board's refresh, so the
 * answer is cached. A PR appearing a minute late is fine; a menu that stutters
 * every three seconds is not.
 */
const TTL_MS = 60_000;
const cache = new Map<string, CacheEntry>();

/** One failure means gh is missing or unauthenticated, and every call will fail. */
let ghUnavailable = false;

export function clearPullRequestCache() {
  cache.clear();
  ghUnavailable = false;
}

export function findPullRequest(
  worktreePath: string,
  branch: string,
  now = Date.now(),
): PullRequest | null {
  if (ghUnavailable || !branch) return null;

  const cached = cache.get(branch);
  if (cached && now - cached.at < TTL_MS) return cached.value;

  const result = tryRun(
    'gh',
    [
      'pr',
      'list',
      '--head',
      branch,
      '--state',
      'open',
      '--json',
      'number,url,title,isDraft',
      '--limit',
      '1',
    ],
    worktreePath,
  );

  if (!result.ok) {
    // A repo with no GitHub remote answers with an error too, so cache the
    // miss for this branch rather than giving up on every other worktree.
    if (/not found|command not found|gh auth|not authenticated/i.test(result.stdout)) {
      ghUnavailable = true;
    }
    cache.set(branch, { value: null, at: now });
    return null;
  }

  const pullRequest = parsePullRequestList(result.stdout);
  cache.set(branch, { value: pullRequest, at: now });
  return pullRequest;
}

export function parsePullRequestList(stdout: string): PullRequest | null {
  try {
    const rows = JSON.parse(stdout) as PullRequest[];
    return rows[0] ?? null;
  } catch {
    return null;
  }
}
