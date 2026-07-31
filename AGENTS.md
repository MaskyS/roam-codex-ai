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
`Codex: Do this block`, briefly show a `[[Codex/running]]` child, and
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
2. Read the relevant current primary documentation when the change touches a
   Roam or Codex protocol surface.
3. Make the smallest change that tests the current hypothesis.
4. Run `npm run check`.
5. Reload developer extensions with the Roam CLI or `Ctrl-D Ctrl-R`.
6. Exercise the changed behavior in Roam and inspect `.dev/last-run.jsonl`.
7. Record observed behavior and the next experiment in `[[Codex Roam Lab]]`.

## Documentation and research

- Be proactive about research. When behavior may depend on a current API,
  recent product change, known bug, or unfamiliar integration detail, look it
  up before designing or editing. Do not wait for the user to suggest the
  relevant documentation.
- For Roam extension work, start with the applicable pages on
  `https://roamdocs.fyi`, especially the Roam Depot Extension API and Roam Alpha
  API documentation. Read the specific command, focused-block, pull-watch,
  comments, sidebar, or developer-extension guidance relevant to the change;
  do not infer supported behavior from DOM appearance alone.
- Also use the official `roam-tools` / Roam MCP and Roam CLI documentation when
  the task concerns graph tools, comments, permissions, or extension reloads.
  Prefer the supported API or CLI over DOM automation. Verify reloads from the
  explicit command result or changed live behavior; a silent keyboard shortcut
  is not proof that new code loaded.
- For Codex runtime work, consult the current official Codex App Server API
  documentation at `https://learn.chatgpt.com/docs/app-server`. For exact
  request fields, notification payloads, and enums, also generate bindings from
  the installed CLI with `codex app-server generate-ts`; the installed protocol
  and current official documentation take precedence over memory.
- Prefer official and primary sources for technical claims. If the available
  sources conflict, state the conflict and verify the behavior against the
  installed version or a bounded live experiment before committing to a
  design.
- Research should be proportional. Do not browse merely to rewrite local text
  or perform a graph-only transformation whose behavior is already established
  by the code and tests. Do research whenever recency or external behavior can
  materially affect correctness.
- Before declaring a fix complete, inspect the relevant code path, run the
  focused tests plus `npm run check`, and verify the live seam involved: Roam
  UI/API behavior, bridge trace, app-server event stream, or extension reload.

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
