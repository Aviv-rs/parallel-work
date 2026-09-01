import { describe, expect, it } from 'bun:test';

import type { FigmaNode } from './figma';
import {
  cropImage,
  decode,
  diffImages,
  encode,
  frameChrome,
  maskImage,
} from './image-diff';
import { PNG } from 'pngjs';

function box(x: number, y: number, width: number, height: number) {
  return { x, y, width, height };
}

function node(
  id: string,
  name: string,
  bounds: ReturnType<typeof box>,
  extra: Partial<FigmaNode> = {},
): FigmaNode {
  return { id, name, type: 'FRAME', absoluteBoundingBox: bounds, ...extra };
}

/** The measured shape of 4263:32210: 390x844 frame, 810 content, 43 status bar. */
const MOBILE_FRAME: FigmaNode = node('1:1', 'Profile', box(-100, 200, 390, 844), {
  children: [
    node('1:2', 'Profile Container', box(-100, 200, 390, 810), {
      children: [
        node('1:3', 'upper container', box(-76, 200, 342, 74), {
          type: 'INSTANCE',
          children: [
            node('1:4', 'Upper Container', box(-76, 200, 342, 43), {
              children: [
                node('1:5', 'Status bar', box(-76, 200, 342, 43), {
                  type: 'INSTANCE',
                }),
              ],
            }),
          ],
        }),
      ],
    }),
    node('1:6', 'Confetti-desktop', box(-100, 700, 390, 300), {
      type: 'INSTANCE',
      visible: false,
    }),
    node('1:7', 'home_indicator/button', box(-100, 1010, 390, 34), {
      type: 'INSTANCE',
    }),
    node('1:8', 'Vector', box(40, 560, 19, 23), { type: 'VECTOR' }),
  ],
});

describe('frameChrome', () => {
  it('crops to the content container and off the measured status bar', () => {
    const chrome = frameChrome(MOBILE_FRAME);
    expect(chrome.statusBarHeight).toBe(43);
    expect(chrome.content).toEqual({ x: 0, y: 43, width: 390, height: 767 });
  });

  it('masks the stray cursor, relative to the cropped content', () => {
    expect(frameChrome(MOBILE_FRAME).masks).toEqual([
      { x: 140, y: 317, width: 19, height: 23 },
    ]);
  });

  it('leaves the home indicator to the crop rather than masking it', () => {
    const masks = frameChrome(MOBILE_FRAME).masks;
    expect(masks.some((mask) => mask.height === 34)).toBe(false);
  });

  it('ignores hidden layers, which never reach the render', () => {
    const masks = frameChrome(MOBILE_FRAME).masks;
    expect(masks.some((mask) => mask.height === 300)).toBe(false);
  });

  it('removes nothing off the top when no status bar node is found', () => {
    const bare = node('2:1', 'Screen', box(0, 0, 390, 844), {
      children: [node('2:2', 'Container', box(0, 0, 390, 844))],
    });
    const chrome = frameChrome(bare);
    expect(chrome.statusBarHeight).toBe(0);
    expect(chrome.content).toEqual({ x: 0, y: 0, width: 390, height: 844 });
  });

  it('treats a childless frame as all content', () => {
    const chrome = frameChrome(node('3:1', 'Icon', box(0, 0, 80, 80)));
    expect(chrome.content).toEqual({ x: 0, y: 0, width: 80, height: 80 });
    expect(chrome.masks).toEqual([]);
  });
});

function solid(width: number, height: number, colour: number[]) {
  const image = new PNG({ width, height });
  for (let at = 0; at < image.data.length; at += 4) {
    image.data[at] = colour[0]!;
    image.data[at + 1] = colour[1]!;
    image.data[at + 2] = colour[2]!;
    image.data[at + 3] = 255;
  }
  return image;
}

describe('diffImages', () => {
  it('is zero for identical images', () => {
    const result = diffImages(solid(10, 10, [255, 0, 0]), solid(10, 10, [255, 0, 0]));
    expect(result.ratio).toBe(0);
    expect(result.sizeMismatch).toBeNull();
  });

  it('is one when every pixel moved', () => {
    expect(
      diffImages(solid(10, 10, [255, 0, 0]), solid(10, 10, [0, 255, 0])).ratio,
    ).toBe(1);
  });

  it('reports a size difference instead of scaling one side to fit', () => {
    const result = diffImages(solid(10, 20, [0, 0, 0]), solid(10, 10, [0, 0, 0]));
    expect(result.sizeMismatch).toBe('design 10x20, app 10x10');
    expect(result.height).toBe(10);
  });

  it('sees nothing under a mask applied to both sides', () => {
    const left = maskImage(solid(10, 10, [255, 0, 0]), [box(0, 0, 10, 5)]);
    const right = maskImage(solid(10, 10, [255, 0, 0]), [box(0, 0, 10, 5)]);
    expect(diffImages(left, right).ratio).toBe(0);
  });
});

describe('cropImage', () => {
  it('round trips through png bytes at the requested size', () => {
    const cropped = cropImage(solid(20, 20, [1, 2, 3]), box(5, 5, 10, 10));
    const decoded = decode(encode(cropped));
    expect([decoded.width, decoded.height]).toEqual([10, 10]);
  });

  it('clips a crop that runs off the edge rather than throwing', () => {
    expect(cropImage(solid(10, 10, [0, 0, 0]), box(5, 5, 99, 99)).width).toBe(5);
  });
});
