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
// Reuse resolved workplaces so repeated jobs for the same employer/location do not
// consume another external lookup. This is deliberately separate from geoCache so
// it can use a much longer lifetime.
const workplaceCache = new Map();
const WORKPLACE_CACHE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

const jobCache = new Map();
const inFlightSearches = new Map();

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
    headers: { "Content-Type": "application/x-www-form-urlencoded" },      location: readFirestoreField(f.location) || "",
      precision: readFirestoreField(f.precision) || "likely",
      confidence: readFirestoreField(f.confidence) || "medium"
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
    const results = Array.isArray(data.results) ? data.results : [];    };
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
    }))  if (job.source === "USAJOBS") {
    const postingAddress = extractStreetAddress(job.description)
      ? await geoapifyAddressCandidate(job)
      : null;
    if (postingAddress) {
      job.latitude = postingAddress.latitude;
      job.longitude = postingAddress.longitude;
      job.location = postingAddress.location;
      job.location_precision = "likely";
      job.location_approximate = true;
      job.location_confidence = "high";
      job.location_match_provider = "Geoapify posting address";
      rememberWorkplace(job, {
        latitude: job.latitude,
        longitude: job.longitude,
        location: job.location,
        precision: "likely",
        confidence: "high"
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
    }
    return job;
  }

  // A street address written in the posting is the strongest clue after an exact
  // provider address.
  const postingAddress = await geoapifyAddressCandidate(job);
  if (postingAddress) {
    job.latitude = postingAddress.latitude;
    job.longitude = postingAddress.longitude;
    job.location = postingAddress.location;  }
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
      "User-Agent": USAJOBS_EMAIL,  });
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
