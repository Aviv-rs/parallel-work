import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

import type { RepoConfig } from './config';
import {
  clearLog,
  logTail,
  startDevServer,
  stopDevServer,
  waitForDevUrl,
} from './dev-server';
import { logPath } from './state';
import { parseSlug, type BranchType } from './slug';
import { run, tryRun } from './shell';
import {
  isProcessAlive,
  readState,
  removeWorktree,
  upsertWorktree,
  type WorktreeRecord,
} from './state';
import {
  copyIgnoredFiles,
  createWorktree,
  registerInWorkspace,
  removeWorktreeDirectory,
  uncommittedChanges,
  unmergedCommits,
  unregisterFromWorkspace,
  worktreePathFor,
} from './worktree';

export type Report = (line: string) => void;

const DEV_URL_TIMEOUT_MS = 60_000;

export interface WorktreeStatus extends WorktreeRecord {
  exists: boolean;
  devRunning: boolean;
  uncommitted: number;
  unmerged: number;
}

export function listWorktrees(config: RepoConfig): WorktreeStatus[] {
  const state = readState(config.name);
  return Object.values(state.worktrees).map((record) => {
    const exists = existsSync(record.path);
    return {
      ...record,
      exists,
      devRunning: isProcessAlive(record.devPid),
      uncommitted: exists ? uncommittedChanges(record.path) : 0,
      unmerged: exists ? unmergedCommits(record.path, config.baseBranch) : 0,
    };
  });
}

export async function startDev(
  config: RepoConfig,
  worktreeName: string,
  worktreePath: string,
  report: Report,
) {
  if (!config.dev) throw new Error('no dev command configured');

  report(`dev        ${config.dev} (starting)`);
  const handle = startDevServer(
    config.name,
    worktreeName,
    worktreePath,
    config.dev,
  );
  const { localUrl, networkUrl, died } = await waitForDevUrl(handle.logFile, {
    pid: handle.pid,
    fromOffset: handle.runStartOffset,
    timeoutMs: DEV_URL_TIMEOUT_MS,
    onProgress: (line) => report(`dev        ${line.slice(0, 80)}`),
  });

  upsertWorktree(config.name, {
    name: worktreeName,
    path: worktreePath,
    devPid: handle.pid,
    devUrl: localUrl ?? undefined,
    networkUrl: networkUrl ?? undefined,
    devPort: localUrl ? Number(new URL(localUrl).port) : undefined,
  });

  if (localUrl) {
    report(`dev        ${localUrl}`);
    if (networkUrl) report(`mobile     ${networkUrl}`);
    return { localUrl, networkUrl };
  }

  report(
    died
      ? 'dev        FAILED, last lines of the log:'
      : `dev        no URL after ${DEV_URL_TIMEOUT_MS / 1000}s, still running. Last lines:`,
  );
  for (const line of logTail(handle.logFile)) report(`           ${line}`);
  return { localUrl: null, networkUrl: null };
}

export function stopDev(config: RepoConfig, worktreeName: string) {
  const record = readState(config.name).worktrees[worktreeName];
  return stopDevServer(record?.devPid);
}

export function devLogPath(config: RepoConfig, worktreeName: string) {
  return logPath(config.name, worktreeName);
}

export function readDevLog(
  config: RepoConfig,
  worktreeName: string,
  lineCount: number,
) {
  return logTail(logPath(config.name, worktreeName), lineCount);
}

export function clearDevLog(config: RepoConfig, worktreeName: string) {
  clearLog(logPath(config.name, worktreeName));
}

export function followDevLog(config: RepoConfig, worktreeName: string) {
  const child = spawn('tail', ['-f', logPath(config.name, worktreeName)], {
    stdio: 'inherit',
  });

  // Ctrl-C has to reach tail without also killing pw.
  const ownSigintHandlers = process.listeners('SIGINT');
  process.removeAllListeners('SIGINT');
  const forwardInterrupt = () => child.kill('SIGINT');
  process.on('SIGINT', forwardInterrupt);

  return new Promise<void>((resolve) => {
    child.on('exit', () => {
      process.removeListener('SIGINT', forwardInterrupt);
      for (const handler of ownSigintHandlers) {
        process.on('SIGINT', handler as () => void);
      }
      resolve();
    });
  });
}

interface CreateOptions {
  slug: string;
  branchType: BranchType;
  install: boolean;
  dev: boolean;
}

export async function createWorktreeFlow(
  config: RepoConfig,
  { slug, branchType, install, dev }: CreateOptions,
  report: Report,
) {
  const parsed = parseSlug(slug, {
    repoName: config.name,
    branchType,
    taskPrefix: config.taskPrefix ?? undefined,
  });

  report(`branch     ${parsed.branch}`);
  const worktreePath = createWorktree({
    config,
    directoryName: parsed.directoryName,
    branch: parsed.branch,
  });
  report(`worktree   ${worktreePath}`);

  const { copied, missing } = copyIgnoredFiles(config, worktreePath);
  if (copied.length) report(`copied     ${copied.join(', ')}`);
  if (missing.length) report(`missing    ${missing.join(', ')}`);

  const workspaceFile = registerInWorkspace(config, worktreePath);
  if (workspaceFile) report(`workspace  added to ${workspaceFile}`);

  if (config.install && install) {
    report(`install    ${config.install}`);
    const [installBinary, ...installArgs] = config.install.split(' ');
    run(installBinary ?? 'bun', installArgs, worktreePath);
  }

  upsertWorktree(config.name, {
    name: parsed.directoryName,
    path: worktreePath,
    branch: parsed.branch,
    taskId: parsed.taskId,
    createdAt: new Date().toISOString(),
  });

  if (config.dev && dev) {
    await startDev(config, parsed.directoryName, worktreePath, report);
  }

  return { name: parsed.directoryName, path: worktreePath, branch: parsed.branch };
}

export function removeWorktreeFlow(
  config: RepoConfig,
  worktreeName: string,
  force: boolean,
  report: Report,
) {
  const record = readState(config.name).worktrees[worktreeName];
  const worktreePath = record?.path ?? worktreePathFor(config, worktreeName);

  if (existsSync(worktreePath)) {
    const dirty = uncommittedChanges(worktreePath);
    const unmerged = unmergedCommits(worktreePath, config.baseBranch);
    if ((dirty || unmerged) && !force) {
      throw new Error(
        `${worktreeName} has ${dirty} uncommitted changes and ${unmerged} unmerged commits. ` +
          'Deal with them or force it.',
      );
    }
  }

  if (stopDevServer(record?.devPid)) report('dev        stopped');

  const workspaceFile = unregisterFromWorkspace(config, worktreePath);
  if (workspaceFile) report(`workspace  removed from ${workspaceFile}`);

  if (existsSync(worktreePath)) {
    const result = removeWorktreeDirectory(config, worktreePath, force);
    report(`worktree   removed${result.viaForce ? ' (forced)' : ''}`);
  }

  if (record?.branch) {
    const deleted = tryRun('git', ['branch', '-d', record.branch], config.root);
    report(
      deleted.ok
        ? `branch     ${record.branch} deleted`
        : `branch     ${record.branch} kept (not fully merged)`,
    );
  }

  removeWorktree(config.name, worktreeName);
  report(`registry   ${worktreeName} dropped`);
}
