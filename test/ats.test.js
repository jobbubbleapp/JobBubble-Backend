"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  getAtsBoards,
  fetchAtsJobs,
  normalizeGreenhouseJob,
  normalizeLeverJob,
  normalizeAshbyJob
} = require("../providers/ats");

test("default ATS board set stays unique and includes hourly feeds", () => {
  const oldJson = process.env.ATS_BOARDS_JSON;
  const oldDefaults = process.env.ATS_USE_DEFAULT_BOARDS;
  delete process.env.ATS_BOARDS_JSON;
  delete process.env.ATS_USE_DEFAULT_BOARDS;
  try {
    const boards = getAtsBoards();
    assert.equal(boards.length, 13);
    const keys = boards.map((b) => `${b.provider}:${b.board.toLowerCase()}`);
    assert.equal(new Set(keys).size, boards.length);
    for (const expected of ["lever:gopuff", "lever:bluebottlecoffee", "lever:thuma"]) {
      assert.ok(keys.includes(expected), `missing ${expected}`);
    }
  } finally {
    if (oldJson === undefined) delete process.env.ATS_BOARDS_JSON; else process.env.ATS_BOARDS_JSON = oldJson;
    if (oldDefaults === undefined) delete process.env.ATS_USE_DEFAULT_BOARDS; else process.env.ATS_USE_DEFAULT_BOARDS = oldDefaults;
  }
});

test("ATS normalizers preserve identity, pay, location and clean text", () => {
  const lever = normalizeLeverJob({
    id: "lev-1",
    text: "Barista",
    description: "<p>Serve &amp; delight</p>",
    categories: { location: "Seattle, WA", team: "Retail", commitment: "Part-time" },
    salaryRange: { min: 20, max: 24, interval: "per-hour-salary" },
    hostedUrl: "https://jobs.example/lev-1"
  }, { board: "coffee", company: "Coffee Co" });
  assert.equal(lever.id, "lever:coffee:lev-1");
  assert.equal(lever.salary_min, 20);
  assert.equal(lever.salary_period, "hour");
  assert.equal(lever.location, "Seattle, WA");
  assert.match(lever.description, /Serve & delight/);
  assert.equal(lever.location_approximate, true);

  const greenhouse = normalizeGreenhouseJob({
    id: 42,
    title: "Crew Member",
    location: { name: "Austin, TX" },
    departments: [{ name: "Food & Hospitality" }],
    content: "<p>Make food</p>",
    absolute_url: "https://jobs.example/42"
  }, { board: "food", company: "Food Co" });
  assert.equal(greenhouse.id, "greenhouse:food:42");
  assert.equal(greenhouse.category, "Food & Hospitality");
  assert.equal(greenhouse.description, "Make food");

  const ashby = normalizeAshbyJob({
    title: "Store Associate",
    location: "Portland, OR",
    jobUrl: "https://jobs.ashbyhq.com/shop/abc123",
    applyUrl: "https://jobs.ashbyhq.com/shop/abc123/application",
    compensation: { summaryComponents: [{ compensationType: "Salary", currencyCode: "USD", minValue: 50000, maxValue: 60000, interval: "1 YEAR" }] }
  }, { board: "shop", company: "Shop Co" });
  assert.equal(ashby.id, "ashby:shop:abc123");
  assert.equal(ashby.salary_min, 50000);
  assert.equal(ashby.salary_period, "year");
});

test("ATS category filters expand Android category terms without using description boilerplate", async () => {
  const oldJson = process.env.ATS_BOARDS_JSON;
  const oldDefaults = process.env.ATS_USE_DEFAULT_BOARDS;
  const oldFetch = global.fetch;
  process.env.ATS_USE_DEFAULT_BOARDS = "false";
  process.env.ATS_BOARDS_JSON = JSON.stringify([{ provider: "lever", board: "step9-filter-board", company: "Step9 Co" }]);
  let calls = 0;
  global.fetch = async (input) => {
    calls += 1;
    const url = new URL(String(input));
    assert.equal(url.searchParams.get("limit"), "1000");
    return new Response(JSON.stringify([
      { id: "1", text: "Barista", descriptionPlain: "Corporate retail boilerplate", categories: { location: "Seattle, WA", team: "Cafe" }, hostedUrl: "https://x/1" },
      { id: "2", text: "Warehouse Operations Associate", descriptionPlain: "Food retail company", categories: { location: "Seattle, WA", team: "Operations" }, hostedUrl: "https://x/2" },
      { id: "3", text: "Software Engineer", descriptionPlain: "We support retail stores and restaurants", categories: { location: "Seattle, WA", team: "Engineering" }, hostedUrl: "https://x/3" }
    ]), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const restaurant = await fetchAtsJobs({ query: "restaurant" });
    const warehouse = await fetchAtsJobs({ query: "warehouse" });
    const retail = await fetchAtsJobs({ query: "retail" });
    assert.deepEqual(restaurant.map((j) => j.title), ["Barista"]);
    assert.deepEqual(warehouse.map((j) => j.title), ["Warehouse Operations Associate"]);
    assert.deepEqual(retail.map((j) => j.title), []);
    // Subsequent filters use the cached board; the provider is fetched only once.
    assert.equal(calls, 1);
  } finally {
    global.fetch = oldFetch;
    if (oldJson === undefined) delete process.env.ATS_BOARDS_JSON; else process.env.ATS_BOARDS_JSON = oldJson;
    if (oldDefaults === undefined) delete process.env.ATS_USE_DEFAULT_BOARDS; else process.env.ATS_USE_DEFAULT_BOARDS = oldDefaults;
  }
});
