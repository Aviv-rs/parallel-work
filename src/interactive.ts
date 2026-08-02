import { spawn } from 'node:child_process';

import * as prompt from '@clack/prompts';

import {
  createWorktreeFlow,
  devLogPath,
  listWorktrees,
  removeWorktreeFlow,
  startDev,
  stopDev,
  type WorktreeStatus,
} from './actions';
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
    prompt.log.info(`code ${created.path}`);
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
  spawn('code', [worktree.path], { detached: true, stdio: 'ignore' }).unref();
  prompt.log.success(`opened ${worktree.path}`);
}

async function actionLogs(config: RepoConfig) {
  const worktree = await pickWorktree(config, 'Logs for which worktree');
  if (!worktree) return;
  prompt.log.info(devLogPath(config, worktree.name));
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
        { value: 'list', label: 'List worktrees' },
        { value: 'create', label: 'New worktree' },
        { value: 'dev', label: 'Dev server' },
        { value: 'open', label: 'Open in editor' },
        { value: 'logs', label: 'Show log path' },
        { value: 'remove', label: 'Remove worktree' },
        { value: 'commands', label: 'Command list' },
        { value: 'quit', label: 'Quit' },
      ],
    });

    if (prompt.isCancel(action) || action === 'quit') {
      prompt.outro('bye');
      return;
    }

    if (action === 'list') printList(config);
    if (action === 'create') await actionCreate(config);
    if (action === 'dev') await actionDev(config);
    if (action === 'open') await actionOpen(config);
    if (action === 'logs') await actionLogs(config);
    if (action === 'remove') await actionRemove(config);
    if (action === 'commands') prompt.note(USAGE, 'commands');
  }
}
