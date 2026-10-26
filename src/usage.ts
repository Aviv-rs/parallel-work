export const USAGE = `pw - parallel work across git worktrees

  pw                            Interactive mode: worktrees, agents, qa, dev servers
  pw init                       Write .parallel-work.json for this repo, asking first

  pw wt <slug> [--type feature|bugfix|chore|refactor|docs|ui] [--no-dev] [--no-install]
      Create a worktree, copy ignored files, install, add to the code-workspace,
      start the dev server and print its URL.

  pw rm <name> [--force]        Remove a worktree and everything pw added for it
  pw clean                      Drop registry entries whose folder is gone
  pw list [--json]              Worktrees, branches, dev URLs
  pw dev <name> [--stop]        Start or stop the dev server for a worktree
  pw logs <name> [--tail N] [--follow] [--clear]
                                Dev server log: path, last N lines, or live
  pw open <name>                Open a worktree in your editor
  pw shell <name>               A shell in that worktree, no editor needed
  pw path <name>                Print its path, for cd "$(pw path <name>)"
  pw tile [name...]             One tmux pane per worktree, tiled, all shells
  pw qa <name> [--spec-only] [--visual-only] [--agent] [--tell]
      Check a worktree against its plan. Spec lane always: checklist, changed
      files, tests, types, lint. Visual lane when the plan has a ## Design
      section: every pinned Figma node against a screenshot of the same route.
      Writes spec/<task>/qa-findings.md and stops there.
      --agent  a read-only reviewer in a <name>-qa window, given the failing
               rows only. A clean run starts nothing.
      --tell   send the worker one line pointing at the findings file.

  pw design discover <node-id> --file <figma-file-key>
      The whole flow from one pinned link: its section, the frames in its row,
      and what the row's banner says.
  pw design cache <name>        Render every pinned node beside the plan

  pw status [--json]            Everything: agent, spec progress, dev URL, git
  pw agent start|send|see|kill|list <name>
                                Agent sessions in tmux, one window per worktree
  pw agent tile | untile        Every agent as a pane of one window, and back
  pw help                       This list

Slug is <TASK-ID>-<short-title>, e.g. EROS-696-onboarding-work-area.
Config lives in .parallel-work.json at the repo root.`;
