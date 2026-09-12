#!/usr/bin/env bun
import {
  EDITOR_PATH_HELP,
  clearDevLog,
  createWorktreeFlow,
  devLogPath,
  followDevLog,
  listWorktrees,
  openInEditor,
  openShell,
  readDevLog,
  removeWorktreeFlow,
  resolveEditor,
  startDev,
  stopDev,
  taskStatuses,
  tileWorktrees,
  worktreePath,
} from './actions';
import {
  killAgent,
  runningAgents,
  seeAgent,
  sendToAgent,
  startAgent,
  startQaAgent,
} from './agent';
import { discoverFlow } from './figma';
import { cacheReferenceImages, qaBrief, runQa } from './qa';
import { findSpec, normaliseNodeId, parseDesign } from './spec';
import { loadRepoConfig } from './config';
import { runInteractive } from './interactive';
import { BRANCH_TYPES, type BranchType } from './slug';
import { runSetup } from './setup';
import {
  attachHint,
  describeGrouping,
  describeUngrouping,
  gridWindows,
  sessionName,
  ungridWindows,
} from './backend';
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
  if (subcommand === 'tile') {
    const running = runningAgents(config).filter((window) => window !== 'grid');
    if (!running.length) throw new Error('no agents running to tile');
    gridWindows(sessionName(config.name), running);
    console.log(describeGrouping(running.length));
    console.log(attachHint(sessionName(config.name)));
    return;
  }
  if (subcommand === 'untile') {
    ungridWindows(sessionName(config.name));
    console.log(describeUngrouping());
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
      throw new Error(
        'usage: pw agent <start|send|see|kill|list|tile|untile> <name>',
      );
  }
}

/**
 * Bare `pw qa` runs the checks and writes the findings file, and that is all.
 * Starting an agent and typing into a worker are both things that interrupt
 * somebody, so each one is a flag the human turns on deliberately.
 */
async function commandQa(argv: string[]) {
  const name = argv[0];
  if (!name) {
    throw new Error(
      'usage: pw qa <name> [--spec-only] [--visual-only] [--agent] [--tell]',
    );
  }

  const config = loadRepoConfig();
  const lanes = flag(argv, 'spec-only')
    ? 'spec'
    : flag(argv, 'visual-only')
      ? 'visual'
      : 'both';

  const result = await runQa({ config, name, lanes, report });

  console.log('');
  for (const failure of result.failures) console.log(`FAIL  ${failure}`);
  for (const note of result.notes) console.log(`note  ${note}`);
  if (result.findingsFile) console.log(`\nfindings   ${result.findingsFile}`);

  const brief = qaBrief(result);
  if (flag(argv, 'agent')) {
    if (!brief) {
      console.log('agent      nothing failed, so no reviewer was started');
    } else {
      const started = await startQaAgent(
        config,
        name,
        option(argv, 'model'),
        brief,
      );
      if (started.briefed) {
        console.log(`agent      reviewing in ${started.session}:${started.window}`);
      } else {
        console.log(
          `agent      started in ${started.session}:${started.window}, but it is ${started.state === 'blocked' ? 'sitting on a dialog' : 'not listening yet'}`,
        );
        console.log(`           clear it, then hand it ${started.briefFile}`);
      }
      console.log(`           ${attachHint(started.session)}`);
    }
  }

  // A one line pointer, never the findings themselves: a long multi-line paste
  // into a TUI is how the prompt gets mangled. Resolved by window name only,
  // because the reviewer runs in the same directory as the worker and a
  // directory match would put the worker's message on the reviewer's screen.
  if (flag(argv, 'tell')) {
    if (!result.findingsFile) {
      console.log('tell       nothing to point at, no findings file was written');
    } else if (!runningAgents(config).includes(name)) {
      console.log(`tell       no agent named '${name}' is running`);
    } else {
      await sendToAgent(config, name, `QA run finished, read ${result.findingsFile}`);
      console.log(`tell       pointer sent to ${name}`);
    }
  }

  if (result.failures.length) process.exit(1);
}

/**
 * Plan-time helpers. Discovery turns the one link a ticket carries into the
 * whole flow, and the cache pins what it found next to the plan.
 */
async function commandDesign(argv: string[]) {
  const [subcommand, ...rest] = argv;
  const config = loadRepoConfig();

  if (subcommand === 'discover') {
    const fileKey = option(argv, 'file');
    const node = rest.find(
      (part) => !part.startsWith('--') && part !== fileKey,
    );
    if (!node || !fileKey) {
      throw new Error('usage: pw design discover <node-id> --file <figma-file-key>');
    }

    const flow = await discoverFlow(fileKey, normaliseNodeId(node));
    console.log(`page       ${flow.page ?? '(none)'}`);
    console.log(`section    ${flow.section?.name ?? '(none)'}`);
    console.log(`banner     ${flow.banner?.text ?? '(none)'}`);
    for (const member of flow.row) {
      const { width, height } = member.box;
      console.log(
        `  ${member.id.padEnd(14)} ${member.type.padEnd(14)} ${Math.round(width)}x${Math.round(height)}  ${member.name}`,
      );
    }
    return;
  }

  if (subcommand === 'cache') {
    const name = rest.find((part) => !part.startsWith('--'));
    if (!name) throw new Error('usage: pw design cache <name>');

    const record = readState(config.name).worktrees[name];
    const slug = name.replace(`${config.name}-`, '');
    const planFile =
      findSpec(record?.path ?? config.root, record?.taskId ?? null, slug) ??
      findSpec(config.root, record?.taskId ?? null, slug);
    if (!planFile) throw new Error(`no spec/<task>/plan.md for '${name}'`);

    const manifest = parseDesign(await Bun.file(planFile).text());
    if (!manifest?.fileKey) {
      throw new Error(`${planFile} has no Design section with a Figma file key`);
    }

    const written = await cacheReferenceImages(
      manifest.fileKey,
      manifest.rows.map((row) => row.nodeId),
      planFile,
    );
    for (const path of written) console.log(path);
    return;
  }

  throw new Error('usage: pw design <discover|cache> ...');
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
    case 'init':
      await runSetup(loadRepoConfig().root);
      break;
    case 'tile': {
      const config = loadRepoConfig();
      const tiled = tileWorktrees(
        config,
        argv.filter((part) => !part.startsWith('--')),
      );
      console.log(`tiled into ${tiled.session}:${tiled.window}`);
      console.log(attachHint(tiled.session));
      break;
    }
    case 'shell': {
      const name = argv[0];
      if (!name) throw new Error('usage: pw shell <name>');
      openShell(loadRepoConfig(), name);
      break;
    }
    case 'path': {
      const name = argv[0];
      if (!name) throw new Error('usage: pw path <name>');
      console.log(worktreePath(loadRepoConfig(), name));
      break;
    }
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
    case 'qa':
      await commandQa(argv);
      break;
    case 'design':
      await commandDesign(argv);
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
