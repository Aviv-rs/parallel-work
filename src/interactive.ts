import * as prompt from '@clack/prompts';

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
  type WorktreeStatus,
} from './actions';
import {
  agentStatus,
  killAgent,
  seeAgent,
  sendToAgent,
  startAgent,
} from './agent';
import type { RepoConfig } from './config';
import { BRANCH_TYPES, type BranchType } from './slug';
import { USAGE } from './usage';

function describe(worktree: WorktreeStatus) {
  const dev = worktree.devRunning
    ? (worktree.devUrl ?? 'dev running')
    : 'dev stopped';
  const git = `${worktree.uncommitted} uncommitted, ${worktree.unmerged} unmerged`;
  const missing = worktree.exists ? '' : ' [folder missing] ';
  return `${dev}  |  ${git}${missing}`;
}

function report(line: string) {
  prompt.log.message(line);
}

async function pickWorktree(config: RepoConfig, title: string) {
  const worktrees = listWorktrees(config);
  if (!worktrees.length) {
    prompt.log.warn('no worktrees yet');
    return null;
  }
  const picked = await prompt.select({
    message: title,
    options: worktrees.map((worktree) => ({
      value: worktree,
      label: worktree.name,
      hint: describe(worktree),
    })),
  });
  return prompt.isCancel(picked) ? null : (picked as WorktreeStatus);
}

async function actionCreate(config: RepoConfig) {
  const slug = await prompt.text({
    message: 'Slug',
    placeholder: config.taskPrefix
      ? `${config.taskPrefix}-701-short-title`
      : 'short-title',
    validate: (value) => (value?.trim() ? undefined : 'required'),
  });
  if (prompt.isCancel(slug)) return;

  const branchType = await prompt.select({
    message: 'Branch type',
    options: BRANCH_TYPES.map((type) => ({ value: type, label: type })),
    initialValue: 'feature' as BranchType,
  });
  if (prompt.isCancel(branchType)) return;

  const extras = await prompt.multiselect({
    message: 'Also do',
    options: [
      { value: 'install', label: `run ${config.install ?? 'install'}` },
      { value: 'dev', label: `start ${config.dev ?? 'dev server'}` },
    ],
    initialValues: ['install', 'dev'],
    required: false,
  });
  if (prompt.isCancel(extras)) return;

  const spinner = prompt.spinner();
  spinner.start('working');
  try {
    const created = await createWorktreeFlow(
      config,
      {
        slug: slug as string,
        branchType: branchType as BranchType,
        install: (extras as string[]).includes('install'),
        dev: (extras as string[]).includes('dev'),
      },
      (line) => spinner.message(line),
    );
    spinner.stop(`created ${created.name}`);
    prompt.log.info(`${resolveEditor(config) ?? 'open'} ${created.path}`);
  } catch (error) {
    spinner.stop('failed');
    prompt.log.error((error as Error).message);
  }
}

async function actionRemove(config: RepoConfig) {
  const worktree = await pickWorktree(config, 'Remove which worktree');
  if (!worktree) return;

  const risky = worktree.uncommitted > 0 || worktree.unmerged > 0;
  if (risky) {
    prompt.log.warn(
      `${worktree.name} has ${worktree.uncommitted} uncommitted changes and ${worktree.unmerged} unmerged commits`,
    );
  }
  const confirmed = await prompt.confirm({
    message: risky ? 'Force remove anyway' : `Remove ${worktree.name}`,
    initialValue: false,
  });
  if (prompt.isCancel(confirmed) || !confirmed) return;

  try {
    removeWorktreeFlow(config, worktree.name, risky, report);
  } catch (error) {
    prompt.log.error((error as Error).message);
  }
}

async function actionDev(config: RepoConfig) {
  const worktree = await pickWorktree(config, 'Dev server for which worktree');
  if (!worktree) return;

  if (worktree.devRunning) {
    const choice = await prompt.select({
      message: `${worktree.name} is running at ${worktree.devUrl ?? 'unknown url'}`,
      options: [
        { value: 'stop', label: 'stop it' },
        { value: 'restart', label: 'restart it' },
        { value: 'nothing', label: 'leave it' },
      ],
    });
    if (prompt.isCancel(choice) || choice === 'nothing') return;
    stopDev(config, worktree.name);
    if (choice === 'stop') {
      prompt.log.success('stopped');
      return;
    }
  }

  const spinner = prompt.spinner();
  spinner.start('starting dev server');
  const { localUrl } = await startDev(
    config,
    worktree.name,
    worktree.path,
    (line) => spinner.message(line),
  );
  spinner.stop(localUrl ? `up at ${localUrl}` : 'no URL captured');
}

async function actionOpen(config: RepoConfig) {
  const worktree = await pickWorktree(config, 'Open which worktree');
  if (!worktree) return;

  const editor = openInEditor(config, worktree.path);
  if (!editor) {
    prompt.log.error(EDITOR_PATH_HELP);
    return;
  }
  prompt.log.success(`${editor} ${worktree.path}`);
}

async function actionLogs(config: RepoConfig) {
  const worktree = await pickWorktree(config, 'Logs for which worktree');
  if (!worktree) return;

  for (;;) {
    const choice = await prompt.select({
      message: `Logs for ${worktree.name}`,
      options: [
        { value: '50', label: 'Last 50 lines' },
        { value: '200', label: 'Last 200 lines' },
        { value: 'follow', label: 'Follow live', hint: 'Ctrl-C to come back' },
        { value: 'path', label: 'Show the file path' },
        { value: 'clear', label: 'Clear history' },
        { value: 'back', label: 'Back' },
      ],
    });
    if (prompt.isCancel(choice) || choice === 'back') return;

    if (choice === 'path') {
      prompt.log.info(devLogPath(config, worktree.name));
      continue;
    }

    if (choice === 'clear') {
      clearDevLog(config, worktree.name);
      prompt.log.success('log cleared');
      continue;
    }

    if (choice === 'follow') {
      prompt.log.info('following, Ctrl-C to stop');
      await followDevLog(config, worktree.name);
      continue;
    }

    const lines = readDevLog(config, worktree.name, Number(choice));
    if (!lines.length) {
      prompt.log.warn('log is empty');
      continue;
    }
    console.log(lines.join('\n'));
  }
}

function printStatus(config: RepoConfig) {
  const tasks = taskStatuses(config);
  if (!tasks.length) {
    prompt.log.warn('no worktrees yet');
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
    const body = [
      task.name,
      `  agent  ${agent}`,
      `  spec   ${spec}`,
      `  dev    ${task.devRunning ? (task.devUrl ?? 'running') : 'stopped'}`,
      `  git    ${task.uncommitted} uncommitted, ${task.unmerged} unmerged`,
    ].join('\n');

    if (task.needsYou) prompt.log.warn(body);
    else prompt.log.info(body);
  }
}

async function actionAgent(config: RepoConfig) {
  const worktree = await pickWorktree(config, 'Agent for which worktree');
  if (!worktree) return;

  const status = agentStatus(config, worktree.name, worktree.path);
  const choice = await prompt.select({
    message: status.running
      ? `${worktree.name}: ${status.busy ? 'working' : 'waiting on you'}`
      : `${worktree.name}: no agent running`,
    options: status.running
      ? [
          { value: 'see', label: 'Show its screen' },
          { value: 'send', label: 'Send it a message' },
          { value: 'attach', label: 'How to attach' },
          { value: 'kill', label: 'Kill it' },
          { value: 'back', label: 'Back' },
        ]
      : [
          { value: 'start', label: 'Start an agent here' },
          { value: 'back', label: 'Back' },
        ],
  });
  if (prompt.isCancel(choice) || choice === 'back') return;

  if (choice === 'start') {
    const started = startAgent(config, worktree.name, null);
    prompt.log.success(`started, attach with: ${started.attachWith}`);
    return;
  }
  if (choice === 'see') {
    console.log(seeAgent(config, worktree.name, 60) ?? '(nothing captured)');
    return;
  }
  if (choice === 'attach') {
    prompt.log.info(`tmux attach -t pw-${config.name}`);
    return;
  }
  if (choice === 'kill') {
    prompt.log.success(killAgent(config, worktree.name) ? 'killed' : 'not running');
    return;
  }

  const message = await prompt.text({
    message: 'What to send',
    validate: (value) => (value?.trim() ? undefined : 'required'),
  });
  if (prompt.isCancel(message)) return;
  await sendToAgent(config, worktree.name, message as string);
  prompt.log.success('sent');
}

function printList(config: RepoConfig) {
  const worktrees = listWorktrees(config);
  if (!worktrees.length) {
    prompt.log.warn('no worktrees yet');
    return;
  }
  for (const worktree of worktrees) {
    prompt.log.info(
      `${worktree.name}\n  ${worktree.branch}\n  ${describe(worktree)}`,
    );
  }
}

export async function runInteractive(config: RepoConfig) {
  if (!process.stdin.isTTY) {
    throw new Error('pw -i needs a terminal, run it without piping input');
  }
  prompt.intro(`parallel-work  ${config.name}  (${config.root})`);

  for (;;) {
    const action = await prompt.select({
      message: 'What now',
      options: [
        { value: 'status', label: 'Status of everything' },
        { value: 'list', label: 'List worktrees' },
        { value: 'create', label: 'New worktree' },
        { value: 'agent', label: 'Agents' },
        { value: 'dev', label: 'Dev server' },
        { value: 'open', label: 'Open in editor' },
        { value: 'logs', label: 'Dev server logs' },
        { value: 'remove', label: 'Remove worktree' },
        { value: 'commands', label: 'Command list' },
        { value: 'quit', label: 'Quit' },
      ],
    });

    if (prompt.isCancel(action) || action === 'quit') {
      prompt.outro('bye');
      return;
    }

    if (action === 'status') printStatus(config);
    if (action === 'list') printList(config);
    if (action === 'agent') await actionAgent(config);
    if (action === 'create') await actionCreate(config);
    if (action === 'dev') await actionDev(config);
    if (action === 'open') await actionOpen(config);
    if (action === 'logs') await actionLogs(config);
    if (action === 'remove') await actionRemove(config);
    if (action === 'commands') prompt.note(USAGE, 'commands');
  }
}
