import * as prompt from '@clack/prompts';

import {
  EDITOR_PATH_HELP,
  clearDevLog,
  cleanStaleWorktrees,
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
  type TaskStatus,
  type WorktreeStatus,
} from './actions';
import {
  AGENT_BINARIES,
  agentStatus,
  isAgentCliInstalled,
  killAgent,
  qaWindowName,
  runningAgents,
  seeAgent,
  sendToAgent,
  startAgent,
  startQaAgent,
} from './agent';
import { attachHint, isBackendInstalled, sessionName } from './backend';
import { hasConfigFile, loadRepoConfig, type RepoConfig } from './config';
import { liveMenu } from './live-menu';
import { statusBoard } from './pixel-agent';
import { qaBrief, runQa, type QaReport } from './qa';
import {
  AGENT_CLIS,
  BACKENDS,
  readSettings,
  writeSettings,
  type AgentCli,
  type Backend,
} from './settings';
import { runSetup } from './setup';
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
      ...(task.pullRequest
        ? [
            `  pr     ${task.pullRequest.isDraft ? 'draft ' : ''}#${task.pullRequest.number}  ${task.pullRequest.url}`,
          ]
        : []),
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
    prompt.log.info(attachHint(sessionName(config.name)));
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

type QaLanes = NonNullable<Parameters<typeof runQa>[0]['lanes']>;

/**
 * Same follow-ups as the CLI flags, asked instead of passed. Both interrupt
 * somebody, so a clean run never gets here and "nothing" is the first option.
 */
async function qaFollowUp(
  config: RepoConfig,
  name: string,
  result: QaReport,
  brief: string,
) {
  const reviewerRunning = agentStatus(config, qaWindowName(name)).running;
  const workerRunning = runningAgents(config).includes(name);

  const choice = await prompt.select({
    message: `${result.failures.length} failed. Hand it to someone?`,
    options: [
      { value: 'nothing', label: 'Nothing, I will read the findings' },
      {
        value: 'reviewer',
        label: reviewerRunning
          ? 'Restart the reviewer with these findings'
          : 'Start a read-only reviewer',
        hint: `${qaWindowName(name)} window, failing rows only`,
      },
      {
        value: 'tell',
        label: 'Tell the worker',
        hint: workerRunning
          ? 'one line pointing at the findings file'
          : `no agent named '${name}' is running`,
      },
      { value: 'both', label: 'Reviewer and worker' },
    ],
  });
  if (prompt.isCancel(choice) || choice === 'nothing') return;

  if (choice === 'reviewer' || choice === 'both') {
    if (reviewerRunning) killAgent(config, qaWindowName(name));
    const spinner = prompt.spinner();
    spinner.start('starting reviewer');
    try {
      const started = await startQaAgent(config, name, null, brief);
      if (started.briefed) {
        spinner.stop(`reviewing in ${started.session}:${started.window}`);
      } else {
        spinner.stop(
          `started in ${started.session}:${started.window}, but it is ${started.state === 'blocked' ? 'sitting on a dialog' : 'not listening yet'}`,
        );
        prompt.log.warn(`clear it, then hand it ${started.briefFile}`);
      }
      prompt.log.info(attachHint(started.session));
    } catch (error) {
      spinner.stop('failed');
      prompt.log.error((error as Error).message);
    }
  }

  if (choice === 'tell' || choice === 'both') {
    if (!result.findingsFile) {
      prompt.log.warn('nothing to point at, no findings file was written');
    } else if (!workerRunning) {
      prompt.log.warn(`no agent named '${name}' is running`);
    } else {
      await sendToAgent(config, name, `QA run finished, read ${result.findingsFile}`);
      prompt.log.success(`pointer sent to ${name}`);
    }
  }
}

async function runQaHere(config: RepoConfig, name: string, lanes: QaLanes) {
  const spinner = prompt.spinner();
  spinner.start('checking');
  let result: QaReport;
  try {
    result = await runQa({
      config,
      name,
      lanes,
      report: (line) => spinner.message(line),
    });
  } catch (error) {
    spinner.stop('failed');
    prompt.log.error((error as Error).message);
    return;
  }
  spinner.stop(
    result.failures.length ? `${result.failures.length} failed` : 'all green',
  );

  for (const failure of result.failures) prompt.log.error(`FAIL  ${failure}`);
  for (const note of result.notes) prompt.log.message(`note  ${note}`);
  if (result.findingsFile) prompt.log.info(`findings  ${result.findingsFile}`);

  const brief = qaBrief(result);
  if (brief) await qaFollowUp(config, name, result, brief);
}

/**
 * The reviewer is resolved by window name only, never by directory: it runs in
 * the worker's own worktree, so a directory match would report the worker.
 */
async function actionQa(config: RepoConfig) {
  const worktree = await pickWorktree(config, 'QA which worktree');
  if (!worktree) return;

  for (;;) {
    const reviewer = agentStatus(config, qaWindowName(worktree.name));
    const reviewerState = !reviewer.running
      ? 'no reviewer'
      : reviewer.busy
        ? 'reviewer working'
        : 'reviewer waiting on you';

    const choice = await prompt.select({
      message: `${worktree.name}: ${reviewerState}`,
      options: [
        { value: 'both', label: 'Run the checks', hint: 'spec lane, visual lane if the plan pins a design' },
        { value: 'spec', label: 'Spec lane only', hint: 'checklist, changed files, tests, types, lint' },
        { value: 'visual', label: 'Visual lane only', hint: 'Figma nodes against screenshots' },
        ...(reviewer.running
          ? [
              { value: 'see', label: "Show the reviewer's screen" },
              { value: 'kill', label: 'Kill the reviewer' },
            ]
          : []),
        { value: 'back', label: 'Back' },
      ],
    });
    if (prompt.isCancel(choice) || choice === 'back') return;

    if (choice === 'see') {
      console.log(
        seeAgent(config, qaWindowName(worktree.name), 60) ?? '(nothing captured)',
      );
      continue;
    }
    if (choice === 'kill') {
      prompt.log.success(
        killAgent(config, qaWindowName(worktree.name)) ? 'killed' : 'not running',
      );
      continue;
    }
    await runQaHere(config, worktree.name, choice as QaLanes);
  }
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

const AGENT_CLI_LABELS: Record<AgentCli, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor CLI',
};

async function chooseAgentCli(current: AgentCli) {
  const picked = await prompt.select({
    message: 'Which agent does "Start an agent here" launch',
    options: AGENT_CLIS.map((cli) => ({
      value: cli,
      label: `${AGENT_CLI_LABELS[cli]}${cli === current ? ' (current)' : ''}`,
      hint: isAgentCliInstalled(cli)
        ? AGENT_BINARIES[cli]
        : `${AGENT_BINARIES[cli]} not on PATH`,
    })),
    initialValue: current,
  });
  if (prompt.isCancel(picked)) return;

  const next = writeSettings({ agentCli: picked as AgentCli });
  prompt.log.success(`agent CLI: ${AGENT_CLI_LABELS[next.agentCli]}`);
  if (!isAgentCliInstalled(next.agentCli)) {
    prompt.log.warn(
      `${AGENT_BINARIES[next.agentCli]} is not on PATH, so starting an agent will fail until it is`,
    );
  }
  if (next.agentCli !== 'claude') {
    prompt.log.info(
      'Only the Claude flags are ones pw depends on. If this CLI\'s flags differ, set agentCommands in ~/.parallel-work/settings.json to replace the launch command.',
    );
  }
}

const BACKEND_LABELS: Record<Backend, string> = {
  tmux: 'tmux',
  herdr: 'herdr',
};

async function chooseBackend(current: Backend) {
  const picked = await prompt.select({
    message: 'Which multiplexer runs agent sessions and windows',
    options: BACKENDS.map((backend) => ({
      value: backend,
      label: `${BACKEND_LABELS[backend]}${backend === current ? ' (current)' : ''}`,
      hint: isBackendInstalled(backend)
        ? undefined
        : `${BACKEND_LABELS[backend]} not on PATH`,
    })),
    initialValue: current,
  });
  if (prompt.isCancel(picked)) return;

  const next = writeSettings({ backend: picked as Backend });
  prompt.log.success(`backend: ${BACKEND_LABELS[next.backend]}`);
  if (!isBackendInstalled(next.backend)) {
    prompt.log.warn(
      `${BACKEND_LABELS[next.backend]} is not on PATH, so starting an agent will fail until it is`,
    );
  }
  if (next.backend === 'herdr') {
    prompt.log.info(
      '"Tile them all" splits panes in one tab. Grouping agents into one window is a no-op: herdr already shows every agent as its own clickable tab.',
    );
  }
}

async function actionSettings() {
  for (;;) {
    const settings = readSettings();
    const choice = await prompt.select({
      message: 'Settings',
      options: [
        {
          value: 'toggleLive',
          label: `Live status board: ${settings.liveStatus ? 'on' : 'off'}`,
          hint: settings.liveStatus
            ? 'the board and its pixel agent sit above the main menu'
            : 'status lives only under "Status of everything"',
        },
        {
          value: 'agentCli',
          label: `Agent CLI: ${AGENT_CLI_LABELS[settings.agentCli]}`,
          hint: AGENT_BINARIES[settings.agentCli],
        },
        {
          value: 'backend',
          label: `Backend: ${BACKEND_LABELS[settings.backend]}`,
          hint: 'tmux or herdr, runs every agent session and window',
        },
        { value: 'back', label: 'Back' },
      ],
    });
    if (prompt.isCancel(choice) || choice === 'back') return;

    if (choice === 'toggleLive') {
      const next = writeSettings({ liveStatus: !settings.liveStatus });
      prompt.log.success(`live status board ${next.liveStatus ? 'on' : 'off'}`);
    }
    if (choice === 'agentCli') await chooseAgentCli(settings.agentCli);
    if (choice === 'backend') await chooseBackend(settings.backend);
  }
}

async function actionTile(config: RepoConfig) {
  const worktrees = listWorktrees(config).filter((worktree) => worktree.exists);
  if (!worktrees.length) {
    prompt.log.warn('no worktrees to tile');
    return;
  }

  const picked = await prompt.multiselect({
    message: 'Tile which worktrees',
    options: worktrees.map((worktree) => ({
      value: worktree.name,
      label: worktree.name,
      hint: describe(worktree),
    })),
    initialValues: worktrees.map((worktree) => worktree.name),
    required: true,
  });
  if (prompt.isCancel(picked)) return;

  try {
    const tiled = tileWorktrees(config, picked as string[]);
    prompt.log.success(`tiled into ${tiled.session}:${tiled.window}`);
    prompt.log.info(attachHint(tiled.session));
  } catch (error) {
    prompt.log.error(error instanceof Error ? error.message : String(error));
  }
}

async function actionShell(config: RepoConfig) {
  const worktree = await pickWorktree(config, 'Shell in which worktree');
  if (!worktree) return;
  prompt.log.info(`${worktree.path}, exit the shell to come back to pw`);
  openShell(config, worktree.name);
}

/**
 * A worktree deleted outside pw (manual `rm`, Finder, a crashed flow) leaves
 * its registry entry behind — nothing else notices. This sweeps those out.
 */
async function actionClean(config: RepoConfig) {
  const stale = listWorktrees(config).filter((worktree) => !worktree.exists);
  if (!stale.length) {
    prompt.log.info('nothing stale, registry matches disk');
    return;
  }

  const confirmed = await prompt.confirm({
    message: `Drop ${stale.length} stale entr${stale.length === 1 ? 'y' : 'ies'}: ${stale
      .map((worktree) => worktree.name)
      .join(', ')}`,
    initialValue: true,
  });
  if (prompt.isCancel(confirmed) || !confirmed) return;

  const cleaned = cleanStaleWorktrees(config, report);
  prompt.log.success(`dropped ${cleaned.length}`);
}

/** Everything that acts on a worktree, one level down from the main menu. */
async function actionWorktrees(config: RepoConfig) {
  for (;;) {
    const choice = await prompt.select({
      message: 'Worktrees',
      options: [
        { value: 'create', label: 'New worktree' },
        { value: 'remove', label: 'Remove worktree' },
        { value: 'clean', label: 'Clean up stale entries', hint: 'folders deleted outside pw' },
        { value: 'list', label: 'List' },
        { value: 'tile', label: 'Tile them all', hint: 'one shell per worktree' },
        { value: 'shell', label: 'Open a shell here' },
        { value: 'dev', label: 'Dev server' },
        { value: 'logs', label: 'Dev server logs' },
        { value: 'open', label: 'Open in editor' },
        { value: 'back', label: 'Back' },
      ],
    });
    if (prompt.isCancel(choice) || choice === 'back') return;

    if (choice === 'list') printList(config);
    if (choice === 'tile') await actionTile(config);
    if (choice === 'shell') await actionShell(config);
    if (choice === 'create') await actionCreate(config);
    if (choice === 'dev') await actionDev(config);
    if (choice === 'logs') await actionLogs(config);
    if (choice === 'open') await actionOpen(config);
    if (choice === 'remove') await actionRemove(config);
    if (choice === 'clean') await actionClean(config);
  }
}

const MAIN_MENU = [
  { value: 'status', label: 'Status of everything' },
  { value: 'worktrees', label: 'Worktrees' },
  { value: 'agent', label: 'Agents' },
  { value: 'qa', label: 'QA' },
  { value: 'commands', label: 'Command list' },
  { value: 'settings', label: 'Settings' },
  { value: 'quit', label: 'Quit' },
] as const;

type MainAction = (typeof MAIN_MENU)[number]['value'];

/** The board already shows it, so the entry only earns its place without one. */
function mainMenuFor(liveStatus: boolean) {
  return MAIN_MENU.filter(
    (option) => option.value !== 'status' || !liveStatus,
  ).map((option) => ({ ...option }));
}

async function chooseAction(config: RepoConfig): Promise<MainAction | null> {
  const { liveStatus } = readSettings();
  const options = mainMenuFor(liveStatus);

  if (!liveStatus) {
    const picked = await prompt.select({ message: 'What now', options });
    return prompt.isCancel(picked) ? null : (picked as MainAction);
  }

  return liveMenu<MainAction, TaskStatus[]>({
    message: 'What now',
    options,
    data: () => taskStatuses(config),
    board: (tasks, tick) =>
      statusBoard(tasks, tick, (process.stdout.columns ?? 80) - 1),
  });
}

export async function runInteractive(initialConfig: RepoConfig) {
  if (!process.stdin.isTTY) {
    throw new Error('pw -i needs a terminal, run it without piping input');
  }
  let config = initialConfig;
  prompt.intro(`parallel-work  ${config.name}  (${config.root})`);

  // First run in this repo: the dev command is the one thing pw cannot guess
  // safely, and a wrong one fails much later, when a worktree will not start.
  if (!hasConfigFile(config.root) && (await runSetup(config.root))) {
    config = loadRepoConfig(config.root);
  }

  for (;;) {
    const action = await chooseAction(config);

    if (action === null || action === 'quit') {
      prompt.outro('bye');
      return;
    }

    if (action === 'status') printStatus(config);
    if (action === 'worktrees') await actionWorktrees(config);
    if (action === 'agent') await actionAgent(config);
    if (action === 'qa') await actionQa(config);
    if (action === 'commands') prompt.note(USAGE, 'commands');
    if (action === 'settings') await actionSettings();
  }
}
