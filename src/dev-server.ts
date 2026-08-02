import { spawn } from 'node:child_process';
import { existsSync, openSync, readFileSync, writeFileSync } from 'node:fs';

import { logPath, isProcessAlive } from './state';

const LOCAL_URL_PATTERN = /Local:\s+(https?:\/\/\S+)/;
const NETWORK_URL_PATTERN = /Network:\s+(https?:\/\/\S+)/;

const ANSI_PATTERN = new RegExp(String.raw`\x1b\[[0-9;]*m`, 'g');

export interface DevServerHandle {
  pid: number;
  localUrl: string | null;
  networkUrl: string | null;
  logFile: string;
}

export function startDevServer(
  repoName: string,
  worktreeName: string,
  worktreePath: string,
  devCommand: string,
): DevServerHandle {
  const logFile = logPath(repoName, worktreeName);
  writeFileSync(logFile, '');
  const logHandle = openSync(logFile, 'a');

  const child = spawn(devCommand, {
    cwd: worktreePath,
    shell: true,
    detached: true,
    stdio: ['ignore', logHandle, logHandle],
  });
  child.unref();

  return { pid: child.pid ?? 0, localUrl: null, networkUrl: null, logFile };
}

export async function waitForDevUrl(logFile: string, timeoutMs = 120_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (existsSync(logFile)) {
      const text = readFileSync(logFile, 'utf8').replace(ANSI_PATTERN, '');
      const local = text.match(LOCAL_URL_PATTERN)?.[1];
      if (local) {
        return {
          localUrl: local,
          networkUrl: text.match(NETWORK_URL_PATTERN)?.[1] ?? null,
        };
      }
    }
    await Bun.sleep(500);
  }
  return { localUrl: null, networkUrl: null };
}

export function stopDevServer(pid: number | undefined) {
  if (!isProcessAlive(pid)) return false;
  try {
    process.kill(-pid!, 'SIGTERM');
  } catch {
    try {
      process.kill(pid!, 'SIGTERM');
    } catch {
      return false;
    }
  }
  return true;
}
