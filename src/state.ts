import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface WorktreeRecord {
  name: string;
  path: string;
  branch: string;
  taskId: string | null;
  createdAt: string;
  devPid?: number;
  devPort?: number;
  devUrl?: string;
  networkUrl?: string;
}

interface RepoState {
  worktrees: Record<string, WorktreeRecord>;
}

export const STATE_DIR = join(homedir(), '.parallel-work');

function statePath(repoName: string) {
  return join(STATE_DIR, `${repoName}.json`);
}

export function logPath(repoName: string, worktreeName: string) {
  const directory = join(STATE_DIR, 'logs', repoName);
  mkdirSync(directory, { recursive: true });
  return join(directory, `${worktreeName}.log`);
}

export function readState(repoName: string): RepoState {
  const path = statePath(repoName);
  if (!existsSync(path)) return { worktrees: {} };
  return JSON.parse(readFileSync(path, 'utf8')) as RepoState;
}

export function writeState(repoName: string, state: RepoState) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(statePath(repoName), `${JSON.stringify(state, null, 2)}\n`);
}

type WorktreePatch = Partial<WorktreeRecord> & { name: string };

export function upsertWorktree(repoName: string, patch: WorktreePatch) {
  const state = readState(repoName);
  const existing = state.worktrees[patch.name];
  state.worktrees[patch.name] = {
    name: patch.name,
    path: patch.path ?? existing?.path ?? '',
    branch: patch.branch ?? existing?.branch ?? '',
    taskId: patch.taskId ?? existing?.taskId ?? null,
    createdAt: existing?.createdAt ?? patch.createdAt ?? new Date().toISOString(),
    devPid: patch.devPid ?? existing?.devPid,
    devPort: patch.devPort ?? existing?.devPort,
    devUrl: patch.devUrl ?? existing?.devUrl,
    networkUrl: patch.networkUrl ?? existing?.networkUrl,
  };
  writeState(repoName, state);
}

export function removeWorktree(repoName: string, worktreeName: string) {
  const state = readState(repoName);
  delete state.worktrees[worktreeName];
  writeState(repoName, state);
}

export function isProcessAlive(pid: number | undefined) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
