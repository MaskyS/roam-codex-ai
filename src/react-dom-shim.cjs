module.exports = new Proxy({}, {
  get: (_, key) => (globalThis.window?.ReactDOM ?? globalThis.ReactDOM)?.[key],
});
