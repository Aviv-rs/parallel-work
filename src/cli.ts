#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs';

import { loadRepoConfig } from './config';
import { startDevServer, stopDevServer, waitForDevUrl } from './dev-server';
import { BRANCH_TYPES, parseSlug, type BranchType } from './slug';
import {
  isProcessAlive,
  readState,
  removeWorktree,
  upsertWorktree,
} from './state';
import { run, tryRun } from './shell';
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

const USAGE = `pw - parallel work across git worktrees

  pw wt <slug> [--type feature|bugfix|chore|refactor|docs] [--no-dev] [--no-install]
      Create a worktree, copy ignored files, install, add to the code-workspace,
      start the dev server and print its URL.

  pw rm <name> [--force]        Remove a worktree and everything pw added for it
  pw list [--json]              Worktrees, branches, dev URLs
  pw dev <name> [--stop]        Start or stop the dev server for a worktree
  pw logs <name>                Path to that worktree's dev server log

Slug is <TASK-ID>-<short-title>, e.g. EROS-696-onboarding-work-area.
Config lives in .parallel-work.json at the repo root.`;

function flag(argv: string[], name: string) {
  return argv.includes(`--${name}`);
}

function option(argv: string[], name: string) {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? null : (argv[index + 1] ?? null);
}

async function commandCreate(argv: string[]) {
  const slug = argv[0];
  if (!slug) throw new Error('usage: pw wt <slug>');

  const config = loadRepoConfig();
  const branchType = (option(argv, 'type') ?? 'feature') as BranchType;
  if (!BRANCH_TYPES.includes(branchType)) {
    throw new Error(`--type must be one of ${BRANCH_TYPES.join(', ')}`);
  }

  const parsed = parseSlug(slug, {
    repoName: config.name,
    branchType,
    taskPrefix: config.taskPrefix ?? undefined,
  });

  console.log(`branch     ${parsed.branch}`);
  const worktreePath = createWorktree({
    config,
    directoryName: parsed.directoryName,
    branch: parsed.branch,
  });
  console.log(`worktree   ${worktreePath}`);

  const { copied, missing } = copyIgnoredFiles(config, worktreePath);
  if (copied.length) console.log(`copied     ${copied.join(', ')}`);
  if (missing.length) console.log(`missing    ${missing.join(', ')}`);

  const workspaceFile = registerInWorkspace(config, worktreePath);
  if (workspaceFile) console.log(`workspace  added to ${workspaceFile}`);

  if (config.install && !flag(argv, 'no-install')) {
    console.log(`install    ${config.install}`);
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

  if (config.dev && !flag(argv, 'no-dev')) {
    await startDevFor(config.name, parsed.directoryName, worktreePath, config.dev);
  }

  console.log(`\nopen it:   code ${worktreePath}`);
}

async function startDevFor(
  repoName: string,
  worktreeName: string,
  worktreePath: string,
  devCommand: string,
) {
  console.log(`dev        ${devCommand} (starting)`);
  const handle = startDevServer(repoName, worktreeName, worktreePath, devCommand);
  const { localUrl, networkUrl } = await waitForDevUrl(handle.logFile);

  upsertWorktree(repoName, {
    name: worktreeName,
    path: worktreePath,
    devPid: handle.pid,
    devUrl: localUrl ?? undefined,
    networkUrl: networkUrl ?? undefined,
    devPort: localUrl ? Number(new URL(localUrl).port) : undefined,
  });

  if (localUrl) {
    console.log(`dev        ${localUrl}`);
    if (networkUrl) console.log(`mobile     ${networkUrl}`);
    return;
  }

  if (isProcessAlive(handle.pid)) {
    console.log(`dev        still starting, no URL yet: pw logs ${worktreeName}`);
    return;
  }

  console.log(`dev        FAILED, last lines of ${handle.logFile}:`);
  const tail = readFileSync(handle.logFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .slice(-12);
  for (const line of tail) console.log(`           ${line}`);
}

function commandList(argv: string[]) {
  const config = loadRepoConfig();
  const state = readState(config.name);
  const rows = Object.values(state.worktrees).map((record) => ({
    ...record,
    exists: existsSync(record.path),
    devRunning: isProcessAlive(record.devPid),
    uncommitted: existsSync(record.path) ? uncommittedChanges(record.path) : 0,
    unmerged: existsSync(record.path)
      ? unmergedCommits(record.path, config.baseBranch)
      : 0,
  }));

  if (flag(argv, 'json')) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (!rows.length) {
    console.log('(no worktrees)');
    return;
  }

  for (const row of rows) {
    const dev = row.devRunning ? (row.devUrl ?? 'running') : 'stopped';
    console.log(`${row.name}`);
    console.log(`  branch  ${row.branch}`);
    console.log(`  dev     ${dev}`);
    console.log(
      `  git     ${row.uncommitted} uncommitted, ${row.unmerged} unmerged`,
    );
  }
}

async function commandRemove(argv: string[]) {
  const name = argv[0];
  if (!name) throw new Error('usage: pw rm <name>');

  const config = loadRepoConfig();
  const state = readState(config.name);
  const record = state.worktrees[name];
  const worktreePath = record?.path ?? worktreePathFor(config, name);
  const force = flag(argv, 'force');

  if (existsSync(worktreePath)) {
    const dirty = uncommittedChanges(worktreePath);
    const unmerged = unmergedCommits(worktreePath, config.baseBranch);
    if ((dirty || unmerged) && !force) {
      throw new Error(
        `${name} has ${dirty} uncommitted changes and ${unmerged} unmerged commits. ` +
          'Deal with them or pass --force.',
      );
    }
  }

  if (stopDevServer(record?.devPid)) console.log('dev        stopped');

  const workspaceFile = unregisterFromWorkspace(config, worktreePath);
  if (workspaceFile) console.log(`workspace  removed from ${workspaceFile}`);

  if (existsSync(worktreePath)) {
    const result = removeWorktreeDirectory(config, worktreePath, force);
    console.log(`worktree   removed${result.viaForce ? ' (forced)' : ''}`);
  }

  if (record?.branch) {
    const deleted = tryRun('git', ['branch', '-d', record.branch], config.root);
    console.log(
      deleted.ok
        ? `branch     ${record.branch} deleted`
        : `branch     ${record.branch} kept (not fully merged)`,
    );
  }

  removeWorktree(config.name, name);
  console.log(`registry   ${name} dropped`);
}

async function commandDev(argv: string[]) {
  const name = argv[0];
  if (!name) throw new Error('usage: pw dev <name> [--stop]');

  const config = loadRepoConfig();
  const state = readState(config.name);
  const record = state.worktrees[name];
  if (!record) throw new Error(`no worktree '${name}' in the registry`);

  if (flag(argv, 'stop')) {
    console.log(stopDevServer(record.devPid) ? 'stopped' : 'was not running');
    return;
  }
  if (isProcessAlive(record.devPid)) {
    console.log(`already running: ${record.devUrl ?? '(no url captured)'}`);
    return;
  }
  if (!config.dev) throw new Error('no dev command configured');
  await startDevFor(config.name, name, record.path, config.dev);
}

function commandLogs(argv: string[]) {
  const name = argv[0];
  if (!name) throw new Error('usage: pw logs <name>');
  const config = loadRepoConfig();
  console.log(
    `${process.env.HOME}/.parallel-work/logs/${config.name}/${name}.log`,
  );
}

const [command, ...argv] = process.argv.slice(2);

try {
  switch (command) {
    case 'wt':
    case 'create':
      await commandCreate(argv);
      break;
    case 'rm':
    case 'remove':
      await commandRemove(argv);
      break;
    case 'list':
    case 'ls':
      commandList(argv);
      break;
    case 'dev':
      await commandDev(argv);
      break;
    case 'logs':
      commandLogs(argv);
      break;
    default:
      console.log(USAGE);
      process.exit(command ? 1 : 0);
  }
} catch (error) {
  console.error(`error: ${(error as Error).message}`);
  process.exit(1);
}
