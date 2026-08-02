#!/usr/bin/env bun
import {
  createWorktreeFlow,
  devLogPath,
  listWorktrees,
  removeWorktreeFlow,
  startDev,
  stopDev,
} from './actions';
import { loadRepoConfig } from './config';
import { runInteractive } from './interactive';
import { BRANCH_TYPES, type BranchType } from './slug';
import { readState } from './state';
import { USAGE } from './usage';

const report = (line: string) => console.log(line);

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

  const created = await createWorktreeFlow(
    config,
    {
      slug,
      branchType,
      install: !flag(argv, 'no-install'),
      dev: !flag(argv, 'no-dev'),
    },
    report,
  );
  console.log(`\nopen it:   code ${created.path}`);
}

function commandList(argv: string[]) {
  const config = loadRepoConfig();
  const worktrees = listWorktrees(config);

  if (flag(argv, 'json')) {
    console.log(JSON.stringify(worktrees, null, 2));
    return;
  }
  if (!worktrees.length) {
    console.log('(no worktrees)');
    return;
  }
  for (const worktree of worktrees) {
    const dev = worktree.devRunning
      ? (worktree.devUrl ?? 'running')
      : 'stopped';
    console.log(worktree.name);
    console.log(`  branch  ${worktree.branch}`);
    console.log(`  dev     ${dev}`);
    console.log(
      `  git     ${worktree.uncommitted} uncommitted, ${worktree.unmerged} unmerged`,
    );
  }
}

function commandRemove(argv: string[]) {
  const name = argv[0];
  if (!name) throw new Error('usage: pw rm <name>');
  removeWorktreeFlow(loadRepoConfig(), name, flag(argv, 'force'), report);
}

async function commandDev(argv: string[]) {
  const name = argv[0];
  if (!name) throw new Error('usage: pw dev <name> [--stop]');

  const config = loadRepoConfig();
  const record = readState(config.name).worktrees[name];
  if (!record) throw new Error(`no worktree '${name}' in the registry`);

  if (flag(argv, 'stop')) {
    console.log(stopDev(config, name) ? 'stopped' : 'was not running');
    return;
  }
  await startDev(config, name, record.path, report);
}

function commandLogs(argv: string[]) {
  const name = argv[0];
  if (!name) throw new Error('usage: pw logs <name>');
  console.log(devLogPath(loadRepoConfig(), name));
}

const [command, ...argv] = process.argv.slice(2);

try {
  switch (command) {
    case undefined:
    case '-i':
    case '--interactive':
      await runInteractive(loadRepoConfig());
      break;
    case '-h':
    case '--help':
    case 'help':
      console.log(USAGE);
      break;
    case 'wt':
    case 'create':
      await commandCreate(argv);
      break;
    case 'rm':
    case 'remove':
      commandRemove(argv);
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
      console.error(`unknown command '${command}'\n`);
      console.log(USAGE);
      process.exit(1);
  }
} catch (error) {
  console.error(`error: ${(error as Error).message}`);
  process.exit(1);
}
