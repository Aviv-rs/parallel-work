---
name: parallel-work
description: Use when the user asks to work on two or more tasks in parallel without mixing context, invokes /parallel-work, or wants to create, resume, list or delete long-lived agent sessions, each in its own git worktree. Drives the `pw` CLI, which runs each task as an interactive agent in its own tmux window so the user can attach and watch any of them live.
---

# Parallel Work

Run several independent tasks as separate long-lived agent sessions, one per worktree, so
their contexts never bleed into each other. This session is the conductor: it relays
instructions and reports results, it does not do the work itself.

Everything goes through one tool, the `pw` CLI
(https://github.com/Aviv-rs/parallel-work). It owns worktrees, gitignored files, installs,
workspace entries, dev servers and their logs, and the agent sessions in tmux.

```bash
pw wt <slug> [--type feature|bugfix|chore|refactor|docs]   # worktree, branch, deps, dev server
pw rm <name> [--force]                                     # undo all of it
pw list / pw status [--json]                               # where everything stands
pw dev <name> [--stop] / pw logs <name> [--follow]

pw agent start <name>                 # an agent session in its own tmux window
pw agent send  <name> "do the thing"  # type into it
pw agent see   <name> [--lines 60]    # what is on its screen right now
pw agent list / pw agent kill <name>

pw qa <name> [--spec-only] [--visual-only]   # check a worktree against its plan
pw qa <name> --agent                         # ... and hand the failures to a reviewer
pw qa <name> --tell                          # ... and point the worker at the findings
pw design discover <node-id> --file <key>    # the whole flow from one Figma link
pw design cache <name>                       # pin every design node beside the plan
```

## Why separate sessions, not subagents

A subagent inherits this conversation's context, and the whole point here is isolation.
Each parallel session is a real agent process with its own transcript, resumable across
turns and across days.

## The plan gate: nothing is created before the human approves

**Do not create a worktree, a branch, or a session until the human has approved a written
plan for that task.** No exceptions, including "this one is obviously small".

1. Run `/concise-plan` for the task. It writes `spec/<TASK-ID>-<slug>/plan.md`.
2. Show the human the file path and wait.
3. Only after they say yes, `pw wt <slug>` and start the session.

This exists because the alternative was doing it the other way round, and by the time the
plan was wrong there were four worktrees, four branches and four running agents built on
it. A plan file is cheap to throw away. A worktree is not.

When several tasks are being planned at once, plan them all, show all the paths, and let
the human approve them in one pass.

## Creating a worktree

One command, from the main checkout:

```bash
pw wt EROS-696-onboarding-work-area
```

That branches off the configured base branch, copies the gitignored files the tooling
needs, installs, adds the folder to the VS Code workspace, starts the dev server and
prints its URL. `pw rm <name>` reverses all of it.

Never do this by hand with `git worktree add`. The gitignored files are the whole problem:
`git worktree add` only materialises tracked files, so a missing `playwright/.auth` shows
up later as a module resolution error that points nowhere near the real cause.

Worktrees are **siblings** of the repo, never nested inside it. A nested worktree leaves a
gitlink that gets committed by accident, which has already happened once.

The slug carries the task id **and** a short title:
`EROS-696-onboarding-work-area`, never `EROS-696`, which is unreadable a day later in a
file picker or an editor's folder list.

## Sessions

The worktree name is the session name. One tmux session per repo, one window per task, so
a single `tmux attach -t pw-<repo>` reaches every task.

| Keys | Does |
| --- | --- |
| `Ctrl-b w` | window list, pick a task |
| `Ctrl-b n` / `Ctrl-b p` | next / previous task |
| `Ctrl-b d` | detach, everything keeps running |
| `Ctrl-b z` | zoom the focused pane fullscreen, again to unzoom |

`pw agent kill` on the **last** running window takes the whole tmux session with it, since
tmux drops a session when its final window closes. The other agents are not lost: their
transcripts live outside tmux, and a Claude session comes back with
`claude -r <session-id>` run inside that worktree.

## Permissions

Children launch with `--permission-mode auto`. A child has nobody at its keyboard, so a
permission dialog is a deadlock, not a safeguard. Override per launch with `PW_MODE`.

### The file-writing tools are granted explicitly, and must stay that way

`pw` puts `Write` / `Edit` / `MultiEdit` / `NotebookEdit` on `--allowedTools` at launch.
Leave them there. Under a stricter mode set through `PW_MODE` (`dontAsk`), anything not on
that list is denied outright, and a child sent to implement a ticket reads the whole
codebase, writes a plan, then gets

> `Permission to use Write has been denied because Claude Code is running in don't ask mode.`

on its first file. Hours of context, zero lines written. Never "fix" a blocked child by
telling it to write via a bash heredoc. That is exactly the workaround the escalation
clause forbids.

- Read-only session (audit, review, research)? `PW_EDIT_TOOLS= pw agent start <name>`.
  For QA specifically, `pw qa <name> --agent` already does it: launched with
  `PW_EDIT_TOOLS=` empty, Bash on, in its own `<name>-qa` window of the same session.
- **`Bash` is not granted.** A child cannot run its own tests, typecheck or lint, and will
  say so at the end of its run. Run them yourself in its worktree and send it the results.
- `mcp__*` is **not** a working pattern. It grants nothing, silently, and each MCP tool
  then prompts individually. Grant at the **server** level, e.g.
  `mcp__plugin_atlassian_atlassian`. Override with `PW_MCP="mcp__server_a mcp__server_b"`.

### Migrations

Children may write inside `drizzle/`, because denying it caused more hand-fixing than it
prevented. The rule that replaces the deny goes in every kickoff prompt for a task that
touches the schema:

> Generate migrations with `bun db:generate --name=<descriptive_name>`. Never hand-write a
> file in `drizzle/`. You may edit what it generated (a `USING` clause, a backfill, seed
> data) and you may add seeds. Never run `db:migrate:*` or `db:push:*`.

A hand-written `.sql` is detectable: `drizzle/meta/_journal.json` is maintained by
drizzle-kit, so a migration file with no matching journal entry was not generated. Check it
before trusting a schema change.

Applying migrations is already impossible for children: `bun db:migrate:*`, `bun db:push:*`
and `drizzle-kit push:*` are on the user-level `permissions.deny`, which is checked before
any allow and survives every permission mode.

### Escalation is the safety story

Every kickoff prompt must include this verbatim:

> If a tool is declined, do NOT invent a workaround, skip the step silently, or guess at
> what you could not read. Stop, and report exactly what was declined and what you needed
> it for. The human will run it and hand you the result.

Without it, a declined tool looks identical to a tool that returned nothing, and the child
writes a confident plan around a hole in its knowledge.

**Check `pw status` for a session that has stopped talking before trusting any result.** A
clean-looking answer from a blocked session is the failure mode to fear.

An agent cannot widen its own or a child's permissions, and must not try. Hand the user
the exact snippet or keys, say what it widens, and let them do it. Pre-grant at launch or
in settings, never mid-run: once a child is parked on a dialog only the human can clear it.

A useful `permissions.deny` encodes the project's hardest rules:

```json
"deny": ["Bash(rm:*)", "Bash(git push:*)", "Bash(git reset:*)", "Bash(git clean:*)",
         "Bash(bun db:push:*)", "Bash(bun db:migrate:*)", "Bash(drizzle-kit push:*)"]
```

Deny is checked before allow, so it survives every permission mode. It is pattern matching on command
strings, not a sandbox: it catches `rm -rf x`, not `sh -c 'rm -rf x'`. Real blast-radius
control is worktree isolation plus no push rights.

## Kickoff prompt

The first message is the only context a session gets for free. It must include:

- **Its plan file**, `spec/<task>/plan.md`. Point at the path, do not paraphrase it.
- Which files to read first: the repo's agent instructions, then the plan.
- Its boundary: which branch it owns, and the paths another task owns that it must not
  touch. Name them explicitly.
- What to return: a diff summary, questions, blockers.
- The escalation clause above, verbatim.
- The e2e rule: run **its own spec file only**, never the bare suite, and never at all for
  a visual change.
- That it ticks and strikes its plan checklist as it goes, so an interrupted run shows
  where it stopped.
- **That it does not commit.** See below.

### Children do not commit

Every kickoff prompt says this, verbatim:

> Do not commit on your own initiative. Leave your work uncommitted in the working tree so
> the human can review the diff. This is a default, not a prohibition: if the human asks you
> to commit, to ship, to open a PR, or invokes a command that does, then do it. Never answer
> an explicit request to commit by refusing.

The default exists because a child that commits as it goes hands back a branch whose history
has to be unwound before it can be read, and `git reset` is usually on the deny list, so
neither the child nor the conductor can undo it. The human ends up running the reset by
hand, which is the one thing the whole setup exists to avoid.

An explicit request is the opposite case. "commit this", "/ship", "open the PR" are the
human choosing, and a child that answers with "I am not allowed to commit" has turned a
sensible default into an obstruction. The default governs what it does unprompted, nothing
more.

The plan file is worth naming explicitly if you want it committed up front, because it is
the durable artifact rather than the work. Say so in the prompt when you do.

Uncommitted also keeps `pw status` honest: uncommitted count is what it reports, and work
buried in commits reads as a clean tree.

### Never read the input box, never append to it

`pw agent send` clears the box before it types. Do not work around that, and never inspect
the box to decide what to send.

The CLI fills the input with a suggested next message. In a `capture-pane` that ghost text
is byte for byte identical to something the human typed, so "there is text here, I will
append rather than clobber it" is not a safe move: it is a coin flip on whether the agent
receives an instruction nobody gave. It has already gone wrong. A suggestion reading
`commit all of it` was treated as the human's, got appended to, and the agent committed a
working tree that was still being reviewed. Three earlier sends carried the same kind of
phantom prefix.

Every prompt goes out standalone and self contained. If the human was mid sentence, they
lose a line they can see is gone and retype it. That is strictly cheaper than an invisible
instruction that already ran.

The same applies to reading a pane for any decision, not just sending. `pw agent see` shows
you what the agent said. It does not show you what the human intends.

**Do not write kickoff or hand-off notes into the worktree yourself.** They land in the
human's git status, in their editor's source control panel, and eventually in a pull
request. `pw agent send` already handles a multi-line prompt: it parks the text in
`.pw-prompts/`, which pw excludes from git, keeps the last few for retracing, and points
the agent at the path. A file is needed at all only because a newline inside `send-keys`
submits, so a multi-line message would otherwise fire as several half-prompts. Both backends
do this, and anything over about 300 characters is parked too, because the agent's input box
collapses a long paste and can drop its start. That was the cause of kickoffs arriving cut off.

`pw agent send` also refuses to type when the agent is still starting or sitting on a dialog,
and says so instead of losing the message. A working agent still accepts it and queues it. A
plan that is untracked in the main checkout is not in a fresh worktree: copy it in before the
kickoff, or the agent will report it found no plan.

The plan file is the durable artifact. Everything else is a prompt.

## Design fidelity: `pw qa`

`pw qa <name>` checks a finished worktree against its own plan. Two lanes and one gate.

**Spec lane**, always: the plan's checklist, the files actually changed against the base
branch and in the working tree, and the repo's test, typecheck and lint scripts. A task
with no `## Design` section stops there and never calls Figma.

**Visual lane**, only when the plan pins a design. Every manifest row is exported from
Figma, screenshot from the worktree's own dev server at the matching route and state, and
diffed. qa starts the dev server itself if it is not up.

### What the manifest looks like

```markdown
## Design

Figma file: WdGzjurMa53pyVeu1cU5I9
Mobile 390x844.

| node | url | component | viewport | state |
| --- | --- | --- | --- | --- |
| 4263:32210 | /candidate/resume | CandidateResumeSection | mobile | default |
| 4263:33001 | /candidate/resume | CandidateResumeSection | mobile | setup:resume-filled |
| 2917:57231 | | MobileHeader | | reference |

### Assets

| node | file |
| --- | --- |
| 4263:32215 | src/assets/images/resume-empty-state-illustration.png |
```

`state` is `default`, `hover:<selector>`, `focus:<selector>`, `setup:<module>` for a
`playwright/qa-states/<module>.ts` helper that drives the page, or `reference`. A setup
module that throws fails the row: shooting the default state instead would compare the
wrong screen against the design and pass. Arbitrary page driving belongs in reviewable
repo code, not in a table cell.

`reference` rows are pinned so the worker must consult them, and their assets are still
verified. They are never screenshot. Only a `FRAME` whose size is exactly the row's
viewport is diffable, decided by Figma's own node type: a `COMPONENT_SET` is a variants
board with no url, a wide short frame is a banner, and a native file picker is something a
browser cannot draw. A diffable row pointing at any of those is refused with that message
rather than producing a diff nobody trusts.

### The gate

- **Fails the run**: an asset that no longer matches a fresh export of its node, an asset
  file that is not on disk, an asset row with no node id, a node that cannot be fetched, a
  refused row, a state that could not be reached.
- **Reported, exits 0**: the layout pixel ratio. Font smoothing, animation frames and real
  data all move that number without anything being wrong. Design drift, a fresh render
  against the copy cached beside the plan, is reported the same way: it means the design
  moved after the plan was written.

### Three ways to run it

Findings go to `spec/<task>/qa-findings.md`, newest run replacing the last. The design, app
and diff images live under `~/.parallel-work/qa/`, out of the human's git status.

| Command | Does |
| --- | --- |
| `pw qa <name>` | runs the checks, writes the findings file, stops |
| `pw qa <name> --agent` | plus a reviewer in a `<name>-qa` window, given the failing rows only |
| `pw qa <name> --tell` | plus one line to the worker pointing at the findings file |

Both flags interrupt somebody, which is why neither is the default. The reviewer launches
with `PW_EDIT_TOOLS=` empty and Bash on: it reads the plan, the diff and both images of
each failing row, and reports. It cannot edit the worktree it is judging, because a
reviewer that can edit fixes what it finds instead of reporting it. **A clean run launches
no agent and sends nothing.**

`--tell` sends a pointer, never the findings themselves: a long multi-line paste into a TUI
is how the prompt gets mangled. It resolves the worker by window name only, since the
reviewer runs in the same directory and would otherwise catch the worker's message.

`pw qa` needs `FIGMA_API_KEY` for the visual lane. It is exported from `.zshrc`, so it
reaches interactive shells only; qa says what is missing rather than skipping the lane.

## Before handing work back: the converge pass

Tell each session to finish with this, and do it yourself when you are the one working:

1. Nothing committed unless the human asked for it. The diff sits in the working tree for
   them to read.
2. `pw qa <name>`, which runs `test`, `typecheck` and `lint` in that worktree and checks
   the design manifest at the same time. All green, or say what is not. Add `--tell` when
   you want the child to act on it, `--agent` when the failures need a second pair of eyes
   on the images.
3. Re-read its own `plan.md` and report three lists:
   - **Done**, ticked and true.
   - **Partial**, started and not finished, with what is missing.
   - **Outside the plan**, anything changed that the plan did not call for.
4. For UI work, the click path the human should follow. Not a summary of the change.
5. Delete the design cache before anything is committed: `rm -rf spec/<task>/assets/`.
   Those PNGs exist for the worker and the reviewer while the task is open. They are not
   a diff baseline (qa refetches) and the screenshot drift lane is not something we keep
   using, so they never ship. Do this in the worktree before `/ship`, and check
   `git status` shows no `spec/<task>/assets/` afterwards.

The last list is the one that matters. An agent that quietly reworked a file nobody asked
about is how a regression ships, and it will not volunteer that unless asked directly.

## Running them

- Run long sends in the background so this session is not blocked; report each result as
  it lands.
- Use `pw agent see <name>` to check on a session that looks stuck. A deep read plus an
  MCP pull runs several minutes; that is normal. Tell the user what the session is doing,
  not that it is "still running".
- Relay verbatim intent. When the user says "tell 614 to X", send X. Do not re-plan it
  here.
- Sessions run concurrently. What cannot: anything that writes shared state. Dev servers
  are fine, `pw` gives each worktree its own port. A shared local database is not, so each
  session runs only its own e2e spec and seed data must be unique per run.

## Reporting back

After each send, summarize: which session, what it did, what it asks. Keep the threads
visually separate. Never merge findings from two sessions into one narrative, the
isolation is the deliverable.

## Cleanup

`pw rm <name>` removes the worktree, its workspace entry, its dev server and the branch if
git says it is fully merged. It refuses while there are uncommitted changes or unmerged
commits.

Before removing anything, check the branch really is merged. `git cherry <base> <branch>`
listing zero `+` lines is the proof; a `git log` count is not, because a criss-cross merge
base distorts it. This nearly deleted six commits once.
