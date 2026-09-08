const http = require("http");

const PORT = process.env.PORT || 3000;
const ADZUNA_APP_ID = process.env.ADZUNA_APP_ID;
const ADZUNA_APP_KEY = process.env.ADZUNA_APP_KEY;
const GEOAPIFY_API_KEY = process.env.GEOAPIFY_API_KEY;
const cache = new Map();

function send(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(JSON.stringify(data));
}

function street(s = "") {
  return /\d/.test(s) &&
    /\b(st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|way|ct|court|pl|place|pkwy|parkway|hwy|highway|suite|ste)\b/i.test(s);
}

function genericCompany(s = "") {
  s = s.trim().toLowerCase();
  return !s ||
    ["unknown company", "employer", "confidential", "company"].includes(s) ||
    s.includes("confidential employer") ||
    s.includes("undisclosed");
}

function norm(s = "") {
  return s.toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\b(inc|llc|corp|corporation|company|co|ltd|the)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function nameScore(company, r) {
  const a = norm(company);
  const b = norm(r.name || r.formatted || "");

  if (!a || !b) return 0;
  if (a === b) return 100;
  if (a.includes(b) || b.includes(a)) return 85;

  const A = new Set(a.split(" ").filter(Boolean));
  const B = new Set(b.split(" ").filter(Boolean));

  let hit = 0;
  for (const t of A) {
    if (B.has(t)) hit++;
  }

  return A.size ? Math.round(hit / A.size * 70) : 0;
}

function miles(a, b, c, d) {
  const p = Math.PI / 180;
  const R = 3958.761;
  const x = (c - a) * p;
  const y = (d - b) * p;

  const z =
    Math.sin(x / 2) ** 2 +
    Math.cos(a * p) *
    Math.cos(c * p) *
    Math.sin(y / 2) ** 2;

  return R * 2 * Math.atan2(Math.sqrt(z), Math.sqrt(1 - z));
}

async function geo(job) {
  if (
    !GEOAPIFY_API_KEY ||
    street(job.location) ||
    genericCompany(job.company)
  ) {
    return null;
  }

  const key =
    `${norm(job.company)}|${job.location.toLowerCase().trim()}`;

  const old = cache.get(key);

  if (old && Date.now() - old.t < 604800000) {
    return old.v;
  }

  const u =
    new URL("https://api.geoapify.com/v1/geocode/search");

  u.searchParams.set(
    "text",
    `${job.company}, ${job.location}`
  );

  u.searchParams.set("filter", "countrycode:us");
  u.searchParams.set("format", "json");
  u.searchParams.set("limit", "5");
  u.searchParams.set("apiKey", GEOAPIFY_API_KEY);

  if (
    Number.isFinite(job.latitude) &&
    Number.isFinite(job.longitude)
  ) {
    u.searchParams.set(
      "bias",
      `proximity:${job.longitude},${job.latitude}`
    );
  }

  try {
    const r = await fetch(u);

    if (!r.ok) {
      throw new Error(`Geoapify HTTP ${r.status}`);
    }

    const data = await r.json();

    let best = null;
    let score = -1;

    for (const x of data.results || []) {
      const lat = Number(x.lat);
      const lon = Number(x.lon);

      if (
        !Number.isFinite(lat) ||
        !Number.isFinite(lon)
      ) continue;

      let s = nameScore(job.company, x);

      if (
        Number.isFinite(job.latitude) &&
        Number.isFinite(job.longitude)
      ) {
        const d = miles(
          job.latitude,
          job.longitude,
          lat,
          lon
        );

        if (d > 30) continue;

        s +=
          d <= 3 ? 20 :
          d <= 10 ? 12 :
          d <= 20 ? 5 : 0;
      }

      if (Number(x.rank?.confidence) >= 0.8) {
        s += 8;
      }

      if (s > score) {
        score = s;
        best = x;
      }
    }

    const v =
      best && score >= 70
        ? {
            latitude: +best.lat,
            longitude: +best.lon,
            address:
              best.formatted ||
              job.location,
            score
          }
        : null;

    cache.set(key, {
      t: Date.now(),
      v
    });

    return v;

  } catch (e) {
    console.warn(
      "Geoapify lookup failed:",
      e.message
    );

    return null;
  }
}

async function searchAdzuna(p) {
  if (!ADZUNA_APP_ID || !ADZUNA_APP_KEY) {
    throw new Error(
      "Adzuna credentials are not configured"
    );
  }

  const page =
    Math.max(1, +p.get("page") || 1);

  const u =
    new URL(
      `https://api.adzuna.com/v1/api/jobs/us/search/${page}`
    );

  u.searchParams.set(
    "app_id",
    ADZUNA_APP_ID
  );

  u.search
