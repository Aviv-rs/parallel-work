import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { STATE_DIR } from './state';

export const AGENT_CLIS = ['claude', 'codex', 'cursor'] as const;
export type AgentCli = (typeof AGENT_CLIS)[number];

export interface Settings {
  /** Live status board above the main menu, with the pixel agent. */
  liveStatus: boolean;
  /** Which coding agent `pw agent start` launches in the tmux window. */
  agentCli: AgentCli;
  /** Replaces the built-in launch command for a CLI, when its flags change. */
  agentCommands: Partial<Record<AgentCli, string>>;
}

const DEFAULTS: Settings = {
  liveStatus: true,
  agentCli: 'claude',
  agentCommands: {},
};

export function isAgentCli(value: unknown): value is AgentCli {
  return AGENT_CLIS.some((cli) => cli === value);
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
