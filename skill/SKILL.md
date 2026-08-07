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

Children launch with `--permission-mode dontAsk`. A child has nobody at its keyboard, so a
permission dialog is a deadlock, not a safeguard.

### `dontAsk` denies the file-writing tools too

This is the failure that bites hardest, because everything before it looks healthy.
`dontAsk` is not "prompt-free yes", it is **deny everything not on `--allowedTools`**.
`Write` / `Edit` / `MultiEdit` / `NotebookEdit` are not on that list by default, so a child
sent to implement a ticket reads the whole codebase, writes a plan, then gets

> `Permission to use Write has been denied because Claude Code is running in don't ask mode.`

on its first file. Hours of context, zero lines written. `pw` grants them at launch. Do not
remove them, and do not "fix" a blocked child by telling it to write via a bash heredoc.
That is exactly the workaround the escalation clause forbids.

- Read-only session (audit, review, research)? `PW_EDIT_TOOLS= pw agent start <name>`.
- **`Bash` is not granted.** A child cannot run its own tests, typecheck or lint, and will
  say so at the end of its run. Run them yourself in its worktree and send it the results.
- `mcp__*` is **not** a working pattern. It grants nothing, silently, and each MCP tool
  then prompts individually. Grant at the **server** level, e.g.
  `mcp__plugin_atlassian_atlassian`. Override with `PW_MCP="mcp__server_a mcp__server_b"`.

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
         "Bash(db:push:*)", "Write(drizzle/**)", "Edit(drizzle/**)"]
```

Deny is checked before allow, so it survives `dontAsk`. It is pattern matching on command
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

Write it to a file in the worktree and send that path. `pw agent send` does this for you
when the text is multi-line: a newline inside `send-keys` submits, so a multi-line message
would otherwise fire as several half-prompts.

## Before handing work back: the converge pass

Tell each session to finish with this, and do it yourself when you are the one working:

1. `test`, `typecheck`, `lint`. All green, or say what is not. The child cannot run these,
   so run them in its worktree and send the output back.
2. Re-read its own `plan.md` and report three lists:
   - **Done**, ticked and true.
   - **Partial**, started and not finished, with what is missing.
   - **Outside the plan**, anything changed that the plan did not call for.
3. For UI work, the click path the human should follow. Not a summary of the change.

The third list is the one that matters. An agent that quietly reworked a file nobody asked
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
