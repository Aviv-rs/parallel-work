# QA agent for design fidelity

Status: planned
Branch: feature/qa-agent-design-fidelity
CLI: https://github.com/Aviv-rs/parallel-work

## Overview

A worker agent finishes a ticket and nobody has checked it against the design. Today that
check is me re-reading Figma, which is where wrong illustrations and invented icons get
through. This adds a pinned design manifest to the plan file and a `pw qa` command that
verifies a worktree against it. Tooling only, no product code.

## Scenarios

- If the plan has no `## Design` section then qa runs the spec lane only: checklist boxes
  against the real diff, tests, types, lint. No screenshots, no Figma calls.
- If the plan has a `## Design` section then qa also runs the visual lane over its rows.
- If a row is `reference` then its assets are still verified and it is never screenshot.
- If a row names a state then qa reaches that state before shooting, and a `setup` module
  that throws fails the row loudly rather than shooting the default state.
- If a diffable row points at a `COMPONENT_SET`, or at a node whose size does not match its
  viewport, then qa says so and does not diff it.
- If an asset in the repo does not match a fresh export of its node then qa fails.
- If a manifest row names an asset file that is not on disk then qa fails.
- If a layout diff is over threshold then qa reports it and still exits 0.
- If a mobile row renders then both images are reduced to the content container and the
  chrome is removed before diffing.
- If the status bar cannot be found as a node then nothing is cropped off the top, so a
  screen without one keeps all its content.
- If the Figma frame carries a status bar, a home indicator or a stray cursor then the
  masking rule removes them before the diff.
- Edge: dev server down, qa starts it and waits, or says so and stops.
- Edge: no `FIGMA_API_KEY`, qa says what it needs instead of silently skipping the visual lane.

## Must not break

- `pw status` and the interactive board keep parsing plans that have no `## Design` section.
- `pw agent start|send|see|kill` behave exactly as now.

## Reuse

- `src/spec.ts` already finds and parses `plan.md`. Extend it, do not add a second parser.
- `src/dev-server.ts` for the worktree's own port, `src/tmux.ts` for the agent window.
- `playwright/.auth`, which `pw wt` already copies into every worktree.

## Design manifest

Lives in `plan.md`, so one file per task stays the rule.

```markdown
## Design

Figma file: WdGzjurMa53pyVeu1cU5I9
Mobile 390x844 unless a row says otherwise.

| node | url | component | viewport | state |
| --- | --- | --- | --- | --- |
| 4263:32210 | /candidate/resume | CandidateResumeSection | mobile | default |
| 4263:33xxx | /candidate/resume | CandidateResumeSection | mobile | setup:resume-filled |
| 2917:57231 | | MobileHeader | | reference |

### Assets

| node | file |
| --- | --- |
| 4263:32215 | src/assets/images/resume-empty-state-illustration.png |
```

An asset row without a node id is a planning bug. Without it there is nothing to re-export
against, and the check falls back to trusting the file that is already there.

### Cached reference images

Every pinned node is rendered at scale 1 into `spec/<task>/assets/<node-id>.png`, dashed id
so each file ties to exactly one manifest row. Committed with the plan.

They exist so the human reviewing the plan and the agent implementing it are looking at the
same picture, and because the S3 urls from `/v1/images` expire within the hour, so a link
pasted into a plan is dead by the time anyone follows it. Six frames for EROS-425 come to
312KB at scale 1.

They are never the diff baseline. qa always refetches from Figma at run time, because a
cached copy of the wrong node would quietly validate the wrong thing, which is the same
circularity that makes the repo's own assets unusable as truth.

Comparing the fresh fetch against the cached copy is worth doing for its own sake: a
difference means the design moved after the plan was written, and nothing in the workflow
notices that today.

### One screen, several states

A designer pins the empty state, the filled state, hover, active, and how the flow moves
between them. Those are rows at the same url, so the row has to say how to get there.
Anything left on `default` screenshots the route as it first loads.

| state | what qa does |
| --- | --- |
| `default` | load the url, shoot it |
| `hover:<selector>` | load, hover, shoot |
| `focus:<selector>` | load, focus, shoot |
| `setup:<module>` | run `playwright/qa-states/<module>.ts`, which drives the page, then shoot |
| `reference` | never shoot, never diff |

`setup` keeps arbitrary page driving in reviewable repo code instead of turning a table cell
into a script. Uploading a file, opening a drawer, seeding a row: all of it belongs there.

### One link, the whole flow

Feeding seven links by hand is the manual work this is supposed to remove. One is enough,
because the file's own structure carries the rest.

1. `/v1/files/:key?depth=2` once, cached. Pages and their top-level nodes, no deep content.
2. The given node's ancestor `SECTION` is the flow grouping. On the profile page the
   sections are `profile / general`, `profile / my details`, `Complete Your Profile`,
   `Settings screen`.
3. Inside the section, frames sit in rows: a wide short banner labels a row, and the screens
   for that step sit under it at device size. Same y, ascending x, is one flow.
4. Every frame in that row is a candidate row for the manifest. Classify each by node type
   and size, then let the human cut what does not belong.

Measured on `4263:32210`. Its section is `profile / general`, its row is at y 11817, and the
row holds the empty state that was given plus four more: a native OS file picker
(`6914:226205`), the filled state with Save and with Saved (`10022:65674`, `10022:65748`),
and the banner `3753:13300`, which reads "Resume - adding (replace is like adding)" and
settles a product question no screenshot would have answered.

Banners are worth reading, not just skipping. They carry the designer's intent for the row.

### Not every pinned node is a screen

Only diff a `FRAME` whose size matches the row's viewport. Everything else is `reference`:
pinned so the worker must consult it and so its assets are still verified, never diffed.

An OS overlay is the other case that must never be diffed. `6914:226205` renders the native
file picker over the screen, which a browser cannot produce at all.

Figma's own `type` decides the component case, no guessing. `2917:57231`, the mobile header, is a
`COMPONENT_SET` of 8 `COMPONENT` variants named `type=page title+back`,
`type=page title + save`, `type=page title + add`. A variants board has no url and diffing it
against a route is meaningless. Its value is telling the worker which prop combinations
exist. The banner node `4264:47291` is 9662x170 and holds a text label, and wide container
frames hold many screens side by side; both are reference too.

Validate this when the plan is written, not when the diff runs. A row marked diffable whose
node is a `COMPONENT_SET`, or whose dimensions do not match its viewport, fails with that
message instead of producing a garbage diff nobody trusts.

## Two lanes

**Spec lane**, always. Re-read the plan, check every ticked box against the diff, run test,
typecheck and lint, report what is done, partial, and changed outside the plan.

**Visual lane**, only when the manifest exists.

1. Export each node from Figma at scale 2 through the REST images endpoint.
2. One call to `/v1/files/:key/nodes?ids=<node>&depth=2` for the layer geometry, which is
   what the masking below is derived from.
3. Screenshot the same route from the worktree's dev server, iPhone 13 device profile for
   mobile rows.
4. Mask, then diff. Under threshold, drop it silently.
5. Only failing pairs reach the agent, which reads both images and the component and writes
   findings.

### Removing chrome, measured against node 4263:32210

REST has no `contentsOnly`, so the frame renders with its chrome. The app screenshot has no
status bar at all, so the two images are vertically offset until the chrome is gone.

A wrong crop shifts everything below it and reads as a total mismatch. A wrong mask only
blinds one region. So cropping is only ever done to bounds Figma itself reports, and
anything uncertain is masked instead.

1. Crop to the largest child by area, the content container. These are the frame's own
   reported bounds, so nothing real is lost. This alone drops the home indicator, which
   sits below it (content 0 to 810, indicator 810 to 844).
2. Remove the status bar only if it is found as a node: a descendant at the top edge, under
   50 high, named or instanced as a status bar, falling back to covering at least 80 percent
   of the frame width. Use its measured height, never a constant. If no such node is found,
   remove nothing and let the row diff as is.
3. Mask, do not crop, the boxes of the remaining visible children that overlap the content
   area. This is what catches the designer's cursor, a bare `Vector` 19x23 that no name rule
   would match, and a missed guess here costs one blinded rectangle rather than the row.

Hidden layers need no handling. A 390x301 confetti instance on that frame carries
`visible: false` and never reaches the render.

On this frame the status bar is a `Status bar` instance at (24,0) 342x43, nested three
levels inside the content container rather than being a sibling, and the real header starts
at y 47. Note it is 342 wide in a 390 frame, so a full width test misses it. A blind 44px
inset happens to work here and would eat real content on any screen that has no status bar.

## Gate

- Fails the run: asset mismatch against a fresh export, missing asset file, manifest row
  whose node cannot be fetched.
- Reports only, exits 0: layout pixel diff. Font smoothing, animation frames and real data
  all move that number without anything being wrong.

## Findings

`spec/<task>/qa-findings.md`, markdown, newest run replaces it. pw sends the worker a one
line pointer at the path, never the findings themselves. A long paste into a TUI is how the
multi-line prompt problems start.

## Plan

1. `src/spec.ts` add `parseDesign(markdown)` returning rows, asset rows and each row's
   state, null when the section is absent. Keep `parseSpec` untouched.
2. `src/figma.ts` new. Node and asset export through `/v1/images`, layer geometry through
   `/v1/files/:key/nodes`, authenticated with `FIGMA_API_KEY`. pw is a CLI with no MCP
   access, so REST is the only way it fetches anything itself.
3. `src/screenshot.ts` new. Playwright against the worktree's dev URL, device profile per
   row, reusing `playwright/.auth`. Resolves the row's state first: hover, focus, or a
   `playwright/qa-states/<module>.ts` helper.
4. `src/image-diff.ts` new. Content crop, measured status bar removal, sibling masks, then
   a pixel ratio. No model. Never crop to a constant.
5. `src/qa.ts` new. Lane selection, node type validation, the gate, and the findings file.
6. `src/cli.ts` add `pw qa <name> [--visual-only] [--spec-only]`.
7. `src/agent.ts` allow a QA session: read-only edits off, Bash on, own tmux window.
8. `skill/SKILL.md` document the manifest, the two lanes, the gate, and `pw qa`.
9. `~/.claude/skills/concise-plan/SKILL.md` require the `## Design` section for any task
   with a Figma link, and require a node id on every asset row.

## Checklist

- [x] ~~parseDesign in spec.ts, absent section returns null~~
- [x] ~~States: default, hover, focus, setup module, reference~~
- [ ] Node type validation, COMPONENT_SET and size mismatches refused at plan time
- [ ] Flow discovery from one node: section, row, banner, sibling frames
- [ ] Cached reference images written to spec/<task>/assets, never used as the baseline
- [ ] Design drift reported when a fresh fetch differs from the cached copy
- [ ] Figma REST export
- [ ] Playwright capture per row
- [ ] Content crop, measured status bar removal, sibling masks, diff
- [ ] Lane selection and gate
- [ ] pw qa in the CLI
- [ ] QA agent session mode
- [ ] Both skills updated

## Manual tests

- [ ] `pw qa` on a schema-only task runs the spec lane and never calls Figma
- [ ] `pw qa` on a task with a manifest produces a findings file
- [ ] Two rows on one url with different states shoot two different screens
- [ ] A reference row is never screenshot but its assets are still checked
- [ ] A diffable row pointing at 2917:57231 is refused with a readable message
- [ ] Discovery from 4263:32210 alone returns its four row siblings and the banner text
- [ ] Editing a frame in Figma after planning is reported as drift, not as a layout failure
- [ ] Swap an asset for the wrong illustration, qa fails and names it
- [ ] Delete an asset file, qa fails
- [ ] Node 4263:32210, whose frame carries a status bar, a home indicator and a cursor,
      does not trip the layout threshold
- [ ] A real spacing error does trip it
- [ ] Findings pointer arrives in the worker's tmux window
- [ ] `pw status` still parses a plan with no Design section

## Notes

`FIGMA_API_KEY` is exported from `.zshrc`, so it reaches interactive shells only. pw must
read it from the environment and say what is missing rather than skipping the visual lane
quietly.

Verified against node 4263:32210 before planning: the images endpoint returns the frame at
780x1688 for a 390x844 mobile screen at scale 2, hidden layers are omitted, and the layer
geometry needed for masking comes back in one `depth=2` call.
