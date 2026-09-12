import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { STATE_DIR } from './state';

export const AGENT_CLIS = ['claude', 'codex', 'cursor'] as const;
export type AgentCli = (typeof AGENT_CLIS)[number];

export const BACKENDS = ['tmux', 'herdr'] as const;
export type Backend = (typeof BACKENDS)[number];

export interface Settings {
  /** Live status board above the main menu, with the pixel agent. */
  liveStatus: boolean;
  /** Which coding agent `pw agent start` launches in the session window. */
  agentCli: AgentCli;
  /** Replaces the built-in launch command for a CLI, when its flags change. */
  agentCommands: Partial<Record<AgentCli, string>>;
  /** Which terminal multiplexer backs sessions, windows and agent panes. */
  backend: Backend;
}

const DEFAULTS: Settings = {
  liveStatus: true,
  agentCli: 'claude',
  agentCommands: {},
  backend: 'tmux',
};

export function isAgentCli(value: unknown): value is AgentCli {
  return AGENT_CLIS.some((cli) => cli === value);
}

export function isBackend(value: unknown): value is Backend {
  return BACKENDS.some((backend) => backend === value);
}

function settingsPath() {
  return join(STATE_DIR, 'settings.json');
}

export function readSettings(): Settings {
  const path = settingsPath();
  if (!existsSync(path)) return { ...DEFAULTS };
  try {
    const stored = JSON.parse(readFileSync(path, 'utf8')) as Partial<Settings>;
    return {
      ...DEFAULTS,
      ...stored,
      // A hand-edited or older file can carry a name pw no longer knows.
      agentCli: isAgentCli(stored.agentCli) ? stored.agentCli : DEFAULTS.agentCli,
      agentCommands: stored.agentCommands ?? {},
      backend: isBackend(stored.backend) ? stored.backend : DEFAULTS.backend,
    };
  } catch {
    // A hand-edited file that no longer parses should not stop pw from starting.
    return { ...DEFAULTS };
  }
}

export function writeSettings(patch: Partial<Settings>) {
  const next = { ...readSettings(), ...patch };
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(settingsPath(), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}
