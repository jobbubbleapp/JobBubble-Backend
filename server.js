const http = require("http");

const PORT = process.env.PORT || 3000;
const ADZUNA_APP_ID = process.env.ADZUNA_APP_ID;
const ADZUNA_APP_KEY = process.env.ADZUNA_APP_KEY;
const GEOAPIFY_API_KEY = process.env.GEOAPIFY_API_KEY;
const USAJOBS_API_KEY = process.env.USAJOBS_API_KEY;
const USAJOBS_EMAIL = process.env.USAJOBS_EMAIL;

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
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180 &&
    !(Math.abs(lat) < 0.0001 && Math.abs(lon) < 0.0001)
  );
}

function looksLikeStreetAddress(text) {
  const x = String(text || "").toLowerCase();

  return (
    /\d/.test(x) &&
    /\b(st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|way|ct|court|pl|place|pkwy|parkway|hwy|highway|suite|ste)\b/.test(x)
  );
}

function isGenericCompanyName(name) {
  const x = String(name || "")
    .trim()
    .toLowerCase();

  return (
    !x ||
    x === "unknown company" ||
    x === "employer" ||
    x === "confidential" ||
    x === "company" ||
    x.includes("confidential employer") ||
    x.includes("undisclosed")
  );
}

function normalizeName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(
      /\b(inc|llc|corp|corporation|company|co|ltd|the)\b/g,
      " "
    )
    .replace(/\s+/g, " ")
    .trim();
}

function nameScore(company, result) {
  const want = normalizeName(company);

  const got = normalizeName(
    result?.name ||
    result?.formatted ||
    ""
  );

  if (!want || !got) return 0;

  if (got === want) {
    return 100;
  }

  if (
    got.includes(want) ||
    want.includes(got)
  ) {
    return 85;
  }

  const a = new Set(
    want.split(" ").filter(Boolean)
  );

  const b = new Set(
    got.split(" ").filter(Boolean)
  );

  let overlap = 0;

  for (const token of a) {
    if (b.has(token)) {
      overlap++;
    }
  }

  return a.size
    ? Math.round((overlap / a.size) * 70)
    : 0;
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

  return (
    R *
    2 *
    Math.atan2(
      Math.sqrt(a),
      Math.sqrt(1 - a)
    )
  );
}

async function geoapifySearchOrigin(
  where,
  fallbackLat,
  fallbackLon
) {
  if (validCoordinate(fallbackLat, fallbackLon)) {
    return {
      latitude: fallbackLat,
      longitude: fallbackLon,
      label: where || `${fallbackLat},${fallbackLon}`
    };
  }

  if (
    !GEOAPIFY_API_KEY ||
    !String(where || "").trim()
  ) {
    return null;
  }

  const url = new URL(
    "https://api.geoapify.com/v1/geocode/search"
  );

  url.searchParams.set(
    "text",
    String(where).trim()
  );

  url.searchParams.set(
    "filter",
    "countrycode:us"
  );

  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "1");
  url.searchParams.set("lang", "en");
  url.searchParams.set(
    "apiKey",
    GEOAPIFY_API_KEY
  );

  const response = await fetch(url, {
    signal: AbortSignal.timeout(7000)
  });

  if (!response.ok) {
    throw new Error(
      `Geoapify origin HTTP ${response.status}`
    );
  }

  const data = await response.json();

  const result =
    Array.isArray(data.results)
      ? data.results[0]
      : null;

  const lat = Number(result?.lat);
  const lon = Number(result?.lon);

  if (!validCoordinate(lat, lon)) {
    return null;
  }

  return {
    latitude: lat,
    longitude: lon,
    label:
      result.formatted ||
      String(where).trim()
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
    normalizeName(job.company) +
    "|" +
    String(job.location || "")
      .trim()
      .toLowerCase();

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

  url.searchParams.set(
    "filter",
    "countrycode:us"
  );

  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "5");
  url.searchParams.set("lang", "en");
  url.searchParams.set(
    "apiKey",
    GEOAPIFY_API_KEY
  );

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(7000)
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json();

    const results =
      Array.isArray(data.results)
        ? data.results
        : [];

    let best = null;
    let bestScore = 0;

    for (const result of results) {
      const score = nameScore(
        job.company,
        result
      );

      const lat = Number(result.lat);
      const lon = Number(result.lon);

      if (
        score > bestScore &&
        validCoordinate(lat, lon)
      ) {
        bestScore = score;
        best = result;
      }
    }

    if (!best || bestScore < 50) {
      geoCache.set(cacheKey, {
        time: Date.now(),
        value: null
      });

      return null;
    }

    const value = {
      latitude: Number(best.lat),
      longitude: Number(best.lon),
      formatted:
        best.formatted ||
        best.address_line1 ||
        job.location,
      score: bestScore
    };

    geoCache.set(cacheKey, {
      time: Date.now(),
      value
    });

    return value;
  } catch (error) {
    console.error(
      "Geoapify workplace lookup failed:",
      error.message
    );

    return null;
  }
}function usaJobsSalaryPeriod(remuneration) {
  const code = String(
    remuneration?.RateIntervalCode || ""
  ).toUpperCase();

  const description = String(
    remuneration?.Description || ""
  ).toLowerCase();

  if (code === "PH" || description.includes("hour")) {
    return "hour";
  }

  if (code === "PD" || description.includes("day")) {
    return "day";
  }

  if (code === "PW" || description.includes("week")) {
    return "week";
  }

  if (code === "PM" || description.includes("month")) {
    return "month";
  }

  return "year";
}

function closestUSAJobsLocation(locations, origin) {
  const valid = (Array.isArray(locations) ? locations : [])
    .map((location) => ({
      raw: location,
      latitude: Number(location?.Latitude),
      longitude: Number(location?.Longitude)
    }))
    .filter((location) =>
      validCoordinate(
        location.latitude,
        location.longitude
      )
    );

  if (!valid.length) {
    return null;
  }

  if (
    !origin ||
    !validCoordinate(
      origin.latitude,
      origin.longitude
    )
  ) {
    return valid[0];
  }

  let best = valid[0];
  let bestDistance = Infinity;

  for (const location of valid) {
    const distance = milesBetween(
      origin.latitude,
      origin.longitude,
      location.latitude,
      location.longitude
    );

    if (distance < bestDistance) {
      bestDistance = distance;
      best = location;
    }
  }

  return best;
}

function normalizeUSAJobsJob(item, origin) {
  const descriptor =
    item?.MatchedObjectDescriptor || {};

  const bestLocation = closestUSAJobsLocation(
    descriptor.PositionLocation,
    origin
  );

  const providerLocation =
    bestLocation?.raw?.LocationName ||
    descriptor.PositionLocationDisplay ||
    "";

  const remuneration =
    Array.isArray(descriptor.PositionRemuneration)
      ? descriptor.PositionRemuneration[0]
      : null;

  const salaryMin = Number(
    remuneration?.MinimumRange
  );

  const salaryMax = Number(
    remuneration?.MaximumRange
  );

  const categories =
    Array.isArray(descriptor.JobCategory)
      ? descriptor.JobCategory
      : [];

  const applyUris =
    Array.isArray(descriptor.ApplyURI)
      ? descriptor.ApplyURI
      : [];

  const details =
    descriptor.UserArea?.Details || {};

  const exact =
    looksLikeStreetAddress(providerLocation);

  return {
    id: String(
      descriptor.PositionID ||
      item?.MatchedObjectId ||
      ""
    ),

    source: "USAJOBS",

    title:
      descriptor.PositionTitle ||
      "Untitled job",

    company:
      descriptor.OrganizationName ||
      descriptor.DepartmentName ||
      "U.S. Government",

    latitude:
      bestLocation
        ? bestLocation.latitude
        : null,

    longitude:
      bestLocation
        ? bestLocation.longitude
        : null,

    salary_min:
      Number.isFinite(salaryMin)
        ? salaryMin
        : null,

    salary_max:
      Number.isFinite(salaryMax)
        ? salaryMax
        : null,

    salary_period:
      usaJobsSalaryPeriod(remuneration),

    category:
      categories[0]?.Name ||
      "Federal Government",

    location:
      providerLocation,

    description:
      details.JobSummary ||
      descriptor.QualificationSummary ||
      descriptor.PositionFormattedDescription?.[0]?.Content ||
      "",

    apply_url:
      applyUris[0] ||
      descriptor.PositionURI ||
      "",

    posted_at:
      descriptor.PublicationStartDate ||
      descriptor.PositionStartDate ||
      "",

    location_precision:
      exact
        ? "exact"
        : "area",

    location_approximate:
      !exact,

    location_match_provider:
      "USAJOBS"
  };
}

function dedupeJobs(jobs) {
  const seen = new Map();

  for (const job of jobs) {
    if (!job) continue;

    const lat = Number(job.latitude);
    const lon = Number(job.longitude);

    const locationKey =
      validCoordinate(lat, lon)
        ? `${lat.toFixed(2)},${lon.toFixed(2)}`
        : normalizeName(job.location);

    const key = [
      normalizeName(job.title),
      normalizeName(job.company),
      locationKey
    ].join("|");

    const existing = seen.get(key);

    if (!existing) {
      seen.set(key, job);
      continue;
    }

    // Prefer the official USAJOBS listing if another
    // provider also has the same federal job.
    if (
      job.source === "USAJOBS" &&
      existing.source !== "USAJOBS"
    ) {
      seen.set(key, job);
    }
  }

  return Array.from(seen.values());
}

function normalizeAdzunaJob(item) {
  const lat = Number(item.latitude);
  const lon = Number(item.longitude);

  const providerLocation =
    item.location?.display_name || "";

  const exact =
    looksLikeStreetAddress(
      providerLocation
    );

  return {
    id: String(item.id || ""),

    source: "Adzuna",

    title:
      item.title ||
      "Untitled job",

    company:
      item.company?.display_name ||
      "Unknown company",

    latitude:
      validCoordinate(lat, lon)
        ? lat
        : null,

    longitude:
      validCoordinate(lat, lon)
        ? lon
        : null,

    salary_min:
      Number.isFinite(
        Number(item.salary_min)
      )
        ? Number(item.salary_min)
        : null,

    salary_max:
      Number.isFinite(
        Number(item.salary_max)
      )
        ? Number(item.salary_max)
        : null,

    salary_period: "year",

    category:
      item.category?.label || "",

    location:
      providerLocation,

    description:
      item.description || "",

    apply_url:
      item.redirect_url || "",

    posted_at:
      item.created || "",

    location_precision:
      exact
        ? "exact"
        : "area",

    location_approximate:
      !exact,

    location_match_provider:
      null
  };
}

async function enrichJobLocation(job) {
  if (!job) {
    return job;
  }

  if (
    looksLikeStreetAddress(
      job.location
    )
  ) {
    job.location_precision =
      "exact";

    job.location_approximate =
      false;

    return job;
  }

  // USAJOBS already supplies official location coordinates.
  if (
    job.source === "USAJOBS" &&
    validCoordinate(
      job.latitude,
      job.longitude
    )
  ) {
    job.location_precision = "area";
    job.location_approximate = true;
    job.location_match_provider = "USAJOBS";

    return job;
  }

  const match =
    await geoapifyLikelyWorkplace(job);

  if (!match) {
    job.location_precision =
      "area";

    job.location_approximate =
      true;

    return job;
  }

  job.latitude =
    match.latitude;

  job.longitude =
    match.longitude;

  job.location =
    match.location;

  job.location_precision =
    "likely";

  job.location_approximate =
    true;

  job.location_match_provider =
    "Geoapify";

  return job;
}async function fetchAdzunaJobs(
  where,
  radius,
  query
) {
  if (
    !ADZUNA_APP_ID ||
    !ADZUNA_APP_KEY
  ) {
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
    url.searchParams.set(
      "where",
      where
    );
  }

  if (query) {
    url.searchParams.set(
      "what",
      query
    );
  }

  if (radius > 0) {
    url.searchParams.set(
      "distance",
      String(
        Math.min(
          radius,
          100
        )
      )
    );
  }

  url.searchParams.set(
    "content-type",
    "application/json"
  );

  const response = await fetch(
    url,
    {
      signal:
        AbortSignal.timeout(
          15000
        )
    }
  );

  if (!response.ok) {
    const body =
      await response.text();

    throw new Error(
      `Adzuna HTTP ${response.status}: ` +
      body.slice(0, 200)
    );
  }

  const data =
    await response.json();

  return Array.isArray(
    data.results
  )
    ? data.results
    : [];
}

async function fetchUSAJobs(
  where,
  radius,
  query
) {
  if (
    !USAJOBS_API_KEY ||
    !USAJOBS_EMAIL
  ) {
    throw new Error(
      "USAJOBS environment variables are missing"
    );
  }

  const url = new URL(
    "https://data.usajobs.gov/api/search"
  );

  url.searchParams.set(
    "ResultsPerPage",
    "50"
  );

  url.searchParams.set(
    "Fields",
    "Full"
  );

  url.searchParams.set(
    "WhoMayApply",
    "Public"
  );

  if (where) {
    url.searchParams.set(
      "LocationName",
      where
    );
  }

  if (query) {
    url.searchParams.set(
      "Keyword",
      query
    );
  }

  if (radius > 0 && where) {
    url.searchParams.set(
      "Radius",
      String(
        Math.min(radius, 100)
      )
    );
  }

  const response = await fetch(
    url,
    {
      headers: {
        "User-Agent": USAJOBS_EMAIL,
        "Authorization-Key": USAJOBS_API_KEY,
        "Accept": "application/json"
      },

      signal:
        AbortSignal.timeout(
          15000
        )
    }
  );

  if (!response.ok) {
    const body =
      await response.text();

    throw new Error(
      `USAJOBS HTTP ${response.status}: ` +
      body.slice(0, 200)
    );
  }

  const data =
    await response.json();

  const items =
    data?.SearchResult?.SearchResultItems;

  return Array.isArray(items)
    ? items
    : [];
}

async function handleJobs(
  req,
  res,
  url
) {
  try {
    const where =
      String(
        url.searchParams.get(
          "where"
        ) || ""
      ).trim();

    const query =
      String(
        url.searchParams.get(
          "what"
        ) ||
        url.searchParams.get(
          "query"
        ) ||
        ""
      ).trim();

    const requestedRadius =
      Number(
        url.searchParams.get(
          "radius"
        ) || 25
      );

    const radius =
      Number.isFinite(
        requestedRadius
      ) &&
      requestedRadius > 0
        ? Math.min(
            requestedRadius,
            100
          )
        : 25;

    const centerLat =
      Number(
        url.searchParams.get(
          "lat"
        )
      );

    const centerLon =
      Number(
        url.searchParams.get(
          "lon"
        )
      );

    const origin =
      await geoapifySearchOrigin(
        where,
        centerLat,
        centerLon
      );

    if (!origin) {
      return sendJson(
        res,
        400,
        {
          error:
            "Could not resolve the requested search location."
        }
      );
    }

    // Search both providers simultaneously.
    const providerResults =
      await Promise.allSettled([
        fetchAdzunaJobs(
          where,
          radius,
          query
        ),

        fetchUSAJobs(
          where,
          radius,
          query
        )
      ]);

    const rawAdzuna =
      providerResults[0].status === "fulfilled"
        ? providerResults[0].value
        : [];

    const rawUSAJobs =
      providerResults[1].status === "fulfilled"
        ? providerResults[1].value
        : [];

    if (
      providerResults[0].status === "rejected"
    ) {
      console.error(
        "Adzuna request failed:",
        providerResults[0].reason?.message ||
        providerResults[0].reason
      );
    }

    if (
      providerResults[1].status === "rejected"
    ) {
      console.error(
        "USAJOBS request failed:",
        providerResults[1].reason?.message ||
        providerResults[1].reason
      );
    }

    if (
      providerResults.every(
        (result) =>
          result.status === "rejected"
      )
    ) {
      throw new Error(
        "All job providers are currently unavailable"
      );
    }

    const normalized = [
      ...rawAdzuna.map(
        normalizeAdzunaJob
      ),

      ...rawUSAJobs.map(
        (item) =>
          normalizeUSAJobsJob(
            item,
            origin
          )
      )
    ];

    // Process Geoapify lookups in small parallel batches
    // instead of doing them one-by-one.
    const enrichmentBatchSize = 8;
    const enriched = [];

    for (
      let i = 0;
      i < normalized.length;
      i += enrichmentBatchSize
    ) {
      const batch =
        normalized.slice(
          i,
          i + enrichmentBatchSize
        );

      const results =
        await Promise.all(
          batch.map(
            async (job) => {
              const updated =
                await enrichJobLocation(
                  job
                );

              if (
                !validCoordinate(
                  updated.latitude,
                  updated.longitude
                )
              ) {
                return null;
              }

              const distance =
                milesBetween(
                  origin.latitude,
                  origin.longitude,
                  updated.latitude,
                  updated.longitude
                );

              if (
                distance > radius
              ) {
                return null;
              }

              updated.distance_miles =
                Math.round(
                  distance * 10
                ) / 10;

              return updated;
            }
          )
        );

      for (
        const job of results
      ) {
        if (job) {
          enriched.push(job);
        }
      }
    }

    const deduped =
      dedupeJobs(enriched);

    deduped.sort(
      (a, b) =>
        Number(
          a.distance_miles || 0
        ) -
        Number(
          b.distance_miles || 0
        )
    );

    return sendJson(
      res,
      200,
      {
        count:
          deduped.length,

        search_location:
          origin.label,

        search_latitude:
          origin.latitude,

        search_longitude:
          origin.longitude,

        radius_miles:
          radius,

        jobs:
          deduped
      }
    );
  } catch (error) {
    console.error(
      "Jobs request failed:",
      error
    );

    return sendJson(
      res,
      500,
      {
        error:
          "Unable to load live jobs right now.",

        details:
          error.message
      }
    );
  }
}const server =
  http.createServer(
    async (req, res) => {
      try {
        const url =
          new URL(
            req.url,
            `http://${req.headers.host || "localhost"}`
          );

        if (req.method === "OPTIONS") {
          res.writeHead(
            204,
            {
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Methods":
                "GET,OPTIONS",
              "Access-Control-Allow-Headers":
                "Content-Type"
            }
          );

          return res.end();
        }

        if (
          req.method === "GET" &&
          url.pathname === "/"
        ) {
          return sendJson(
            res,
            200,
            {
              name: "JobBubble API",
              status: "online"
            }
          );
        }

        if (
          req.method === "GET" &&
          url.pathname === "/health"
        ) {
          return sendJson(
            res,
            200,
            {
              status: "ok",

              adzuna:
                ADZUNA_APP_ID &&
                ADZUNA_APP_KEY
                  ? "enabled"
                  : "disabled",

              geoapify:
                GEOAPIFY_API_KEY
                  ? "enabled"
                  : "disabled",

              usajobs:
                USAJOBS_API_KEY &&
                USAJOBS_EMAIL
                  ? "enabled"
                  : "disabled"
            }
          );
        }

        if (
          req.method === "GET" &&
          url.pathname === "/jobs"
        ) {
          return handleJobs(
            req,
            res,
            url
          );
        }

        return sendJson(
          res,
          404,
          {
            error: "Not found"
          }
        );
      } catch (error) {
        console.error(
          "Unhandled request error:",
          error
        );

        return sendJson(
          res,
          500,
          {
            error:
              "Internal server error"
          }
        );
      }
    }
  );

server.listen(
  PORT,
  () => {
    console.log(
      `JobBubble backend listening on port ${PORT}`
    );

    console.log(
      "Adzuna:",
      ADZUNA_APP_ID &&
      ADZUNA_APP_KEY
        ? "enabled"
        : "disabled"
    );

    console.log(
      "Geoapify:",
      GEOAPIFY_API_KEY
        ? "enabled"
        : "disabled"
    );

    console.log(
      "USAJOBS:",
      USAJOBS_API_KEY &&
      USAJOBS_EMAIL
        ? "enabled"
        : "disabled"
    );
  }
);
