const fs = require("fs");
const path = require("path");
const Module = require("module");

// Materialize the currently tested bootstrap transformations into server.js itself.
// Render is configured with a fixed `node server.js` start command, so writing the
// generated runtime source directly makes the production service independent of a
// preload or custom start command.
//
// Step 2 note: this materializer is intentionally safe to run against either the
// original source or an already-materialized production server. That lets filter
// fixes be applied without undoing GeoCache V2 / fast-response behavior.

const serverPath = path.resolve(__dirname, "server.js");
const currentServer = fs.readFileSync(serverPath, "utf8");
let generated = null;

if (
  currentServer.includes('const GEO_CACHE_VERSION = "v2";') &&
  currentServer.includes('const geoCache = new SmartGeoCache();')
) {
  generated = currentServer;
} else {
  const originalCompile = Module.prototype._compile;
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

if (!generated.includes("function installMaterializedGeoapifyFetchDedupe()")) {
  const insertionPoint = 'const crypto = require("crypto");\n';
  if (!generated.includes(insertionPoint)) {
    throw new Error("Could not find runtime insertion point for Geoapify dedupe");
  }
  generated = generated.replace(insertionPoint, insertionPoint + dedupeRuntime + "\n");
}

function replaceOnceIfNeeded(source, oldText, newText, label) {
  if (source.includes(newText)) return source;
  const first = source.indexOf(oldText);
  if (first < 0) throw new Error(`Step 2 filter patch target missing: ${label}`);
  if (source.indexOf(oldText, first + oldText.length) >= 0) {
    throw new Error(`Step 2 filter patch target ambiguous: ${label}`);
  }
  return source.slice(0, first) + newText + source.slice(first + oldText.length);
}

// Preserve the distance selected by Android all the way through the backend. The
// previous 100-mile clamps made JobBubble's extended-distance option behave like
// 100 miles even though the client sent the larger value.
generated = replaceOnceIfNeeded(
  generated,
  `    const radius = Number.isFinite(requestedRadius) && requestedRadius > 0\n      ? Math.min(requestedRadius, 100) : 25;`,
  `    const radius = Number.isFinite(requestedRadius) && requestedRadius > 0\n      ? requestedRadius : 25;`,
  "incoming requested radius"
);

generated = replaceOnceIfNeeded(
  generated,
  `  if (radius > 0) url.searchParams.set("distance", String(Math.min(radius, 100)));`,
  `  if (radius > 0) url.searchParams.set("distance", String(radius));`,
  "Adzuna provider radius"
);

generated = replaceOnceIfNeeded(
  generated,
  `  if (radius > 0 && where) url.searchParams.set("Radius", String(Math.min(radius, 100)));`,
  `  if (radius > 0 && where) url.searchParams.set("Radius", String(radius));`,
  "USAJOBS provider radius"
);

const required = [
  'const GEO_CACHE_VERSION = "v2";',
  'const geoCache = new SmartGeoCache();',
  'setTimeout(resolve, 900)',
  'Promise.allSettled([',
  'geo_cache_version: GEO_CACHE_VERSION',
  'GeoCache V2: normalized LRU',
  'installMaterializedGeoapifyFetchDedupe()',
  '__jobbubbleGeoFetchDedupeStats',
  '? requestedRadius : 25;',
  'url.searchParams.set("distance", String(radius))',
  'url.searchParams.set("Radius", String(radius))'
];
for (const token of required) {
  if (!generated.includes(token)) throw new Error(`Generated runtime missing: ${token}`);
}
if (generated.includes("Math.min(requestedRadius, 100)")) {
  throw new Error("Generated runtime still caps requested radius at 100 miles");
}
if (generated.includes("Math.min(radius, 100)")) {
  throw new Error("Generated runtime still caps a provider radius at 100 miles");
}

fs.writeFileSync(serverPath, generated, "utf8");
console.log("Materialized GeoCache V2 + fast first-response + Step 2 extended-radius runtime into server.js");
