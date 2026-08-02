#!/usr/bin/env bun
import {
  EDITOR_PATH_HELP,
  clearDevLog,
  createWorktreeFlow,
  devLogPath,
  followDevLog,
  listWorktrees,
  openInEditor,
  readDevLog,
  removeWorktreeFlow,
  resolveEditor,
  startDev,
  stopDev,
  taskStatuses,
} from './actions';
import {
  killAgent,
  runningAgents,
  seeAgent,
  sendToAgent,
  startAgent,
} from './agent';
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
  console.log(`\nopen it:   ${resolveEditor(config) ?? 'open'} ${created.path}`);
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

function commandStatus(argv: string[]) {
  const config = loadRepoConfig();
  const tasks = taskStatuses(config);

  if (flag(argv, 'json')) {
    console.log(JSON.stringify(tasks, null, 2));
    return;
  }
  if (!tasks.length) {
    console.log('(no worktrees)');
    return;
  }

  for (const task of tasks) {
    const agent = !task.agent.running
      ? 'no agent'
      : task.agent.busy
        ? 'working'
        : 'WAITING ON YOU';
    const spec = task.spec
      ? `${task.spec.done}/${task.spec.total} ${task.spec.status ?? ''}`.trim()
      : 'no spec';
    const dev = task.devRunning ? (task.devUrl ?? 'running') : 'stopped';

    console.log(`${task.needsYou ? '>' : ' '} ${task.name}`);
    console.log(`    agent  ${agent}`);
    console.log(`    spec   ${spec}`);
    console.log(`    dev    ${dev}`);
    console.log(
      `    git    ${task.branch}  ${task.uncommitted} uncommitted, ${task.unmerged} unmerged`,
    );
    if (task.agent.running && task.agent.lastLine) {
      console.log(`    last   ${task.agent.lastLine.slice(0, 90)}`);
    }
  }
}

async function commandAgent(argv: string[]) {
  const [subcommand, name, ...rest] = argv;
  const config = loadRepoConfig();

  if (subcommand === 'list') {
    const running = runningAgents(config);
    console.log(running.length ? running.join('\n') : '(no agents running)');
    return;
  }
  if (!name) {
    throw new Error('usage: pw agent <start|send|see|kill|list> <name>');
  }

  switch (subcommand) {
    case 'start': {
      const started = startAgent(config, name, option(argv, 'model'));
      console.log(`started ${name} in ${started.session}`);
      console.log(started.attachWith);
      break;
    }
    case 'send': {
      const prompt = rest.filter((part) => !part.startsWith('--')).join(' ');
      if (!prompt) throw new Error('usage: pw agent send <name> <prompt>');
      await sendToAgent(config, name, prompt);
      console.log(`sent to ${name}`);
      break;
    }
    case 'see': {
      const screen = seeAgent(config, name, Number(option(argv, 'lines') ?? 60));
      console.log(screen ?? `no running agent for '${name}'`);
      break;
    }
    case 'kill':
      console.log(
        killAgent(config, name) ? `killed ${name}` : `no agent '${name}'`,
      );
      break;
    default:
      throw new Error('usage: pw agent <start|send|see|kill|list> <name>');
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

async function commandLogs(argv: string[]) {
  const name = argv[0];
  if (!name) throw new Error('usage: pw logs <name> [--tail N] [--follow]');

  const config = loadRepoConfig();
  if (flag(argv, 'follow')) {
    await followDevLog(config, name);
    return;
  }
  if (flag(argv, 'clear')) {
    clearDevLog(config, name);
    console.log('log cleared');
    return;
  }

  const tail = option(argv, 'tail');
  if (!tail) {
    console.log(devLogPath(config, name));
    return;
  }
  console.log(readDevLog(config, name, Number(tail)).join('\n'));
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
    case 'status':
      commandStatus(argv);
      break;
    case 'agent':
      await commandAgent(argv);
      break;
    case 'dev':
      await commandDev(argv);
      break;
    case 'open': {
      const name = argv[0];
      if (!name) throw new Error('usage: pw open <name>');
      const config = loadRepoConfig();
      const record = readState(config.name).worktrees[name];
      if (!record) throw new Error(`no worktree '${name}' in the registry`);
      const editor = openInEditor(config, record.path);
      console.log(editor ? `${editor} ${record.path}` : EDITOR_PATH_HELP);
      break;
    }
    case 'logs':
      await commandLogs(argv);
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
