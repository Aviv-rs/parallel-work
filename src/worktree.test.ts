import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import type { RepoConfig } from './config';
import { copyIgnoredFiles, matchCopyEntry } from './worktree';

function gitRepoFixture(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'pw-worktree-'));
  spawnSync('git', ['init', '--quiet'], { cwd: root });
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, contents);
  }
  return root;
}

describe('matchCopyEntry', () => {
  it('keeps a plain entry only when it exists', () => {
    const root = gitRepoFixture({ '.env': '' });
    expect(matchCopyEntry(root, '.env')).toEqual(['.env']);
    expect(matchCopyEntry(root, '.env.local')).toEqual([]);
  });

  it('expands a wildcard inside its folder', () => {
    const root = gitRepoFixture({
      '.env': '',
      '.env.staging': '',
      'config/.env.test': '',
      'environment.ts': '',
    });
    expect(matchCopyEntry(root, '.env*')).toEqual(['.env', '.env.staging']);
    expect(matchCopyEntry(root, 'config/.env*')).toEqual(['config/.env.test']);
  });
});

describe('copyIgnoredFiles', () => {
  it('copies every ignored match of a wildcard and skips tracked ones', () => {
    const root = gitRepoFixture({
      '.gitignore': '.env*\n!.env.example\n',
      '.env': '',
      '.env.staging': '',
      '.env.example': '',
    });
    const worktreePath = mkdtempSync(join(tmpdir(), 'pw-worktree-copy-'));
    const config = { root, copy: ['.env*', '.claude'] } as RepoConfig;

    expect(copyIgnoredFiles(config, worktreePath)).toEqual({
      copied: ['.env', '.env.staging'],
      missing: ['.claude'],
    });
    expect(existsSync(join(worktreePath, '.env.staging'))).toBe(true);
    expect(existsSync(join(worktreePath, '.env.example'))).toBe(false);
  });
});
