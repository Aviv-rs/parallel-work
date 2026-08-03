import { spawn } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  openSync,
  readFileSync,
  statSync,
  truncateSync,
} from 'node:fs';

import { logPath, isProcessAlive } from './state';

const LOCAL_URL_PATTERN = /Local:\s+(https?:\/\/\S+)/;
const NETWORK_URL_PATTERN = /Network:\s+(https?:\/\/\S+)/;

const ANSI_PATTERN = new RegExp(String.raw`\x1b\[[0-9;]*m`, 'g');

export interface DevServerHandle {
  pid: number;
  logFile: string;
  runStartOffset: number;
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
  const runStartOffset = existsSync(logFile) ? statSync(logFile).size : 0;
  appendFileSync(
    logFile,
    `\n=== run ${new Date().toISOString()}  ${devCommand}  in ${worktreePath} ===\n`,
  );
  const logHandle = openSync(logFile, 'a');

  const child = spawn(devCommand, {
    cwd: worktreePath,
    shell: true,
    detached: true,
    stdio: ['ignore', logHandle, logHandle],
  });
  child.unref();

  return { pid: child.pid ?? 0, logFile, runStartOffset };
}

function readLog(logFile: string, fromOffset = 0) {
  if (!existsSync(logFile)) return '';
  const text = readFileSync(logFile, 'utf8');
  return (fromOffset ? text.slice(fromOffset) : text).replace(ANSI_PATTERN, '');
}

export function lastLogLine(logFile: string, fromOffset = 0) {
  const lines = readLog(logFile, fromOffset).split('\n').filter(Boolean);
  return lines[lines.length - 1] ?? '';
}

export function logTail(logFile: string, count = 12, fromOffset = 0) {
  return readLog(logFile, fromOffset).split('\n').filter(Boolean).slice(-count);
}

/**
 * Recovers the URL of a server that is still up but whose URL never reached the
 * registry, e.g. it printed after the startup wait gave up. The last match wins
 * because the log accumulates every run of that worktree.
 */
export function devUrlsFromLog(logFile: string): Omit<DevUrls, 'died'> {
  const text = readLog(logFile);
  const locals = [...text.matchAll(new RegExp(LOCAL_URL_PATTERN, 'g'))];
  const networks = [...text.matchAll(new RegExp(NETWORK_URL_PATTERN, 'g'))];
  return {
    localUrl: locals.at(-1)?.[1] ?? null,
    networkUrl: networks.at(-1)?.[1] ?? null,
  };
}

export function clearLog(logFile: string) {
  if (existsSync(logFile)) truncateSync(logFile, 0);
}

interface WaitOptions {
  pid: number;
  fromOffset?: number;
  timeoutMs?: number;
  onProgress?: (line: string) => void;
}

export async function waitForDevUrl(
  logFile: string,
  { pid, fromOffset = 0, timeoutMs = 120_000, onProgress }: WaitOptions,
): Promise<DevUrls> {
  const startedAt = Date.now();
  let lastReported = '';

  while (Date.now() - startedAt < timeoutMs) {
    const text = readLog(logFile, fromOffset);
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

    const line = lastLogLine(logFile, fromOffset);
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
