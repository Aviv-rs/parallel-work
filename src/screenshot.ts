import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { DesignState, Viewport } from './spec';

/**
 * Rendered at the same scale the Figma frames are exported at, so the two
 * images line up pixel for pixel without either being resampled.
 */
export const DEVICE_SCALE = 2;

/** How long to let a page keep fetching after load before shooting anyway. */
const IDLE_GRACE_MS = 2_000;

/** Set by an app that marks its first client render. Absent apps just skip it. */
const APP_READY_SELECTOR = 'html[data-app-ready="true"]';

/**
 * A screenshot of the login page diffed against a design is a confusing pass or
 * a misleading fail, so a redirect away from the row's own path is treated as a
 * failure with the reason named. The page as it landed travels with the error so
 * the findings can still show what rendered.
 */
export class BouncedError extends Error {
  constructor(
    message: string,
    public readonly landedScreenshot: Buffer,
  ) {
    super(message);
  }
}

async function assertNotBounced(
  requested: string,
  page: QaPage,
  signedInAs: string | null,
) {
  const requestedPath = new URL(requested).pathname;
  const landedPath = new URL(page.url(), requested).pathname;
  if (landedPath === requestedPath) return;
  const authHint = signedInAs
    ? `Signed in as ${signedInAs} from playwright/.auth. That account cannot reach this route, or the app redirected it elsewhere.`
    : `No credentials file in playwright/.auth, so the page was shot signed out. Add ${CREDENTIALS_FILES.recruiter} and ${CREDENTIALS_FILES.candidate}.`;
  throw new BouncedError(
    `navigated to ${requestedPath} but landed on ${landedPath}. ${authHint}`,
    await page.screenshot(),
  );
}

export const PLAYWRIGHT_HELP = `playwright is not installed in this worktree.

pw drives the worktree's own copy rather than carrying one, so the browser and
the app agree on versions. Install it there:

  bun add -d playwright && bunx playwright install chromium`;

/**
 * Credentials, not sessions. A copied session file dies within the hour: the
 * access token is short lived and the refresh token rotates, so the first server
 * that refreshes it kills every other copy. Signing in fresh against the
 * worktree's own dev server costs one login per role per run and never goes
 * stale. The path being shot picks the role, since the app redirects a
 * signed-in user away from the areas their role does not own.
 */
export const CREDENTIALS_FILES = {
  recruiter: 'playwright/.auth/test-user-credentials.json',
  candidate: 'playwright/.auth/candidate-credentials.json',
} as const;

const LOGIN_PATH = '/login';
const SIGN_IN_TIMEOUT_MS = 30_000;

interface Credentials {
  email: string;
  password: string;
}

export function credentialsFile(worktreePath: string, path = '') {
  const role = path.startsWith('/candidate') ? 'candidate' : 'recruiter';
  const file = join(worktreePath, CREDENTIALS_FILES[role]);
  return existsSync(file) ? file : null;
}

function readCredentials(file: string): Credentials {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<Credentials>;
  if (!parsed.email || !parsed.password) {
    throw new Error(`${file} must hold { "email", "password" }`);
  }
  return { email: parsed.email, password: parsed.password };
}

/** One sign-in per credentials file per run. */
const storageStateByCredentials = new Map<string, unknown>();

async function signedInStorageState(
  browser: QaBrowser,
  baseUrl: string,
  file: string,
): Promise<unknown> {
  const cached = storageStateByCredentials.get(file);
  if (cached) return cached;

  const credentials = readCredentials(file);
  const context = await browser.newContext({});
  try {
    const page = await context.newPage();
    await page.goto(new URL(LOGIN_PATH, baseUrl).toString(), {
      waitUntil: 'load',
    });
    await page
      .waitForSelector(APP_READY_SELECTOR, { timeout: IDLE_GRACE_MS })
      .catch(() => {});
    await page.getByRole('textbox', { name: 'Email*' }).fill(credentials.email);
    await page
      .getByRole('textbox', { name: 'Password*' })
      .fill(credentials.password);
    await page.getByRole('button', { name: 'Sign In' }).click();
    await page.waitForURL((url) => !url.pathname.startsWith(LOGIN_PATH), {
      timeout: SIGN_IN_TIMEOUT_MS,
    });
    const state = await context.storageState();
    storageStateByCredentials.set(file, state);
    return state;
  } catch (error) {
    throw new Error(
      `sign in as ${credentials.email} (${file}) failed: ${(error as Error).message}`,
    );
  } finally {
    await context.close();
  }
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
  waitForLoadState(
    state: string,
    options?: { timeout?: number },
  ): Promise<void>;
  waitForSelector(
    selector: string,
    options?: { timeout?: number },
  ): Promise<unknown>;
  url(): string;
  screenshot(): Promise<Buffer>;
  getByRole(
    role: string,
    options: { name: string },
  ): { fill(value: string): Promise<void>; click(): Promise<void> };
  waitForURL(
    url: (url: URL) => boolean,
    options?: { timeout?: number },
  ): Promise<void>;
}

interface QaContext {
  newPage(): Promise<QaPage>;
  storageState(): Promise<unknown>;
  close(): Promise<void>;
}

interface QaBrowser {
  newContext(options: Record<string, unknown>): Promise<QaContext>;
  close(): Promise<void>;
}

interface Playwright {
  chromium: {
    launch(): Promise<QaBrowser>;
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
/**
 * One browser for the whole run, not one per row.
 *
 * Launching and tearing down a browser per row resets its sockets abruptly, and
 * a dev server that treats a read ECONNRESET as an unhandled error event dies
 * partway through, failing every remaining row with a connection refusal that
 * looks like the app's fault. A single browser with a context per row also
 * skips a browser launch per row, which dominated the run.
 */
let sharedBrowser: QaBrowser | null = null;

export async function closeCaptureBrowser() {
  const browser = sharedBrowser;
  sharedBrowser = null;
  storageStateByCredentials.clear();
  await browser?.close();
}

async function captureBrowser(worktreePath: string) {
  if (!sharedBrowser) {
    const { chromium } = await loadPlaywright(worktreePath);
    sharedBrowser = await chromium.launch();
  }
  return sharedBrowser;
}

export async function capture({
  worktreePath,
  baseUrl,
  path,
  viewport,
  state,
  settleMs = 600,
}: CaptureOptions): Promise<Buffer> {
  const browser = await captureBrowser(worktreePath);
  const credentials = credentialsFile(worktreePath, path);
  const storageState = credentials
    ? await signedInStorageState(browser, baseUrl, credentials)
    : null;

  let context: QaContext | null = null;
  try {
    context = await browser.newContext({
      viewport,
      deviceScaleFactor: DEVICE_SCALE,
      isMobile: viewport.width < 500,
      hasTouch: viewport.width < 500,
      reducedMotion: 'reduce',
      ...(storageState ? { storageState } : {}),
    });
    const page = await context.newPage();

    const target = new URL(path, baseUrl).toString();
    await page.goto(target, { waitUntil: 'load' });
    // A dev server holds its HMR socket open, so networkidle never arrives and
    // waiting on it as the goto condition times out every row. Load is the real
    // gate; idle is a best effort on top of it for whatever the page fetches
    // after mount.
    await page
      .waitForLoadState('networkidle', { timeout: IDLE_GRACE_MS })
      .catch(() => {});
    await assertNotBounced(target, page, credentials && readCredentials(credentials).email);
    // A click dispatched before the client render commits lands on markup with
    // no handler and is silently dropped, so a setup module's first action can
    // do nothing at all. Apps that publish a ready flag get waited on; those
    // that do not carry on after the grace period.
    await page
      .waitForSelector(APP_READY_SELECTOR, { timeout: IDLE_GRACE_MS })
      .catch(() => {});
    await reachState(page, state, worktreePath);
    await page.waitForTimeout(settleMs);

    return await page.screenshot();
  } finally {
    await context?.close();
  }
}
