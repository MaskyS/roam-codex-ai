# Roam Codex Lab

This repository is the builder workspace for a deliberately small Roam/Codex
prototype.

## Product boundary

- Roam is the interface and the place where experiments are recorded.
- `bridge.mjs` is a narrow localhost adapter to `codex app-server`.
- Codex is the runtime agent.
- The official Roam MCP is the graph adapter.
- Do not add a second agent framework.

## First vertical slice

The prototype is successful when a focused block in the `maskys` graph can run
`Codex: Work on this block`, briefly show a `[[Codex/running]]` child, and
receive useful appended outline blocks beneath the focused block. When the run
finishes, the temporary running child must be deleted.

The runtime agent reads Roam through the allowlisted MCP tools and returns a
bounded edit plan. It may use built-in live web search when a task depends on
current or external facts. It must not write to Roam, edit this repository, or
invoke shell commands. `extension.js`, running under the signed-in human's Roam
session, owns the visible writes: append-only outline edits, linked source
comments, and other native comments.

## Development loop

1. Read `[[Codex Roam Lab]]` in the `maskys` graph when the task concerns
   recorded friction or the last experiment.
2. Make the smallest change that tests the current hypothesis.
3. Run `npm run check`.
4. Reload developer extensions with the Roam CLI or `Ctrl-D Ctrl-R`.
5. Exercise the changed behavior in Roam and inspect `.dev/last-run.jsonl`.
6. Record observed behavior and the next experiment in `[[Codex Roam Lab]]`.

## Safety

- Keep the bridge bound to `127.0.0.1`.
- Keep bearer tokens and traces under ignored `.dev/`.
- Prefer a read-only runtime Roam token. If Roam grants broader token scopes,
  keep the runtime's Codex MCP tool allowlist strictly read-only.
- Builder tasks may use every Roam MCP tool through the user's normal
  connection. Do not copy that authority into the app-server runtime; its
  restriction is applied explicitly by `bridge.mjs`.
- Do not enable Roam write, delete, move, update, raw Datalog, file, or UI tools
  for the runtime agent.
- Never rewrite or delete the user's selected block.
- The explicit command authorizes the extension to append descendants beneath
  the selected block. It does not authorize rewriting, moving, or deleting
  existing user blocks.
- Keep errors, run IDs, thread IDs, and timing out of graph content. The one
  permitted operational block is the temporary extension-owned
  `[[Codex/running]]` child, which must be deleted after success or failure.
- Present changing run state, including elapsed time, through extension-owned
  DOM only. Request concise app-server reasoning summaries and show those plus
  semantic tool activity; never expose raw reasoning text. Do not repeatedly
  update the temporary Roam block.
- Stop active work through app-server `turn/interrupt`. Treat interruption as a
  neutral stopped outcome, remove the temporary indicator, and apply no plan.
- Put durable results in the ordinary outline. Put sources, questions, caveats,
  and explanations in native comments on the most relevant source or generated
  block, opening the comments sidebar when any comment is added.
- Keep the outline useful with comments closed and allow contextual Markdown
  links where they improve understanding or actionability. Do not create source
  lists in the outline; render source metadata in native comments.
- Do not browse for work that is fully answerable from the graph, such as
  rewriting, organizing, extracting tasks, or continuing a draft.
- For current or external facts, require live research and direct source URLs.
  Prefer official and primary sources. If required research is unavailable,
  make no factual edits and leave a warning comment instead of guessing.
- Render validated research citations as a grouped native comment on the
  specific outline block they support.
- Preserve unrelated work in this repository and graph.

## Verification

Run:

```bash
npm run check
```

For a live smoke test, start the bridge, create or select a disposable block in
the `maskys` graph, and invoke the Roam command. A successful run must show the
temporary status while working, preserve the source block, append useful child
blocks, add linked primary sources when research is required, put conversational
material in native comments, and remove the temporary status when finished.
