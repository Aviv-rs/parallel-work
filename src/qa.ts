import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { startDev, type Report } from './actions';
import { devUrlsFromLog } from './dev-server';
import type { RepoConfig } from './config';
import {
  fetchNodes,
  hasFigmaKey,
  renderNodes,
  FIGMA_KEY_HELP,
  type FigmaNode,
} from './figma';
import {
  decode,
  diffImages,
  encode,
  frameChrome,
  prepareApp,
  prepareDesign,
} from './image-diff';
import { BouncedError, capture, closeCaptureBrowser, DEVICE_SCALE } from './screenshot';
import {
  checklistItems,
  findSpec,
  parseDesign,
  parseSpec,
  viewportFor,
  type ChecklistItem,
  type DesignManifest,
  type DesignRow,
  type Viewport,
} from './spec';
import { logPath, readState, STATE_DIR } from './state';
import { tryRun } from './shell';

/** Over this share of moved pixels a layout is worth a human look. */
export const LAYOUT_THRESHOLD = 0.02;
/** Assets are the same artwork or they are not, so the bar is far tighter. */
export const ASSET_THRESHOLD = 0.005;
/** Anything above this between a fresh render and the cached copy is drift. */
export const DRIFT_THRESHOLD = 0.002;

export type RowVerdict =
  | { kind: 'diff' }
  | { kind: 'reference'; reason: string }
  | { kind: 'refused'; reason: string };

/**
 * Figma's own `type` decides this, never a guess from the name. A COMPONENT_SET
 * is a variants board with no url behind it, and a frame whose size is not the
 * row's viewport is a banner or a container holding many screens side by side.
 * Diffing either against a route produces a number nobody can act on.
 */
export function classifyRow(
  row: DesignRow,
  node: FigmaNode | undefined,
  viewport: Viewport | null,
): RowVerdict {
  if (row.state.kind === 'reference') {
    return { kind: 'reference', reason: 'marked reference' };
  }
  if (!node) return { kind: 'refused', reason: 'node could not be fetched' };
  if (node.type !== 'FRAME') {
    return {
      kind: 'refused',
      reason: `node is a ${node.type}, not a FRAME. Mark the row reference.`,
    };
  }
  if (!row.url) {
    return { kind: 'refused', reason: 'diffable row has no url' };
  }
  if (!viewport) {
    return {
      kind: 'refused',
      reason: `viewport '${row.viewport ?? 'none'}' has no size in the manifest`,
    };
  }

  const box = node.absoluteBoundingBox;
  if (!box) return { kind: 'refused', reason: 'node has no geometry' };

  const width = Math.round(box.width);
  const height = Math.round(box.height);
  if (width !== viewport.width || height !== viewport.height) {
    return {
      kind: 'refused',
      reason: `node is ${width}x${height}, not the ${row.viewport ?? 'row'} viewport ${viewport.width}x${viewport.height}. Mark the row reference.`,
    };
  }
  return { kind: 'diff' };
}

export interface CheckResult {
  name: string;
  command: string;
  ok: boolean;
  output: string;
}

export interface RowResult {
  nodeId: string;
  url: string | null;
  component: string | null;
  state: string;
  status: 'diffed' | 'reference' | 'refused' | 'error';
  ratio: number | null;
  sizeMismatch: string | null;
  message: string | null;
  driftRatio: number | null;
  images: { design: string; app: string; diff: string } | null;
}

export interface AssetResult {
  file: string;
  nodeId: string | null;
  ok: boolean;
  message: string;
}

export interface QaReport {
  task: string;
  worktree: string;
  planFile: string | null;
  status: string | null;
  checklist: ChecklistItem[];
  changedFiles: string[];
  checks: CheckResult[];
  rows: RowResult[];
  assets: AssetResult[];
  /** Everything that fails the run. Empty means exit 0. */
  failures: string[];
  /** Reported, never fatal: layout diffs, design drift, skipped lanes. */
  notes: string[];
  findingsFile: string | null;
}

function describeState(row: DesignRow) {
  const state = row.state;
  if (state.kind === 'hover') return `hover:${state.selector}`;
  if (state.kind === 'focus') return `focus:${state.selector}`;
  if (state.kind === 'setup') return `setup:${state.module}`;
  return state.kind;
}

/**
 * Committed work plus whatever is still in the tree, because an agent that has
 * not committed yet has still done the work the checklist claims.
 */
export function changedFiles(worktreePath: string, baseBranch: string) {
  const committed = tryRun(
    'git',
    ['diff', '--name-only', `${baseBranch}...HEAD`],
    worktreePath,
  );
  // -uall, or a new directory collapses to one entry and the report says
  // "src/" where the agent added nine files.
  const working = tryRun('git', ['status', '--porcelain', '-uall'], worktreePath);

  const files = new Set<string>();
  for (const line of committed.stdout.split('\n')) {
    if (line.trim()) files.add(line.trim());
  }
  for (const line of working.stdout.split('\n')) {
    const file = line.slice(3).trim();
    if (file) files.add(file);
  }
  return [...files].sort();
}

function runCheck(
  name: string,
  command: string | null,
  cwd: string,
): CheckResult | null {
  if (!command) return null;
  const result = spawnSync(command, { cwd, shell: true, encoding: 'utf8' });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  return { name, command, ok: result.status === 0, output };
}

function qaImageDir(repoName: string, task: string) {
  const directory = join(STATE_DIR, 'qa', repoName, task);
  mkdirSync(directory, { recursive: true });
  return directory;
}

/** `4263:32210` -> `4263-32210`, one cached file per manifest row. */
export function assetFileName(nodeId: string) {
  return `${nodeId.replace(':', '-')}.png`;
}

export function cachedReferencePath(planFile: string, nodeId: string) {
  return join(dirname(planFile), 'assets', assetFileName(nodeId));
}

/**
 * The scale a repo asset was exported at. Figma renders whole multiples only,
 * so a file that is not one is either the wrong artwork or the wrong node, and
 * guessing a resample here would hide exactly the mistake this check exists for.
 */
export function assetScale(nodeWidth: number, fileWidth: number) {
  const scale = fileWidth / nodeWidth;
  const rounded = Math.round(scale);
  if (rounded < 1 || rounded > 4) return null;
  return Math.abs(scale - rounded) < 0.02 ? rounded : null;
}

async function checkAssets(
  fileKey: string,
  manifest: DesignManifest,
  worktreePath: string,
): Promise<AssetResult[]> {
  const results: AssetResult[] = [];
  const withNode = manifest.assets.filter((asset) => asset.nodeId);
  const nodes = withNode.length
    ? await fetchNodes(
        fileKey,
        withNode.map((asset) => asset.nodeId!),
      )
    : {};

  for (const asset of manifest.assets) {
    const path = join(worktreePath, asset.file);
    if (!existsSync(path)) {
      results.push({
        ...asset,
        ok: false,
        message: 'file is not in the worktree',
      });
      continue;
    }
    if (!asset.nodeId) {
      results.push({
        ...asset,
        ok: false,
        message:
          'asset row has no node id, so there is nothing to re-export against',
      });
      continue;
    }

    const node = nodes[asset.nodeId];
    const box = node?.absoluteBoundingBox;
    if (!box) {
      results.push({
        ...asset,
        ok: false,
        message: `node ${asset.nodeId} could not be fetched`,
      });
      continue;
    }

    const onDisk = decode(readFileSync(path));
    const scale = assetScale(box.width, onDisk.width);
    if (!scale) {
      results.push({
        ...asset,
        ok: false,
        message: `file is ${onDisk.width}x${onDisk.height}, node is ${Math.round(box.width)}x${Math.round(box.height)}: not a whole-number export of it`,
      });
      continue;
    }

    const rendered = (await renderNodes(fileKey, [asset.nodeId], scale))[
      asset.nodeId
    ];
    if (!rendered) {
      results.push({
        ...asset,
        ok: false,
        message: `node ${asset.nodeId} did not render`,
      });
      continue;
    }

    const diff = diffImages(decode(rendered), onDisk);
    const ok = !diff.sizeMismatch && diff.ratio <= ASSET_THRESHOLD;
    results.push({
      ...asset,
      ok,
      message: ok
        ? `matches a fresh ${scale}x export of ${asset.nodeId}`
        : `does not match a fresh ${scale}x export of ${asset.nodeId}: ${diff.sizeMismatch ?? `${(diff.ratio * 100).toFixed(2)}% of pixels differ`}`,
    });
  }

  return results;
}

/**
 * A fresh render against the copy cached beside the plan. A difference is not a
 * bug in the app: it means the design moved after the plan was written, which
 * nothing else in the workflow notices.
 */
function driftRatio(planFile: string | null, nodeId: string, fresh: Buffer) {
  if (!planFile) return null;
  const cached = cachedReferencePath(planFile, nodeId);
  if (!existsSync(cached)) return null;
  const diff = diffImages(decode(fresh), decode(readFileSync(cached)));
  return diff.sizeMismatch ? 1 : diff.ratio;
}

/**
 * Renders every pinned node at scale 1 beside the plan. These are committed
 * with it so the human reviewing the plan and the agent implementing it look at
 * the same picture, and because the S3 urls from /v1/images die within the hour.
 *
 * They are never the diff baseline: a cached copy of the wrong node would
 * quietly validate the wrong thing.
 */
export async function cacheReferenceImages(
  fileKey: string,
  nodeIds: string[],
  planFile: string,
) {
  const directory = join(dirname(planFile), 'assets');
  mkdirSync(directory, { recursive: true });

  const rendered = await renderNodes(fileKey, nodeIds, 1);
  const written: string[] = [];
  for (const [nodeId, png] of Object.entries(rendered)) {
    const path = join(directory, assetFileName(nodeId));
    writeFileSync(path, png);
    written.push(path);
  }
  return written;
}

export interface QaOptions {
  config: RepoConfig;
  name: string;
  lanes?: 'both' | 'spec' | 'visual';
  report?: Report;
}

/**
 * The recorded URL outlives the server that printed it: a restart can land on
 * another port while the state still names the old one, and a stale URL turns
 * every row into a connection refusal.
 */
async function isUrlAlive(url: string) {
  try {
    await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(3_000) });
    return true;
  } catch {
    return false;
  }
}

async function devBaseUrl(
  config: RepoConfig,
  name: string,
  worktreePath: string,
  report: Report,
) {
  const record = readState(config.name).worktrees[name];
  const logged = devUrlsFromLog(logPath(config.name, name)).localUrl;
  for (const url of [record?.devUrl, logged]) {
    if (url && (await isUrlAlive(url))) return url;
  }

  report('dev        not running, starting it for the visual lane');
  const started = await startDev(config, name, worktreePath, report);
  return started.localUrl;
}

async function visualLane(
  options: QaOptions,
  worktreePath: string,
  planFile: string,
  manifest: DesignManifest,
  qaReport: QaReport,
  report: Report,
) {
  const { config, name } = options;
  if (!manifest.fileKey) {
    qaReport.failures.push('the Design section names no Figma file key');
    return;
  }
  if (!hasFigmaKey()) {
    qaReport.failures.push(FIGMA_KEY_HELP);
    return;
  }

  const fileKey = manifest.fileKey;
  const ids = manifest.rows.map((row) => row.nodeId);
  const nodes = await fetchNodes(fileKey, ids, 4);
  const rendered = await renderNodes(fileKey, ids, DEVICE_SCALE);
  const referenceScale = await renderNodes(fileKey, ids, 1);
  const images = qaImageDir(config.name, basename(dirname(planFile)));

  let baseUrl: string | null = null;
  const needsBrowser = manifest.rows.some(
    (row) => classifyRow(row, nodes[row.nodeId], viewportFor(manifest, row)).kind === 'diff',
  );
  if (needsBrowser) {
    baseUrl = await devBaseUrl(config, name, worktreePath, report);
    if (!baseUrl) {
      qaReport.failures.push(
        'the dev server has no URL, so no route could be screenshot',
      );
    }
  }

  for (const row of manifest.rows) {
    const node = nodes[row.nodeId];
    const verdict = classifyRow(row, node, viewportFor(manifest, row));
    const result: RowResult = {
      nodeId: row.nodeId,
      url: row.url,
      component: row.component,
      state: describeState(row),
      status: 'reference',
      ratio: null,
      sizeMismatch: null,
      message: null,
      driftRatio: driftRatio(planFile, row.nodeId, referenceScale[row.nodeId]!),
      images: null,
    };

    if (!node) {
      result.status = 'error';
      result.message = `node ${row.nodeId} could not be fetched`;
      qaReport.failures.push(result.message);
      qaReport.rows.push(result);
      continue;
    }
    if (verdict.kind !== 'diff') {
      result.status = verdict.kind === 'reference' ? 'reference' : 'refused';
      result.message = verdict.reason;
      if (verdict.kind === 'refused') qaReport.failures.push(`${row.nodeId}: ${verdict.reason}`);
      qaReport.rows.push(result);
      continue;
    }
    if (!baseUrl) {
      qaReport.rows.push({ ...result, status: 'error', message: 'no dev URL' });
      continue;
    }

    const chrome = frameChrome(node);
    try {
      const shot = await capture({
        worktreePath,
        baseUrl,
        path: row.url!,
        viewport: { width: chrome.content.width, height: chrome.content.height },
        state: row.state,
      });

      const design = prepareDesign(rendered[row.nodeId]!, chrome, DEVICE_SCALE);
      const app = prepareApp(shot, chrome, DEVICE_SCALE);
      const diff = diffImages(design, app);

      const paths = {
        design: join(images, `${assetFileName(row.nodeId)}`.replace('.png', '-design.png')),
        app: join(images, `${assetFileName(row.nodeId)}`.replace('.png', '-app.png')),
        diff: join(images, `${assetFileName(row.nodeId)}`.replace('.png', '-diff.png')),
      };
      writeFileSync(paths.design, encode(design));
      writeFileSync(paths.app, encode(app));
      writeFileSync(paths.diff, diff.png);

      result.status = 'diffed';
      result.ratio = diff.ratio;
      result.sizeMismatch = diff.sizeMismatch;
      result.images = paths;
      if (diff.ratio > LAYOUT_THRESHOLD || diff.sizeMismatch) {
        qaReport.notes.push(
          `${row.nodeId} ${row.url}: ${(diff.ratio * 100).toFixed(1)}% of pixels differ${diff.sizeMismatch ? ` (${diff.sizeMismatch})` : ''}`,
        );
      }
    } catch (error) {
      // A state that cannot be reached is a failure of the row, never a licence
      // to shoot the default state and call it a pass.
      result.status = 'error';
      result.message = (error as Error).message;
      if (error instanceof BouncedError) {
        const landed = join(images, assetFileName(row.nodeId).replace('.png', '-landed.png'));
        writeFileSync(landed, error.landedScreenshot);
        result.message += ` Landed page saved to ${landed}.`;
      }
      qaReport.failures.push(`${row.nodeId} (${result.state}): ${result.message}`);
    }
    qaReport.rows.push(result);
  }

  qaReport.assets = await checkAssets(fileKey, manifest, worktreePath);
  for (const asset of qaReport.assets) {
    if (!asset.ok) qaReport.failures.push(`${asset.file}: ${asset.message}`);
  }

  for (const row of qaReport.rows) {
    if (row.driftRatio !== null && row.driftRatio > DRIFT_THRESHOLD) {
      qaReport.notes.push(
        `${row.nodeId} has moved in Figma since the plan was written (${(row.driftRatio * 100).toFixed(1)}% against the cached copy)`,
      );
    }
  }
}

/**
 * The rows a reviewer has something to do about: refused, errored, over the
 * layout threshold, a different size, or drifted from the cached copy. A row
 * that matched its design is not worth an agent's context.
 */
export function rowsNeedingReview(report: QaReport) {
  return report.rows.filter(
    (row) =>
      row.status === 'refused' ||
      row.status === 'error' ||
      Boolean(row.sizeMismatch) ||
      (row.ratio !== null && row.ratio > LAYOUT_THRESHOLD) ||
      (row.driftRatio !== null && row.driftRatio > DRIFT_THRESHOLD),
  );
}

/**
 * What the reviewer is handed. Only the failing rows, with their three images:
 * a passing row would cost it context and tempt it to find something.
 *
 * Null when there is nothing to review, which is what keeps a clean run from
 * launching an agent at all.
 */
export function qaBrief(report: QaReport): string | null {
  const rows = rowsNeedingReview(report);
  const otherFailures = report.failures.filter(
    (failure) => !rows.some((row) => failure.startsWith(row.nodeId)),
  );
  if (!rows.length && !otherFailures.length) return null;

  const lines = [
    `You are reviewing ${report.task} against its design. Report what is wrong,`,
    'do not fix it: the worker owns these files and you have no edit tools.',
    '',
    `Worktree: ${report.worktree}`,
    `Plan: ${report.planFile ?? '(none)'}`,
    `Full findings: ${report.findingsFile ?? '(none)'}`,
    '',
  ];

  if (rows.length) {
    lines.push(`## ${rows.length} row(s) to look at`, '');
    for (const row of rows) {
      lines.push(`### ${row.nodeId} ${row.url ?? ''} (${row.state})`.trimEnd());
      lines.push('');
      if (row.component) lines.push(`- component: ${row.component}`);
      lines.push(`- status: ${row.status}`);
      if (row.ratio !== null) {
        lines.push(`- pixels differing: ${(row.ratio * 100).toFixed(2)}%`);
      }
      if (row.sizeMismatch) lines.push(`- size: ${row.sizeMismatch}`);
      if (row.message) lines.push(`- ${row.message}`);
      if (row.driftRatio !== null && row.driftRatio > DRIFT_THRESHOLD) {
        lines.push(
          `- the design itself moved since the plan was written (${(row.driftRatio * 100).toFixed(1)}% against the cached copy). Check that before blaming the code.`,
        );
      }
      if (row.images) {
        lines.push(`- read the design: ${row.images.design}`);
        lines.push(`- read the app: ${row.images.app}`);
        lines.push(`- read the diff: ${row.images.diff}`);
      }
      lines.push('');
    }
  }

  if (otherFailures.length) {
    lines.push('## Also failing', '');
    for (const failure of otherFailures) lines.push(`- ${failure}`);
    lines.push('');
  }

  lines.push(
    'Read both images for each row before saying anything about it. Font',
    'smoothing and real data move the pixel number on their own, so say which',
    'differences are real and which are noise. Finish with a short list the',
    'worker can act on, worst first.',
  );
  return `${lines.join('\n')}\n`;
}

export function renderFindings(report: QaReport) {
  const lines: string[] = [
    `# QA findings: ${report.task}`,
    '',
    `Worktree: ${report.worktree}`,
    `Plan: ${report.planFile ?? '(none found)'}`,
    `Gate: ${report.failures.length ? 'FAILED' : 'passed'}`,
    '',
  ];

  if (report.failures.length) {
    lines.push('## Failures', '');
    for (const failure of report.failures) lines.push(`- ${failure}`);
    lines.push('');
  }
  if (report.notes.length) {
    lines.push('## Reported, not fatal', '');
    for (const note of report.notes) lines.push(`- ${note}`);
    lines.push('');
  }

  lines.push('## Spec lane', '');
  const done = report.checklist.filter((item) => item.checked).length;
  lines.push(`Checklist ${done}/${report.checklist.length}, status ${report.status ?? 'none'}.`, '');
  for (const item of report.checklist) {
    lines.push(`- [${item.checked ? 'x' : ' '}] ${item.text}`);
  }
  lines.push('');

  for (const check of report.checks) {
    lines.push(`### ${check.name}: ${check.ok ? 'pass' : 'FAIL'}`, '');
    lines.push('```', `$ ${check.command}`, check.output.split('\n').slice(-40).join('\n'), '```', '');
  }

  lines.push(`### Files changed (${report.changedFiles.length})`, '');
  for (const file of report.changedFiles) lines.push(`- ${file}`);
  lines.push('');

  if (report.rows.length) {
    lines.push('## Visual lane', '');
    for (const row of report.rows) {
      lines.push(`### ${row.nodeId} ${row.url ?? ''} (${row.state})`.trimEnd());
      lines.push('');
      lines.push(`- status: ${row.status}${row.component ? `, component ${row.component}` : ''}`);
      if (row.ratio !== null) {
        lines.push(`- pixels differing: ${(row.ratio * 100).toFixed(2)}%`);
      }
      if (row.sizeMismatch) lines.push(`- size: ${row.sizeMismatch}`);
      if (row.message) lines.push(`- ${row.message}`);
      if (row.driftRatio !== null) {
        lines.push(`- drift against the cached copy: ${(row.driftRatio * 100).toFixed(2)}%`);
      }
      if (row.images) {
        lines.push(`- design: ${row.images.design}`);
        lines.push(`- app: ${row.images.app}`);
        lines.push(`- diff: ${row.images.diff}`);
      }
      lines.push('');
    }
  }

  if (report.assets.length) {
    lines.push('## Assets', '');
    for (const asset of report.assets) {
      lines.push(`- ${asset.ok ? 'ok' : 'FAIL'} ${asset.file}: ${asset.message}`);
    }
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * The spec lane always runs; the visual lane only when the plan pins a design.
 * A schema-only ticket must never wait on Figma to be told its tests pass.
 */
export async function runQa({
  config,
  name,
  lanes = 'both',
  report = () => {},
}: QaOptions): Promise<QaReport> {
  const record = readState(config.name).worktrees[name];
  if (!record) throw new Error(`no worktree '${name}' in the registry`);

  // The worktree's own copy first: the agent ticks its checklist there, and the
  // main checkout's copy is the plan as it stood before any of the work.
  const slug = name.replace(`${config.name}-`, '');
  const planFile =
    findSpec(record.path, record.taskId, slug) ??
    findSpec(config.root, record.taskId, slug);
  const plan = planFile ? readFileSync(planFile, 'utf8') : null;

  const qaReport: QaReport = {
    task: name,
    worktree: record.path,
    planFile,
    status: plan ? parseSpec(plan).status : null,
    checklist: plan ? checklistItems(plan) : [],
    changedFiles: changedFiles(record.path, config.baseBranch),
    checks: [],
    rows: [],
    assets: [],
    failures: [],
    notes: [],
    findingsFile: null,
  };

  if (!planFile) {
    qaReport.notes.push(`no spec/<task>/plan.md found for '${name}'`);
  }

  if (lanes !== 'visual') {
    for (const [checkName, command] of [
      ['tests', config.test],
      ['typecheck', config.typecheck],
      ['lint', config.lint],
    ] as const) {
      report(`${checkName.padEnd(10)} ${command ?? '(not configured)'}`);
      const result = runCheck(checkName, command, record.path);
      if (!result) continue;
      qaReport.checks.push(result);
      if (!result.ok) qaReport.failures.push(`${checkName} failed: ${command}`);
    }
  }

  const manifest = plan ? parseDesign(plan) : null;
  if (lanes === 'spec') {
    qaReport.notes.push('visual lane skipped: --spec-only');
  } else if (!manifest) {
    qaReport.notes.push('no Design section in the plan, so no visual lane');
  } else {
    report(`design     ${manifest.rows.length} rows, ${manifest.assets.length} assets`);
    try {
      await visualLane(
        { config, name, lanes },
        record.path,
        planFile!,
        manifest,
        qaReport,
        report,
      );
    } finally {
      // The lane shares one browser across its rows, so it is closed here
      // rather than per row, and on the failure path too or the run leaves a
      // headless chromium behind.
      await closeCaptureBrowser();
    }
  }

  if (planFile) {
    const findingsFile = join(dirname(planFile), 'qa-findings.md');
    writeFileSync(findingsFile, renderFindings(qaReport));
    qaReport.findingsFile = findingsFile;
  }
  return qaReport;
}
