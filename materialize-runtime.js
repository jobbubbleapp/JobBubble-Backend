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

// The bootstrap installs this wrapper outside the generated source. Materialized
// production server.js must carry the same in-flight Geoapify deduplication itself.
const dedupeRuntime = String.raw`
function installMaterializedGeoapifyFetchDedupe() {
  if (globalThis.__jobbubbleGeoFetchDedupeInstalled) return;
  const nativeFetch = globalThis.fetch;
  if (typeof nativeFetch !== "function") return;
  const inFlight = new Map();
  const stats = { deduped: 0, started: 0 };
  globalThis.__jobbubbleGeoFetchDedupeStats = stats;
  globalThis.__jobbubbleGeoFetchDedupeInstalled = true;
  globalThis.fetch = function jobbubbleFetch(input, init = {}) {
    let url = "";
    try {
      url = typeof input === "string" ? input : String(input?.url || input || "");
    } catch (_) {}
    const method = String(init?.method || input?.method || "GET").toUpperCase();
    const isGeoapifyGeocode = method === "GET" &&
      url.startsWith("https://api.geoapify.com/v1/geocode/search");
    if (!isGeoapifyGeocode) return nativeFetch(input, init);
    let promise = inFlight.get(url);
    if (!promise) {
      stats.started += 1;
      promise = nativeFetch(input, init).finally(() => inFlight.delete(url));
      inFlight.set(url, promise);
    } else {
      stats.deduped += 1;
    }
    return promise.then((response) => response.clone());
  };
}
installMaterializedGeoapifyFetchDedupe();
`;

const insertionPoint = 'const crypto = require("crypto");\n';
if (!generated.includes(insertionPoint)) {
  throw new Error("Could not find runtime insertion point for Geoapify dedupe");
}
generated = generated.replace(insertionPoint, insertionPoint + dedupeRuntime + "\n");

const required = [
  'const GEO_CACHE_VERSION = "v2";',
  'const geoCache = new SmartGeoCache();',
  'setTimeout(resolve, 900)',
  'Promise.allSettled([',
  'geo_cache_version: GEO_CACHE_VERSION',
  'GeoCache V2: normalized LRU',
  'installMaterializedGeoapifyFetchDedupe()',
  '__jobbubbleGeoFetchDedupeStats'
];
for (const token of required) {
  if (!generated.includes(token)) throw new Error(`Generated runtime missing: ${token}`);
}

fs.writeFileSync(serverPath, generated, "utf8");
console.log("Materialized GeoCache V2 + fast first-response runtime into server.js");
