import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import * as prompt from '@clack/prompts';

import { CONFIG_FILE, configPath, type RepoConfig } from './config';
import { tryRun } from './shell';

export interface DetectedDefaults {
  install: string;
  dev: string;
  baseBranch: string;
  taskPrefix: string | null;
  copy: string[];
  workspaceFile: string | null;
}

const LOCKFILES: [file: string, install: string, run: string][] = [
  ['bun.lock', 'bun install', 'bun'],
  ['bun.lockb', 'bun install', 'bun'],
  ['pnpm-lock.yaml', 'pnpm install', 'pnpm'],
  ['yarn.lock', 'yarn install', 'yarn'],
  ['package-lock.json', 'npm install', 'npm run'],
];

const DEV_SCRIPT_CANDIDATES = ['dev', 'start', 'serve'];

/** Files worth copying that a repo actually has, so the list is never noise. */
const COPY_CANDIDATES = [
  '.env',
  '.env.local',
  '.env.development',
  '.claude',
  'playwright/.auth',
  '.vscode',
];

function readPackageJson(root: string) {
  const path = join(root, 'package.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as {
      scripts?: Record<string, string>;
    };
  } catch {
    return null;
  }
}

/** `origin/main` on most repos, `origin/master` on older ones. Ask git. */
function detectBaseBranch(root: string) {
  const head = tryRun(
    'git',
    ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'],
    root,
  );
  if (head.ok && head.stdout.trim()) {
    return head.stdout.trim().replace('refs/remotes/', '');
  }
  const remote = tryRun('git', ['branch', '--remotes', '--list', 'origin/main'], root);
  return remote.ok && remote.stdout.trim() ? 'origin/main' : 'origin/master';
}

/** A ticket prefix is only worth guessing when the branches already use one. */
function detectTaskPrefix(root: string) {
  const branches = tryRun(
    'git',
    ['for-each-ref', '--format=%(refname:short)', '--count=50', 'refs/heads'],
    root,
  );
  if (!branches.ok) return null;

  const counts = new Map<string, number>();
  for (const branch of branches.stdout.split('\n')) {
    const match = branch.match(/(?:^|\/)([A-Z]{2,10})-\d+/);
    if (!match?.[1]) continue;
    counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
  }

  const ranked = [...counts.entries()].sort(([, a], [, b]) => b - a);
  return ranked[0]?.[0] ?? null;
}

export function detectDefaults(root: string): DetectedDefaults {
  const lockfile = LOCKFILES.find(([file]) => existsSync(join(root, file)));
  const [, install, runner] = lockfile ?? ['', 'bun install', 'bun'];

  const scripts = readPackageJson(root)?.scripts ?? {};
  const devScript = DEV_SCRIPT_CANDIDATES.find((name) => scripts[name]);

  const workspaceFile = existsSync(root)
    ? (readdirSync(root).find((entry) => entry.endsWith('.code-workspace')) ??
      null)
    : null;

  return {
    install,
    dev: devScript ? `${runner} ${devScript}` : '',
    baseBranch: detectBaseBranch(root),
    taskPrefix: detectTaskPrefix(root),
    copy: COPY_CANDIDATES.filter((entry) => existsSync(join(root, entry))),
    workspaceFile,
  };
}

function writeConfig(root: string, config: Partial<RepoConfig>) {
  // Only what the user actually chose, so the file stays readable and the
  // defaults keep moving with the tool.
  const body = JSON.stringify(config, null, 2);
  writeFileSync(configPath(root), `${body}\n`);
}

/**
 * Runs on the first interactive `pw` in a repo with no config, and on demand
 * via `pw init`. Everything is prefilled from what the repo already shows, so
 * the fast path is pressing enter four times.
 */
export async function runSetup(root: string): Promise<boolean> {
  const detected = detectDefaults(root);

  prompt.note(
    [
      `repo          ${root}`,
      `base branch   ${detected.baseBranch}`,
      `install       ${detected.install}`,
      `dev           ${detected.dev || '(none found)'}`,
      `task prefix   ${detected.taskPrefix ?? '(none)'}`,
      `copy          ${detected.copy.join(', ') || '(nothing gitignored found)'}`,
    ].join('\n'),
    'what pw found',
  );

  const start = await prompt.select({
    message: `No ${CONFIG_FILE} here yet`,
    options: [
      { value: 'setup', label: 'Set it up now', hint: 'four questions' },
      {
        value: 'accept',
        label: 'Use what pw found',
        hint: 'writes the values above',
      },
      {
        value: 'skip',
        label: 'Not now',
        hint: 'defaults apply, asked again next time',
      },
    ],
  });
  if (prompt.isCancel(start) || start === 'skip') return false;

  if (start === 'accept') {
    writeConfig(root, {
      taskPrefix: detected.taskPrefix,
      baseBranch: detected.baseBranch,
      copy: detected.copy,
      install: detected.install,
      dev: detected.dev || null,
      workspaceFile: detected.workspaceFile,
    });
    prompt.log.success(`wrote ${CONFIG_FILE}`);
    return true;
  }

  const dev = await prompt.text({
    message: 'Dev server command',
    placeholder: 'bun dev',
    initialValue: detected.dev,
    validate: (value) =>
      value?.trim() ? undefined : 'required, pw starts one per worktree',
  });
  if (prompt.isCancel(dev)) return false;

  const install = await prompt.text({
    message: 'Install command',
    initialValue: detected.install,
    validate: (value) => (value?.trim() ? undefined : 'required'),
  });
  if (prompt.isCancel(install)) return false;

  const baseBranch = await prompt.text({
    message: 'Branch new worktrees start from',
    initialValue: detected.baseBranch,
    validate: (value) => (value?.trim() ? undefined : 'required'),
  });
  if (prompt.isCancel(baseBranch)) return false;

  const taskPrefix = await prompt.text({
    message: 'Ticket prefix, empty for none',
    placeholder: 'EROS',
    initialValue: detected.taskPrefix ?? '',
  });
  if (prompt.isCancel(taskPrefix)) return false;

  // A terminal-only user has no workspace file to keep in sync, and adding
  // entries to one they never open is noise in their git status.
  const workspaceFile = detected.workspaceFile
    ? await prompt.confirm({
        message: `Add each worktree to ${detected.workspaceFile}?`,
        initialValue: true,
      })
    : false;
  if (prompt.isCancel(workspaceFile)) return false;

  const copy =
    detected.copy.length > 0
      ? await prompt.multiselect({
          message: 'Gitignored files to copy into every worktree',
          options: detected.copy.map((entry) => ({
            value: entry,
            label: entry,
          })),
          initialValues: detected.copy,
          required: false,
        })
      : [];
  if (prompt.isCancel(copy)) return false;

  writeConfig(root, {
    taskPrefix: taskPrefix.trim() || null,
    baseBranch: baseBranch.trim(),
    copy: copy as string[],
    install: install.trim(),
    dev: dev.trim(),
    workspaceFile: workspaceFile ? detected.workspaceFile : null,
  });
  prompt.log.success(`wrote ${CONFIG_FILE}`);
  return true;
}
