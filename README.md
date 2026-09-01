# parallel-work

`pw`, a CLI for running several tickets at once in git worktrees without the setup tax.

One command gives you a branch, a worktree with your gitignored files in it, installed
dependencies, an entry in your VS Code workspace, and a running dev server with its URL
printed.

## Install

```bash
bun add --global github:Aviv-rs/parallel-work
```

`pw` lands in `~/.bun/bin`, which has to be on your `PATH`. To try it without installing
anything: `bunx github:Aviv-rs/parallel-work status`.

Working on the tool itself instead:

```bash
git clone https://github.com/Aviv-rs/parallel-work.git
cd parallel-work && bun install
ln -sf "$PWD/src/cli.ts" ~/.local/bin/pw
```

### What it needs

- **bun**, on macOS or Linux. The entry point is TypeScript with a `bun` shebang.
- **git**.
- **tmux** and an agent CLI (**claude**, **codex** or **cursor-agent**), for `pw agent` and
  the agent column of the status board. Everything else works without them.
- **gh**, optional. When it is there and authenticated, each worktree with an open pull
  request shows its number and link. Without it, that line is simply absent.
- A dev command that picks its own free port. Two worktrees sharing one hardcoded port
  means the second silently serves the first one's app, which shows up as a 404 on a route
  that plainly exists.

### First run

The first bare `pw` in a repo with no `.parallel-work.json` offers to write one. It reads
what it can off the repo first, so the fast path is accepting what it found:

- install and dev commands from the lockfile and `package.json` scripts
- base branch from `origin/HEAD`
- ticket prefix from the shape of your existing branch names
- which gitignored files exist and are worth copying

Say "not now" and pw runs on defaults and asks again next time. `pw init` re-runs it.

## Use

```bash
pw -i                                 # interactive: browse, create, remove, dev servers
pw wt EROS-696-onboarding-work-area   # create everything and start the dev server
pw list                               # branches, dev URLs, uncommitted and unmerged counts
pw list --json                        # same data for other tools
pw dev <name>                         # start the dev server, or --stop it
pw logs <name>                        # path to that worktree's dev server log
pw rm <name>                          # remove worktree, workspace entry, branch, registry row

pw tile [name...]                     # one tmux pane per worktree, tiled, all shells
pw shell <name>                       # a shell in that worktree, exit to come back
pw path <name>                        # cd "$(pw path <name>)"

pw qa <name> [--agent] [--tell]       # check a worktree against its plan, two lanes
pw design discover <node> --file <key># the whole Figma flow from one link
pw design cache <name>                # pin every design node beside the plan

pw status                             # agent, spec progress, dev URL and git state per task
pw agent start <name>                 # a Claude session in its own tmux window
pw agent send <name> "do the thing"   # type into it
pw agent see <name> [--lines 60]      # what is on its screen right now
pw agent kill <name>
```

`pw status` marks a task with `>` when it wants you: an agent that has stopped working and
is sitting at its prompt. Spec progress comes from `spec/<task>/plan.md`, counting the
checklist and ignoring the manual tests, which are yours to run.

### Interactive mode

Bare `pw` opens a menu with a live status board above it, refreshed every few seconds
while you sit there. Each worktree shows its agent, checklist progress, dev URL, git
counts, and the link to its open pull request when there is one.

Beside them sits a small pixel agent. Its colour is the headline: yellow when an agent
wants you, cyan while they work, blue when everything is stopped, red only when a worktree
folder has gone missing. Its caption is the work, `18/26 done`, `needs review`, `in
review`, `all done`, never the plumbing.

The menu is `Worktrees` (list, create, dev server, logs, open, remove), `Agents`, a
command list, and settings. `Status of everything` only appears when the live board is
switched off, since otherwise it is already on screen. Settings toggles the board and
persists to `~/.parallel-work/settings.json`.

### Without an editor

Nothing here needs one. `pw tile` puts every worktree on screen at once, a tmux pane each,
already in the right directory and titled with its name, which is the split-screen version
of working three tickets in parallel. `pw shell <name>` drops you into one, and
`cd "$(pw path <name>)"` moves the shell you are already in.

The setup wizard asks before wiring worktrees into a `.code-workspace`, and answering no
leaves your editor out of it entirely. `pw agent tile` does the same trick for running
agents, pulling their windows into panes of one window; `pw agent untile` splits them back.

### QA

`pw qa <name>` checks a finished worktree against its own plan.

The **spec lane** always runs: the plan's checklist, the files actually changed against
the base branch and in the working tree, and the repo's `test`, `typecheck` and `lint`
scripts, found from `package.json` or named in `.parallel-work.json`.

The **visual lane** runs when the plan has a `## Design` section pinning Figma nodes to
routes. Each row is exported from Figma, screenshot from that worktree's own dev server at
the matching route and state, and diffed. Findings land in `spec/<task>/qa-findings.md`.

A bare `pw qa` stops there. Two flags interrupt somebody, so each is opt in:

- `--agent` opens a reviewer in a `<name>-qa` window of the worker's own tmux session,
  handed only the rows that failed and their three images. It launches with
  `PW_EDIT_TOOLS=` empty, so it cannot edit the worktree it is judging: a reviewer that
  can edit fixes what it finds instead of reporting it. A clean run starts nothing.
- `--tell` sends the worker one line pointing at the findings file. Never the findings
  themselves, and never without you asking, since the worker may be mid-edit.

```markdown
## Design

Figma file: WdGzjurMa53pyVeu1cU5I9
Mobile 390x844.

| node | url | component | viewport | state |
| --- | --- | --- | --- | --- |
| 4263:32210 | /candidate/resume | CandidateResumeSection | mobile | default |
| 2917:57231 | | MobileHeader | | reference |
```

A row's `state` is `default`, `hover:<selector>`, `focus:<selector>`, `setup:<module>` for
a `playwright/qa-states/<module>.ts` helper that drives the page, or `reference`. Only a
`FRAME` whose size is exactly the row's viewport is diffed; a variants board, a banner or a
native OS overlay is `reference`, pinned to be consulted and never screenshot.

Assets fail the run: an illustration in the repo that no longer matches a fresh export of
its node, or a file that is not there at all. The layout pixel ratio is reported and exits
0, because font smoothing, animation frames and real data all move it without anything
being wrong.

Rendering a Figma frame through the REST API gives you its status bar, its home indicator
and any cursor the designer left on it, and there is no `contentsOnly` to ask for the
content alone. So qa crops to the frame's own largest child, removes the status bar at its
measured height when it can find one as a node, and masks whatever is left over. Cropping
is only ever done to bounds Figma reports: a wrong crop shifts everything below it and
reads as a total mismatch, a wrong mask only blinds one rectangle.

It needs `FIGMA_API_KEY` in the environment and `playwright` installed in the worktree.

`pw design discover <node-id> --file <key>` is the plan-time half: one pinned link gives
you the section it lives in, every frame in its row, and the text of the banner labelling
that row. `pw design cache <name>` renders each pinned node into `spec/<task>/assets/` to
be committed with the plan, since the urls Figma hands back expire within the hour.

### Agents

`pw agent start` launches **Claude Code** by default; Settings switches it to **Codex** or
the **Cursor CLI**, and the menu says which of the three is actually on your PATH.

Claude launches with `--permission-mode dontAsk` plus explicit grants for the file writing
tools, because dontAsk denies everything not on the allow list and a tmux session has
nobody to answer a permission dialog. Override with `PW_MODE`, `PW_MCP`, `PW_EDIT_TOOLS`.

Only those Claude flags are ones pw depends on. Codex and Cursor get a reasonable
auto-approval flag and nothing more, and CLIs move fast, so when their flags change set
`agentCommands` in `~/.parallel-work/settings.json` to replace the launch command outright:

```json
{ "agentCli": "codex", "agentCommands": { "codex": "codex --sandbox workspace-write" } }
```

Killing the **last** running agent takes the whole tmux session with it, since tmux drops a
session when its final window closes. Nothing is lost: transcripts live outside tmux, and a
Claude session resumes with `claude -r <session-id>` inside that worktree.

### Driving it with Claude

`skill/` in this repo is a Claude Code skill that teaches Claude to run the whole workflow:
plan before creating anything, one session per worktree, relay messages, converge at the
end. It is optional, the CLI stands on its own.

```bash
ln -s "$(pwd)/skill" ~/.claude/skills/parallel-work
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
  "test": "bun run test",
  "typecheck": "bun run typecheck",
  "lint": "bun run lint",
  "workspaceFile": "sweft.code-workspace"
}
```

`copy` is the point of the tool. `git worktree add` only materialises tracked files, so
anything gitignored is missing and the failure usually points somewhere else. A missing
`playwright/.auth` shows up as a module resolution error, not a missing file.

Written for you by the first run or by `pw init`, so hand-editing is optional.

State lives in `~/.parallel-work/<repo>.json`, dev server logs in
`~/.parallel-work/logs/<repo>/<worktree>.log`, and your preferences, the live board and the
agent CLI, in `~/.parallel-work/settings.json`.

## Notes

The workspace file is edited as text, not parsed and rewritten, so comments and trailing
commas in your `.code-workspace` survive. That is covered by tests.

Your dev setup has to pick free ports on its own. Two dev servers on one hardcoded port,
or one hardcoded debugger port, is the failure this tool would otherwise hit on every
second worktree.
