"use strict";

const MUSE_API_URL = "https://www.themuse.com/api/public/jobs";
const GEOAPIFY_API_KEY = process.env.GEOAPIFY_API_KEY;

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
  return [item?.name,item?.company?.name,categories.join(" "),levels.join(" "),plainText(item?.contents)]
    .filter(Boolean).join(" ").toLowerCase();
}

function matchesQuery(item, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return true;
  const words = q.split(/\s+/).filter(word => word.length > 1);
  if (!words.length) return true;
  const text = itemSearchText(item);
  // A free-form JobBubble query is not a Muse category. Requiring every word made
  // valid postings disappear (for example, titles with equivalent wording).
  // Prefer the full phrase, otherwise require a meaningful majority of its terms.
  if (text.includes(q)) return true;
  const hits = words.filter(word => text.includes(word)).length;
  return hits >= Math.max(1, Math.ceil(words.length * 0.6));
}

function coordinateWhere(value) {
  const match = String(value || "").trim().match(/^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/);
  if (!match) return null;
  const latitude = Number(match[1]);
  const longitude = Number(match[2]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  return { latitude, longitude };
}

async function resolveMuseWhere(where, signal) {
  const coordinates = coordinateWhere(where);
  if (!coordinates || !GEOAPIFY_API_KEY) return String(where || "").trim();
  try {
    const url = new URL("https://api.geoapify.com/v1/geocode/reverse");
    url.searchParams.set("lat", String(coordinates.latitude));
    url.searchParams.set("lon", String(coordinates.longitude));
    url.searchParams.set("format", "json");
    url.searchParams.set("lang", "en");
    url.searchParams.set("apiKey", GEOAPIFY_API_KEY);
    const response = await fetch(url, { headers: { "Accept": "application/json" }, signal });
    if (!response.ok) throw new Error(`Geoapify reverse HTTP ${response.status}`);
    const data = await response.json();
    const result = Array.isArray(data?.results) ? data.results[0] : null;
    if (!result) return String(where || "").trim();
    const city = result.city || result.town || result.village || result.municipality || result.county || "";
    const state = result.state_code || result.state || "";
    const resolved = [city, state].filter(Boolean).join(", ").trim();
    if (resolved) {
      console.log(`The Muse search location resolved from coordinates: ${resolved}`);
      return resolved;
    }
  } catch (error) {
    console.error("The Muse coordinate reverse-geocode failed:", error.message);
  }
  return String(where || "").trim();
}

async function fetchMusePage({ apiKey, where, category, page, signal }) {
  const url = new URL(MUSE_API_URL);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("page", String(Math.max(1, Number(page) || 1)));
  if (where) url.searchParams.append("location", String(where).trim());
  if (category) url.searchParams.set("category", category);
  const response = await fetch(url, { headers: { "Accept": "application/json" }, signal });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`The Muse HTTP ${response.status}: ${body.slice(0, 240)}`);
  }
  const data = await response.json();
  return Array.isArray(data?.results) ? data.results : [];
}

async function fetchBatch({ apiKey, where, category, firstPage, signal }) {
  // Five pages gives local searches substantially more coverage while staying bounded.
  const pages = Array.from({ length: 5 }, (_, i) => firstPage + i);
  const batches = await Promise.all(pages.map(page => fetchMusePage({ apiKey, where, category, page, signal })));
  return batches.flat();
}

function locationVariants(where) {
  const full = String(where || "").trim();
  if (!full) return [""];
  const parts = full.split(",").map(x => x.trim()).filter(Boolean);
  const variants = [full];
  // Muse location labels are not guaranteed to use the same city/state formatting
  // as Geoapify/JobBubble. Try city-only before concluding the provider has no jobs.
  if (parts[0] && parts[0].toLowerCase() !== full.toLowerCase()) variants.push(parts[0]);
  return [...new Set(variants)];
}

async function fetchMuseJobs({ apiKey, where, query, page = 1, signal }) {
  if (!apiKey) throw new Error("THE_MUSE_API_KEY environment variable is missing");
  const rawQuery = String(query || "").trim();
  const category = Array.from(MUSE_CATEGORIES).find(x => x.toLowerCase() === rawQuery.toLowerCase()) || "";
  const firstPage = Math.max(1, Number(page) || 1);
  const resolvedWhere = await resolveMuseWhere(where, signal);

  let combined = [];
  for (const candidateWhere of locationVariants(resolvedWhere)) {
    combined = await fetchBatch({ apiKey, where: candidateWhere, category, firstPage, signal });
    if (combined.length) break;
  }

  // Keep API results distinct when overlapping pages/variants contain the same posting.
  const seen = new Set();
  combined = combined.filter(item => {
    const id = String(item?.id || item?.refs?.landing_page || "");
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });

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
    latitude: null, longitude: null,
    salary_min: null, salary_max: null, salary_period: "",
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
