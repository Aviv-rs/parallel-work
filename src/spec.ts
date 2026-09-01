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

export type DesignState =
  | { kind: 'default' }
  | { kind: 'hover'; selector: string }
  | { kind: 'focus'; selector: string }
  | { kind: 'setup'; module: string }
  | { kind: 'reference' };

export interface DesignRow {
  nodeId: string;
  url: string | null;
  component: string | null;
  viewport: string | null;
  state: DesignState;
}

export interface AssetRow {
  /** Null is a planning bug: with no node there is nothing to re-export against. */
  nodeId: string | null;
  file: string;
}

export interface Viewport {
  width: number;
  height: number;
}

export interface DesignManifest {
  fileKey: string | null;
  rows: DesignRow[];
  assets: AssetRow[];
  /** Named sizes read off the prose, e.g. "Mobile 390x844 unless a row says otherwise." */
  viewports: Record<string, Viewport>;
}

const DESIGN_HEADING = /^##\s+design\s*$/i;
const ASSETS_HEADING = /^#{3,6}\s+assets\s*$/i;
const TOP_HEADING = /^#{1,2}\s/;
const FIGMA_FILE = /^\s*figma\s+file\s*:\s*(\S+)\s*$/i;
const VIEWPORT_LINE = /(?:^|\s)([A-Za-z][\w-]*)\s+(\d{2,5})\s*[x×]\s*(\d{2,5})\b/g;
const TABLE_ROW = /^\s*\|(.+)\|\s*$/;
const TABLE_DIVIDER = /^[\s|:-]+$/;
const NODE_ID = /^[A-Za-z0-9]+[:-]\d+$/;

function sectionLines(lines: string[], from: number) {
  const body: string[] = [];
  for (let index = from + 1; index < lines.length; index += 1) {
    if (TOP_HEADING.test(lines[index]!)) break;
    body.push(lines[index]!);
  }
  return body;
}

function cells(line: string) {
  return line
    .replace(TABLE_ROW, '$1')
    .split('|')
    .map((cell) => cell.trim());
}

/** Empty cells are common in a manifest, and mean "not applicable to this row". */
function cell(values: string[], index: number) {
  const value = values[index]?.trim();
  return value ? value : null;
}

/**
 * A node id is written `4263:32210` in the API and `4263-32210` in a Figma url.
 * Both appear in plans, so both are accepted and normalised to the API form,
 * which is what every endpoint wants.
 */
export function normaliseNodeId(value: string) {
  return value.trim().replace('-', ':');
}

export function parseState(value: string | null): DesignState {
  const raw = (value ?? 'default').trim();
  const [kind, ...rest] = raw.split(':');
  const argument = rest.join(':').trim();

  if (/^reference$/i.test(raw)) return { kind: 'reference' };
  if (/^hover$/i.test(kind ?? '') && argument) {
    return { kind: 'hover', selector: argument };
  }
  if (/^focus$/i.test(kind ?? '') && argument) {
    return { kind: 'focus', selector: argument };
  }
  if (/^setup$/i.test(kind ?? '') && argument) {
    return { kind: 'setup', module: argument };
  }
  return { kind: 'default' };
}

/**
 * Reads the pinned design manifest out of `plan.md`. Returns null when the plan
 * has no `## Design` section, which is how qa decides to run the spec lane
 * alone: a schema-only ticket must never wait on Figma.
 */
export function parseDesign(markdown: string): DesignManifest | null {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => DESIGN_HEADING.test(line));
  if (start === -1) return null;

  const body = sectionLines(lines, start);
  const manifest: DesignManifest = {
    fileKey: null,
    rows: [],
    assets: [],
    viewports: {},
  };

  let inAssets = false;
  for (const line of body) {
    if (ASSETS_HEADING.test(line)) {
      inAssets = true;
      continue;
    }

    const fileKey = line.match(FIGMA_FILE)?.[1];
    if (fileKey) {
      manifest.fileKey = fileKey;
      continue;
    }

    if (!TABLE_ROW.test(line)) {
      // One prose line can name several sizes: "Mobile 390x844. Desktop 1440x900."
      for (const viewport of line.matchAll(VIEWPORT_LINE)) {
        manifest.viewports[viewport[1]!.toLowerCase()] = {
          width: Number(viewport[2]),
          height: Number(viewport[3]),
        };
      }
      continue;
    }

    const values = cells(line);
    const first = values[0] ?? '';
    if (TABLE_DIVIDER.test(line) || /^node$/i.test(first)) continue;

    if (inAssets) {
      const file = cell(values, 1);
      if (!file) continue;
      manifest.assets.push({
        nodeId: NODE_ID.test(first) ? normaliseNodeId(first) : null,
        file,
      });
      continue;
    }

    if (!NODE_ID.test(first)) continue;
    manifest.rows.push({
      nodeId: normaliseNodeId(first),
      url: cell(values, 1),
      component: cell(values, 2),
      viewport: cell(values, 3)?.toLowerCase() ?? null,
      state: parseState(cell(values, 4)),
    });
  }

  return manifest;
}

/** The size a row is shot at: its own named viewport, or the manifest default. */
export function viewportFor(
  manifest: DesignManifest,
  row: DesignRow,
): Viewport | null {
  const named = row.viewport ? manifest.viewports[row.viewport] : null;
  if (named) return named;
  const only = Object.values(manifest.viewports);
  return only.length === 1 ? only[0]! : null;
}
