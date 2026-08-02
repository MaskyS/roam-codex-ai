# Roam Codex development guide

This document contains the architecture, protocol, safety, and verification
detail intentionally omitted from the user-facing `README.md` shown by Roam
Depot.

## Product boundary

Roam owns editing and durable graph content. The browser extension owns the
visible integration, composer lifecycle, and temporary run marker. Codex makes
explicitly requested durable graph changes through the official Roam MCP.
`bridge.mjs` is a narrow authenticated adapter to `codex app-server`, and Codex
is the runtime agent.

```text
Roam Desktop
  ├─ extension.js ── native sidebar/composer, transcript, settings, run marker
  └─ 127.0.0.1 bridge
       └─ codex app-server
            └─ user's graph connection in ~/.roam-tools.json
```

There is no second agent framework. The bridge remains bound to `127.0.0.1`,
and the runtime never executes inside this builder repository.

## Source map

- `extension.js` — extension lifecycle, commands, chat panel, graph-scoped
  browser state, bridge requests, and temporary run-marker lifecycle.
- `extension.css` — panel and local running-state presentation.
- `bridge.mjs` — loopback HTTP authentication, App Server JSON-RPC client,
  runtime isolation, stream normalization, and request validation.
- `runtime-agent.md` — persistent-chat runtime contract.
- `runtime-work-agent.md` — direct graph-editing `Do this block` contract.
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

`Codex: Do this block` starts a separate ephemeral App Server turn and uses the
access mode selected in the panel. In Auto and Manual, Codex carries out the
requested result beneath the selected block through the same explicit Roam MCP
write-tool allowlist used by chat. Read only removes those write tools, so the
runtime must explain that graph-editing work needs a different access mode. The
runtime contract forbids rewriting or deleting the selected block.

## Research and graph presentation

Graph-only writing and organization should not browse. Work requiring current
or external facts must use live research and direct source URLs. If required
research is unavailable, the runtime returns no factual edits and a warning
instead of guessing.

The ordinary outline remains useful with comments closed. Durable results are
ordinary blocks. Sources, caveats, questions, and explanations belong in native
comments on the relevant source or generated block. The runtime groups direct
primary-source links in comments rather than adding source-list clutter to the
outline.

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

The CLI copies the files needed by the LaunchAgent to
`~/.roam-better-ai/app/<bridge-version>/` and writes that stable `bin.mjs` path
into the plist. The service must never point into `~/.npm/_npx/`; that cache is
an installation source, not a durable runtime location.

Every `thread/start` and `thread/resume` result is audited. User-global Codex
guidance under the active `CODEX_HOME` may apply; project instruction sources
are rejected. This prevents this repository's `AGENTS.md`, project config, and
development skills from becoming runtime instructions.

Roam credentials come from the user's existing `~/.roam-tools.json`. Pairing
checks for the active graph and starts the official Roam MCP connect flow when
it is absent. Stable graph-specific runtime directories keep App Server threads
separate; explicit access-mode tool allowlists enforce the capability boundary.

## Bridge pairing and graph identity

On a new installation, startup is unbound. The first approved pairing adopts
the active graph and persists that graph plus a random bearer token in
`~/.roam-better-ai/config.json`. On macOS, Pair opens a native consent dialog.
When native consent is unavailable, the bridge writes a short-lived fallback
code to `~/.roam-better-ai/pairing-code`; the code expires after five minutes,
permits five attempts, and is consumed by its first successful exchange.

`POST /pair` requires an allowed Roam origin, the active graph, and either the
approved native consent or fallback code. The bearer token is also stored in
graph-scoped browser `localStorage`. It is never saved in graph-synced extension
settings or printed by the CLI.

Every browser request carries graph identity in its JSON body where applicable
and as an encoded `X-Roam-Graph` header. The bridge rejects mismatches and the
panel offers to pair the bridge to the active graph instead. Settings accept
only an explicit
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

The bridge uses the user's normal Roam MCP connection store. Pairing starts the
connect flow automatically if the graph is missing; it can also be prepared
explicitly:

```bash
npx -y @roam-research/roam-mcp connect \
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

Start the bridge in the foreground for development:

```bash
npm start
```

To exercise the actual packaged-service path from a checkout, run
`node bin.mjs setup`. Confirm the plist targets
`~/.roam-better-ai/app/<bridge-version>/bin.mjs`, then use `node bin.mjs status`
and a `launchctl kickstart` cycle to verify automatic recovery.

Open the Codex panel, select Pair, and approve the native dialog. If the dialog
is unavailable, run `node bin.mjs code` and paste that fallback code into the
panel.

## Verification

The required local check is:

```bash
npm run check
```

For a live smoke test, use a disposable block and verify:

1. Extension reload succeeds explicitly.
2. Pairing adopts the active graph, persists it locally, and rejects fallback
   code replay.
3. The source block survives.
4. Chat sends, steers, stops, and restores drafts correctly.
5. `Do this block` writes through Roam MCP according to the selected access
   mode, preserves the source block, and removes its temporary running child.
6. Research adds linked primary sources in native comments.
7. Unload removes extension-owned DOM, listeners, observers, intervals, and
   native renderer mounts.
8. `.dev/last-run.jsonl` records complete failure classification, including an
   available HTTP status and detail, without a bearer token or pairing code.

Before a Depot release, repeat the complete setup on a clean client and a
non-development graph, test the URL/PR-shorthand install path, and review the
exact pinned source commit.

## Primary documentation

- [Roam Depot extensions](https://roamdocs.fyi/developer-documentation/roam-depot-extensions)
- [Roam Depot Extension API](https://roamdocs.fyi/developer-documentation/roam-depot-extension-api)
- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [Roam Depot repository](https://github.com/Roam-Research/roam-depot)
