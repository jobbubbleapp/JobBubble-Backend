const fs = require("fs");
const path = require("path");
const Module = require("module");

// Materialize the currently tested bootstrap transformations into server.js itself.
// Render is configured with a fixed `node server.js` start command, so writing the
// generated runtime source directly makes the production service independent of a
// preload or custom start command.

const serverPath = path.resolve(__dirname, "server.js");
const originalCompile = Module.prototype._compile;
let generated = null;

Module.prototype._compile = function captureGeneratedServer(content, filename) {
  if (path.resolve(filename) === serverPath && this.filename === serverPath) {
    generated = String(content);
    return;
  }
  return originalCompile.call(this, content, filename);
};

try {
  require("./bootstrap-fast.js");
} finally {
  Module.prototype._compile = originalCompile;
}

if (!generated) throw new Error("Failed to capture generated JobBubble server runtime");

const required = [
  'const GEO_CACHE_VERSION = "v2";',
  'const geoCache = new SmartGeoCache();',
  'setTimeout(resolve, 900)',
  'Promise.allSettled([',
  'geo_cache_version: GEO_CACHE_VERSION',
  'GeoCache V2: normalized LRU'
];
for (const token of required) {
  if (!generated.includes(token)) throw new Error(`Generated runtime missing: ${token}`);
}

fs.writeFileSync(serverPath, generated, "utf8");
console.log("Materialized GeoCache V2 + fast first-response runtime into server.js");
