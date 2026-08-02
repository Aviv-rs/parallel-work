# parallel-work

`pw`, a CLI for running several tickets at once in git worktrees without the setup tax.

One command gives you a branch, a worktree with your gitignored files in it, installed
dependencies, an entry in your VS Code workspace, and a running dev server with its URL
printed.

## Install

```bash
bun install
ln -sf "$PWD/src/cli.ts" ~/.local/bin/pw
```

## Use

```bash
pw wt EROS-696-onboarding-work-area   # create everything and start the dev server
pw list                               # branches, dev URLs, uncommitted and unmerged counts
pw list --json                        # same data for other tools
pw dev <name>                         # start the dev server, or --stop it
pw logs <name>                        # path to that worktree's dev server log
pw rm <name>                          # remove worktree, workspace entry, branch, registry row
```

`pw rm` refuses while a worktree has uncommitted changes or unmerged commits. Pass
`--force` when you mean it. The branch is deleted only when git agrees it is fully merged.

## Naming

A slug is `<TASK-ID>-<short-title>`:

| Thing | Value |
| --- | --- |
| slug | `EROS-696-onboarding-work-area` |
| branch | `feature/EROS-696-onboarding-work-area` |
| worktree | `../sweft-eros-696-onboarding-work-area` |

`--type bugfix` swaps the branch prefix. With no ticket id the type leads instead, so
`pw wt query-keys-cleanup --type refactor` gives `refactor/query-keys-cleanup`.

Worktrees are always siblings of the repo, never nested inside it. A nested worktree
leaves a gitlink that can be committed by accident.

## Config

`.parallel-work.json` at the repo root, all fields optional:

```json
{
  "taskPrefix": "EROS",
  "baseBranch": "origin/master",
  "copy": [".env", ".env.local", ".claude", "playwright/.auth"],
  "install": "bun install",
  "dev": "bun dev",
  "workspaceFile": "sweft.code-workspace"
}
```

`copy` is the point of the tool. `git worktree add` only materialises tracked files, so
anything gitignored is missing and the failure usually points somewhere else. A missing
`playwright/.auth` shows up as a module resolution error, not a missing file.

State lives in `~/.parallel-work/<repo>.json`, dev server logs in
`~/.parallel-work/logs/<repo>/<worktree>.log`.

## Notes

The workspace file is edited as text, not parsed and rewritten, so comments and trailing
commas in your `.code-workspace` survive. That is covered by tests.

Your dev setup has to pick free ports on its own. Two dev servers on one hardcoded port,
or one hardcoded debugger port, is the failure this tool would otherwise hit on every
second worktree.
