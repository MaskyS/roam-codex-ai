// Roam ships React 17 and ReactDOM as window globals; extensions must use
// those instances rather than bundling their own copy.
const host = typeof window !== "undefined" ? window : globalThis;

export const React = host.React;
export const ReactDOM = host.ReactDOM;

export function assertReactAvailable() {
  if (!React?.createElement || !ReactDOM?.render) {
    throw new Error("Roam's bundled React is unavailable.");
  }
}
