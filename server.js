const http = require("http");

const PORT = process.env.PORT || 3000;
const ADZUNA_APP_ID = process.env.ADZUNA_APP_ID;
const ADZUNA_APP_KEY = process.env.ADZUNA_APP_KEY;
const GEOAPIFY_API_KEY = process.env.GEOAPIFY_API_KEY;

const GEO_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const geoCache = new Map();

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(JSON.stringify(data));
}

function validCoordinate(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) &&
    lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180 &&
    !(Math.abs(lat) < 0.0001 && Math.abs(lon) < 0.0001);
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

function nameScore(company, result) {
  const want = normalizeName(company);
  const got = normalizeName(result?.name || result?.formatted || "");

  if (!want || !got) return 0;
  if (got === want) return 100;
  if (got.includes(want) || want.includes(got)) return 85;

  const a = new Set(want.split(" ").filter(Boolean));
  const b = new Set(got.split(" ").filter(Boolean));

  let overlap = 0;
  for (const token of a) {
    if (b.has(token)) overlap++;
  }

  return a.size ? Math.round((overlap / a.size) * 70) : 0;
}

function milesBetween(lat1, lon1, lat2, lon2) {
  const R = 3958.761;
  const p = Math.PI / 180;
  const dLat = (lat2 - lat1) * p;
  const dLon = (lon2 - lon1) * p;

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * p) *
    Math.cos(lat2 * p) *
    Math.sin(dLon / 2) ** 2;

  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function geoapifyLikelyWorkplace(job) {
  if (
    !GEOAPIFY_API_KEY ||
    !job ||
    looksLikeStreetAddress(job.location) ||
    isGenericCompanyName(job.company)
  ) {
    return null;
  }

  const cacheKey =
    `${normalizeName(job.company)}|${String(job.location || "")
      .toLowerCase()
      .trim()}`;

  const cached = geoCache.get(cacheKey);

  if (
    cached &&
    Date.now() - cached.time < GEO_CACHE_TTL_MS
  ) {
    return cached.value;
  }

  const url =
    new URL("https://api.geoapify.com/v1/geocode/search");

  url.searchParams.set(
    "text",
    `${job.company}, ${job.location}`
  );

  url.searchParams.set("type", "amenity");
  url.searchParams.set("filter", "countrycode:us");
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "5");
  url.searchParams.set("lang", "en");
  url.searchParams.set("apiKey", GEOAPIFY_API_KEY);

  if (validCoordinate(job.latitude, job.longitude)) {
    url.searchParams.set(
      "bias",
      `proximity:${job.longitude},${job.latitude}`
    );
  }

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(7000)
    });

    if (!response.ok) {
      throw new Error(`Geoapify HTTP ${response.status}`);
    }

    const data = await response.json();

    const results =
      Array.isArray(data.results) ? data.results : [];

    let best = null;
    let bestScore = -1;

    for (
