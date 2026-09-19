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

const INLINE_PROMPT_MAX_CHARS = 300;

/**
 * The agent's input box mangles anything long or multi-line typed into it: a
 * big paste is collapsed and its start can be dropped, and a newline submits
 * early. Only a short single line is safe to type.
 */
export function shouldParkPrompt(prompt: string) {
  return prompt.includes('\n') || prompt.length > INLINE_PROMPT_MAX_CHARS;
}

/** What actually gets typed into the pane: the prompt, or a pointer to its park file. */
export function typedPromptText(
  worktreePath: string,
  name: string,
  prompt: string,
) {
  if (!shouldParkPrompt(prompt)) return prompt;
  return `Read ${parkPrompt(worktreePath, name, prompt)} in full and do what it says.`;
}

/**
 * Footer and input-box text that means the TUI is up and listening. The auto
 * mode footer replaces the shortcuts hint, so both are listed: matching only
 * the hint made every auto mode session look like it never became ready.
 */
export const PROMPT_READY_MARKERS = [
  '? for shortcuts',
  'Bypassing Permissions',
  'shift+tab to cycle',
  'auto mode on',
  'accept edits on',
  'plan mode on',
];
