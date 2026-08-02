import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

import { run } from './shell';

export interface RepoConfig {
  root: string;
  name: string;
  taskPrefix: string | null;
  baseBranch: string;
  copy: string[];
  install: string | null;
  dev: string | null;
  workspaceFile: string | null;
}

const CONFIG_FILE = '.parallel-work.json';

const DEFAULT_COPY = ['.env', '.env.local', '.claude', 'playwright/.auth'];

function findWorkspaceFile(root: string) {
  const match = readdirSync(root).find((entry) =>
    entry.endsWith('.code-workspace'),
  );
  return match ?? null;
}

export function mainCheckoutRoot(startDirectory = process.cwd()) {
  const commonDir = run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], startDirectory);
  return commonDir.replace(/\/\.git\/?$/, '');
}

export function loadRepoConfig(startDirectory = process.cwd()): RepoConfig {
  const root = mainCheckoutRoot(startDirectory);
  const configPath = join(root, CONFIG_FILE);
  const fileConfig = existsSync(configPath)
    ? (JSON.parse(readFileSync(configPath, 'utf8')) as Partial<RepoConfig>)
    : {};

  return {
    root,
    name: fileConfig.name ?? basename(root),
    taskPrefix: fileConfig.taskPrefix ?? null,
    baseBranch: fileConfig.baseBranch ?? 'origin/master',
    copy: fileConfig.copy ?? DEFAULT_COPY,
    install: fileConfig.install ?? 'bun install',
    dev: fileConfig.dev ?? 'bun dev',
    workspaceFile: fileConfig.workspaceFile ?? findWorkspaceFile(root),
  };
}
