import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

import type { FigmaBox, FigmaNode } from './figma';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FrameChrome {
  /** The content region in design px, relative to the frame's own origin. */
  content: Rect;
  /** Measured, never assumed. 0 when no status bar node was found. */
  statusBarHeight: number;
  /** Boxes to blind, relative to `content`. */
  masks: Rect[];
}

const STATUS_BAR_MAX_HEIGHT = 50;
const STATUS_BAR_MIN_WIDTH_RATIO = 0.8;
const STATUS_BAR_NAME = /status\s*bar/i;

function visibleChildren(node: FigmaNode) {
  return (node.children ?? []).filter(
    (child) => child.visible !== false && child.absoluteBoundingBox,
  );
}

function relative(box: FigmaBox, origin: FigmaBox): Rect {
  return {
    x: box.x - origin.x,
    y: box.y - origin.y,
    width: box.width,
    height: box.height,
  };
}

function overlaps(a: Rect, b: Rect) {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

function intersect(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x),
    height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y),
  };
}

/**
 * A status bar is not always a sibling: on the measured frame it is an instance
 * three levels inside the content container, 342 wide in a 390 frame, so a
 * full-width test misses it. Search descendants, take the first thing at the
 * top edge that is short enough, preferring the name and falling back to width.
 */
function findStatusBar(node: FigmaNode, top: number): FigmaBox | null {
  let fallback: FigmaBox | null = null;

  const walk = (current: FigmaNode): FigmaBox | null => {
    for (const child of visibleChildren(current)) {
      const box = child.absoluteBoundingBox!;
      const atTop = Math.abs(box.y - top) < 1;
      const short = box.height > 0 && box.height <= STATUS_BAR_MAX_HEIGHT;
      if (atTop && short && STATUS_BAR_NAME.test(child.name)) return box;
      if (atTop && short && !fallback) fallback = box;
      const deeper = walk(child);
      if (deeper) return deeper;
    }
    return null;
  };

  const named = walk(node);
  if (named) return named;
  return fallback;
}

/**
 * What to remove from a rendered Figma frame before it can be compared with a
 * browser screenshot. REST has no `contentsOnly`, so the frame arrives with its
 * status bar, its home indicator and whatever the designer left lying on it.
 *
 * Cropping is only ever done to bounds Figma itself reports, because a wrong
 * crop shifts everything below it and reads as a total mismatch, while a wrong
 * mask only blinds one rectangle.
 */
export function frameChrome(frame: FigmaNode): FrameChrome {
  const frameBox = frame.absoluteBoundingBox;
  if (!frameBox) throw new Error(`node ${frame.id} has no geometry`);

  const children = visibleChildren(frame);
  const container = children
    .slice()
    .sort(
      (left, right) =>
        right.absoluteBoundingBox!.width * right.absoluteBoundingBox!.height -
        left.absoluteBoundingBox!.width * left.absoluteBoundingBox!.height,
    )[0];

  // No children at all: the whole frame is the content, chrome and all.
  const containerBox = container?.absoluteBoundingBox ?? frameBox;
  const content = relative(containerBox, frameBox);

  const statusBar = container ? findStatusBar(container, containerBox.y) : null;
  const statusBarHeight = statusBar ? Math.round(statusBar.height) : 0;
  const cropped: Rect = {
    x: content.x,
    y: content.y + statusBarHeight,
    width: content.width,
    height: content.height - statusBarHeight,
  };

  // Everything still floating over the content after the crop. On the measured
  // frame this is the designer's cursor, a bare 19x23 `Vector` that no name
  // rule would ever match.
  const masks = children
    .filter((child) => child !== container)
    .map((child) => relative(child.absoluteBoundingBox!, frameBox))
    .filter((box) => overlaps(box, cropped))
    .map((box) => {
      const clipped = intersect(box, cropped);
      return { ...clipped, x: clipped.x - cropped.x, y: clipped.y - cropped.y };
    });

  return { content: cropped, statusBarHeight, masks };
}

export function decode(png: Buffer) {
  return PNG.sync.read(png);
}

export function encode(image: PNG) {
  return PNG.sync.write(image);
}

function scaled(rect: Rect, scale: number) {
  return {
    x: Math.round(rect.x * scale),
    y: Math.round(rect.y * scale),
    width: Math.round(rect.width * scale),
    height: Math.round(rect.height * scale),
  };
}

export function cropImage(image: PNG, rect: Rect) {
  const box = intersect(rect, {
    x: 0,
    y: 0,
    width: image.width,
    height: image.height,
  });
  const out = new PNG({ width: box.width, height: box.height });
  PNG.bitblt(image, out, box.x, box.y, box.width, box.height, 0, 0);
  return out;
}

/** Flat black, so the same rectangle reads identical in both images. */
export function maskImage(image: PNG, rects: Rect[]) {
  for (const rect of rects) {
    const box = intersect(rect, {
      x: 0,
      y: 0,
      width: image.width,
      height: image.height,
    });
    for (let y = box.y; y < box.y + box.height; y += 1) {
      for (let x = box.x; x < box.x + box.width; x += 1) {
        const at = (image.width * y + x) << 2;
        image.data[at] = 0;
        image.data[at + 1] = 0;
        image.data[at + 2] = 0;
        image.data[at + 3] = 255;
      }
    }
  }
  return image;
}

/**
 * Reduces a rendered Figma frame to the region a browser can actually produce:
 * cropped to the content container, the measured status bar off the top, and
 * the leftovers blinded.
 */
export function prepareDesign(png: Buffer, chrome: FrameChrome, scale: number) {
  const cropped = cropImage(decode(png), scaled(chrome.content, scale));
  return maskImage(cropped, chrome.masks.map((rect) => scaled(rect, scale)));
}

/**
 * The app screenshot is taken at the content size already, so it is only
 * masked, with the same rectangles: masking one side and not the other would
 * itself show up as a difference.
 */
export function prepareApp(png: Buffer, chrome: FrameChrome, scale: number) {
  return maskImage(decode(png), chrome.masks.map((rect) => scaled(rect, scale)));
}

export interface DiffResult {
  ratio: number;
  changed: number;
  width: number;
  height: number;
  /** Set when the two images were not the same size, which diff cannot judge. */
  sizeMismatch: string | null;
  png: Buffer;
}

const DIFF_THRESHOLD = 0.1;

/**
 * Compared over the overlap, top-left aligned. A size difference is reported
 * rather than resolved: scaling one side to fit would move every edge in it and
 * turn a page that is simply longer into a total mismatch.
 */
export function diffImages(left: PNG, right: PNG): DiffResult {
  const width = Math.min(left.width, right.width);
  const height = Math.min(left.height, right.height);
  const sizeMismatch =
    left.width === right.width && left.height === right.height
      ? null
      : `design ${left.width}x${left.height}, app ${right.width}x${right.height}`;

  const a = cropImage(left, { x: 0, y: 0, width, height });
  const b = cropImage(right, { x: 0, y: 0, width, height });
  const out = new PNG({ width, height });
  const changed = pixelmatch(a.data, b.data, out.data, width, height, {
    threshold: DIFF_THRESHOLD,
  });

  return {
    ratio: width && height ? changed / (width * height) : 1,
    changed,
    width,
    height,
    sizeMismatch,
    png: encode(out),
  };
}
