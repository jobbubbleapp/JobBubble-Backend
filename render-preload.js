const Module = require("module");
const path = require("path");

// Render currently starts this service with the fixed command `node server.js`.
// Preload the production patch pipeline before Node loads that main file. The
// bootstrap compiles and starts the patched server itself; afterwards the normal
// main-file load is intentionally turned into a no-op so the HTTP server is not
// started twice.

const targetServer = path.resolve(__dirname, "server.js");
const originalJsLoader = Module._extensions[".js"];
let patchedServerStarted = false;

require("./bootstrap-fast.js");
patchedServerStarted = true;

Module._extensions[".js"] = function jobbubbleRenderLoader(mod, filename) {
  if (patchedServerStarted && path.resolve(filename) === targetServer) {
    mod._compile("// JobBubble server already started by render-preload.js\n", filename);
    return;
  }
  return originalJsLoader(mod, filename);
};
