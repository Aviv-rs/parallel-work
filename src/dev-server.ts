import { spawn } from 'node:child_process';
import { existsSync, openSync, readFileSync, writeFileSync } from 'node:fs';

import { logPath, isProcessAlive } from './state';

const LOCAL_URL_PATTERN = /Local:\s+(https?:\/\/\S+)/;
const NETWORK_URL_PATTERN = /Network:\s+(https?:\/\/\S+)/;

const ANSI_PATTERN = new RegExp(String.raw`\x1b\[[0-9;]*m`, 'g');

export interface DevServerHandle {
  pid: number;
  logFile: string;
}

export interface DevUrls {
  localUrl: string | null;
  networkUrl: string | null;
  died: boolean;
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

  return { pid: child.pid ?? 0, logFile };
}

function readLog(logFile: string) {
  if (!existsSync(logFile)) return '';
  return readFileSync(logFile, 'utf8').replace(ANSI_PATTERN, '');
}

export function lastLogLine(logFile: string) {
  const lines = readLog(logFile).split('\n').filter(Boolean);
  return lines[lines.length - 1] ?? '';
}

export function logTail(logFile: string, count = 12) {
  return readLog(logFile).split('\n').filter(Boolean).slice(-count);
}

interface WaitOptions {
  pid: number;
  timeoutMs?: number;
  onProgress?: (line: string) => void;
}

export async function waitForDevUrl(
  logFile: string,
  { pid, timeoutMs = 120_000, onProgress }: WaitOptions,
): Promise<DevUrls> {
  const startedAt = Date.now();
  let lastReported = '';

  while (Date.now() - startedAt < timeoutMs) {
    const text = readLog(logFile);
    const localUrl = text.match(LOCAL_URL_PATTERN)?.[1];
    if (localUrl) {
      return {
        localUrl,
        networkUrl: text.match(NETWORK_URL_PATTERN)?.[1] ?? null,
        died: false,
      };
    }

    // The process is detached, so a crash shows up only as a dead pid.
    if (!isProcessAlive(pid)) {
      return { localUrl: null, networkUrl: null, died: true };
    }

    const line = lastLogLine(logFile);
    if (onProgress && line && line !== lastReported) {
      lastReported = line;
      onProgress(line);
    }

    await Bun.sleep(400);
  }

  return { localUrl: null, networkUrl: null, died: !isProcessAlive(pid) };
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
