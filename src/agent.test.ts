import { describe, expect, it } from 'bun:test';

import { agentCommand } from './agent';
import type { Settings } from './settings';

const settings = (patch: Partial<Settings> = {}): Settings => ({
  liveStatus: true,
  agentCli: 'claude',
  agentCommands: {},
  ...patch,
});

describe('agentCommand', () => {
  it('grants claude the file writing tools, which dontAsk would otherwise deny', () => {
    const command = agentCommand(null, settings());
    expect(command).toStartWith('claude ');
    expect(command).toContain('--permission-mode dontAsk');
    expect(command).toContain('Write Edit MultiEdit NotebookEdit');
  });

  it('launches codex and cursor by their own binaries', () => {
    expect(agentCommand(null, settings({ agentCli: 'codex' }))).toStartWith(
      'codex ',
    );
    expect(agentCommand(null, settings({ agentCli: 'cursor' }))).toStartWith(
      'cursor-agent ',
    );
  });

  it('passes a model through for every CLI', () => {
    expect(agentCommand('opus', settings())).toContain('--model opus');
    expect(agentCommand('o3', settings({ agentCli: 'codex' }))).toContain(
      '-m o3',
    );
  });

  it('lets an override replace the built-in command outright', () => {
    const command = agentCommand(
      null,
      settings({
        agentCli: 'codex',
        agentCommands: { codex: 'codex --sandbox danger-full-access' },
      }),
    );
    expect(command).toBe('codex --sandbox danger-full-access');
  });

  it('ignores an override belonging to a different CLI', () => {
    const command = agentCommand(
      null,
      settings({ agentCli: 'claude', agentCommands: { codex: 'codex weird' } }),
    );
    expect(command).toStartWith('claude ');
  });
});
