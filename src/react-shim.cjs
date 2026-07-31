// Roam supplies React on window; this lazy proxy lets bundled code use
// ordinary `import ... from "react"` without touching the global at
// module-evaluation time (the extension must load even if React is absent).
module.exports = new Proxy({}, {
  get: (_, key) => (globalThis.window?.React ?? globalThis.React)?.[key],
});
