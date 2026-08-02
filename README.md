# Roam Codex Lab

This repository is the minimum end-to-end development loop for the `maskys`
Roam graph:

```text
focused Roam block
        |
        v
Codex: Do this block
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

`Codex: Open chat` uses the focused ordinary Roam block when one exists. With
no focused block, it creates one visually empty ordinary block at the end of
the page or block open in the main window; from the Daily Notes log it uses today's Daily
Note. It opens that block through Roam's supported right-sidebar API and mounts
the extension-owned chat controls inside that exact native editable Block
Outline window. A fallback block is an extension-owned scratch prompt: closing
the native window removes that exact block after any active turn has finished.
Existing focused blocks are never cleared or deleted.

While the right sidebar is open, a small sparkle button appears immediately
beside Roam's native sidebar toggle. It invokes the same `openChatPanel`
workflow as the `Codex: Open chat` command-palette command. While a Codex panel
is active, the highlighted button and its accessible label switch to Close;
activating it again closes that panel. The launcher disappears with the sidebar
when that sidebar is closed.

Within that native window, the conversation sits above Roam's editable block
and the compact model, effort, Stop, and Send bar sits below it. The complete
extension-created fallback Block Outline is one composer. On Send, the extension
snapshots that exact outline, immediately removes every unchanged descendant,
resets the root to a visually empty temporary placeholder without losing its
UID, and focuses that root for the next message. Success keeps the empty
composer. Failure or Stop restores the submitted root and descendant hierarchy,
including their UIDs and order. If the user has already begun a new draft, that
newer draft wins and is never overwritten by restoration.

When chat opens on a user-owned outline, the extension first snapshots the UIDs
of its existing blocks. Those blocks remain protected source material. A new
block created afterward with ordinary Roam Enter behavior becomes a reusable
composer when submitted: its complete unchanged submitted outline disappears
immediately while its root UID, pre-existing parent, and siblings remain; it is
restored on failure or Stop under the same newer-draft guard.
Closing chat deletes only an untouched temporary placeholder; a real draft is
preserved.

The focused block in that sidebar window is the message composer, so Roam keeps
ownership of editing, autocomplete, `[[page references]]`, and
`((block references))`; the extension does not render a textarea or parallel
Read and Write inputs. An empty conversation shows no explanatory placeholder
or send-hint sentence. The first sent block starts a persistent Codex app-server
thread and later blocks resume it. The panel loads recent user messages and
final replies, streams concise progress, and gets model and reasoning-effort
choices from `model/list`. It selects the concrete default model and that
model's concrete default reasoning effort, marking each visible option with
`(Default)` instead of showing synthetic blank default entries.

The conversation title opens a graph-scoped history popover. `New chat` keeps
the existing Codex rollout and current Roam draft, clears only the panel's
active conversation and transcript, and carries the visible model and effort
into the next conversation. History is built only from thread IDs already
recorded for this graph; the bridge hydrates those exact IDs with `thread/read`
without listing or resuming unrelated Codex work.

User and Codex messages are rendered with Roam's native `renderString`
component. Page links, block references, and Roam formatting therefore behave
like ordinary non-editable Roam content in the transcript. The extension
unmounts those native components whenever the transcript changes or closes and
falls back to safe plain text if Roam's renderer is unavailable.
Each message also has a keyboard-accessible copy icon that appears on hover or
focus. It copies the exact source string passed to `renderString`, preserving
Roam links, references, formatting markers, newlines, and indentation rather
than copying transformed DOM text.

Persistent chat has direct read/write access to this one configured graph. It
does not write ordinary replies into Roam, but when the user explicitly asks
for a graph change it performs that change through Roam MCP and reports the
result in chat. There is no separate Apply stage. The structured `Do this
block` command remains a different workflow: it asks for a bounded plan and the
extension applies that plan through the browser API.

The model picker also controls graph access per conversation. `Auto` is the
default and answers App Server approvals for explicitly requested Roam changes.
`Read only` exposes only graph-reading tools. `Manual` exposes the write tools
but pauses each approval-requiring tool call in the transcript until the user
chooses Allow or Reject. The bridge answers App Server with the exact option
labels supplied by `item/tool/requestUserInput`; it does not treat the picker as
presentation-only state.

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
Roam MCP tool, including developer-extension reload commands. The bridge uses a
separate graph-scoped Roam connection for the runtime app-server, exposes graph
read/write tools to persistent chat, and narrows the structured `Do this
block` thread to its read-only tool list. Plugins and unrelated MCP servers are
disabled by default. The chat picker's Tools section lists configured Codex MCP
servers; explicitly enabled servers are saved in graph-synced extension
settings and added to non-read-only chat threads.

Runtime instructions are deliberately separate from builder instructions:

- [`runtime-agent.md`](./runtime-agent.md) is the plugin-owned contract for
  persistent chat.
- [`runtime-work-agent.md`](./runtime-work-agent.md) is the stricter read-only
  contract for `Do this block` planning.
- `[[roam/agent guidelines]]` remains the graph owner's place for graph-specific
  naming, structure, filing, and presentation preferences. The runtime reads it
  through `get_graph_guidelines` according to the Roam tool contract.
- The ordinary prompt block and its descendants are the task and immediate
  context for one turn.
- Bridge authentication, the fixed graph, sandbox, approval policy, and the
  per-mode MCP allowlists enforce capability. Prompt or graph text cannot widen
  them.

The app-server process and its threads run with a stable per-graph runtime
directory at `~/.roam-better-ai/graphs/<graph>/` as their `cwd`, not this
builder repository. The bridge checks the `instructionSources` returned by
every `thread/start` and `thread/resume`: user-global Codex guidance under the
active `CODEX_HOME` may apply, but any project instruction source is rejected.
This prevents this repository's `AGENTS.md`, project configuration, and
development skills from becoming part of the Roam agent's role.

## Prerequisites

- Roam Research Desktop with the `maskys` graph open.
- Node.js 20 or later.
- A signed-in Codex CLI (`codex --version` should work).
- Roam Developer Mode enabled.

This workspace was created against Codex CLI `0.144.4` and
`@roam-research/roam-mcp` `0.9.1`.

## One-time setup

### 1. Create a separate graph-scoped runtime Roam token

Keep the runtime token separate from personal Roam tokens. Persistent chat can
make graph changes when explicitly requested, so this connection requires full
access:

```bash
mkdir -p .dev/roam-home
HOME="$PWD/.dev/roam-home" \
  npx -y @roam-research/roam-mcp@0.9.1 connect \
  --graph maskys \
  --nickname maskys \
  --access-level full
```

Approve the token request in Roam Desktop. This creates ignored files beneath
`.dev/roam-home`; do not commit them. Keep only the intended graph in this
runtime profile. `bridge.mjs` controls which tools are available to persistent
chat and to the separate structured planning workflow.

### 2. Load this directory as a developer extension

In Roam Desktop, open Settings → Extensions, enable Developer Mode, and add this
repository directory:

```text
/Users/sheikmeeran/roam-extensions/roam-better-ai
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
2. Focus it and choose `Codex: Do this block` from the slash menu or the
   command palette. The block is the instruction; Codex carries it out and
   appends the result beneath. The previous `Work on ...` and `Probe ...`
   labels are removed; rebind any hotkey to the new label.
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
GET  /models
GET  /threads/:threadId/messages
POST /threads/summaries
     Authorization: Bearer <device-local token>
     {"graph":"maskys","threadIds":["..."]}
POST /pair
     Origin: https://roamresearch.com
POST /chat
     Authorization: Bearer <device-local token>
     {"graph":"maskys","message":"...","promptBlockUid":"abcdefghi","threadId":"optional"}
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
