import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

import type { RepoConfig } from './config';
import { run, tryRun } from './shell';
import { addFolderToWorkspace, removeFolderFromWorkspace } from './workspace';

export interface CreateWorktreeInput {
  config: RepoConfig;
  directoryName: string;
  branch: string;
}

export function worktreePathFor(config: RepoConfig, directoryName: string) {
  return join(dirname(config.root), directoryName);
}

export function createWorktree({
  config,
  directoryName,
  branch,
}: CreateWorktreeInput) {
  const worktreePath = worktreePathFor(config, directoryName);
  if (existsSync(worktreePath)) {
    throw new Error(`${worktreePath} already exists`);
  }

  const remote = config.baseBranch.split('/')[0] ?? 'origin';
  tryRun('git', ['fetch', remote], config.root);

  const branchExists = tryRun(
    'git',
    ['rev-parse', '--verify', branch],
    config.root,
  ).ok;
  const args = branchExists
    ? ['worktree', 'add', worktreePath, branch]
    : ['worktree', 'add', '-b', branch, worktreePath, config.baseBranch];
  run('git', args, config.root);

  return worktreePath;
}

export function copyIgnoredFiles(config: RepoConfig, worktreePath: string) {
  const copied: string[] = [];
  const missing: string[] = [];
  for (const entry of config.copy) {
    const source = join(config.root, entry);
    if (!existsSync(source)) {
      missing.push(entry);
      continue;
    }
    cpSync(source, join(worktreePath, entry), { recursive: true });
    copied.push(entry);
  }
  return { copied, missing };
}

export function registerInWorkspace(config: RepoConfig, worktreePath: string) {
  if (!config.workspaceFile) return null;
  const workspacePath = join(config.root, config.workspaceFile);
  if (!existsSync(workspacePath)) return null;

  const folderPath = relative(config.root, worktreePath);
  const updated = addFolderToWorkspace(readFileSync(workspacePath, 'utf8'), {
    name: worktreePath.split('/').pop() ?? folderPath,
    path: folderPath,
  });
  writeFileSync(workspacePath, updated);
  return config.workspaceFile;
}

export function unregisterFromWorkspace(
  config: RepoConfig,
  worktreePath: string,
) {
  if (!config.workspaceFile) return null;
  const workspacePath = join(config.root, config.workspaceFile);
  if (!existsSync(workspacePath)) return null;

  const folderPath = relative(config.root, worktreePath);
  const updated = removeFolderFromWorkspace(
    readFileSync(workspacePath, 'utf8'),
    folderPath,
  );
  writeFileSync(workspacePath, updated);
  return config.workspaceFile;
}

export function removeWorktreeDirectory(
  config: RepoConfig,
  worktreePath: string,
  force: boolean,
) {
  const args = ['worktree', 'remove', worktreePath];
  if (force) args.push('--force');
  const result = tryRun('git', args, config.root);
  // `git worktree remove` refuses while node_modules is present.
  if (!result.ok && force) {
    rmSync(worktreePath, { recursive: true, force: true });
    run('git', ['worktree', 'prune'], config.root);
    return { removed: true, viaForce: true };
  }
  if (!result.ok) throw new Error(result.stderr || result.stdout);
  return { removed: true, viaForce: false };
}

export function uncommittedChanges(worktreePath: string) {
  const result = tryRun('git', ['status', '--porcelain'], worktreePath);
  return result.stdout ? result.stdout.split('\n').length : 0;
}

export function unmergedCommits(worktreePath: string, baseBranch: string) {
  const result = tryRun('git', ['cherry', baseBranch, 'HEAD'], worktreePath);
  if (!result.ok || !result.stdout) return 0;
  return result.stdout.split('\n').filter((line) => line.startsWith('+')).length;
}
