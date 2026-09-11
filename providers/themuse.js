"use strict";

const MUSE_API_URL = "https://www.themuse.com/api/public/jobs";

async function fetchMuseJobs({ apiKey, where, query, page = 1, signal }) {
  if (!apiKey) throw new Error("THE_MUSE_API_KEY environment variable is missing");

  const url = new URL(MUSE_API_URL);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("page", String(Math.max(1, Number(page) || 1)));
  if (where) url.searchParams.append("location", String(where).trim());
  if (query) url.searchParams.set("category", String(query).trim());

  const response = await fetch(url, {
    headers: { "Accept": "application/json" },
    signal
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`The Muse HTTP ${response.status}: ${body.slice(0, 240)}`);
  }

  const data = await response.json();
  return Array.isArray(data?.results) ? data.results : [];
}

function plainText(value) {
  return String(value || "")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeMuseJob(item) {
  const locations = Array.isArray(item?.locations) ? item.locations : [];
  const location = locations.map((x) => x?.name).filter(Boolean).join(" · ");
  const categories = Array.isArray(item?.categories) ? item.categories : [];
  const levels = Array.isArray(item?.levels) ? item.levels : [];

  return {
    id: `muse-${String(item?.id || item?.refs?.landing_page || "")}`,
    source: "The Muse",
    title: item?.name || "Untitled job",
    company: item?.company?.name || "Unknown company",
    latitude: null,
    longitude: null,
    salary_min: null,
    salary_max: null,
    salary_period: "",
    category: categories[0]?.name || levels[0]?.name || "",
    location,
    description: plainText(item?.contents),
    apply_url: item?.refs?.landing_page || "",
    posted_at: item?.publication_date || "",
    location_precision: "area",
    location_approximate: true,
    location_match_provider: "The Muse"
  };
}

module.exports = { fetchMuseJobs, normalizeMuseJob };
