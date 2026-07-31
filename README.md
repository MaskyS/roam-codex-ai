# Roam Codex Lab

This repository is the minimum end-to-end development loop for the `maskys`
Roam graph:

```text
focused Roam block
        |
        v
Codex: Work on this block
        |
        v
localhost bridge -> Codex app-server -> block + prior comments
        |
        v
append-only outline edits + native comments when needed
```

The current interaction streams concise app-server progress while intentionally
omitting persistent thread mapping and automatic comment watching. It proves
the unfamiliar seams while keeping failures easy to locate.

## What is implemented

- `extension.js`: Roam slash-command and command-palette affordances.
- `extension.css`: local-only running-state presentation.
- `bridge.mjs`: authenticated loopback HTTP plus a minimal app-server client.
- `.codex/config.toml`: full Roam MCP access for builder tasks in this repo.
- `.dev/last-run.jsonl`: an ignored, local trace of the latest experiments.
- `AGENTS.md`: the builder/runtime boundary and the improvement loop.

The runtime agent reads the graph and prior comments, then returns a bounded,
flat edit plan. The extension appends that plan beneath the invoked block.
Questions, caveats, and explanations use Roam's supported comment API on the
most relevant source or newly created block.

Research is contextual rather than automatic:

```text
graph-only writing or organization -> no web search
current or external facts          -> live web research + linked sources
required research unavailable      -> no factual edits + warning comment
```

For researched work, the runtime must provide direct `http(s)` source URLs.
The bridge validates them, and the extension adds a grouped native source
comment to the particular generated block each source supports. It does not
cite search results, AI summaries, or sources the runtime did not inspect.
The outline remains the working surface: Codex may use contextual Markdown
links when they make an instruction easier to understand or act on. Source
lists, verification details, uncertainty, and discussion remain in comments.

While Codex is working, the extension creates one temporary
`[[Codex/running]]` child beneath the invoked block. It deletes that exact,
extension-owned block after success or failure. A device-local list of those
generated UIDs lets extension startup clean up a status left behind by a crash,
without scanning or deleting unrelated graph content. Beside that block, an
extension-owned DOM badge shows a spinner, elapsed timer, concise reasoning
summaries, semantic activity such as reading graph context or checking a web
source, and a Stop button. The bridge requests `summary: "concise"` and
forwards only the readable app-server summaries—not raw reasoning text. The
top row holds the spinner, timer, and Stop action; the summary wraps below it.
Badge and timer changes
stay in the browser DOM; they never call `block.update`, so Roam sees only the
temporary block's initial create and final delete. Extension unload removes the
badge and interval. Run IDs, Codex thread IDs, and failures stay in local
diagnostics or transient toasts.

Builder tasks inherit the user's ordinary read/write Roam connection and every
Roam MCP tool, including developer-extension reload commands. When the bridge
launches the runtime app-server, command-line configuration overrides restore
the separate read-only token, six-tool allowlist, and disabled unrelated MCP
servers/plugins. Thus builder capability does not broaden ambient task-agent
authority.

## Prerequisites

- Roam Research Desktop with the `maskys` graph open.
- Node.js 20 or later.
- A signed-in Codex CLI (`codex --version` should work).
- Roam Developer Mode enabled.

This workspace was created against Codex CLI `0.144.4` and
`@roam-research/roam-mcp` `0.9.1`.

## One-time setup

### 1. Create a separate runtime Roam token

Keep the runtime token separate from personal Roam tokens and request the
smallest available scope:

```bash
mkdir -p .dev/roam-home
HOME="$PWD/.dev/roam-home" \
  npx -y @roam-research/roam-mcp@0.9.1 connect \
  --graph maskys \
  --nickname maskys \
  --access-level read-only
```

Approve the token request in Roam Desktop. This creates ignored files beneath
`.dev/roam-home`; do not commit them. Roam decides the actual grant at approval
time. If it grants broader access, `bridge.mjs` still starts the runtime with
only the six read-only Roam tools, but token-level read-only access is the
stronger boundary.

### 2. Load this directory as a developer extension

In Roam Desktop, open Settings → Extensions, enable Developer Mode, and add this
repository directory:

```text
/Users/sheikmeeran/Documents/Roam Better AI
```

Roam loads the default export in `extension.js`. After edits, run:

```bash
npx -y @roam-research/roam-cli@0.9.1 \
  reload-dev-extensions --graph maskys
```

The keyboard equivalent is `Ctrl-D Ctrl-R`.

### 3. Start and pair the bridge

Start the bridge:

```bash
npm run dev
```

In Roam's command palette, run `Codex: Pair local bridge`. The extension asks
the loopback bridge for its random bearer token. The pairing endpoint accepts
only an allowed Roam origin, and the extension stores the token in browser
`localStorage`, not graph-synced extension settings. Then run
`Codex: Check local bridge`.

`npm run show-token` remains available for diagnostics, but normal pairing does
not expose or copy the token.

## Run the first experiment

1. Write an ordinary request or question as a Roam block.
2. Focus it and choose `Codex: Work on this block` from the slash menu, or
   `Codex: Work on focused block` from the command palette.
   The previous `Codex: Probe selected block` and
   `Codex: Probe focused block` labels remain as aliases.
3. A `[[Codex/running]]` child appears with a local spinner, elapsed timer, Stop
   button, and evolving concise progress summary while the bridge is working.
4. Codex's durable result appears as ordinary child blocks at the invocation
   point, and the running child disappears.
5. When the task needs current or external facts, relevant result blocks get a
   native comment containing clickable primary-source links.
6. If Codex has a question or caveat, it becomes a native comment on the
   relevant source or generated block and Roam opens that comment in the right
   sidebar.
7. Add a normal comment when you want to supply follow-up context, then invoke
   the command on the original block again.
8. Inspect `.dev/last-run.jsonl` if anything failed.

For an uncomplicated result, the outline becomes:

```text
- Your request block
    - Useful result
        - Supporting detail
            - comment: **Codex** — Sources
                - [Official source](https://example.gov) — Supporting evidence
```

There are no proposal wrappers, interpretation headings, run IDs, thread IDs,
or completion markers. Comments are ordinary Roam graph blocks under Roam's
comment structure; the supported API owns that structure and opens the native
comment interface.

## Local API

The bridge binds only to `127.0.0.1:47321`.

```text
GET  /health
POST /pair
     Origin: https://roamresearch.com
POST /probe
     Authorization: Bearer <device-local token>
     {"graph":"maskys","blockUid":"abcdefghi"}
POST /runs/:runId/cancel
     Authorization: Bearer <device-local token>
```

`POST /pair` returns the device-local bearer token only to an allowed Roam
origin. `POST /probe` returns an authenticated NDJSON stream containing a start
event, normalized progress events, and one completed result or error. The
bridge validates the request origin, graph, token, body size, block UID, and
one-active-run-per-block constraint. The cancel endpoint maps the local run ID
to its app-server thread and turn, sends `turn/interrupt`, and reports an
interrupted outcome without applying an edit plan.

## Verification

Run the static checks and tests:

```bash
npm run check
```

The bridge uses the JSON-RPC handshake and v2 method names generated by the
installed Codex CLI: `initialize`, `initialized`, `thread/start`, `turn/start`,
`item/reasoning/summaryTextDelta`, `item/started`, `item/completed`,
`turn/interrupt`, `turn/completed`, and `thread/unsubscribe`.

## Why this is the bootstrap

The first loop is deliberately inspectable:

```text
use -> notice friction -> comment in Roam -> edit this repo
  ^                                               |
  +-------------- reload -> ask -> observe -------+
```

Once this is reliable, the next useful experiments are automatic comment
follow-ups and persistent block-to-thread mapping. Live cards, broad watchers,
and autonomous graph writes remain outside this prototype.
