import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { DesignState, Viewport } from './spec';

/**
 * Rendered at the same scale the Figma frames are exported at, so the two
 * images line up pixel for pixel without either being resampled.
 */
export const DEVICE_SCALE = 2;

export const PLAYWRIGHT_HELP = `playwright is not installed in this worktree.

pw drives the worktree's own copy rather than carrying one, so the browser and
the app agree on versions. Install it there:

  bun add -d playwright && bunx playwright install chromium`;

/** The auth state `pw wt` already copies into every worktree. */
export function authStateFile(worktreePath: string) {
  const file = join(worktreePath, 'playwright/.auth/user.json');
  return existsSync(file) ? file : null;
}

export function setupModulePath(worktreePath: string, module: string) {
  for (const extension of ['.ts', '.js', '.mjs']) {
    const file = join(worktreePath, 'playwright/qa-states', `${module}${extension}`);
    if (existsSync(file)) return file;
  }
  return null;
}

/**
 * Only the handful of calls pw makes, typed structurally. pw has no playwright
 * of its own to import types from, and adding one for types alone would put a
 * second browser version in the picture.
 */
export interface QaPage {
  goto(url: string, options?: { waitUntil?: string }): Promise<unknown>;
  hover(selector: string): Promise<void>;
  focus(selector: string): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
  screenshot(): Promise<Buffer>;
}

interface Playwright {
  chromium: {
    launch(): Promise<{
      newContext(options: Record<string, unknown>): Promise<{
        newPage(): Promise<QaPage>;
      }>;
      close(): Promise<void>;
    }>;
  };
}

async function loadPlaywright(worktreePath: string) {
  let entry: string;
  try {
    entry = Bun.resolveSync('playwright', worktreePath);
  } catch {
    throw new Error(PLAYWRIGHT_HELP);
  }
  return (await import(entry)) as Playwright;
}

/**
 * Drives the page to the state its manifest row names. A setup module that
 * throws takes the row down with it: shooting the default state instead would
 * silently compare the wrong screen against the design and pass.
 */
async function reachState(
  page: QaPage,
  state: DesignState,
  worktreePath: string,
) {
  if (state.kind === 'hover') {
    await page.hover(state.selector);
    return;
  }
  if (state.kind === 'focus') {
    await page.focus(state.selector);
    return;
  }
  if (state.kind !== 'setup') return;

  const file = setupModulePath(worktreePath, state.module);
  if (!file) {
    throw new Error(
      `state setup:${state.module} needs playwright/qa-states/${state.module}.ts in the worktree`,
    );
  }

  const module = (await import(file)) as {
    default?: (page: unknown) => Promise<void>;
    setup?: (page: unknown) => Promise<void>;
  };
  const drive = module.default ?? module.setup;
  if (typeof drive !== 'function') {
    throw new Error(`${file} must export a default function taking the page`);
  }
  await drive(page);
}

export interface CaptureOptions {
  worktreePath: string;
  baseUrl: string;
  path: string;
  viewport: Viewport;
  state: DesignState;
  /** Fonts, images and entry animations all settle after load. */
  settleMs?: number;
}

/**
 * The viewport is the design's content height, not the device's 844: the
 * browser never draws the status bar or the home indicator, so shooting at
 * device height and comparing against a chrome-stripped frame would offset
 * every row by the difference.
 */
export async function capture({
  worktreePath,
  baseUrl,
  path,
  viewport,
  state,
  settleMs = 600,
}: CaptureOptions): Promise<Buffer> {
  const { chromium } = await loadPlaywright(worktreePath);
  const browser = await chromium.launch();
  const storageState = authStateFile(worktreePath);

  try {
    const context = await browser.newContext({
      viewport,
      deviceScaleFactor: DEVICE_SCALE,
      isMobile: viewport.width < 500,
      hasTouch: viewport.width < 500,
      reducedMotion: 'reduce',
      ...(storageState ? { storageState } : {}),
    });
    const page = await context.newPage();

    await page.goto(new URL(path, baseUrl).toString(), {
      waitUntil: 'networkidle',
    });
    await reachState(page, state, worktreePath);
    await page.waitForTimeout(settleMs);

    return await page.screenshot();
  } finally {
    await browser.close();
  }
}
