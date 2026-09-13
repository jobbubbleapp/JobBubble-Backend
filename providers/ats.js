"use strict";

const DEFAULT_CACHE_TTL_MS = 15 * 60 * 1000;
const STALE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

// Curated public job boards that currently contain useful hourly, restaurant,
// retail, warehouse, or customer-facing work. More boards can be added without
// code changes through ATS_BOARDS_JSON.
const DEFAULT_BOARDS = [
  { provider: "lever", board: "fixinssoulkitchen", company: "Fixins Soul Kitchen" },
  { provider: "lever", board: "insomniacookies", company: "Insomnia Cookies" },
  { provider: "lever", board: "cscgeneration-2", company: "CSC Generation / Sur La Table" },
  { provider: "greenhouse", board: "jjus", company: "Joe & The Juice" },
  { provider: "greenhouse", board: "philzcoffeecareers", company: "Philz Coffee" },
  { provider: "greenhouse", board: "saxbys", company: "Saxbys" },
  { provider: "ashby", board: "rothys", company: "Rothy's" },
  { provider: "ashby", board: "tonal", company: "Tonal" },
  { provider: "ashby", board: "Away", company: "Away" },
  { provider: "ashby", board: "renuity", company: "Renuity" }
];

const boardCache = new Map();

function cleanText(value) {
  return String(value == null ? "" : value)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

function normalizeProvider(value) {
  const provider = String(value || "").trim().toLowerCase();
  if (provider === "greenhouse" || provider === "lever" || provider === "ashby") return provider;
  return "";
}

function parseConfiguredBoards() {
  const raw = String(process.env.ATS_BOARDS_JSON || "").trim();
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("ATS_BOARDS_JSON must be an array");
    return parsed
      .map((item) => ({
        provider: normalizeProvider(item?.provider),
        board: String(item?.board || "").trim(),
        company: String(item?.company || "").trim()
      }))
      .filter((item) => item.provider && item.board && item.company);
  } catch (error) {
    console.error("ATS_BOARDS_JSON could not be parsed:", error.message);
    return [];
  }
}

function getAtsBoards() {
  const useDefaults = String(process.env.ATS_USE_DEFAULT_BOARDS || "true").toLowerCase() !== "false";
  const combined = [
    ...(useDefaults ? DEFAULT_BOARDS : []),
    ...parseConfiguredBoards()
  ];

  const unique = new Map();
  for (const item of combined) {
    unique.set(`${item.provider}:${item.board.toLowerCase()}`, item);
  }
  return Array.from(unique.values());
}

function intervalToPeriod(interval) {
  const value = String(interval || "").toLowerCase();
  if (value.includes("hour")) return "hour";
  if (value.includes("day")) return "day";
  if (value.includes("week")) return "week";
  if (value.includes("month")) return "month";
  if (value.includes("year") || value.includes("annual")) return "year";
  return "";
}

function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function ashbySalary(job) {
  const components = Array.isArray(job?.compensation?.summaryComponents)
    ? job.compensation.summaryComponents : [];
  const salary = components.find((item) =>
    String(item?.compensationType || "").toLowerCase() === "salary" &&
    (!item?.currencyCode || String(item.currencyCode).toUpperCase() === "USD")
  );
  if (!salary) return { min: null, max: null, period: "" };
  return {
    min: safeNumber(salary.minValue),
    max: safeNumber(salary.maxValue),
    period: intervalToPeriod(salary.interval)
  };
}

function ashbyJobId(job) {
  for (const raw of [job?.jobUrl, job?.applyUrl]) {
    try {
      const url = new URL(raw);
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length) return parts[parts.length - 1];
    } catch (_) {}
  }
  return `${cleanText(job?.title)}|${cleanText(job?.location)}|${cleanText(job?.publishedAt)}`;
}

function normalizeGreenhouseJob(item, board) {
  const departments = Array.isArray(item?.departments)
    ? item.departments.map((x) => cleanText(x?.name)).filter(Boolean) : [];
  return {
    id: `greenhouse:${board.board}:${String(item?.id || "")}`,
    source: "ATS/Greenhouse",
    title: cleanText(item?.title) || "Untitled job",
    company: board.company,
    latitude: null,
    longitude: null,
    salary_min: null,
    salary_max: null,
    salary_period: "",
    category: departments[0] || "",
    location: cleanText(item?.location?.name),
    description: cleanText(item?.content),
    apply_url: String(item?.absolute_url || ""),
    posted_at: String(item?.updated_at || ""),
    employment_type: "",
    workplace_type: "",
    location_precision: "area",
    location_approximate: true,
    location_match_provider: "Greenhouse employer feed",
    ats_provider: "greenhouse",
    ats_board: board.board
  };
}

function normalizeLeverJob(item, board) {
  const salary = item?.salaryRange || {};
  const lists = Array.isArray(item?.lists)
    ? item.lists.map((list) => `${cleanText(list?.text)}\n${cleanText(list?.content)}`).filter(Boolean)
    : [];
  const description = [
    cleanText(item?.descriptionPlain || item?.description),
    ...lists,
    cleanText(item?.additionalPlain || item?.additional)
  ].filter(Boolean).join("\n\n");

  return {
    id: `lever:${board.board}:${String(item?.id || "")}`,
    source: "ATS/Lever",
    title: cleanText(item?.text) || "Untitled job",
    company: board.company,
    latitude: null,
    longitude: null,
    salary_min: safeNumber(salary.min),
    salary_max: safeNumber(salary.max),
    salary_period: intervalToPeriod(salary.interval),
    category: cleanText(item?.categories?.team || item?.categories?.department),
    location: cleanText(item?.categories?.location || item?.categories?.allLocations?.[0]),
    description,
    apply_url: String(item?.applyUrl || item?.hostedUrl || ""),
    posted_at: "",
    employment_type: cleanText(item?.categories?.commitment),
    workplace_type: cleanText(item?.workplaceType),
    location_precision: "area",
    location_approximate: true,
    location_match_provider: "Lever employer feed",
    ats_provider: "lever",
    ats_board: board.board
  };
}

function normalizeAshbyJob(item, board) {
  const salary = ashbySalary(item);
  const postal = item?.address?.postalAddress || {};
  const structuredLocation = [postal.addressLocality, postal.addressRegion]
    .map(cleanText).filter(Boolean).join(", ");

  return {
    id: `ashby:${board.board}:${ashbyJobId(item)}`,
    source: "ATS/Ashby",
    title: cleanText(item?.title) || "Untitled job",
    company: board.company,
    latitude: null,
    longitude: null,
    salary_min: salary.min,
    salary_max: salary.max,
    salary_period: salary.period,
    category: cleanText(item?.team || item?.department),
    location: cleanText(item?.location) || structuredLocation,
    description: cleanText(item?.descriptionPlain || item?.descriptionHtml),
    apply_url: String(item?.applyUrl || item?.jobUrl || ""),
    posted_at: String(item?.publishedAt || ""),
    employment_type: cleanText(item?.employmentType),
    workplace_type: cleanText(item?.workplaceType),
    location_precision: "area",
    location_approximate: true,
    location_match_provider: "Ashby employer feed",
    ats_provider: "ashby",
    ats_board: board.board
  };
}

async function fetchJson(url, signal) {
  const response = await fetch(url, {
    headers: { "Accept": "application/json", "User-Agent": "JobBubble/1.0" },
    signal
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`HTTP ${response.status}: ${body.slice(0, 220)}`);
  }
  return response.json();
}

async function fetchGreenhouseBoard(board, signal) {
  const url = new URL(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board.board)}/jobs`);
  url.searchParams.set("content", "true");
  const data = await fetchJson(url, signal);
  return (Array.isArray(data?.jobs) ? data.jobs : [])
    .map((item) => normalizeGreenhouseJob(item, board));
}

async function fetchLeverBoard(board, signal) {
  const jobs = [];
  const pageSize = 100;
  let skip = 0;

  // Cap each board so a misconfigured feed cannot monopolize a JobBubble search.
  while (skip < 1000) {
    const url = new URL(`https://api.lever.co/v0/postings/${encodeURIComponent(board.board)}`);
    url.searchParams.set("mode", "json");
    url.searchParams.set("skip", String(skip));
    url.searchParams.set("limit", String(pageSize));
    const page = await fetchJson(url, signal);
    if (!Array.isArray(page) || !page.length) break;
    jobs.push(...page.map((item) => normalizeLeverJob(item, board)));
    if (page.length < pageSize) break;
    skip += page.length;
  }

  return jobs;
}

async function fetchAshbyBoard(board, signal) {
  const url = new URL(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board.board)}`);
  url.searchParams.set("includeCompensation", "true");
  const data = await fetchJson(url, signal);
  return (Array.isArray(data?.jobs) ? data.jobs : [])
    .filter((item) => item?.isListed !== false)
    .map((item) => normalizeAshbyJob(item, board));
}

async function fetchBoard(board, signal) {
  if (board.provider === "greenhouse") return fetchGreenhouseBoard(board, signal);
  if (board.provider === "lever") return fetchLeverBoard(board, signal);
  if (board.provider === "ashby") return fetchAshbyBoard(board, signal);
  return [];
}

function cacheTtlMs() {
  const configured = Number(process.env.ATS_CACHE_TTL_MS);
  return Number.isFinite(configured) && configured >= 60000
    ? configured : DEFAULT_CACHE_TTL_MS;
}

async function fetchBoardCached(board, signal) {
  const key = `${board.provider}:${board.board.toLowerCase()}`;
  const cached = boardCache.get(key);
  const now = Date.now();
  if (cached && now - cached.time <= cacheTtlMs()) return cached.jobs;

  try {
    const jobs = await fetchBoard(board, signal);
    boardCache.set(key, { time: now, jobs });
    return jobs;
  } catch (error) {
    if (cached && now - cached.time <= STALE_CACHE_TTL_MS) {
      console.error(`ATS ${key} refresh failed; serving stale cache:`, error.message);
      return cached.jobs;
    }
    throw error;
  }
}

function tokenMatch(haystack, query) {
  const tokens = String(query || "").toLowerCase().split(/\s+/).filter((x) => x.length >= 2);
  if (!tokens.length) return true;
  const text = String(haystack || "").toLowerCase();
  return tokens.every((token) => text.includes(token));
}

function filterAtsJobs(jobs, { query = "" } = {}) {
  if (!query) return jobs;
  return jobs.filter((job) => tokenMatch([
    job.title, job.company, job.category, job.description
  ].join(" "), query));
}

async function fetchAtsJobs({ query = "", signal } = {}) {
  const boards = getAtsBoards();
  const settled = await Promise.allSettled(
    boards.map((board) => fetchBoardCached(board, signal))
  );

  const jobs = [];
  settled.forEach((result, index) => {
    if (result.status === "fulfilled") {
      jobs.push(...result.value);
    } else {
      const board = boards[index];
      console.error(`ATS ${board.provider}:${board.board} failed:`, result.reason?.message || result.reason);
    }
  });

  if (!jobs.length && settled.length && settled.every((x) => x.status === "rejected")) {
    throw new Error("All configured ATS feeds are currently unavailable");
  }

  return filterAtsJobs(jobs, { query });
}

module.exports = {
  DEFAULT_BOARDS,
  getAtsBoards,
  fetchAtsJobs,
  normalizeGreenhouseJob,
  normalizeLeverJob,
  normalizeAshbyJob
};
