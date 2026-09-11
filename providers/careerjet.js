"use strict";

const CAREERJET_ENDPOINT = "https://search.api.careerjet.net/v4/query";

function required(name, value) {
  if (!value) throw new Error(`${name} environment variable is missing`);
  return value;
}

function firstForwardedIp(headers = {}) {
  const forwarded = String(headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || String(headers["x-real-ip"] || "").trim() || "127.0.0.1";
}

async function fetchCareerjetJobs({
  apiKey,
  where,
  radius,
  query,
  requestHeaders,
  pageSize = 50,
  signal
}) {
  required("CAREERJET_API_KEY", apiKey);

  const userIp = firstForwardedIp(requestHeaders);
  const userAgent = String(requestHeaders?.["user-agent"] || "JobBubble Android").slice(0, 500);
  const safeRadius = Math.max(1, Math.min(Number(radius) || 25, 100));
  const safePageSize = Math.max(1, Math.min(Number(pageSize) || 50, 100));

  const url = new URL(CAREERJET_ENDPOINT);
  url.searchParams.set("locale_code", "en_US");
  if (String(query || "").trim()) url.searchParams.set("keywords", String(query).trim());
  if (String(where || "").trim()) url.searchParams.set("location", String(where).trim());
  url.searchParams.set("radius", String(safeRadius));
  url.searchParams.set("page_size", String(safePageSize));
  url.searchParams.set("sort", "date");
  url.searchParams.set("user_ip", userIp);
  url.searchParams.set("user_agent", userAgent);

  const auth = Buffer.from(`${apiKey}:`, "utf8").toString("base64");
  const response = await fetch(url, {
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: "application/json",
      Referer: "https://jobbubble-backend-1.onrender.com/"
    },
    signal
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Careerjet HTTP ${response.status}: ${body.slice(0, 240)}`);
  }

  const data = await response.json();
  if (data?.type === "LOCATIONS") return [];
  if (data?.type !== "JOBS") {
    throw new Error(`Careerjet API error: ${String(data?.message || "Unexpected response").slice(0, 240)}`);
  }
  return Array.isArray(data.jobs) ? data.jobs : [];
}

function normalizeCareerjetJob(item) {
  const salaryTypeMap = { Y: "year", M: "month", W: "week", D: "day", H: "hour" };
  return {
    id: `careerjet:${String(item?.url || item?.title || "")}`,
    source: "Careerjet",
    title: item?.title || "Untitled job",
    company: item?.company || "Unknown company",
    latitude: null,
    longitude: null,
    salary_min: Number.isFinite(Number(item?.salary_min)) ? Number(item.salary_min) : null,
    salary_max: Number.isFinite(Number(item?.salary_max)) ? Number(item.salary_max) : null,
    salary_period: salaryTypeMap[String(item?.salary_type || "").toUpperCase()] || "",
    category: "",
    location: item?.locations || "",
    description: item?.description || "",
    apply_url: item?.url || "",
    posted_at: item?.date || "",
    location_precision: "area",
    location_approximate: true,
    location_match_provider: "Careerjet"
  };
}

module.exports = { fetchCareerjetJobs, normalizeCareerjetJob };
