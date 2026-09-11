"use strict";

const MUSE_API_URL = "https://www.themuse.com/api/public/jobs";

const MUSE_CATEGORIES = new Set([
  "Account Management","Accounting and Finance","Administration and Office",
  "Advertising and Marketing","Animal Care","Arts","Business Operations",
  "Cleaning and Facilities","Computer and IT","Construction","Customer Service",
  "Data and Analytics","Design and UX","Education","Energy Generation and Mining",
  "Entertainment and Travel Services","Farming and Outdoors","Food and Hospitality Services",
  "Healthcare","Human Resources and Recruitment","Installation, Maintenance, and Repairs",
  "Legal Services","Management","Manufacturing and Warehouse","Media, PR, and Communications",
  "Personal Care and Services","Product Management","Project Management","Protective Services",
  "Real Estate","Retail","Sales","Science and Engineering","Social Services",
  "Software Engineering","Sports, Fitness, and Recreation","Transportation and Logistics",
  "Writing and Editing"
]);

function plainText(value) {
  return String(value || "")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function itemSearchText(item) {
  const categories = Array.isArray(item?.categories) ? item.categories.map(x => x?.name).filter(Boolean) : [];
  const levels = Array.isArray(item?.levels) ? item.levels.map(x => x?.name).filter(Boolean) : [];
  return [
    item?.name,
    item?.company?.name,
    categories.join(" "),
    levels.join(" "),
    plainText(item?.contents)
  ].filter(Boolean).join(" ").toLowerCase();
}

function matchesQuery(item, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return true;
  const words = q.split(/\s+/).filter(Boolean);
  const text = itemSearchText(item);
  return words.every(word => text.includes(word));
}

async function fetchMusePage({ apiKey, where, category, page, signal }) {
  const url = new URL(MUSE_API_URL);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("page", String(Math.max(1, Number(page) || 1)));
  if (where) url.searchParams.append("location", String(where).trim());
  if (category) url.searchParams.set("category", category);

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

async function fetchMuseJobs({ apiKey, where, query, page = 1, signal }) {
  if (!apiKey) throw new Error("THE_MUSE_API_KEY environment variable is missing");

  const rawQuery = String(query || "").trim();
  const category = Array.from(MUSE_CATEGORIES).find(x => x.toLowerCase() === rawQuery.toLowerCase()) || "";
  const firstPage = Math.max(1, Number(page) || 1);
  const pages = [firstPage, firstPage + 1, firstPage + 2];
  const batches = await Promise.all(pages.map(p => fetchMusePage({ apiKey, where, category, page: p, signal })));
  const combined = batches.flat();

  // The Muse's `category` parameter only accepts official category names. JobBubble's
  // free-form search text is therefore filtered locally instead of being sent as an
  // invalid category, which previously caused empty result sets.
  return category || !rawQuery ? combined : combined.filter(item => matchesQuery(item, rawQuery));
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
