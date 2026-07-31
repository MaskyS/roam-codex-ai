# React panel port — working notes (delete before merge)

Branch `react-panel`, worktree `../roam-better-ai-react`. Plan block on
`[[Codex Roam Lab/Chat panel and persistent conversations]]` (uid ygihLfBfP).

## Baseline (done)

- `src/core.js` — everything except `createChatPanel`, plus an internal-helper
  export block at the bottom. Unchanged logic.
- `src/chat-panel.jsx` — verbatim vanilla `createChatPanel` importing helpers
  from core. To be rewritten.
- `src/extension.js` — entry; re-exports core + panel + default onload.
- `npm run build` = esbuild bundle → root `extension.js` (what Roam loads and
  tests import). `npm run check` builds first. All 86 tests pass on the bundle.
- `src/react-globals.js` — window.React / window.ReactDOM (Roam ships React
  17.0.2; `ReactDOM.render` / `unmountComponentAtNode`, no React 18 APIs).

## Port architecture (agreed reasoning)

- Split `createChatPanel` into:
  1. `createChatPanelStore(options)` — framework-free closure holding ALL
     current state (messages, models, picker*, history, running, progress,
     graph-thread indexing, send/loadHistory/selectConversation/close). Logic
     moves verbatim where possible; every mutation calls `emit()`. No DOM.
     DOM-adjacent side effects that stay in the store: focus calls, storage,
     `api.*` calls.
  2. React view components subscribing to the store snapshot (React 17
     subscription: useState + useEffect subscribe; no useSyncExternalStore).
     Components: `ChatPanelView` (transcript + progress row + resize handle +
     scroll-latest), `PanelHeader` (conversation button, history popover,
     close ✕), `ControlsBar` (picker pill + two-level menu/submenu, Send/Stop
     slot), `RoamString` (owns renderString/unmountNode per message — replaces
     renderedMessageNodes/messageRenderVersion bookkeeping), `CopyButton`
     (local feedback state, replaces copyFeedbackTimers map).
- `createChatPanel(options)` keeps its EXACT external contract:
  `{ element, headerElement, controlsElement, rootBlockUid, close, focus,
  send }`. It creates the three container elements, `ReactDOM.render`s one
  tree with portals into header/controls containers, and wires store.close to
  unmount. All class names, aria labels, and dataset attributes stay
  identical so extension.css and tests keep working.
- Vercel-rules adaptations for React 17: handler-ref pattern instead of
  useEffectEvent; derive state in render; no inline component definitions;
  interaction logic in handlers, not effects.
- Imperative/manual DOM that stays imperative: transcript scrollTop/scroll
  measurements (effect with refs), document-level keydown/click/visibility
  listeners (one effect with cleanup), transcript drag-resize (pointer events
  effect).

## Test port (task 13)

- Panel tests (those using `createFakePanelDocument` / `panelElements`) move
  to jsdom: set `globalThis.window` from a JSDOM instance, assign
  `window.React = require(react)`, `window.ReactDOM` BEFORE importing the
  bundle. Replace `element.listeners.click()` with real `dispatchEvent` /
  `click()`; `panelElements` walker works on real DOM children.
- Non-panel tests unchanged.

## Remaining steps

Store + components done (through 3bbb47e): ordinary react/react-dom imports
via lazy proxy-shim aliases, automatic JSX runtime, useSyncExternalStore
shim, context instead of prop threading, derived picker view-model,
transient drag. Bundle expects window.React at import time (Roam provides).
Verbatim vanilla panel reference: `git show 394474a:src/chat-panel.jsx`.

1. TypeScript for src/chat-panel.tsx + src/chat-panel-store.ts (esbuild
   compiles free; add typescript devDep + `tsc --noEmit` to check). Types:
   Model, ThreadRecord, Snapshot, store actions.
2. Port panel tests to jsdom + real React; use node:test mock timers instead
   of injected timer impls (the DI was removed). Mirror main's newest
   expectations (data-speed, wrap heights, ⌥↵).
3. Live smoke in Roam (point dev extension at this worktree or merge first).
4. Final review with the user; delete this file before merge.
