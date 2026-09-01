import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { STATE_DIR } from './state';

const API = 'https://api.figma.com';

export interface FigmaBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FigmaNode {
  id: string;
  name: string;
  type: string;
  characters?: string;
  /** Absent means visible; Figma only sends the flag when it is false. */
  visible?: boolean;
  absoluteBoundingBox?: FigmaBox | null;
  children?: FigmaNode[];
}

export const FIGMA_KEY_HELP = `FIGMA_API_KEY is not set.

It is exported from ~/.zshrc, which only interactive shells read, so a script
or a tmux pane started without one sees nothing. Export it in the shell you run
pw from, or add it to the environment pw is launched with:

  export FIGMA_API_KEY=figd_...`;

/** Read at call time, never at import, so the spec lane runs without a key. */
export function figmaKey() {
  const key = process.env.FIGMA_API_KEY?.trim();
  if (!key) throw new Error(FIGMA_KEY_HELP);
  return key;
}

export function hasFigmaKey() {
  return Boolean(process.env.FIGMA_API_KEY?.trim());
}

async function figmaJson<T>(path: string): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    headers: { 'X-Figma-Token': figmaKey() },
  });
  if (!response.ok) {
    const body = (await response.text()).slice(0, 300);
    throw new Error(`figma ${response.status} on ${path}: ${body}`);
  }
  return (await response.json()) as T;
}

interface NodesResponse {
  nodes: Record<string, { document: FigmaNode } | undefined>;
}

/**
 * `depth` is the whole cost control here: geometry for masking needs a few
 * levels, and a bare existence check needs one. Ids are sent in one request
 * because Figma rate limits per call, not per node.
 */
export async function fetchNodes(
  fileKey: string,
  ids: string[],
  depth = 1,
): Promise<Record<string, FigmaNode>> {
  if (!ids.length) return {};
  const query = `ids=${encodeURIComponent(ids.join(','))}&depth=${depth}`;
  const body = await figmaJson<NodesResponse>(
    `/v1/files/${fileKey}/nodes?${query}`,
  );

  const found: Record<string, FigmaNode> = {};
  for (const id of ids) {
    const document = body.nodes[id]?.document;
    if (document) found[id] = document;
  }
  return found;
}

interface ImagesResponse {
  err: string | null;
  images: Record<string, string | null>;
}

/**
 * The rendered png bytes per node. The S3 urls the endpoint hands back expire
 * within the hour, so they are downloaded here and never stored or pasted
 * anywhere: a link in a plan is dead by the time anyone follows it.
 */
export async function renderNodes(
  fileKey: string,
  ids: string[],
  scale = 2,
): Promise<Record<string, Buffer>> {
  if (!ids.length) return {};
  const query = `ids=${encodeURIComponent(ids.join(','))}&format=png&scale=${scale}`;
  const body = await figmaJson<ImagesResponse>(
    `/v1/images/${fileKey}?${query}`,
  );
  if (body.err) throw new Error(`figma images: ${body.err}`);

  const rendered: Record<string, Buffer> = {};
  for (const [id, url] of Object.entries(body.images)) {
    if (!url) continue;
    const image = await fetch(url);
    if (!image.ok) throw new Error(`figma render for ${id}: ${image.status}`);
    rendered[id] = Buffer.from(await image.arrayBuffer());
  }
  return rendered;
}

export interface FilePage {
  id: string;
  name: string;
  children: FigmaNode[];
}

function indexPath(fileKey: string) {
  return join(STATE_DIR, 'figma', `${fileKey}-depth2.json`);
}

/**
 * Pages and their top-level nodes, cached on disk. This is one 600KB call for
 * a real design file, and flow discovery needs it for every row, so refetching
 * it per node would be the slowest part of a qa run for no new information.
 */
export async function fetchFileIndex(
  fileKey: string,
  { refresh = false } = {},
): Promise<FilePage[]> {
  const path = indexPath(fileKey);
  if (!refresh && existsSync(path)) {
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as FilePage[];
    } catch {
      // A truncated cache is not worth a failed run; refetch over it.
    }
  }

  const body = await figmaJson<{ document: { children: FilePage[] } }>(
    `/v1/files/${fileKey}?depth=2`,
  );
  const pages = body.document.children.map((page) => ({
    id: page.id,
    name: page.name,
    children: (page.children ?? []).map((child) => ({
      id: child.id,
      name: child.name,
      type: child.type,
      absoluteBoundingBox: child.absoluteBoundingBox ?? null,
    })),
  }));

  mkdirSync(join(STATE_DIR, 'figma'), { recursive: true });
  writeFileSync(path, JSON.stringify(pages));
  return pages;
}

export function contains(outer: FigmaBox, inner: FigmaBox, slack = 1) {
  return (
    inner.x >= outer.x - slack &&
    inner.y >= outer.y - slack &&
    inner.x + inner.width <= outer.x + outer.width + slack &&
    inner.y + inner.height <= outer.y + outer.height + slack
  );
}

export function area(box: FigmaBox) {
  return box.width * box.height;
}

export interface FlowMember {
  id: string;
  name: string;
  type: string;
  box: FigmaBox;
}

export interface Flow {
  page: string | null;
  section: FlowMember | null;
  /** Frames sharing the node's row, left to right, the given node included. */
  row: FlowMember[];
  banner: (FlowMember & { text: string | null }) | null;
}

function member(node: FigmaNode): FlowMember | null {
  const box = node.absoluteBoundingBox;
  return box ? { id: node.id, name: node.name, type: node.type, box } : null;
}

function allText(node: FigmaNode, found: string[] = []) {
  if (node.visible === false) return found;
  if (node.type === 'TEXT' && node.characters) found.push(node.characters);
  for (const child of node.children ?? []) allText(child, found);
  return found;
}

/**
 * Pages have independent coordinate spaces, so more than one section can
 * geometrically contain a node. The smallest containing box is the real
 * ancestor; a 74000px wide section on another page is the coincidence.
 */
export function findSection(pages: FilePage[], box: FigmaBox) {
  let best: { page: string; node: FigmaNode } | null = null;
  for (const page of pages) {
    for (const child of page.children) {
      const childBox = child.absoluteBoundingBox;
      if (child.type !== 'SECTION' || !childBox) continue;
      if (!contains(childBox, box)) continue;
      if (!best || area(childBox) < area(best.node.absoluteBoundingBox!)) {
        best = { page: page.name, node: child };
      }
    }
  }
  return best;
}

const ROW_TOLERANCE = 200;
const BANNER_GAP = 600;

/**
 * One pinned link is enough to find the rest of a flow, because the file's own
 * layout carries it: the designer's screens for one step sit in a row at the
 * same y inside a section, under a wide short banner that names the step. The
 * banner is read, not skipped; it carries intent no screenshot answers.
 */
export async function discoverFlow(
  fileKey: string,
  nodeId: string,
): Promise<Flow> {
  const node = (await fetchNodes(fileKey, [nodeId]))[nodeId];
  const box = node?.absoluteBoundingBox;
  if (!node || !box) throw new Error(`figma node ${nodeId} has no geometry`);

  const found = findSection(await fetchFileIndex(fileKey), box);
  if (!found) return { page: null, section: null, row: [member(node)!], banner: null };

  const section = (await fetchNodes(fileKey, [found.node.id]))[found.node.id];
  const siblings = (section?.children ?? [])
    .map(member)
    .filter((entry): entry is FlowMember => Boolean(entry));

  const row = siblings
    .filter((entry) => Math.abs(entry.box.y - box.y) < ROW_TOLERANCE)
    .sort((left, right) => left.box.x - right.box.x);

  // A banner is wider than the screens it labels and much shorter, and sits
  // just above the row. Anything else above is the previous step's screens.
  const banner = siblings
    .filter(
      (entry) =>
        entry.box.y < box.y &&
        entry.box.y > box.y - BANNER_GAP &&
        entry.box.width > box.width * 2 &&
        entry.box.height < box.height / 2,
    )
    .sort((left, right) => right.box.y - left.box.y)[0];

  if (!banner) {
    return { page: found.page, section: member(found.node), row, banner: null };
  }

  const deep = (await fetchNodes(fileKey, [banner.id], 4))[banner.id];
  return {
    page: found.page,
    section: member(found.node),
    row,
    banner: { ...banner, text: deep ? (allText(deep).join(' ').trim() || null) : null },
  };
}
