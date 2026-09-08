const http = require("http");

const PORT = process.env.PORT || 3000;
const ADZUNA_APP_ID = process.env.ADZUNA_APP_ID;
const ADZUNA_APP_KEY = process.env.ADZUNA_APP_KEY;
const GEOAPIFY_API_KEY = process.env.GEOAPIFY_API_KEY;

function send(res, code, data) {
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(JSON.stringify(data));
}

function hasStreet(s = "") {
  return /\d/.test(s) &&
    /\b(st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|way|ct|court|pl|place|pkwy|parkway|hwy|highway)\b/i.test(s);
}

async function geoMatch(job) {
  if (!GEOAPIFY_API_KEY || !job.company || hasStreet(job.location)) {
    return null;
  }

  try {
    const u = new URL("https://api.geoapify.com/v1/geocode/search");

    u.searchParams.set("text", `${job.company}, ${job.location}`);
    u.searchParams.set("format", "json");
    u.searchParams.set("limit", "3");
    u.searchParams.set("filter", "countrycode:us");
    u.searchParams.set("apiKey", GEOAPIFY_API_KEY);

    if (Number.isFinite(job.latitude) && Number.isFinite(job.longitude)) {
      u.searchParams.set(
        "bias",
        `proximity:${job.longitude},${job.latitude}`
      );
    }

    const r = await fetch(u);

    if (!r.ok) return null;

    const data = await r.json();
    const best = data.results && data.results[0];

    if (!best) return null;

    return {
      latitude: Number(best.lat),
      longitude: Number(best.lon),
      address: best.formatted || job.location
    };
  } catch (e) {
    console.log("Geoapify failed:", e.message);
    return null;
  }
}

async function getJobs(params) {
  if (!ADZUNA_APP_ID || !ADZUNA_APP_KEY) {
    throw new Error("Missing Adzuna credentials");
  }

  const page = Math.max(1, Number(params.get("page")) || 1);

  const u = new URL(
    `https://api.adzuna.com/v1/api/jobs/us/search/${page}`
  );

  u.searchParams.set("app_id", ADZUNA_APP_ID);
  u.searchParams.set("app_key", ADZUNA_APP_KEY);
  u.searchParams.set("results_per_page", "30");
  u.searchParams.set("content-type", "application/json");

  if (params.get("what")) {
    u.searchParams.set("what", params.get("what"));
  }

  if (params.get("where")) {
    u.searchParams.set("where", params.get("where"));
  }

  if (params.get("radius")) {
    u.searchParams.set("distance", params.get("radius"));
  }

  const r = await fetch(u);

  if (!r.ok) {
    throw new Error(`Adzuna HTTP ${r.status}`);
  }

  const data = await r.json();
  const out = [];

  for (const j of data.results || []) {
    const location = j.location?.display_name || "";

    let job = {
      id: String(j.id || ""),
      source: "Adzuna",
      title: j.title || "Job",
      company: j.company?.display_name || "Unknown company",
      latitude: typeof j.latitude === "number" ? j.latitude : null,
      longitude: typeof j.longitude === "number" ? j.longitude : null,
      salary_min: typeof j.salary_min === "number" ? j.salary_min : null,
      salary_max: typeof j.salary_max === "number" ? j.salary_max : null,
      salary_period: "year",
      category: j.category?.label || "",
      location,
      description: j.description || "",
      apply_url: j.redirect_url || "",
      posted_at: j.created || null,
      location_precision: hasStreet(location) ? "exact" : "area",
      location_approximate: !hasStreet(location)
    };

    if (!hasStreet(location)) {
      const match = await geoMatch(job);

      if (match) {
        job = {
          ...job,
          latitude: match.latitude,
          longitude: match.longitude,
          location: match.address,
          location_precision: "likely",
          location_approximate: true,
          location_match_provider: "Geoapify"
        };
      }
    }

    out.push(job);
  }

  return out;
}

http.createServer(async (req, res) => {
  try {
    const u = new URL(
      req.url,
      `http://${req.headers.host || "localhost"}`
    );

    if (u.pathname === "/health") {
      return send(res, 200, {
        status: "ok",
        geoapify: GEOAPIFY_API_KEY ? "enabled" : "disabled"
      });
    }

    if (u.pathname === "/jobs") {
      const jobs = await getJobs(u.searchParams);
      return send(res, 200, {
        count: jobs.length,
        jobs
      });
    }

    return send(res, 200, {
      name: "JobBubble API",
      status: "online"
    });
  } catch (e) {
    console.error(e);
    return send(res, 500, {
      error: e.message
    });
  }
}).listen(PORT, "0.0.0.0", () => {
  console.log(`JobBubble API running on port ${PORT}`);
});
