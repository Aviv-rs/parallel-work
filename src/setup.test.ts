import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import { detectDefaults } from './setup';

function repoFixture(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'pw-setup-'));
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, contents);
  }
  return root;
}

const scripts = (value: Record<string, string>) =>
  JSON.stringify({ scripts: value });

describe('detectDefaults', () => {
  it('reads the package manager off the lockfile', () => {
    const root = repoFixture({
      'pnpm-lock.yaml': '',
      'package.json': scripts({ dev: 'vite' }),
    });
    expect(detectDefaults(root)).toMatchObject({
      install: 'pnpm install',
      dev: 'pnpm dev',
    });
  });

  it('falls back through start and serve for the dev script', () => {
    const root = repoFixture({
      'package-lock.json': '',
      'package.json': scripts({ serve: 'http-server' }),
    });
    expect(detectDefaults(root).dev).toBe('npm run serve');
  });

  it('reports no dev command when the repo has no script for it', () => {
    const root = repoFixture({ 'package.json': scripts({ build: 'tsc' }) });
    expect(detectDefaults(root).dev).toBe('');
  });

  it('survives a package.json that does not parse', () => {
    const root = repoFixture({ 'package.json': '{ not json' });
    expect(detectDefaults(root).dev).toBe('');
  });

  it('offers only the ignored files the repo actually has', () => {
    const root = repoFixture({ '.env': '', '.env.local': '' });
    expect(detectDefaults(root).copy).toEqual(['.env', '.env.local']);
  });

  it('finds the code-workspace file', () => {
    const root = repoFixture({ 'thing.code-workspace': '{}' });
    expect(detectDefaults(root).workspaceFile).toBe('thing.code-workspace');
  });
});
