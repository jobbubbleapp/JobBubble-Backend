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
  return /\d/.test(x) && /\b(st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|way|ct|court|pl|place|pkwy|parkway|hwy|highway|suite|ste)\b/.test(x);
}

function isGenericCompanyName(name) {
  const x = String(name || "").trim().toLowerCase();
  return !x || x === "unknown company" || x === "employer" ||
    x === "confidential" || x === "company" ||
    x.includes("confidential employer") ||
    x.includes("undisclosed");
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

async function geoapifySearchOrigin(where, fallbackLat, fallbackLon) {
  if (validCoordinate(fallbackLat, fallbackLon)) {
    return {
      latitude: fallbackLat,
      longitude: fallbackLon,
      label: where || `${fallbackLat},${fallbackLon}`
    };
  }

  if (!GEOAPIFY_API_KEY || !String(where || "").trim()) {
    return null;
  }

  const url = new URL("https://api.geoapify.com/v1/geocode/search");

  url.searchParams.set("text", String(where).trim());
  url.searchParams.set("filter", "countrycode:us");
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "1");
  url.searchParams.set("lang", "en");
  url.searchParams.set("apiKey", GEOAPIFY_API_KEY);

  const response = await fetch(url, {
    signal: AbortSignal.timeout(7000)
  });

  if (!response.ok) {
    throw new Error(`Geoapify origin HTTP ${response.status}`);
  }

  const data = await response.json();
  const r = Array.isArray(data.results) ? data.results[0] : null;

  const lat = Number(r?.lat);
  const lon = Number(r?.lon);

  if (!validCoordinate(lat, lon)) {
    return null;
  }

  return {
    latitude: lat,
    longitude: lon,
    label: r.formatted || String(where).trim()
  };
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
    `${normalizeName(job.company)}|` +
    `${String(job.location || "").toLowerCase().trim()}`;

  const cached = geoCache.get(cacheKey);

  if (
    cached &&
    Date.now() - cached.time < GEO_CACHE_TTL_MS
  ) {
    return cached.value;
  }

  const url = new URL(
    "https://api.geoapify.com/v1/geocode/search"
  );

  url.searchParams.set(
    "text",
    `${job.company}, ${job.location}`
  );

  url.searchParams.set("type", "amenity");
  url.searchParams.set("filter", "countrycode:us");  if (validCoordinate(job.latitude, job.longitude)) {
    url.searchParams.set(
      "bias",
      `proximity:${job.longitude},${job.latitude}`
    );
  }

  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "5");
  url.searchParams.set("lang", "en");
  url.searchParams.set("apiKey", GEOAPIFY_API_KEY);

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(7000)
    });

    if (!response.ok) {
      throw new Error(`Geoapify workplace HTTP ${response.status}`);
    }

    const data = await response.json();
    const results = Array.isArray(data.results)
      ? data.results
      : [];

    let best = null;
    let bestScore = 0;

    for (const result of results) {
      const lat = Number(result.lat);
      const lon = Number(result.lon);

      if (!validCoordinate(lat, lon)) {
        continue;
      }

      const score = nameScore(job.company, result);

      if (score > bestScore) {
        bestScore = score;
        best = result;
      }
    }

    if (!best || bestScore < 55) {
      geoCache.set(cacheKey, {
        time: Date.now(),
        value: null
      });

      return null;
    }

    const match = {
      latitude: Number(best.lat),
      longitude: Number(best.lon),
      location:
        best.formatted ||
        best.address_line2 ||
        job.location,
      score: bestScore
    };

    geoCache.set(cacheKey, {
      time: Date.now(),
      value: match
    });

    return match;
  } catch (error) {
    console.error(
      "Geoapify workplace lookup failed:",
      error.message
    );

    return null;
  }
}

function normalizeAdzunaJob(item) {
  const lat = Number(item.latitude);
  const lon = Number(item.longitude);

  return {
    id: String(item.id || ""),
    source: "Adzuna",
    title: item.title || "Untitled job",
    company:
      item.company?.display_name ||
      "Unknown company",

    latitude: validCoordinate(lat, lon)
      ? lat
      : null,

    longitude: validCoordinate(lat, lon)
      ? lon
      : null,

    salary_min:
      Number.isFinite(Number(item.salary_min))
        ? Number(item.salary_min)
        : null,

    salary_max:
      Number.isFinite(Number(item.salary_max))
        ? Number(item.salary_max)
        : null,

    salary_period: "year",

    category:
      item.category?.label || "",

    location:
      item.location?.display_name || "",

    description:
      item.description || "",

    apply_url:
      item.redirect_url || "",

    posted_at:
      item.created || "",

    location_precision:
      looksLikeStreetAddress(
        item.location?.display_name
      )
        ? "exact"
        : "area",

    location_approximate:
      !looksLikeStreetAddress(
        item.location?.display_name
      ),

    location_match_provider: null
  };
}

async function enrichJobLocation(job) {
  if (!job) {
    return job;
  }

  if (looksLikeStreetAddress(job.location)) {
    job.location_precision = "exact";
    job.location_approximate = false;
    return job;
  }

  const match =
    await geoapifyLikelyWorkplace(job);

  if (!match) {
    job.location_precision = "area";
    job.location_approximate = true;
    return job;
  }

  job.latitude = match.latitude;
  job.longitude = match.longitude;
  job.location = match.location;
  job.location_precision = "likely";
  job.location_approximate = true;
  job.location_match_provider = "Geoapify";

  return job;
}

async function fetchAdzunaJobs(
  where,
  radius,
  query
) {
  if (!ADZUNA_APP_ID || !ADZUNA_APP_KEY) {
    throw new Error(
      "Adzuna environment variables are missing"
    );
  }

  const url = new URL(
    "https://api.adzuna.com/v1/api/jobs/us/search/1"
  );

  url.searchParams.set(
    "app_id",
    ADZUNA_APP_ID
  );

  url.searchParams.set(
    "app_key",
    ADZUNA_APP_KEY
  );

  url.searchParams.set(
    "results_per_page",
    "50"
  );

  if (where) {
    url.searchParams.set("where", where);
  }

  if (query) {
    url.searchParams.set("what", query);
  }

  if (radius > 0) {
    url.searchParams.set(
      "distance",
      String(Math.min(radius, 100))
    );
  }

  url.searchParams.set(
    "content-type",
    "application/json"
  );

  const response = await fetch(url, {
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    const body = await response.text();

    throw new Error(
      `Adzuna HTTP ${response.status}: ` +
      body.slice(0, 200)
    );
  }

  const data = await response.json();

  return Array.isArray(data.results)
    ? data.results
    : [];
}async function handleJobs(req, res, url) {
  try {
    const where =
      String(url.searchParams.get("where") || "").trim();

    const query =
      String(
        url.searchParams.get("what") ||
        url.searchParams.get("query") ||
        ""
      ).trim();

    const requestedRadius =
      Number(url.searchParams.get("radius") || 25);

    const radius =
      Number.isFinite(requestedRadius) &&
      requestedRadius > 0
        ? Math.min(requestedRadius, 100)
        : 25;

    const centerLat =
      Number(url.searchParams.get("lat"));

    const centerLon =
      Number(url.searchParams.get("lon"));

    const origin =
      await geoapifySearchOrigin(
        where,
        centerLat
