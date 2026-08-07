export const USAGE = `pw - parallel work across git worktrees

  pw                            Interactive mode: browse, create, remove, dev servers
  pw init                       Write .parallel-work.json for this repo, asking first

  pw wt <slug> [--type feature|bugfix|chore|refactor|docs] [--no-dev] [--no-install]
      Create a worktree, copy ignored files, install, add to the code-workspace,
      start the dev server and print its URL.

  pw rm <name> [--force]        Remove a worktree and everything pw added for it
  pw list [--json]              Worktrees, branches, dev URLs
  pw dev <name> [--stop]        Start or stop the dev server for a worktree
  pw logs <name> [--tail N] [--follow] [--clear]
                                Dev server log: path, last N lines, or live
  pw open <name>                Open a worktree in your editor
  pw shell <name>               A shell in that worktree, no editor needed
  pw path <name>                Print its path, for cd "$(pw path <name>)"
  pw tile [name...]             One tmux pane per worktree, tiled, all shells
  pw status [--json]            Everything: agent, spec progress, dev URL, git
  pw agent start|send|see|kill|list <name>
                                Agent sessions in tmux, one window per worktree
  pw agent tile | untile        Every agent as a pane of one window, and back
  pw help                       This list

Slug is <TASK-ID>-<short-title>, e.g. EROS-696-onboarding-work-area.
Config lives in .parallel-work.json at the repo root.`;
