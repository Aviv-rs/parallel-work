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
const HEADING = /^#{1,6}\s/;
const MANUAL_TESTS_HEADING = /^#{1,6}\s+manual tests/i;

/**
 * Manual tests are the human's to run, so counting them as agent progress
 * would report finished work as unfinished forever. A plan that covers several
 * tickets has several such sections, so each one is skipped up to the next
 * heading rather than truncating the file at the first one, which used to hide
 * every checklist below it.
 */
function agentOwnedLines(lines: string[]) {
  let inManualTests = false;
  return lines.filter((line) => {
    if (MANUAL_TESTS_HEADING.test(line)) {
      inManualTests = true;
      return false;
    }
    if (inManualTests && HEADING.test(line)) inManualTests = false;
    return !inManualTests;
  });
}

export function parseSpec(markdown: string) {
  const lines = markdown.split('\n');
  const status = lines.map((line) => line.match(STATUS)?.[1]).find(Boolean);
  const body = agentOwnedLines(lines);

  const done = body.filter((line) => CHECKED.test(line)).length;
  const total = done + body.filter((line) => UNCHECKED.test(line)).length;

  return { status: status ?? null, done, total };
}

const LEADING_TASK_ID = /^[a-z]+-\d+(?:-\d+)*-/i;

/** `EROS-787-792-job-opening-qa` -> `job-opening-qa`. */
export function descriptiveTail(name: string) {
  return name.toLowerCase().replace(LEADING_TASK_ID, '');
}

/**
 * A branch may chain several ticket ids (`EROS-787-792-...`) while its plan
 * folder is named after the parent story (`EROS-747-...`), so an id match alone
 * reports "no spec" for work that plainly has one. The descriptive tail is what
 * the two reliably share.
 */
export function findSpec(repoRoot: string, taskId: string | null, slug: string) {
  const specRoot = join(repoRoot, 'spec');
  if (!existsSync(specRoot)) return null;

  const entries = readdirSync(specRoot);
  const wanted = (taskId ?? slug).toLowerCase();
  const tail = descriptiveTail(slug);

  const match =
    entries.find((entry) => entry.toLowerCase().startsWith(wanted)) ??
    (tail ? entries.find((entry) => descriptiveTail(entry) === tail) : undefined);
  if (!match) return null;

  const file = join(specRoot, match, 'plan.md');
  return existsSync(file) ? file : null;
}

/**
 * Roots are tried in order and the first plan found wins. Callers pass the
 * worktree before the main checkout: the agent ticks its checklist inside its
 * own worktree, so reading the main copy reports zero progress forever.
 */
export function readSpecProgress(
  roots: string | string[],
  taskId: string | null,
  slug: string,
): SpecProgress | null {
  for (const root of Array.isArray(roots) ? roots : [roots]) {
    if (!root) continue;
    const file = findSpec(root, taskId, slug);
    if (file) return { file, ...parseSpec(readFileSync(file, 'utf8')) };
  }
  return null;
}
