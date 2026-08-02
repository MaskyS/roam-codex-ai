# Roam Codex development guide

This document contains the architecture, protocol, safety, and verification
detail intentionally omitted from the user-facing `README.md` shown by Roam
Depot.

## Product boundary

Roam owns editing and durable graph content. The browser extension owns the
visible integration and all writes made through the signed-in user's Roam
session. `bridge.mjs` is a narrow authenticated adapter to `codex app-server`;
Codex is the runtime agent, and the official Roam MCP is its graph adapter.

```text
Roam Desktop
  ├─ extension.js ── native sidebar/composer, transcript, settings, graph writes
  └─ 127.0.0.1 bridge
       └─ codex app-server
            └─ graph-scoped Roam MCP connection
```

There is no second agent framework. The bridge remains bound to `127.0.0.1`,
and the runtime never executes inside this builder repository.

## Source map

- `extension.js` — extension lifecycle, commands, chat panel, graph-scoped
  browser state, bridge requests, and application of structured block work.
- `extension.css` — panel and local running-state presentation.
- `bridge.mjs` — loopback HTTP authentication, App Server JSON-RPC client,
  runtime isolation, stream normalization, and request validation.
- `runtime-agent.md` — persistent-chat runtime contract.
- `runtime-work-agent.md` — stricter structured `Do this block` contract.
- `test/bridge.test.mjs` and `test/extension.test.mjs` — protocol, safety,
  lifecycle, and UI contract tests.
- `.dev/last-run.jsonl` — ignored local trace for the latest bridge activity.
- `AGENTS.md` — builder instructions and required research/verification loop.

## Chat ownership and lifecycle

`Codex: Open chat` uses a focused ordinary block when possible. Otherwise it
creates a visually empty scratch block on the current page or Daily Note and
opens that block with Roam's supported right-sidebar API. Roam's native Block
Outline remains the editor, preserving page references, block references,
autocomplete, keyboard behavior, and nested outlines.

The extension snapshots the submitted outline before clearing an
extension-owned composer. A successful send keeps the composer empty. Failure,
Stop, or a rejected steer restores the submitted UIDs, hierarchy, and order
unless the user has already written a newer draft. Existing source blocks are
protected and are never cleared or deleted. Closing chat removes only an
untouched extension-created placeholder.

The first message starts a persistent App Server thread; later messages resume
it. During an active turn, Send becomes Steer and calls `turn/steer` with the
exact active turn precondition. Stop maps to `turn/interrupt`. A race in which
the turn ends before steering restores the draft and sends it as a normal next
turn after the active run settles.

Conversation history is graph-scoped and contains only thread IDs indexed in
that graph. The bridge reads those exact threads without listing or resuming
unrelated Codex work. Messages use Roam's native `renderString`; every native
renderer mount is unmounted when its transcript changes or closes.

## Graph access and tools

Access is selected per conversation:

- **Auto** exposes the explicit chat write-tool allowlist and answers expected
  Roam write approvals.
- **Read only** exposes only graph-reading tools.
- **Manual** exposes writes but pauses approval-requiring calls until the user
  chooses Allow or Reject in the transcript.

The runtime defaults to the `roam` MCP server only. The Tools picker enumerates
other configured Codex MCP servers; graph-synced settings record explicit
opt-ins. The bridge disables every server except `roam` and those opt-ins on
each runtime thread.

Structured `Codex: Do this block` is a separate read-only runtime workflow. It
returns a bounded edit plan, which the extension applies beneath the selected
block through the browser API. It never rewrites or deletes the selected block.

## Research and graph presentation

Graph-only writing and organization should not browse. Work requiring current
or external facts must use live research and direct source URLs. If required
research is unavailable, the runtime returns no factual edits and a warning
instead of guessing.

The ordinary outline remains useful with comments closed. Durable results are
ordinary blocks. Sources, caveats, questions, and explanations belong in native
comments on the relevant source or generated block. The extension groups
validated primary-source links in comments rather than adding source-list
clutter to the outline.

`Codex: Do this block` creates one temporary `[[Codex/running]]` child and
deletes that exact extension-owned block after success, failure, or Stop. An
extension-owned DOM badge shows elapsed time and concise App Server summaries;
it never repeatedly updates the Roam block. Raw reasoning, run IDs, thread IDs,
and errors stay out of graph content.

## Runtime isolation

Each graph uses a stable runtime directory under:

```text
~/.roam-better-ai/graphs/<graph-identity>/
```

Lowercase filesystem-safe graph names retain a readable directory. Other names
use a bounded readable prefix plus a digest of the exact name so Unicode,
case-only, and long graph names remain distinct on macOS filesystems.

Every `thread/start` and `thread/resume` result is audited. User-global Codex
guidance under the active `CODEX_HOME` may apply; project instruction sources
are rejected. This prevents this repository's `AGENTS.md`, project config, and
development skills from becoming runtime instructions.

The runtime Roam connection is separate from the builder's normal connection.
Keep only the intended graph in `.dev/roam-home`; workflow and access-mode tool
allowlists enforce the runtime capability boundary.

## Bridge pairing and graph identity

Normal startup requires an explicit `ROAM_GRAPH`. The bridge creates a random
bearer token under ignored `.dev/` and prints only a short-lived pairing code.
The code expires after five minutes, permits five attempts, and is consumed by
its first successful exchange.

`POST /pair` requires an allowed Roam origin, the exact active graph, and the
one-time code. The bearer token is stored only in graph-scoped browser
`localStorage`. It is never saved in graph-synced extension settings or printed
during normal startup. `npm run show-token` is the explicit diagnostic escape
hatch.

Every browser request carries graph identity in its JSON body where applicable
and as an encoded `X-Roam-Graph` header. The bridge rejects mismatches with an
actionable restart message. Settings accept only an explicit
`http://127.0.0.1:<port>` endpoint with no credentials, path, query, or hash.

## Local bridge API

The default endpoint is `http://127.0.0.1:47321`.

```text
GET  /health
GET  /models
GET  /mcp-servers
GET  /threads/:threadId/messages
POST /threads/summaries
POST /threads/:threadId/name
POST /pair
POST /chat
POST /probe
POST /runs/:runId/steer
POST /runs/:runId/cancel
POST /runs/:runId/approvals/:approvalId
```

Except for health and pairing, routes require the device-local bearer token.
The bridge validates origin, graph, token, body size, identifiers, and route
state. Chat and probe return authenticated NDJSON streams. Cancellation maps a
local run to `turn/interrupt`; steering maps it to `turn/steer` with
`expectedTurnId`.

The bridge speaks the App Server JSON-RPC protocol over stdio. Exact request
and notification shapes must be checked against both the current official App
Server documentation and bindings generated from the installed CLI:

```bash
codex app-server generate-ts --out /tmp/codex-app-server-schema
```

## Development setup

Create a dedicated runtime Roam profile:

```bash
mkdir -p .dev/roam-home
HOME="$PWD/.dev/roam-home" \
  npx -y @roam-research/roam-mcp@0.9.1 connect \
  --graph "your-graph-name" \
  --nickname "your-graph-name" \
  --access-level full
```

Load the repository folder from Roam Settings → Roam Depot → Developer
Extensions. Reload through the supported CLI when testing a code change:

```bash
npx -y @roam-research/roam-cli@0.9.1 \
  reload-dev-extensions --graph "your-graph-name"
```

Start the bridge with the same exact graph name:

```bash
ROAM_GRAPH="your-graph-name" npm start
```

Run `Codex: Pair local bridge`, enter the terminal code, and then run
`Codex: Check local bridge`.

## Verification

The required local check is:

```bash
npm run check
```

For a live smoke test, use a disposable block and verify:

1. Extension reload succeeds explicitly.
2. Pairing works once and rejects replay.
3. The source block survives.
4. Chat sends, steers, stops, and restores drafts correctly.
5. `Do this block` shows and removes its temporary running child.
6. Research adds linked primary sources in native comments.
7. Unload removes extension-owned DOM, listeners, observers, intervals, and
   native renderer mounts.
8. `.dev/last-run.jsonl` contains no bearer token or pairing code.

Before a Depot release, repeat the complete setup on a clean client and a
non-development graph, test the URL/PR-shorthand install path, and review the
exact pinned source commit.

## Primary documentation

- [Roam Depot extensions](https://roamdocs.fyi/developer-documentation/roam-depot-extensions)
- [Roam Depot Extension API](https://roamdocs.fyi/developer-documentation/roam-depot-extension-api)
- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [Roam Depot repository](https://github.com/Roam-Research/roam-depot)
