const fs = require("fs");
const path = require("path");
const Module = require("module");
const vm = require("vm");

const SERVER_PATH = path.join(__dirname, "server.js");
const CHECK_ONLY = process.argv.includes("--check");

function replaceOnce(source, needle, replacement, label) {
  const first = source.indexOf(needle);
  if (first < 0) throw new Error(`GeoCache V2 patch target missing: ${label}`);
  if (source.indexOf(needle, first + needle.length) >= 0) {
    throw new Error(`GeoCache V2 patch target is ambiguous: ${label}`);
  }
  return source.slice(0, first) + replacement + source.slice(first + needle.length);
}

function installGeoapifyFetchDedupe() {
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

    const key = url;
    let promise = inFlight.get(key);
    if (!promise) {
      stats.started += 1;
      promise = nativeFetch(input, init)
        .finally(() => inFlight.delete(key));
      inFlight.set(key, promise);
    } else {
      stats.deduped += 1;
    }

    // Each consumer gets its own Response body while sharing one network request.
    return promise.then((response) => response.clone());
  };
}

function patchServerSource(source) {
  source = replaceOnce(
    source,
    `// Geo results barely change, so keep them for a week.\nconst GEO_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;`,
    `// GeoCache V2: successful job-location geocodes are stable and can live much\n// longer, while weak/failed matches expire quickly so temporary misses do not poison\n// location quality for a full week.\nconst GEO_CACHE_TTL_MS = 90 * 24 * 60 * 60 * 1000;\nconst GEO_NEGATIVE_CACHE_TTL_MS = 30 * 60 * 1000;\nconst GEO_MEDIUM_CACHE_TTL_MS = 6 * 60 * 60 * 1000;\nconst GEO_AREA_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;\nconst GEO_CACHE_MAX_ENTRIES = 5000;\nconst GEO_CACHE_VERSION = "v2";`,
    "geo cache TTL constants"
  );

  const smartCache = String.raw`
const GEO_STATE_NORMALIZATIONS = [
  ["alabama","al"],["alaska","ak"],["arizona","az"],["arkansas","ar"],
  ["california","ca"],["colorado","co"],["connecticut","ct"],["delaware","de"],
  ["florida","fl"],["georgia","ga"],["hawaii","hi"],["idaho","id"],
  ["illinois","il"],["indiana","in"],["iowa","ia"],["kansas","ks"],
  ["kentucky","ky"],["louisiana","la"],["maine","me"],["maryland","md"],
  ["massachusetts","ma"],["michigan","mi"],["minnesota","mn"],["mississippi","ms"],
  ["missouri","mo"],["montana","mt"],["nebraska","ne"],["nevada","nv"],
  ["new hampshire","nh"],["new jersey","nj"],["new mexico","nm"],["new york","ny"],
  ["north carolina","nc"],["north dakota","nd"],["ohio","oh"],["oklahoma","ok"],
  ["oregon","or"],["pennsylvania","pa"],["rhode island","ri"],["south carolina","sc"],
  ["south dakota","sd"],["tennessee","tn"],["texas","tx"],["utah","ut"],
  ["vermont","vt"],["virginia","va"],["washington","wa"],["west virginia","wv"],
  ["wisconsin","wi"],["wyoming","wy"],["district of columbia","dc"]
];

const GEO_STREET_NORMALIZATIONS = [
  ["street","st"],["avenue","ave"],["boulevard","blvd"],["road","rd"],
  ["drive","dr"],["lane","ln"],["highway","hwy"],["parkway","pkwy"],
  ["court","ct"],["circle","cir"],["place","pl"],["terrace","ter"]
];

const geoCacheStats = {
  hits: 0,
  misses: 0,
  expired: 0,
  writes: 0,
  persistent_hydrated: 0,
  persistent_writes: 0,
  persistent_errors: 0,
  weaker_results_rejected: 0
};

function geoNormalizeText(value) {
  let out = String(value == null ? "" : value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[#]/g, " number ")
    .replace(/[^a-z0-9|.,-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  for (const [name, abbreviation] of GEO_STATE_NORMALIZATIONS) {
    out = out.replace(new RegExp(`\\b${name}\\b`, "g"), abbreviation);
  }
  for (const [name, abbreviation] of GEO_STREET_NORMALIZATIONS) {
    out = out.replace(new RegExp(`\\b${name}\\b`, "g"), abbreviation);
  }
  return out.replace(/\s*,\s*/g, ",").replace(/\s+/g, " ").trim();
}

function normalizeGeoCacheKey(key) {
  const raw = String(key || "");
  if (raw.startsWith(`${GEO_CACHE_VERSION}|`)) return raw;
  const parts = raw.split("|");
  const prefix = String(parts.shift() || "geo").toLowerCase().trim();
  return `${GEO_CACHE_VERSION}|${prefix}|${parts.map(geoNormalizeText).join("|")}`;
}

function geoCacheValueCoordinates(value) {
  if (!value || typeof value !== "object") return null;
  const latitude = Number(value.latitude ?? value.lat);
  const longitude = Number(value.longitude ?? value.lon ?? value.lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  return { latitude, longitude };
}

function geoCacheQuality(key, value) {
  if (!value) return 0;
  let score = 1;
  const confidence = String(value.confidence || "").toLowerCase();
  const precision = String(value.precision || "").toLowerCase();
  const reason = String(value.reason || "").toLowerCase();
  if (confidence === "high") score += 4;
  else if (confidence === "medium") score += 2;
  if (precision === "exact") score += 4;
  else if (precision === "likely") score += 2;
  if (reason.includes("address") || key.includes("|explicit-address|") || key.includes("|address|")) score += 3;
  if (key.includes("|origin|")) score -= 1;
  return score;
}

function geoCacheTtlFor(key, value) {
  if (!value) return GEO_NEGATIVE_CACHE_TTL_MS;
  const confidence = String(value.confidence || "").toLowerCase();
  if (confidence === "medium") return GEO_MEDIUM_CACHE_TTL_MS;
  if (key.includes("|origin|")) return GEO_AREA_CACHE_TTL_MS;
  if (key.includes("|explicit-address|") || key.includes("|address|")) return GEO_CACHE_TTL_MS;
  if (confidence === "high") return GEO_CACHE_TTL_MS;
  return GEO_AREA_CACHE_TTL_MS;
}

function shouldPersistGeoCacheEntry(key, value) {
  // Never persist the user's arbitrary search-origin text. It can be a home address.
  // Persistent storage is reserved for public job/workplace location data.
  if (!value || key.includes("|origin|")) return false;
  if (!geoCacheValueCoordinates(value)) return false;
  if (String(value.confidence || "").toLowerCase() === "medium") return false;
  return key.includes("|explicit-address|") || key.includes("|address|") ||
    (key.includes("|workplace|") && String(value.confidence || "").toLowerCase() === "high");
}

class SmartGeoCache extends Map {
  get(key) {
    const normalized = normalizeGeoCacheKey(key);
    const entry = super.get(normalized);
    if (!entry) {
      geoCacheStats.misses += 1;
      return undefined;
    }
    const expiresAt = Number(entry.expiresAt || 0);
    if (expiresAt && Date.now() >= expiresAt) {
      super.delete(normalized);
      geoCacheStats.expired += 1;
      geoCacheStats.misses += 1;
      return undefined;
    }
    // Touch the entry and move it to the end, giving us true LRU eviction while
    // keeping the legacy caller's age check compatible with per-entry expirations.
    super.delete(normalized);
    entry.lastAccess = Date.now();
    entry.time = Date.now();
    super.set(normalized, entry);
    geoCacheStats.hits += 1;
    return entry;
  }

  set(key, entry) {
    const normalized = normalizeGeoCacheKey(key);
    const now = Date.now();
    const next = entry && typeof entry === "object"
      ? { ...entry }
      : { time: now, value: null };
    next.time = Number.isFinite(Number(next.time)) ? Number(next.time) : now;
    next.lastAccess = now;
    next.expiresAt = Number(next.expiresAt || (now + geoCacheTtlFor(normalized, next.value)));

    const existing = Map.prototype.get.call(this, normalized);
    if (existing && (!existing.expiresAt || existing.expiresAt > now)) {
      const oldQuality = geoCacheQuality(normalized, existing.value);
      const newQuality = geoCacheQuality(normalized, next.value);
      if (oldQuality > newQuality) {
        geoCacheStats.weaker_results_rejected += 1;
        return this;
      }
    }

    Map.prototype.delete.call(this, normalized);
    Map.prototype.set.call(this, normalized, next);
    geoCacheStats.writes += 1;
    if (shouldPersistGeoCacheEntry(normalized, next.value)) {
      persistGeoCacheEntry(normalized, next).catch(() => {});
    }
    pruneGeoCache();
    return this;
  }

  hydrate(key, entry) {
    const normalized = normalizeGeoCacheKey(key);
    if (!entry || Number(entry.expiresAt || 0) <= Date.now()) return;
    Map.prototype.delete.call(this, normalized);
    Map.prototype.set.call(this, normalized, { ...entry, lastAccess: Date.now() });
    pruneGeoCache();
  }

  delete(key) {
    return Map.prototype.delete.call(this, normalizeGeoCacheKey(key));
  }

  has(key) {
    const normalized = normalizeGeoCacheKey(key);
    const entry = Map.prototype.get.call(this, normalized);
    if (!entry) return false;
    if (entry.expiresAt && Date.now() >= entry.expiresAt) {
      Map.prototype.delete.call(this, normalized);
      return false;
    }
    return true;
  }
}

function pruneGeoCache() {
  if (typeof geoCache === "undefined") return;
  const now = Date.now();
  for (const [key, entry] of geoCache) {
    if (!entry || (entry.expiresAt && now >= entry.expiresAt)) {
      Map.prototype.delete.call(geoCache, key);
    }
  }
  while (geoCache.size > GEO_CACHE_MAX_ENTRIES) {
    const oldestKey = geoCache.keys().next().value;
    Map.prototype.delete.call(geoCache, oldestKey);
  }
}
`;

  source = replaceOnce(
    source,
    `const geoCache = new Map();`,
    `${smartCache}\nconst geoCache = new SmartGeoCache();`,
    "geoCache declaration"
  );

  source = replaceOnce(
    source,
    `  pruneTimedCache(geoCache, 2500, GEO_CACHE_TTL_MS);`,
    `  pruneGeoCache();`,
    "geoCache maintenance"
  );

  const persistence = String.raw`
async function persistGeoCacheEntry(cacheKey, entry) {
  if (!firestoreEnabled || !cacheKey || !entry || !entry.value) return;
  try {
    const token = await getFirebaseAccessToken();
    if (!token) return;
    const id = firestoreDocumentId(cacheKey);
    const project = encodeURIComponent(firebaseServiceAccount.project_id);
    const url = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/geo_cache_v2/${id}`;
    const fields = {
      cache_key: firestoreValue(cacheKey),
      value_json: firestoreValue(JSON.stringify(entry.value)),
      updated_at_ms: firestoreValue(Date.now()),
      expires_at_ms: firestoreValue(Number(entry.expiresAt || 0)),
      cache_version: firestoreValue(GEO_CACHE_VERSION)
    };
    const response = await fetch(url, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ fields }),
      signal: AbortSignal.timeout(6000)
    });
    if (!response.ok) throw new Error(`Firestore geo-cache write HTTP ${response.status}`);
    geoCacheStats.persistent_writes += 1;
  } catch (error) {
    geoCacheStats.persistent_errors += 1;
    console.error("Firestore geo-cache write failed:", error.message);
    throw error;
  }
}

async function hydrateGeoCacheFromFirestore() {
  if (!firestoreEnabled) return 0;
  try {
    const token = await getFirebaseAccessToken();
    if (!token) return 0;
    const project = encodeURIComponent(firebaseServiceAccount.project_id);
    let pageToken = "";
    let loaded = 0;
    let pages = 0;
    do {
      const url = new URL(`https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/geo_cache_v2`);
      url.searchParams.set("pageSize", "1000");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(6000)
      });
      if (response.status === 404) return loaded;
      if (!response.ok) throw new Error(`Firestore geo-cache read HTTP ${response.status}`);
      const payload = await response.json();
      for (const doc of payload.documents || []) {
        const f = doc.fields || {};
        const cacheKey = String(readFirestoreField(f.cache_key) || "");
        const expiresAt = Number(readFirestoreField(f.expires_at_ms) || 0);
        const valueJson = String(readFirestoreField(f.value_json) || "");
        if (!cacheKey || !valueJson || expiresAt <= Date.now()) continue;
        let value = null;
        try { value = JSON.parse(valueJson); } catch (_) { continue; }
        if (!shouldPersistGeoCacheEntry(cacheKey, value)) continue;
        geoCache.hydrate(cacheKey, {
          time: Date.now(),
          lastAccess: Date.now(),
          expiresAt,
          value
        });
        loaded += 1;
        if (loaded >= GEO_CACHE_MAX_ENTRIES) break;
      }
      pageToken = String(payload.nextPageToken || "");
      pages += 1;
    } while (pageToken && loaded < GEO_CACHE_MAX_ENTRIES && pages < 5);
    geoCacheStats.persistent_hydrated += loaded;
    if (loaded) console.log(`GeoCache V2 hydrated ${loaded} persistent job-location entries`);
    return loaded;
  } catch (error) {
    geoCacheStats.persistent_errors += 1;
    console.error("Firestore geo-cache hydration failed:", error.message);
    return 0;
  }
}
`;

  source = replaceOnce(
    source,
    `async function readPersistentWorkplace(cacheKey) {`,
    `${persistence}\nasync function readPersistentWorkplace(cacheKey) {`,
    "Firestore geo-cache persistence insertion"
  );

  source = replaceOnce(
    source,
    `        geo_cache_entries: geoCache.size,`,
    `        geo_cache_entries: geoCache.size,\n        geo_cache_version: GEO_CACHE_VERSION,\n        geo_cache_hits: geoCacheStats.hits,\n        geo_cache_misses: geoCacheStats.misses,\n        geo_cache_expired: geoCacheStats.expired,\n        geo_cache_persistent_hydrated: geoCacheStats.persistent_hydrated,\n        geo_cache_persistent_writes: geoCacheStats.persistent_writes,\n        geo_cache_persistent_errors: geoCacheStats.persistent_errors,\n        geo_cache_weaker_results_rejected: geoCacheStats.weaker_results_rejected,\n        geoapify_requests_deduped: globalThis.__jobbubbleGeoFetchDedupeStats?.deduped || 0,\n        firestore_geo_cache: firestoreEnabled ? "enabled" : "disabled",`,
    "health geo-cache metrics"
  );

  source = replaceOnce(
    source,
    `server.listen(PORT, () => {`,
    `hydrateGeoCacheFromFirestore().catch((error) => {\n  console.error("GeoCache V2 startup hydration failed:", error.message);\n});\n\nserver.listen(PORT, () => {`,
    "startup geo-cache hydration"
  );

  source = replaceOnce(
    source,
    `  console.log("Fast search cache: enabled");`,
    `  console.log("Fast search cache: enabled");\n  console.log("GeoCache V2: normalized LRU, short negative TTL, request dedupe, persistent job-location cache");`,
    "startup geo-cache log"
  );

  return source;
}

installGeoapifyFetchDedupe();
const original = fs.readFileSync(SERVER_PATH, "utf8");
const patched = patchServerSource(original);

if (CHECK_ONLY) {
  new vm.Script(patched, { filename: SERVER_PATH });
  const required = [
    'const GEO_CACHE_VERSION = "v2";',
    'const geoCache = new SmartGeoCache();',
    'async function hydrateGeoCacheFromFirestore()',
    'geo_cache_version: GEO_CACHE_VERSION',
    'GeoCache V2: normalized LRU'
  ];
  for (const token of required) {
    if (!patched.includes(token)) throw new Error(`GeoCache V2 generated source missing: ${token}`);
  }
  console.log("GeoCache V2 patched server syntax and invariants verified");
  process.exit(0);
}

const serverModule = new Module(SERVER_PATH, module);
serverModule.filename = SERVER_PATH;
serverModule.paths = Module._nodeModulePaths(__dirname);
serverModule._compile(patched, SERVER_PATH);
