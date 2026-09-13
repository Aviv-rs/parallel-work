import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import { agentStatus, type AgentStatus } from './agent';
import type { RepoConfig } from './config';
import { readSpecProgress, type SpecProgress } from './spec';
import {
  clearLog,
  devUrlsFromLog,
  logTail,
  startDevServer,
  stopDevServer,
  waitForDevUrl,
} from './dev-server';
import { findPullRequest, type PullRequest } from './pull-request';
import { sessionName, tileShells } from './backend';
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

export interface TaskStatus extends WorktreeStatus {
  agent: AgentStatus;
  spec: SpecProgress | null;
  pullRequest: PullRequest | null;
  needsYou: boolean;
}

/**
 * Everything that can want your attention: an agent that stopped talking, a
 * dead dev server, or work that is finished and not merged.
 */
export function taskStatuses(config: RepoConfig): TaskStatus[] {
  return listWorktrees(config).map((worktree) => {
    const agent = agentStatus(config, worktree.name, worktree.path);
    // The worktree's own copy first: the agent ticks its checklist there, so
    // the main checkout's copy reports zero progress for the whole run.
    const spec = readSpecProgress(
      [worktree.exists ? worktree.path : '', config.root],
      worktree.taskId,
      worktree.name.replace(`${config.name}-`, ''),
    );
    return {
      ...worktree,
      agent,
      spec,
      pullRequest: worktree.exists
        ? findPullRequest(worktree.path, worktree.branch)
        : null,
      needsYou: agent.running && !agent.busy,
    };
  });
}

export function listWorktrees(config: RepoConfig): WorktreeStatus[] {
  const state = readState(config.name);
  return Object.values(state.worktrees).map((record) => {
    const exists = existsSync(record.path);
    const devRunning = isProcessAlive(record.devPid);
    // A server whose URL arrived after the startup wait gave up is still a
    // running server; read it back off the log instead of reporting a bare
    // "running" with no address.
    const recovered =
      devRunning && !record.devUrl
        ? devUrlsFromLog(logPath(config.name, record.name))
        : null;

    return {
      ...record,
      devUrl: record.devUrl ?? recovered?.localUrl ?? undefined,
      networkUrl: record.networkUrl ?? recovered?.networkUrl ?? undefined,
      exists,
      devRunning,
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

const EDITOR_CANDIDATES = [
  'cursor',
  'code',
  'code-insiders',
  'windsurf',
  'zed',
  'subl',
  'webstorm',
];

export const EDITOR_PATH_HELP = `No editor command found on PATH.

VS Code or Cursor: open the command palette and run
  Shell Command: Install 'code' command in PATH
  Shell Command: Install 'cursor' command in PATH

Or point pw at yours, in .parallel-work.json:
  { "editor": "cursor" }
or per shell:
  export PW_EDITOR=cursor`;

export function resolveEditor(config: RepoConfig) {
  const preferred = process.env.PW_EDITOR ?? config.editor;
  const candidates = preferred
    ? [preferred, ...EDITOR_CANDIDATES]
    : EDITOR_CANDIDATES;
  return candidates.find((candidate) => tryRun('which', [candidate]).ok) ?? null;
}

/**
 * Tiles every worktree, or the named ones, as shells in one tmux window. The
 * editor path is optional; this is the terminal-only equivalent.
 */
export function tileWorktrees(config: RepoConfig, names: string[]) {
  const worktrees = listWorktrees(config).filter((worktree) => worktree.exists);
  const wanted = names.length
    ? names.map((name) => {
        const match = worktrees.find((worktree) => worktree.name === name);
        if (!match) throw new Error(`no worktree '${name}'`);
        return match;
      })
    : worktrees;

  if (!wanted.length) throw new Error('no worktrees to tile');

  return tileShells(
    sessionName(config.name),
    wanted.map((worktree) => ({ name: worktree.name, cwd: worktree.path })),
  );
}

export function worktreePath(config: RepoConfig, name: string) {
  const record = readState(config.name).worktrees[name];
  if (!record) throw new Error(`no worktree '${name}'`);
  return record.path;
}

/**
 * A shell already in the worktree, for people who do not want an editor. It
 * blocks: pw is done until the user exits the shell, which is the behaviour
 * anyone typing `pw shell` expects.
 */
export function openShell(config: RepoConfig, name: string) {
  const cwd = worktreePath(config, name);
  const shell = process.env.SHELL || '/bin/sh';
  spawnSync(shell, { cwd, stdio: 'inherit' });
  return { cwd, shell };
}

export function openInEditor(config: RepoConfig, worktreePath: string) {
  const editor = resolveEditor(config);
  if (!editor) return null;
  spawn(editor, [worktreePath], { detached: true, stdio: 'ignore' }).unref();
  return editor;
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

/**
 * State drifts from disk when a worktree directory is deleted outside `pw`
 * (manual `rm`, Finder, a crashed flow) — nothing else notices, so `pw ls`
 * and the picker keep showing an entry nothing backs. This sweeps those out.
 */
export function cleanStaleWorktrees(config: RepoConfig, report: Report) {
  const stale = listWorktrees(config).filter((worktree) => !worktree.exists);
  for (const worktree of stale) {
    removeWorktreeFlow(config, worktree.name, true, report);
  }
  return stale.map((worktree) => worktree.name);
}
