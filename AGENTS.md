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

The structured `Do this block` runtime reads Roam through its read-only MCP
allowlist and returns a bounded edit plan; `extension.js`, running under the
signed-in human's Roam session, applies that plan. Persistent chat uses its
separate allowlist and may make explicitly requested graph changes according to
the selected access mode. Runtime agents may use built-in live web search when
a task depends on current or external facts, but must not edit this repository
or invoke shell commands.

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

- Required first-turn gate: for every nontrivial implementation, debugging,
  review, or design task in this integration, the first substantive discovery
  turn must actually open and read both (a) the applicable current Roam
  documentation on `https://roamdocs.fyi` and (b) the current official Codex
  App Server API at `https://learn.chatgpt.com/docs/app-server`. Do this before
  forming a plan, reviewing an implementation, or editing code. Merely knowing,
  citing, or intending to use these sources does not satisfy the gate; if they
  were not read in the first substantive turn, the task's discovery contract
  has failed. The only exceptions are local prose-only edits and graph-only
  transformations whose behavior does not touch the integration.
- Be proactive about research. When behavior may depend on a current API,
  recent product change, known bug, or unfamiliar integration detail, look it
  up before designing or editing. Do not wait for the user to suggest the
  relevant documentation.
- For any work that touches Roam behavior, go read the applicable current pages
  on `https://roamdocs.fyi` before designing or editing. This includes Roam's
  components and interaction behavior generally—not only the Roam Depot
  Extension API and Roam Alpha API. Read the specific block, outline, command,
  focused-block, pull-watch, comments, sidebar, settings, rendering, or
  developer-extension guidance relevant to the change; do not infer supported
  behavior from DOM appearance alone.
- Also use the official `roam-tools` / Roam MCP and Roam CLI documentation when
  the task concerns graph tools, comments, permissions, or extension reloads.
  Prefer the supported API or CLI over DOM automation. Verify reloads from the
  explicit command result or changed live behavior; a silent keyboard shortcut
  is not proof that new code loaded.
- When a task concerns planned work, current priorities, or an implementation
  already in progress, read the repository's relevant open GitHub issues and
  recent comments, then inspect the current worktree and other active worktrees
  before designing or editing. Treat concurrent work as shared state. Skip this
  issue review for isolated changes whose contract is already clear from the
  code and tests.
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
- Use a separate graph-scoped runtime Roam token. Persistent chat requires the
  graph access needed for explicitly requested writes; capability is narrowed
  by the per-workflow and per-access-mode allowlists in `bridge.mjs`, not by
  copying the builder connection into the runtime.
- Builder tasks may use every Roam MCP tool through the user's normal
  connection. The structured `Do this block` workflow must keep its runtime
  Roam tools read-only. Persistent chat may expose only its explicit tool list:
  Read only hides write tools, while Auto and Manual expose writes under their
  documented consent behavior. Other MCP servers remain disabled unless the
  user explicitly enables them in Tools.
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
