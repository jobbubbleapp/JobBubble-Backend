const Module = require("module");
const path = require("path");

// Render currently starts this service with the fixed command `node server.js`.
// NODE_OPTIONS also affects build-time Node processes such as yarn, so only activate
// the production patch pipeline when the actual main script is server.js.

const targetServer = path.resolve(__dirname, "server.js");
const requestedMain = process.argv[1] ? path.resolve(process.argv[1]) : "";

if (requestedMain === targetServer) {
  const originalJsLoader = Module._extensions[".js"];
  let patchedServerStarted = false;

  // bootstrap-fast applies the fast first-response patch, then bootstrap applies
  // GeoCache V2 and starts the patched server implementation.
  require("./bootstrap-fast.js");
  patchedServerStarted = true;

  // Node will still attempt to execute the configured main file after preloads run.
  // Make that second load a no-op so the HTTP listener is not started twice.
  Module._extensions[".js"] = function jobbubbleRenderLoader(mod, filename) {
    if (patchedServerStarted && path.resolve(filename) === targetServer) {
      mod._compile("// JobBubble server already started by render-preload.js\n", filename);
      return;
    }
    return originalJsLoader(mod, filename);
  };
}
