const http = require("http");

const PORT = process.env.PORT || 3000;
const ADZUNA_APP_ID = process.env.ADZUNA_APP_ID;
const ADZUNA_APP_KEY = process.env.ADZUNA_APP_KEY;

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(JSON.stringify(data));
}

async function searchAdzuna(params) {
  if (!ADZUNA_APP_ID || !ADZUNA_APP_KEY) {
    throw new Error("Adzuna credentials are not configured");
  }

  const page = Math.max(1, Number(params.get("page")) || 1);
  const what = params.get("what") || "";
  const where = params.get("where") || "";
  const distance = Math.min(100, Math.max(1, Number(params.get("radius")) || 25));

  const url = new URL(
    `https://api.adzuna.com/v1/api/jobs/us/search/${page}`
  );

  url.searchParams.set("app_id", ADZUNA_APP_ID);
  url.searchParams.set("app_key", ADZUNA_APP_KEY);
  url.searchParams.set("results_per_page", "50");
  url.searchParams.set("content-type", "application/json");
  url.searchParams.set("distance", String(distance));

  if (what) url.searchParams.set("what", what);
  if (where) url.searchParams.set("where", where);

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Adzuna returned HTTP ${response.status}`);
  }

  const data = await response.json();

  return (data.results || []).map(job => ({
    id: String(job.id || ""),
    source: "Adzuna",
    title: job.title || "Job",
    company: job.company?.display_name || "Unknown company",

    latitude:
      typeof job.latitude === "number" ? job.latitude : null,

    longitude:
      typeof job.longitude === "number" ? job.longitude : null,

    salary_min:
      typeof job.salary_min === "number" ? job.salary_min : null,

    salary_max:
      typeof job.salary_max === "number" ? job.salary_max : null,

    salary_period: "year",

    category:
      job.category?.label || job.category?.tag || "",

    location:
      job.location?.display_name || "",

    description:
      job.description || "",

    apply_url:
      job.redirect_url || "",

    posted_at:
      job.created || null
  }));
}

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(
      req.url,
      `http://${req.headers.host || "localhost"}`
    );

    if (requestUrl.pathname === "/") {
      return sendJson(res, 200, {
        name: "JobBubble API",
        status: "online"
      });
    }

    if (requestUrl.pathname === "/health") {
      return sendJson(res, 200, {
        status: "ok",
        provider: "Adzuna"
      });
    }

    if (requestUrl.pathname === "/jobs") {
      const jobs = await searchAdzuna(requestUrl.searchParams);

      return sendJson(res, 200, {
        count: jobs.length,
        jobs
      });
    }

    sendJson(res, 404, {
      error: "Not found"
    });

  } catch (error) {
    console.error(error);

    sendJson(res, 500, {
      error: "Unable to retrieve jobs"
    });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`JobBubble API running on port ${PORT}`);
});
