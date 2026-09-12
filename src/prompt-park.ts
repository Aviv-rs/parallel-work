import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Parks a message in the worktree and returns its path. Inside the worktree
 * because reading outside it re-triggers a permission dialog.
 */
export function parkPrompt(worktreePath: string, name: string, prompt: string) {
  const promptDirectory = join(worktreePath, '.pw-prompts');
  mkdirSync(promptDirectory, { recursive: true });
  const promptFile = join(promptDirectory, `${name}-${Bun.nanoseconds()}.md`);
  writeFileSync(promptFile, `${prompt}\n`);
  prunePrompts(promptDirectory);
  return promptFile;
}

const PROMPTS_KEPT = 5;

/**
 * The newest few stay readable for anyone retracing what an agent was told;
 * the rest are litter. Deleting the one just written would race the agent,
 * which reads it a beat after the keystroke lands.
 */
function prunePrompts(promptDirectory: string) {
  const files = readdirSync(promptDirectory).filter((file) =>
    file.endsWith('.md'),
  );
  const oldestFirst = files
    .map((file) => ({
      file,
      at: statSync(join(promptDirectory, file)).mtimeMs,
    }))
    .sort((left, right) => left.at - right.at);

  for (const { file } of oldestFirst.slice(0, -PROMPTS_KEPT)) {
    rmSync(join(promptDirectory, file), { force: true });
  }
}
