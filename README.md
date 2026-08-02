# Roam Codex

Use Codex from ordinary Roam blocks without giving up Roam's native editor.
Chat in the right sidebar, ask Codex to read or change the active graph, or run
a focused block as a structured task. Conversations stay attached to the graph
while Codex runs locally through its official App Server.

> **Pre-release:** Roam Depot distribution is not ready yet. The current beta
> requires this repository and a locally running bridge. A packaged bridge and
> in-panel setup/recovery flow are tracked before the Depot release.

## What you can do

- Open persistent Codex chat beside any Roam block.
- Keep writing with Roam's normal Block Outline, page references, block
  references, autocomplete, and nested blocks.
- Read the graph, research current information, and request graph changes.
- Choose Auto, Read only, or Manual graph access per conversation.
- Steer an active turn with another block instead of stopping and restarting.
- Stop a turn without losing the submitted outline.
- Reopen graph-scoped conversation history.
- Run `Codex: Do this block` to append a structured result beneath a focused
  block, with sources and caveats placed in native comments.

Codex replies remain in the chat panel unless the task explicitly writes to the
graph. The selected source block is never rewritten or deleted by `Do this
block`.

## Requirements

- Roam Research Desktop
- Node.js 20 or later
- A signed-in [Codex CLI](https://github.com/openai/codex)
- Roam Developer Mode while the extension is in beta

The current integration is tested with Codex CLI `0.144.4` and
`@roam-research/roam-mcp` `0.9.1`.

## Install the current beta

### 1. Get the extension and bridge

```bash
git clone https://github.com/MaskyS/roam-codex-ai.git
cd roam-codex-ai
```

No package installation or build step is required.

### 2. Connect a dedicated Roam runtime

Replace `your-graph-name` with the exact graph name shown in Roam:

```bash
mkdir -p .dev/roam-home
HOME="$PWD/.dev/roam-home" \
  npx -y @roam-research/roam-mcp@0.9.1 connect \
  --graph "your-graph-name" \
  --nickname "your-graph-name" \
  --access-level full
```

Approve the connection in Roam Desktop. This profile is separate from your
normal Roam tooling and should contain only the graph you intend Codex to use.

### 3. Load the developer extension

In Roam, open **Settings → Roam Depot**, enable Developer Mode, choose
**Load extension**, and select the cloned `roam-codex-ai` folder.

### 4. Start and pair the bridge

From the repository folder, start the bridge with the same graph name:

```bash
ROAM_GRAPH="your-graph-name" npm start
```

The terminal displays a short-lived pairing code. In Roam's command palette:

1. Run `Codex: Pair local bridge`.
2. Enter the terminal code.
3. Run `Codex: Check local bridge`.

The code expires after five minutes and works once. Restart the bridge to
generate a new code.

## Use chat

Run `Codex: Open chat` from the command palette, use the sparkle button beside
Roam's right-sidebar toggle, or press `Cmd-J` on macOS (`Ctrl-J` elsewhere).

1. Write the message in the native Block Outline inside the chat window.
2. Choose the model, reasoning effort, graph access, and optional tools.
3. Select **Send**.
4. While Codex is working, write another block and select **Steer** to redirect
   the same turn, or select **Stop** to interrupt it.

The conversation title opens history. **New chat** starts with the model and
access defaults configured under **Settings → Extensions → Roam Codex**.

## Run a focused block

Focus an ordinary block and choose `Codex: Do this block` from the slash menu or
command palette. Codex reads that outline as the task and appends the result
beneath the focused block.

A temporary `[[Codex/running]]` child appears while the task runs and is removed
after success, failure, or Stop. Research sources, questions, and caveats are
placed in native comments instead of cluttering the result outline.

## Access and settings

The chat picker controls graph access per conversation:

- **Auto** — allow graph changes that the user explicitly requests.
- **Read only** — expose only graph-reading tools.
- **Manual** — pause approval-requiring graph changes for Allow or Reject.

The Tools section can opt other configured Codex MCP servers into chat. They
are disabled by default. Read-only conversations never expose graph write
tools.

Roam's extension settings store only non-secret defaults:

- Local bridge URL
- Default access mode
- Default model
- Enabled optional MCP servers

The active graph always comes from Roam and is not a setting.

## Security and data

- The bridge accepts connections only on `127.0.0.1`.
- Pairing requires the allowed Roam origin, exact graph, and one-time code.
- The bearer token stays in graph-scoped browser `localStorage`; it is not
  written to graph content or graph-synced settings.
- Runtime files and Codex threads use a graph-specific directory under
  `~/.roam-better-ai/graphs/`.
- The runtime receives only the explicit Roam tool allowlist and optional MCP
  servers enabled for the graph.
- Progress summaries are shown, but raw model reasoning is never exposed.
- Current or external factual work requires live sources; graph-only writing
  and organization do not browse.

## Troubleshooting

**The bridge is unavailable**

Confirm the terminal process is still running and that the configured bridge
URL is `http://127.0.0.1:47321` unless you deliberately changed the port.

**The bridge reports the wrong graph**

Stop it and restart with the exact active graph name:

```bash
ROAM_GRAPH="your-graph-name" npm start
```

**Pairing fails or the code expired**

Restart the bridge and enter the newly printed code. A successful code cannot
be replayed.

**Codex is unavailable**

Verify `codex --version` works and the CLI is signed in, then restart the
bridge.

**A development run failed**

Inspect the ignored local trace at `.dev/last-run.jsonl`. It contains runtime
diagnostics, not the bridge bearer token.

## Remove the beta

Stop the bridge and remove or disable the developer extension in Roam. Roam
removes extension commands and styles on unload. Device-local tokens, runtime
profiles, and Codex thread files remain on disk until you explicitly remove
them.

## Development and project status

- [Architecture, protocol, safety, and verification](./DEVELOPMENT.md)
- [Release-readiness tracker](https://github.com/MaskyS/roam-codex-ai/issues/9)
- [Open issues](https://github.com/MaskyS/roam-codex-ai/issues)
- [Builder instructions](./AGENTS.md)
