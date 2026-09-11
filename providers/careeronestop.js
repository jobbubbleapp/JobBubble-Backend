"use strict";

const CAREERONESTOP_BASE_URL = "https://api.careeronestop.org";

function requiredEnv(name, value) {
  if (!value) throw new Error(`${name} environment variable is missing`);
  return value;
}

function cleanPathSegment(value, fallback = "0") {
  const text = String(value == null ? "" : value).trim();
  return encodeURIComponent(text || fallback);
}

async function fetchCareerOneStopJobs({
  userId,
  apiToken,
  where,
  radius,
  query,
  pageSize = 50,
  days = 60,
  signal
}) {
  requiredEnv("CAREERONESTOP_USER_ID", userId);
  requiredEnv("CAREERONESTOP_API_TOKEN", apiToken);

  const safeRadius = Math.max(1, Math.min(Number(radius) || 25, 100));
  const safePageSize = Math.max(1, Math.min(Number(pageSize) || 50, 100));
  const safeDays = Math.max(0, Number(days) || 0);

  // Jobs V2 requires every path parameter. CareerOneStop documents `0` as the
  // relevance/default value for keyword and sort fields, so use it when JobBubble
  // has no keyword instead of emitting an empty path segment.
  const path = [
    "v2",
    "jobsearch",
    cleanPathSegment(userId),
    cleanPathSegment(query, "0"),
    cleanPathSegment(where, "US"),
    String(safeRadius),
    "0",
    "0",
    "0",
    String(safePageSize),
    String(safeDays)
  ].join("/");

  const url = new URL(`${CAREERONESTOP_BASE_URL}/${path}`);
  url.searchParams.set("showFilters", "false");
  url.searchParams.set("enableJobDescriptionSnippet", "true");
  url.searchParams.set("enableMetaData", "false");

  const response = await fetch(url, {
    headers: {
      "Authorization": `Bearer ${apiToken}`,
      "Accept": "application/json"
    },
    signal
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`CareerOneStop HTTP ${response.status}: ${body.slice(0, 240)}`);
  }

  const data = await response.json();
  if (data?.ErrorMessage) {
    throw new Error(`CareerOneStop API error: ${String(data.ErrorMessage).slice(0, 240)}`);
  }

  return Array.isArray(data?.Jobs) ? data.Jobs : [];
}

function normalizeCareerOneStopJob(item) {
  const location = String(item?.Location || "").trim();
  return {
    id: String(item?.JvId || ""),
    source: "CareerOneStop/NLx",
    title: item?.JobTitle || "Untitled job",
    company: item?.Company || "Unknown company",
    latitude: null,
    longitude: null,
    salary_min: null,
    salary_max: null,
    salary_period: "",
    category: Array.isArray(item?.OnetCodes) && item.OnetCodes.length
      ? String(item.OnetCodes[0])
      : "",
    location,
    description: item?.DescriptionSnippet || "",
    apply_url: item?.URL || "",
    posted_at: item?.AcquisitionDate || "",
    location_precision: "area",
    location_approximate: true,
    location_match_provider: "CareerOneStop/NLx"
  };
}

module.exports = {
  fetchCareerOneStopJobs,
  normalizeCareerOneStopJob
};
