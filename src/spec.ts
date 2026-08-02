import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface SpecProgress {
  file: string;
  status: string | null;
  done: number;
  total: number;
}

const CHECKED = /^\s*[-*]\s+\[x\]/i;
const UNCHECKED = /^\s*[-*]\s+\[ \]/;
const STATUS = /^\s*\**\s*status\s*\**\s*:\s*\**\s*(.+?)\s*\**\s*$/i;

export function parseSpec(markdown: string) {
  const lines = markdown.split('\n');
  const status = lines.map((line) => line.match(STATUS)?.[1]).find(Boolean);

  // Manual tests are the human's to run, so counting them as agent progress
  // would report finished work as unfinished forever.
  const manualTestsHeading = lines.findIndex((line) =>
    /^##\s+manual tests/i.test(line),
  );
  const body =
    manualTestsHeading === -1 ? lines : lines.slice(0, manualTestsHeading);

  const done = body.filter((line) => CHECKED.test(line)).length;
  const total = done + body.filter((line) => UNCHECKED.test(line)).length;

  return { status: status ?? null, done, total };
}

export function findSpec(repoRoot: string, taskId: string | null, slug: string) {
  const specRoot = join(repoRoot, 'spec');
  if (!existsSync(specRoot)) return null;

  const wanted = (taskId ?? slug).toLowerCase();
  const match = readdirSync(specRoot).find((entry) =>
    entry.toLowerCase().startsWith(wanted),
  );
  if (!match) return null;

  const file = join(specRoot, match, 'plan.md');
  return existsSync(file) ? file : null;
}

export function readSpecProgress(
  repoRoot: string,
  taskId: string | null,
  slug: string,
): SpecProgress | null {
  const file = findSpec(repoRoot, taskId, slug);
  if (!file) return null;
  return { file, ...parseSpec(readFileSync(file, 'utf8')) };
}
