const http = require("http");
const fs = require("fs");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const ADZUNA_APP_ID = process.env.ADZUNA_APP_ID;
const ADZUNA_APP_KEY = process.env.ADZUNA_APP_KEY;
const GEOAPIFY_API_KEY = process.env.GEOAPIFY_API_KEY;
const USAJOBS_API_KEY = process.env.USAJOBS_API_KEY;
const USAJOBS_EMAIL = process.env.USAJOBS_EMAIL;

// Geo results barely change, so keep them for a week.
const GEO_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Job searches are fresh for 2 minutes and may be served stale for 10 minutes
// while a refresh runs in the background.
const JOB_CACHE_TTL_MS = 2 * 60 * 1000;
const JOB_STALE_TTL_MS = 10 * 60 * 1000;
// A fresh search waits only briefly for better pin placement. The rest of the
// location refinement continues in the background and is cached for the next read.
const FIRST_RESPONSE_ENRICH_WAIT_MS = 1200;
const MAX_ENRICH_JOBS = 40;
const ENRICH_CONCURRENCY = 12;

const geoCache = new Map();
const postingPageCache = new Map();
const POSTING_PAGE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Reuse resolved workplaces so repeated jobs for the same employer/location do not
// consume another external lookup. This is deliberately separate from geoCache so
// it can use a much longer lifetime.
const workplaceCache = new Map();
const WORKPLACE_CACHE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
// Medium-confidence matches may help during the current server session, but expire
// quickly and are never persisted to Firestore.
const MEDIUM_WORKPLACE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const jobCache = new Map();
const inFlightSearches = new Map();
// V9.4.35 performance: collapse duplicate network work when several jobs resolve
// the same posting page or workplace cache key at the same time.
const postingPageInFlight = new Map();
const workplaceReadInFlight = new Map();

function pruneTimedCache(map, maxEntries, maxAgeMs) {
  const now = Date.now();
  for (const [key, value] of map) {
    if (!value || !Number.isFinite(value.time) || now - value.time > maxAgeMs) map.delete(key);
  }
  while (map.size > maxEntries) map.delete(map.keys().next().value);
}

function maintainCaches() {
  pruneTimedCache(jobCache, 120, JOB_STALE_TTL_MS * 2);
  pruneTimedCache(geoCache, 2500, GEO_CACHE_TTL_MS);
  pruneTimedCache(postingPageCache, 1200, POSTING_PAGE_CACHE_TTL_MS);
  pruneTimedCache(workplaceCache, 2500, WORKPLACE_CACHE_TTL_MS);
}
const cacheMaintenanceTimer = setInterval(maintainCaches, 10 * 60 * 1000);
if (cacheMaintenanceTimer.unref) cacheMaintenanceTimer.unref();

const FIREBASE_SERVICE_ACCOUNT_PATH = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || "/etc/secrets/firebase-service-account.json";
let firebaseServiceAccount = null;
let firebaseAccessToken = null;
let firebaseAccessTokenExpiresAt = 0;
let firestoreEnabled = false;

try {
  if (fs.existsSync(FIREBASE_SERVICE_ACCOUNT_PATH)) {
    firebaseServiceAccount = JSON.parse(fs.readFileSync(FIREBASE_SERVICE_ACCOUNT_PATH, "utf8"));
    firestoreEnabled = Boolean(
      firebaseServiceAccount && firebaseServiceAccount.project_id &&
      firebaseServiceAccount.client_email && firebaseServiceAccount.private_key
    );
  }
} catch (error) {
  console.error("Firebase service account could not be loaded:", error.message);
}

function base64Url(input) {
  return Buffer.from(input).toString("base64")
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function getFirebaseAccessToken() {
  if (!firestoreEnabled) return null;
  const now = Date.now();
  if (firebaseAccessToken && now < firebaseAccessTokenExpiresAt - 60000) return firebaseAccessToken;

  const nowSeconds = Math.floor(now / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64Url(JSON.stringify({
    iss: firebaseServiceAccount.client_email,
    scope: "https://www.googleapis.com/auth/datastore",
    aud: "https://oauth2.googleapis.com/token",
    iat: nowSeconds,
    exp: nowSeconds + 3600
  }));
  const unsigned = `${header}.${claims}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(firebaseServiceAccount.private_key);
  const assertion = `${unsigned}.${base64Url(signature)}`;

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion
  });
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(6000)
  });
  if (!response.ok) throw new Error(`Firebase OAuth HTTP ${response.status}`);
  const data = await response.json();
  if (!data.access_token) throw new Error("Firebase OAuth returned no access token");
  firebaseAccessToken = data.access_token;
  firebaseAccessTokenExpiresAt = now + (Number(data.expires_in || 3600) * 1000);
  return firebaseAccessToken;
}

function firestoreDocumentId(cacheKey) {
  return crypto.createHash("sha256").update(String(cacheKey)).digest("hex");
}

function firestoreValue(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") return Number.isInteger(value)
    ? { integerValue: String(value) } : { doubleValue: value };
  return { stringValue: String(value) };
}

function readFirestoreField(field) {
  if (!field) return null;
  if (Object.prototype.hasOwnProperty.call(field, "doubleValue")) return Number(field.doubleValue);
  if (Object.prototype.hasOwnProperty.call(field, "integerValue")) return Number(field.integerValue);
  if (Object.prototype.hasOwnProperty.call(field, "booleanValue")) return Boolean(field.booleanValue);
  if (Object.prototype.hasOwnProperty.call(field, "stringValue")) return field.stringValue;
  return null;
}

async function readPersistentWorkplace(cacheKey) {
  if (!firestoreEnabled || !cacheKey) return null;
  try {
    const token = await getFirebaseAccessToken();
    if (!token) return null;
    const id = firestoreDocumentId(cacheKey);
    const project = encodeURIComponent(firebaseServiceAccount.project_id);
    const url = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/workplace_cache/${id}`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(6000)
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Firestore read HTTP ${response.status}`);
    const doc = await response.json();
    const f = doc.fields || {};
    const updatedAtMs = Number(readFirestoreField(f.updated_at_ms) || 0);
    if (!updatedAtMs || Date.now() - updatedAtMs > WORKPLACE_CACHE_TTL_MS) return null;
    const latitude = Number(readFirestoreField(f.latitude));
    const longitude = Number(readFirestoreField(f.longitude));
    if (!validCoordinate(latitude, longitude)) return null;
    const confidence = readFirestoreField(f.confidence) || "medium";
    // V9.4.35 only trusts high-confidence records from persistent storage.
    // Older medium-confidence documents remain harmless in Firestore but are ignored.
    if (confidence !== "high") return null;
    return {
      latitude,
      longitude,
      location: readFirestoreField(f.location) || "",
      precision: readFirestoreField(f.precision) || "likely",
      confidence
    };
  } catch (error) {
    console.error("Firestore workplace-cache read failed:", error.message);
    return null;
  }
}

async function writePersistentWorkplace(cacheKey, match) {
  if (!firestoreEnabled || !cacheKey || !match || !validCoordinate(match.latitude, match.longitude)) return;
  try {
    const token = await getFirebaseAccessToken();
    if (!token) return;
    const id = firestoreDocumentId(cacheKey);
    const project = encodeURIComponent(firebaseServiceAccount.project_id);
    const url = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/workplace_cache/${id}`;
    const fields = {
      cache_key: firestoreValue(cacheKey),
      latitude: firestoreValue(Number(match.latitude)),
      longitude: firestoreValue(Number(match.longitude)),
      location: firestoreValue(match.location || ""),
      precision: firestoreValue(match.precision || "likely"),
      confidence: firestoreValue(match.confidence || "medium"),
      updated_at_ms: firestoreValue(Date.now())
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
    if (!response.ok) throw new Error(`Firestore write HTTP ${response.status}`);
  } catch (error) {
    console.error("Firestore workplace-cache write failed:", error.message);
  }
}

function sendJson(res, status, data, extraHeaders = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
    ...extraHeaders
  });
  res.end(JSON.stringify(data));
}

function validCoordinate(lat, lon) {
  return (
    Number.isFinite(lat) && Number.isFinite(lon) &&
    lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180 &&
    !(Math.abs(lat) < 0.0001 && Math.abs(lon) < 0.0001)
  );
}

function milesBetween(lat1, lon1, lat2, lon2) {
  const R = 3958.761;
  const p = Math.PI / 180;
  const dLat = (lat2 - lat1) * p;
  const dLon = (lon2 - lon1) * p;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * p) * Math.cos(lat2 * p) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function looksLikeStreetAddress(text) {
  const x = String(text || "").toLowerCase();
  return /\d/.test(x) &&
    /\b(st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|way|ct|court|pl|place|pkwy|parkway|hwy|highway|suite|ste)\b/.test(x);
}

function isGenericCompanyName(name) {
  const x = String(name || "").trim().toLowerCase();
  return !x || x === "unknown company" || x === "employer" ||
    x === "confidential" || x === "company" ||
    x.includes("confidential employer") || x.includes("undisclosed");
}

function normalizeName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\b(inc|llc|corp|corporation|company|co|ltd|the)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractStreetAddress(text) {
  const plain = String(text || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  const match = plain.match(
    /\b\d{1,6}\s+[A-Za-z0-9.'#&\- ]{2,55}\s(?:st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|way|ct|court|pl|place|pkwy|parkway|hwy|highway)\b(?:\s*(?:,|#|suite|ste)\s*[A-Za-z0-9.\- ]{0,30})?/i
  );
  return match ? match[0].trim() : null;
}


function walkJsonForJobPosting(value, found = []) {
  if (!value || found.length >= 6) return found;
  if (Array.isArray(value)) {
    for (const item of value) walkJsonForJobPosting(item, found);
    return found;
  }
  if (typeof value !== "object") return found;
  const type = value["@type"];
  const types = Array.isArray(type) ? type : [type];
  if (types.some((x) => String(x || "").toLowerCase() === "jobposting")) found.push(value);
  if (value["@graph"]) walkJsonForJobPosting(value["@graph"], found);
  for (const [key, child] of Object.entries(value)) {
    if (key === "@graph") continue;
    if (child && typeof child === "object") walkJsonForJobPosting(child, found);
  }
  return found;
}

function addressFromJobPosting(posting) {
  const locations = Array.isArray(posting?.jobLocation) ? posting.jobLocation : [posting?.jobLocation];
  for (const loc of locations) {
    const address = loc?.address || loc;
    if (!address || typeof address !== "object") continue;
    const street = String(address.streetAddress || "").trim();
    const locality = String(address.addressLocality || "").trim();
    const region = String(address.addressRegion || "").trim();
    const postal = String(address.postalCode || "").trim();
    const country = typeof address.addressCountry === "string"
      ? address.addressCountry : String(address.addressCountry?.name || "").trim();
    const parts = [street, locality, region, postal, country].filter(Boolean);
    const text = parts.join(", ");
    if (street && looksLikeStreetAddress(street)) return text;
  }
  return null;
}

async function postingPageStreetAddressCore(job) {
  const applyUrl = String(job?.apply_url || "").trim();
  if (!/^https?:\/\//i.test(applyUrl)) return null;
  const cacheKey = `posting-page|${applyUrl}`;
  const cached = postingPageCache.get(cacheKey);
  if (cached && Date.now() - cached.time < POSTING_PAGE_CACHE_TTL_MS) return cached.value;

  try {
    const response = await fetch(applyUrl, {
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; JobBubble/9.4.35; +https://jobbubble-backend-1.onrender.com)",
        "Accept": "text/html,application/xhtml+xml"
      },
      signal: AbortSignal.timeout(5500)
    });
    if (!response.ok) throw new Error(`posting page HTTP ${response.status}`);
    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) return null;
    const html = (await response.text()).slice(0, 1_500_000);
    const scripts = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) || [];
    for (const script of scripts.slice(0, 30)) {
      const bodyMatch = script.match(/>([\s\S]*?)<\/script>/i);
      if (!bodyMatch) continue;
      const body = bodyMatch[1].trim().replace(/^<!--|-->$/g, "").trim();
      if (!body) continue;
      try {
        const parsed = JSON.parse(body);
        const postings = walkJsonForJobPosting(parsed);
        for (const posting of postings) {
          const address = addressFromJobPosting(posting);
          if (address) {
            postingPageCache.set(cacheKey, { time: Date.now(), value: address });
            return address;
          }
        }
      } catch (_) {}
    }
  } catch (error) {
    console.error("Posting-page address lookup failed:", error.message);
  }
  postingPageCache.set(cacheKey, { time: Date.now(), value: null });
  return null;
}

async function postingPageStreetAddress(job) {
  const applyUrl = String(job?.apply_url || "").trim();
  if (!/^https?:\/\//i.test(applyUrl)) return null;
  const inFlightKey = `posting-page|${applyUrl}`;
  const existing = postingPageInFlight.get(inFlightKey);
  if (existing) return existing;
  const promise = postingPageStreetAddressCore(job)
    .finally(() => postingPageInFlight.delete(inFlightKey));
  postingPageInFlight.set(inFlightKey, promise);
  return promise;
}

async function geoapifyExplicitAddress(job, address, providerLabel) {
  if (!GEOAPIFY_API_KEY || !address) return null;
  const cacheKey = `explicit-address|${String(address).toLowerCase().trim()}`;
  const cached = geoCache.get(cacheKey);
  if (cached && Date.now() - cached.time < GEO_CACHE_TTL_MS) return cached.value;
  const url = new URL("https://api.geoapify.com/v1/geocode/search");
  url.searchParams.set("text", address);
  url.searchParams.set("filter", "countrycode:us");
  if (validCoordinate(job?.latitude, job?.longitude)) {
    url.searchParams.set("bias", `proximity:${job.longitude},${job.latitude}`);
  }
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "3");
  url.searchParams.set("lang", "en");
  url.searchParams.set("apiKey", GEOAPIFY_API_KEY);
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`Geoapify explicit-address HTTP ${response.status}`);
    const data = await response.json();
    const results = Array.isArray(data.results) ? data.results : [];
    for (const result of results) {
      const lat = Number(result.lat), lon = Number(result.lon);
      if (!validCoordinate(lat, lon)) continue;
      // An address explicitly supplied by the posting is stronger than an approximate
      // provider pin. Still reject absurd geocodes far away from the provider area.
      if (validCoordinate(job?.latitude, job?.longitude)) {
        const miles = milesBetween(job.latitude, job.longitude, lat, lon);
        if (miles > 35) continue;
      }
      const match = {
        latitude: lat,
        longitude: lon,
        location: result.formatted || address,
        score: 140,
        confidence: "high",
        reason: providerLabel || "posting-page-address"
      };
      geoCache.set(cacheKey, { time: Date.now(), value: match });
      return match;
    }
  } catch (error) {
    console.error("Explicit posting-address geocode failed:", error.message);
  }
  geoCache.set(cacheKey, { time: Date.now(), value: null });
  return null;
}

function nameScore(company, result) {
  const want = normalizeName(company);
  const got = normalizeName(result?.name || result?.formatted || "");
  if (!want || !got) return 0;
  if (got === want) return 100;
  if (got.includes(want) || want.includes(got)) return 85;

  const a = new Set(want.split(" ").filter(Boolean));
  const b = new Set(got.split(" ").filter(Boolean));
  let overlap = 0;
  for (const token of a) if (b.has(token)) overlap++;
  return a.size ? Math.round((overlap / a.size) * 70) : 0;
}

async function geoapifySearchOrigin(where, fallbackLat, fallbackLon) {
  if (validCoordinate(fallbackLat, fallbackLon)) {
    return {
      latitude: fallbackLat,
      longitude: fallbackLon,
      label: where || `${fallbackLat},${fallbackLon}`
    };
  }

  if (!GEOAPIFY_API_KEY || !String(where || "").trim()) return null;

  const cacheKey = `origin|${String(where).toLowerCase().trim()}`;
  const cached = geoCache.get(cacheKey);
  if (cached && Date.now() - cached.time < GEO_CACHE_TTL_MS) return cached.value;

  const url = new URL("https://api.geoapify.com/v1/geocode/search");
  url.searchParams.set("text", String(where).trim());
  url.searchParams.set("filter", "countrycode:us");
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "1");
  url.searchParams.set("lang", "en");
  url.searchParams.set("apiKey", GEOAPIFY_API_KEY);

  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`Geoapify origin HTTP ${response.status}`);

  const data = await response.json();
  const result = Array.isArray(data.results) ? data.results[0] : null;
  const lat = Number(result?.lat);
  const lon = Number(result?.lon);
  if (!validCoordinate(lat, lon)) return null;

  const value = {
    latitude: lat,
    longitude: lon,
    label: result.formatted || String(where).trim()
  };
  geoCache.set(cacheKey, { time: Date.now(), value });
  return value;
}

async function geoapifyAddressCandidate(job) {
  if (!GEOAPIFY_API_KEY || !job) return null;
  const address = extractStreetAddress(job.description);
  if (!address) return null;

  const cacheKey = `address|${address.toLowerCase()}|${String(job.location || "").toLowerCase()}`;
  const cached = geoCache.get(cacheKey);
  if (cached && Date.now() - cached.time < GEO_CACHE_TTL_MS) return cached.value;

  const url = new URL("https://api.geoapify.com/v1/geocode/search");
  url.searchParams.set("text", `${address}, ${job.location || ""}`.trim());
  url.searchParams.set("filter", "countrycode:us");
  if (validCoordinate(job.latitude, job.longitude)) {
    url.searchParams.set("bias", `proximity:${job.longitude},${job.latitude}`);
  }
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "3");
  url.searchParams.set("lang", "en");
  url.searchParams.set("apiKey", GEOAPIFY_API_KEY);

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`Geoapify address HTTP ${response.status}`);
    const data = await response.json();
    const results = Array.isArray(data.results) ? data.results : [];

    for (const result of results) {
      const lat = Number(result.lat);
      const lon = Number(result.lon);
      if (!validCoordinate(lat, lon)) continue;

      if (validCoordinate(job.latitude, job.longitude)) {
        const miles = milesBetween(job.latitude, job.longitude, lat, lon);
        if (miles > 20) continue;
      }

      const match = {
        latitude: lat,
        longitude: lon,
        location: result.formatted || address,
        score: 100,
        reason: "posting-address"
      };
      geoCache.set(cacheKey, { time: Date.now(), value: match });
      return match;
    }
  } catch (error) {
    console.error("Geoapify posting-address lookup failed:", error.message);
  }

  geoCache.set(cacheKey, { time: Date.now(), value: null });
  return null;
}

function locationContextTokens(value) {
  const stop = new Set(["united", "states", "usa", "us", "county", "area"]);
  return normalizeName(value).split(" ")
    .filter((token) => token.length >= 2 && !stop.has(token));
}

function locationContextScore(jobLocation, result) {
  const wanted = new Set(locationContextTokens(jobLocation));
  if (!wanted.size) return 0;
  const resultText = [
    result?.city, result?.town, result?.village, result?.suburb,
    result?.county, result?.state, result?.state_code,
    result?.postcode, result?.formatted, result?.address_line2
  ].filter(Boolean).join(" ");
  const got = new Set(locationContextTokens(resultText));
  let overlap = 0;
  for (const token of wanted) if (got.has(token)) overlap++;
  return Math.min(18, overlap * 6);
}

async function geoapifyLikelyWorkplace(job) {
  if (!GEOAPIFY_API_KEY || !job || looksLikeStreetAddress(job.location) ||
      isGenericCompanyName(job.company)) return null;

  // Include the provider's approximate coordinate in the lookup cache. This keeps
  // separate branches of the same chain in the same city from sharing one result.
  const anchor = validCoordinate(job.latitude, job.longitude)
    ? `${Number(job.latitude).toFixed(3)},${Number(job.longitude).toFixed(3)}` : "no-anchor";
  const cacheKey = `workplace|${normalizeName(job.company)}|${String(job.location || "").toLowerCase().trim()}|${anchor}`;
  const cached = geoCache.get(cacheKey);
  if (cached && Date.now() - cached.time < GEO_CACHE_TTL_MS) return cached.value;

  const url = new URL("https://api.geoapify.com/v1/geocode/search");
  url.searchParams.set("text", `${job.company}, ${job.location}`);
  url.searchParams.set("filter", "countrycode:us");
  if (validCoordinate(job.latitude, job.longitude)) {
    url.searchParams.set("bias", `proximity:${job.longitude},${job.latitude}`);
  }
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "8");
  url.searchParams.set("lang", "en");
  url.searchParams.set("apiKey", GEOAPIFY_API_KEY);

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`Geoapify workplace HTTP ${response.status}`);
    const data = await response.json();
    const results = Array.isArray(data.results) ? data.results : [];

    const ranked = [];
    for (const result of results) {
      const lat = Number(result.lat);
      const lon = Number(result.lon);
      if (!validCoordinate(lat, lon)) continue;

      const companyScore = nameScore(job.company, result);
      if (companyScore < 45) continue;

      let score = companyScore + locationContextScore(job.location, result);
      let distance = null;
      if (validCoordinate(job.latitude, job.longitude)) {
        distance = milesBetween(job.latitude, job.longitude, lat, lon);
        if (distance <= 0.75) score += 35;
        else if (distance <= 2) score += 28;
        else if (distance <= 5) score += 16;
        else if (distance <= 12) score += 6;
        else if (distance <= 25) score -= 12;
        else score -= 45;
      }

      ranked.push({ result, score, distance, companyScore });
    }

    ranked.sort((a, b) => b.score - a.score || (a.distance ?? Infinity) - (b.distance ?? Infinity));
    const best = ranked[0];
    const second = ranked[1];

    // Reject weak or ambiguous chain-branch matches. If two nearby branches score
    // almost the same, keeping the provider area estimate is safer than pinning the
    // job to the wrong store, restaurant, hospital, or warehouse.
    const ambiguous = Boolean(
      best && second && best.score - second.score < 9 &&
      (best.distance == null || second.distance == null || Math.abs(best.distance - second.distance) < 2.5)
    );
    const closeToProvider = best && best.distance != null && best.distance <= 2;
    if (!best || best.score < 72 || (ambiguous && !closeToProvider)) {
      geoCache.set(cacheKey, { time: Date.now(), value: null });
      return null;
    }

    // High confidence requires multiple independent signals: a strong employer-name
    // match plus either very close provider coordinates or a clearly dominant score.
    // Everything else remains useful as a temporary medium-confidence map refinement.
    const dominant = !second || best.score - second.score >= 14;
    const veryCloseToProvider = best.distance != null && best.distance <= 1.25;
    const confidence = (best.companyScore >= 85 && veryCloseToProvider && dominant) ||
      (best.score >= 118 && best.companyScore >= 85 && dominant)
      ? "high" : "medium";
    const match = {
      latitude: Number(best.result.lat),
      longitude: Number(best.result.lon),
      location: best.result.formatted || best.result.address_line2 || job.location,
      score: best.score,
      confidence,
      distance_from_provider_miles: best.distance == null ? null : Math.round(best.distance * 10) / 10
    };
    geoCache.set(cacheKey, { time: Date.now(), value: match });
    return match;
  } catch (error) {
    console.error("Geoapify workplace lookup failed:", error.message);
    return null;
  }
}


function workplaceCacheKey(job) {
  if (!job || isGenericCompanyName(job.company)) return null;
  const company = normalizeName(job.company);
  const location = normalizeName(job.location || "");
  if (!company) return null;

  // Provider coordinates are intentionally part of the persistent key. A chain can
  // have several locations in one city; a city-only key could poison future jobs by
  // reusing the wrong branch for 90 days.
  const anchor = validCoordinate(job.latitude, job.longitude)
    ? `${Number(job.latitude).toFixed(2)},${Number(job.longitude).toFixed(2)}` : "no-anchor";
  return `${company}|${location}|${anchor}`;
}

async function getCachedWorkplaceCore(job) {
  const key = workplaceCacheKey(job);
  if (!key) return null;
  const cached = workplaceCache.get(key);
  if (cached) {
    const confidence = cached.value?.confidence || "medium";
    const ttl = confidence === "high" ? WORKPLACE_CACHE_TTL_MS : MEDIUM_WORKPLACE_CACHE_TTL_MS;
    if (Date.now() - cached.time <= ttl) return cached.value || null;
    workplaceCache.delete(key);
  }

  const persistent = await readPersistentWorkplace(key);
  if (persistent) {
    workplaceCache.set(key, { time: Date.now(), value: { ...persistent } });
    return persistent;
  }
  return null;
}

async function getCachedWorkplace(job) {
  const key = workplaceCacheKey(job);
  if (!key) return null;
  const existing = workplaceReadInFlight.get(key);
  if (existing) return existing;
  const promise = getCachedWorkplaceCore(job)
    .finally(() => workplaceReadInFlight.delete(key));
  workplaceReadInFlight.set(key, promise);
  return promise;
}

function rememberWorkplace(job, match) {
  const key = workplaceCacheKey(job);
  if (!key || !match || !validCoordinate(match.latitude, match.longitude)) return;

  const confidence = String(match.confidence || "medium").toLowerCase();
  const cachedMatch = { ...match, confidence };
  workplaceCache.set(key, { time: Date.now(), value: cachedMatch });

  // Only high-confidence matches become permanent learned workplaces. Medium
  // matches can still improve the current session, but cannot poison Firestore.
  if (confidence === "high") {
    writePersistentWorkplace(key, cachedMatch);
  }
}

async function bestEstimateForJob(job) {
  if (!job) return null;

  // The provider coordinate is usually the best area-level fallback because it is
  // tied to this specific posting. Keep it instead of inventing a precise address.
  if (validCoordinate(job.latitude, job.longitude)) {
    return {
      latitude: Number(job.latitude),
      longitude: Number(job.longitude),
      location: job.location || "Approximate job area",
      precision: "area",
      provider: `${job.source || "Provider"} area estimate`
    };
  }

  // If the provider omitted coordinates, geocode the posting's city/ZIP/location
  // text and use the resulting centroid as a last-resort estimate.
  if (String(job.location || "").trim()) {
    try {
      const origin = await geoapifySearchOrigin(job.location, null, null);
      if (origin && validCoordinate(origin.latitude, origin.longitude)) {
        return {
          latitude: origin.latitude,
          longitude: origin.longitude,
          location: origin.label || job.location,
          precision: "area",
          provider: "Geoapify area estimate"
        };
      }
    } catch (error) {
      console.error("Best-estimate location lookup failed:", error.message);
    }
  }

  return null;
}

function usaJobsSalaryPeriod(remuneration) {
  const code = String(remuneration?.RateIntervalCode || "").toUpperCase();
  const description = String(remuneration?.Description || "").toLowerCase();
  if (code === "PH" || description.includes("hour")) return "hour";
  if (code === "PD" || description.includes("day")) return "day";
  if (code === "PW" || description.includes("week")) return "week";
  if (code === "PM" || description.includes("month")) return "month";
  return "year";
}

function closestUSAJobsLocation(locations, origin) {
  const valid = (Array.isArray(locations) ? locations : [])
    .map((location) => ({
      raw: location,
      latitude: Number(location?.Latitude),
      longitude: Number(location?.Longitude)
    }))
    .filter((location) => validCoordinate(location.latitude, location.longitude));

  if (!valid.length) return null;
  if (!origin || !validCoordinate(origin.latitude, origin.longitude)) return valid[0];

  let best = valid[0];
  let bestDistance = Infinity;
  for (const location of valid) {
    const distance = milesBetween(
      origin.latitude, origin.longitude, location.latitude, location.longitude
    );
    if (distance < bestDistance) {
      bestDistance = distance;
      best = location;
    }
  }
  return best;
}

function normalizeUSAJobsJob(item, origin) {
  const descriptor = item?.MatchedObjectDescriptor || {};
  const bestLocation = closestUSAJobsLocation(descriptor.PositionLocation, origin);
  const providerLocation = bestLocation?.raw?.LocationName ||
    descriptor.PositionLocationDisplay || "";
  const remuneration = Array.isArray(descriptor.PositionRemuneration)
    ? descriptor.PositionRemuneration[0] : null;
  const salaryMin = Number(remuneration?.MinimumRange);
  const salaryMax = Number(remuneration?.MaximumRange);
  const categories = Array.isArray(descriptor.JobCategory) ? descriptor.JobCategory : [];
  const applyUris = Array.isArray(descriptor.ApplyURI) ? descriptor.ApplyURI : [];
  const details = descriptor.UserArea?.Details || {};
  const exact = looksLikeStreetAddress(providerLocation);

  return {
    id: String(descriptor.PositionID || item?.MatchedObjectId || ""),
    source: "USAJOBS",
    title: descriptor.PositionTitle || "Untitled job",
    company: descriptor.OrganizationName || descriptor.DepartmentName || "U.S. Government",
    latitude: bestLocation ? bestLocation.latitude : null,
    longitude: bestLocation ? bestLocation.longitude : null,
    salary_min: Number.isFinite(salaryMin) ? salaryMin : null,
    salary_max: Number.isFinite(salaryMax) ? salaryMax : null,
    salary_period: usaJobsSalaryPeriod(remuneration),
    category: categories[0]?.Name || "Federal Government",
    location: providerLocation,
    description: details.JobSummary || descriptor.QualificationSummary ||
      descriptor.PositionFormattedDescription?.[0]?.Content || "",
    apply_url: applyUris[0] || descriptor.PositionURI || "",
    posted_at: descriptor.PublicationStartDate || descriptor.PositionStartDate || "",
    location_precision: exact ? "exact" : "area",
    location_approximate: !exact,
    location_match_provider: "USAJOBS"
  };
}

function normalizeAdzunaJob(item) {
  const lat = Number(item.latitude);
  const lon = Number(item.longitude);
  const providerLocation = item.location?.display_name || "";
  const exact = looksLikeStreetAddress(providerLocation);

  return {
    id: String(item.id || ""),
    source: "Adzuna",
    title: item.title || "Untitled job",
    company: item.company?.display_name || "Unknown company",
    latitude: validCoordinate(lat, lon) ? lat : null,
    longitude: validCoordinate(lat, lon) ? lon : null,
    salary_min: Number.isFinite(Number(item.salary_min)) ? Number(item.salary_min) : null,
    salary_max: Number.isFinite(Number(item.salary_max)) ? Number(item.salary_max) : null,
    salary_period: "year",
    category: item.category?.label || "",
    location: providerLocation,
    description: item.description || "",
    apply_url: item.redirect_url || "",
    posted_at: item.created || "",
    location_precision: exact ? "exact" : "area",
    location_approximate: !exact,
    location_match_provider: null
  };
}

async function enrichJobLocation(job) {
  if (!job) return job;

  if (looksLikeStreetAddress(job.location)) {
    job.location_precision = "exact";
    job.location_approximate = false;
    job.location_confidence = "high";
    return job;
  }

  // V9.4.35: trust evidence from the current posting before any learned cache.
  // This prevents a stale branch match from overriding a street address that the
  // employer actually supplied in the job description or structured posting data.
  let postingAddress = await geoapifyAddressCandidate(job);
  if (!postingAddress) {
    const pageAddress = await postingPageStreetAddress(job);
    if (pageAddress) postingAddress = await geoapifyExplicitAddress(job, pageAddress, "posting-page-address");
  }
  if (postingAddress) {
    job.latitude = postingAddress.latitude;
    job.longitude = postingAddress.longitude;
    job.location = postingAddress.location;
    job.location_precision = "exact";
    job.location_approximate = false;
    job.location_confidence = "high";
    job.location_match_provider = postingAddress.reason === "posting-page-address"
      ? "Employer/ATS posting address" : "Geoapify posting address";
    rememberWorkplace(job, {
      latitude: job.latitude,
      longitude: job.longitude,
      location: job.location,
      precision: "exact",
      confidence: "high"
    });
    return job;
  }

  const cachedWorkplace = await getCachedWorkplace(job);
  if (cachedWorkplace) {
    job.latitude = cachedWorkplace.latitude;
    job.longitude = cachedWorkplace.longitude;
    job.location = cachedWorkplace.location || job.location;
    job.location_precision = cachedWorkplace.precision || "likely";
    job.location_approximate = cachedWorkplace.precision !== "exact";
    job.location_confidence = cachedWorkplace.confidence || "medium";
    job.location_match_provider = "JobBubble workplace cache";
    return job;
  }

  // USAJOBS postings often describe an official duty area rather than a public
  // storefront. If there is no explicit street address, preserve the official
  // area coordinate instead of inventing a building.
  if (job.source === "USAJOBS") {
    const estimate = await bestEstimateForJob(job);
    if (estimate) {
      job.latitude = estimate.latitude;
      job.longitude = estimate.longitude;
      job.location = estimate.location || job.location;
      job.location_precision = estimate.precision;
      job.location_approximate = true;
      job.location_confidence = "low";
      job.location_match_provider = estimate.provider;
    }
    return job;
  }

  const match = await geoapifyLikelyWorkplace(job);
  if (match) {
    job.latitude = match.latitude;
    job.longitude = match.longitude;
    job.location = match.location;
    job.location_precision = "likely";
    job.location_approximate = true;
    job.location_confidence = match.confidence || (match.score >= 105 ? "high" : "medium");
    job.location_match_provider = "Geoapify workplace match";
    rememberWorkplace(job, {
      latitude: job.latitude,
      longitude: job.longitude,
      location: job.location,
      precision: "likely",
      confidence: job.location_confidence
    });
    return job;
  }

  const estimate = await bestEstimateForJob(job);
  if (estimate) {
    job.latitude = estimate.latitude;
    job.longitude = estimate.longitude;
    job.location = estimate.location || job.location;
    job.location_precision = estimate.precision;
    job.location_approximate = true;
    job.location_confidence = "low";
    job.location_match_provider = estimate.provider;
  } else {
    job.location_precision = "area";
    job.location_approximate = true;
    job.location_confidence = "low";
    job.location_match_provider = "Unresolved area estimate";
  }
  return job;
}

function dedupeJobs(jobs) {
  const seen = new Map();
  for (const job of jobs) {
    if (!job) continue;
    const lat = Number(job.latitude);
    const lon = Number(job.longitude);
    const locationKey = validCoordinate(lat, lon)
      ? `${lat.toFixed(2)},${lon.toFixed(2)}`
      : normalizeName(job.location);
    const key = [normalizeName(job.title), normalizeName(job.company), locationKey].join("|");
    const existing = seen.get(key);
    if (!existing || (job.source === "USAJOBS" && existing.source !== "USAJOBS")) {
      seen.set(key, job);
    }
  }
  return Array.from(seen.values());
}

function setDistance(job, origin) {
  if (!validCoordinate(job?.latitude, job?.longitude)) return null;
  const distance = milesBetween(
    origin.latitude, origin.longitude, Number(job.latitude), Number(job.longitude)
  );
  job.distance_miles = Math.round(distance * 10) / 10;
  return distance;
}

function finalizeJobs(jobs, origin, radius) {
  const kept = [];
  for (const job of jobs) {
    const distance = setDistance(job, origin);
    if (distance == null || distance > radius) continue;
    kept.push(job);
  }
  const deduped = dedupeJobs(kept);
  deduped.sort((a, b) => Number(a.distance_miles || 0) - Number(b.distance_miles || 0));
  return deduped;
}

async function runWithConcurrency(items, limit, worker) {
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const current = index++;
      if (current >= items.length) return;
      try {
        await worker(items[current], current);
      } catch (error) {
        console.error("Location refinement failed:", error.message);
      }
    }
  });
  await Promise.all(runners);
}

async function fetchAdzunaJobs(where, radius, query) {
  if (!ADZUNA_APP_ID || !ADZUNA_APP_KEY) {
    throw new Error("Adzuna environment variables are missing");
  }

  const url = new URL("https://api.adzuna.com/v1/api/jobs/us/search/1");
  url.searchParams.set("app_id", ADZUNA_APP_ID);
  url.searchParams.set("app_key", ADZUNA_APP_KEY);
  url.searchParams.set("results_per_page", "50");
  if (where) url.searchParams.set("where", where);
  if (query) url.searchParams.set("what", query);
  if (radius > 0) url.searchParams.set("distance", String(Math.min(radius, 100)));
  url.searchParams.set("content-type", "application/json");

  const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Adzuna HTTP ${response.status}: ${body.slice(0, 200)}`);
  }
  const data = await response.json();
  return Array.isArray(data.results) ? data.results : [];
}

async function fetchUSAJobs(where, radius, query) {
  if (!USAJOBS_API_KEY || !USAJOBS_EMAIL) {
    throw new Error("USAJOBS environment variables are missing");
  }

  const url = new URL("https://data.usajobs.gov/api/search");
  url.searchParams.set("ResultsPerPage", "50");
  url.searchParams.set("Fields", "Full");
  url.searchParams.set("WhoMayApply", "Public");
  if (where) url.searchParams.set("LocationName", where);
  if (query) url.searchParams.set("Keyword", query);
  if (radius > 0 && where) url.searchParams.set("Radius", String(Math.min(radius, 100)));

  const response = await fetch(url, {
    headers: {
      "User-Agent": USAJOBS_EMAIL,
      "Authorization-Key": USAJOBS_API_KEY,
      "Accept": "application/json"
    },
    signal: AbortSignal.timeout(12000)
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`USAJOBS HTTP ${response.status}: ${body.slice(0, 200)}`);
  }
  const data = await response.json();
  const items = data?.SearchResult?.SearchResultItems;
  return Array.isArray(items) ? items : [];
}

function normalizeSource(value) {
  const x = String(value || "all").trim().toLowerCase();
  if (x === "adzuna") return "adzuna";
  if (x === "usajobs" || x === "usa jobs" || x === "usa_jobs") return "usajobs";
  return "all";
}

function makeSearchKey({ where, radius, query, source, centerLat, centerLon }) {
  const latKey = Number.isFinite(centerLat) ? centerLat.toFixed(4) : "";
  const lonKey = Number.isFinite(centerLon) ? centerLon.toFixed(4) : "";
  return [
    String(where || "").toLowerCase().trim(),
    Number(radius).toFixed(1),
    String(query || "").toLowerCase().trim(),
    source,
    latKey,
    lonKey
  ].join("|");
}

function cloneResponse(value, overrides = {}) {
  return {
    ...value,
    jobs: Array.isArray(value.jobs) ? value.jobs.map((job) => ({ ...job })) : [],
    ...overrides
  };
}

async function fetchSelectedProviders(source, where, radius, query) {
  const tasks = [];
  const labels = [];

  if (source === "all" || source === "adzuna") {
    labels.push("Adzuna");
    tasks.push(fetchAdzunaJobs(where, radius, query));
  }
  if (source === "all" || source === "usajobs") {
    labels.push("USAJOBS");
    tasks.push(fetchUSAJobs(where, radius, query));
  }

  const results = await Promise.allSettled(tasks);
  const successful = [];
  let fulfilledCount = 0;

  results.forEach((result, i) => {
    const label = labels[i];
    if (result.status === "fulfilled") {
      fulfilledCount++;
      successful.push({ label, value: result.value });
    } else {
      console.error(`${label} request failed:`, result.reason?.message || result.reason);
    }
  });

  if (!fulfilledCount) throw new Error("All selected job providers are currently unavailable");
  return successful;
}

async function buildSearch(params, cacheKey) {
  const { where, radius, query, source, centerLat, centerLon } = params;
  const origin = await geoapifySearchOrigin(where, centerLat, centerLon);
  if (!origin) throw new Error("Could not resolve the requested search location.");

  const providerResults = await fetchSelectedProviders(source, where, radius, query);
  const normalized = [];

  for (const provider of providerResults) {
    if (provider.label === "Adzuna") {
      normalized.push(...provider.value.map(normalizeAdzunaJob));
    } else if (provider.label === "USAJOBS") {
      normalized.push(...provider.value.map((item) => normalizeUSAJobsJob(item, origin)));
    }
  }

  // Drop jobs that are already clearly outside the requested radius before paying
  // the cost of Geoapify refinement. Keep a small margin because refinement can move
  // an area-level pin closer to the actual workplace.
  const candidates = [];
  for (const job of normalized) {
    if (!validCoordinate(job.latitude, job.longitude)) {
      // Keep coordinate-less postings long enough for description/ATS address
      // extraction to rescue them during enrichment.
      candidates.push(job);
      continue;
    }
    const distance = setDistance(job, origin);
    if (distance != null && distance <= radius + 12) candidates.push(job);
  }
  candidates.sort((a, b) => {
    const ad = Number.isFinite(Number(a.distance_miles)) ? Number(a.distance_miles) : Infinity;
    const bd = Number.isFinite(Number(b.distance_miles)) ? Number(b.distance_miles) : Infinity;
    return ad - bd;
  });

  // Work on the closest jobs first because those are the ones most likely visible.
  const toEnrich = candidates.slice(0, MAX_ENRICH_JOBS);
  const enrichmentPromise = runWithConcurrency(
    toEnrich,
    ENRICH_CONCURRENCY,
    async (job) => { await enrichJobLocation(job); }
  ).then(() => {
    const refinedJobs = finalizeJobs(candidates, origin, radius);
    const refinedResponse = {
      count: refinedJobs.length,
      search_location: origin.label,
      search_latitude: origin.latitude,
      search_longitude: origin.longitude,
      radius_miles: radius,
      source_filter: source,
      location_refining: false,
      jobs: refinedJobs
    };
    jobCache.set(cacheKey, { time: Date.now(), value: refinedResponse });
    return refinedResponse;
  });

  // Do not make the first screen wait for every Geoapify lookup.
  await Promise.race([
    enrichmentPromise,
    new Promise((resolve) => setTimeout(resolve, FIRST_RESPONSE_ENRICH_WAIT_MS))
  ]);

  const cachedAfterWait = jobCache.get(cacheKey);
  if (cachedAfterWait) return cachedAfterWait.value;

  const fastJobs = finalizeJobs(candidates, origin, radius);
  const fastResponse = {
    count: fastJobs.length,
    search_location: origin.label,
    search_latitude: origin.latitude,
    search_longitude: origin.longitude,
    radius_miles: radius,
    source_filter: source,
    location_refining: true,
    jobs: fastJobs
  };

  // Cache the quick response immediately. enrichmentPromise will replace it with the
  // refined version when the background work finishes.
  jobCache.set(cacheKey, { time: Date.now(), value: fastResponse });
  enrichmentPromise.catch((error) => {
    console.error("Background refinement failed:", error.message);
  });
  return fastResponse;
}

function refreshSearchInBackground(params, cacheKey) {
  if (inFlightSearches.has(cacheKey)) return;
  const promise = buildSearch(params, cacheKey)
    .catch((error) => console.error("Background job refresh failed:", error.message))
    .finally(() => inFlightSearches.delete(cacheKey));
  inFlightSearches.set(cacheKey, promise);
}

async function handleJobs(req, res, url) {
  try {
    const where = String(url.searchParams.get("where") || "").trim();
    const query = String(
      url.searchParams.get("what") || url.searchParams.get("query") || ""
    ).trim();
    const requestedRadius = Number(url.searchParams.get("radius") || 25);
    const radius = Number.isFinite(requestedRadius) && requestedRadius > 0
      ? Math.min(requestedRadius, 100) : 25;
    const centerLat = Number(url.searchParams.get("lat"));
    const centerLon = Number(url.searchParams.get("lon"));
    const source = normalizeSource(url.searchParams.get("source"));
    const forceRefresh = url.searchParams.get("refresh") === "1";
    const refined = url.searchParams.get("refined") === "1";

    const params = { where, radius, query, source, centerLat, centerLon };
    const cacheKey = makeSearchKey(params);
    const cached = jobCache.get(cacheKey);
    const age = cached ? Date.now() - cached.time : Infinity;

    if (!forceRefresh && cached && age < JOB_CACHE_TTL_MS && (!refined || !cached.value.location_refining)) {
      return sendJson(res, 200, cloneResponse(cached.value, { cache: "hit" }));
    }

    // If the app asks for refined results while the first response is still being
    // improved in the background, wait briefly for that same work instead of
    // calling Adzuna/USAJOBS a second time.
    if (!forceRefresh && refined && cached && cached.value.location_refining && age < JOB_STALE_TTL_MS) {
      const waitUntil = Date.now() + 6500;
      while (Date.now() < waitUntil) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const latest = jobCache.get(cacheKey)?.value;
        if (latest && !latest.location_refining) {
          return sendJson(res, 200, cloneResponse(latest, { cache: "refined" }));
        }
      }
      const latest = jobCache.get(cacheKey)?.value || cached.value;
      return sendJson(res, 200, cloneResponse(latest, { cache: "refining" }));
    }

    if (!forceRefresh && cached && age < JOB_STALE_TTL_MS && !refined) {
      refreshSearchInBackground(params, cacheKey);
      return sendJson(res, 200, cloneResponse(cached.value, { cache: "stale-refreshing" }));
    }

    let promise = inFlightSearches.get(cacheKey);
    if (!promise) {
      promise = buildSearch(params, cacheKey).finally(() => inFlightSearches.delete(cacheKey));
      inFlightSearches.set(cacheKey, promise);
    }

    let result = await promise;

    // The app can request refined=1 a moment after the first quick response. If the
    // background refinement is still running, wait for the cached refined result.
    if (refined && result.location_refining) {
      const waitUntil = Date.now() + 6500;
      while (Date.now() < waitUntil) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const latest = jobCache.get(cacheKey)?.value;
        if (latest && !latest.location_refining) {
          result = latest;
          break;
        }
      }
    }

    return sendJson(res, 200, cloneResponse(result, { cache: "miss" }));
  } catch (error) {
    console.error("Jobs request failed:", error);
    const status = String(error.message || "").startsWith("Could not resolve") ? 400 : 500;
    return sendJson(res, status, {
      error: status === 400
        ? "Could not resolve the requested search location."
        : "Unable to load live jobs right now.",
      details: error.message
    });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
      });
      return res.end();
    }

    if (req.method === "GET" && url.pathname === "/") {
      return sendJson(res, 200, { name: "JobBubble API", status: "online", version: "9.4.35" });
    }

    if (req.method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, {
        status: "ok",
        version: "9.4.35",
        adzuna: ADZUNA_APP_ID && ADZUNA_APP_KEY ? "enabled" : "disabled",
        geoapify: GEOAPIFY_API_KEY ? "enabled" : "disabled",
        usajobs: USAJOBS_API_KEY && USAJOBS_EMAIL ? "enabled" : "disabled",
        job_cache_entries: jobCache.size,
        geo_cache_entries: geoCache.size,
        workplace_cache_entries: workplaceCache.size,
        firestore_workplace_cache: firestoreEnabled ? "enabled" : "disabled",
        firestore_cache_policy: "high-confidence-only",
        posting_address_lookup: "enabled",
        posting_page_cache_entries: postingPageCache.size,
        searches_in_flight: inFlightSearches.size
      });
    }

    if (req.method === "GET" && url.pathname === "/jobs") {
      return handleJobs(req, res, url);
    }

    return sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    console.error("Unhandled request error:", error);
    return sendJson(res, 500, { error: "Internal server error" });
  }
});

server.listen(PORT, () => {
  console.log(`JobBubble backend V9.4.35 listening on port ${PORT}`);
  console.log("Adzuna:", ADZUNA_APP_ID && ADZUNA_APP_KEY ? "enabled" : "disabled");
  console.log("Geoapify:", GEOAPIFY_API_KEY ? "enabled" : "disabled");
  console.log("USAJOBS:", USAJOBS_API_KEY && USAJOBS_EMAIL ? "enabled" : "disabled");
  console.log("Fast search cache: enabled");
  console.log("Firestore workplace cache:", firestoreEnabled ? "enabled" : "disabled");
  console.log("Firestore cache policy: high-confidence-only");
  console.log("Posting address lookup: enabled");
});
