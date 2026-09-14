"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { fetchMuseJobs, normalizeMuseJob } = require("../providers/themuse");

test("The Muse normalizer preserves source/location and strips HTML", () => {
  const job = normalizeMuseJob({
    id: 77,
    name: "Guest Services Associate",
    company: { name: "Example Hotel" },
    locations: [{ name: "Denver, CO" }, { name: "Aurora, CO" }],
    categories: [{ name: "Customer Service" }],
    contents: "<p>Help guests &amp; solve problems.</p>",
    refs: { landing_page: "https://www.themuse.com/jobs/example/77" },
    publication_date: "2026-09-01T00:00:00Z"
  });
  assert.equal(job.id, "muse-77");
  assert.equal(job.source, "The Muse");
  assert.equal(job.location, "Denver, CO · Aurora, CO");
  assert.equal(job.category, "Customer Service");
  assert.equal(job.description, "Help guests & solve problems.");
  assert.equal(job.location_precision, "area");
  assert.equal(job.location_approximate, true);
});

test("The Muse free-text search filters and deduplicates provider pages", async () => {
  const oldFetch = global.fetch;
  const requests = [];
  global.fetch = async (input) => {
    const url = new URL(String(input));
    requests.push(url);
    return new Response(JSON.stringify({ results: [
      { id: 1, name: "Customer Support Associate", company: { name: "Acme" }, categories: [{ name: "Customer Service" }], levels: [{ name: "Entry Level" }], contents: "Deliver excellent service to customers", locations: [{ name: "Seattle, WA" }], refs: { landing_page: "https://x/1" } },
      { id: 2, name: "Software Engineer", company: { name: "Acme" }, categories: [{ name: "Software Engineering" }], contents: "Build APIs", locations: [{ name: "Seattle, WA" }], refs: { landing_page: "https://x/2" } }
    ] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const jobs = await fetchMuseJobs({ apiKey: "test-key", where: "Seattle, WA", query: "customer service" });
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].id, 1);
    assert.equal(requests.length, 5);
    for (const url of requests) {
      assert.equal(url.searchParams.get("api_key"), "test-key");
      assert.equal(url.searchParams.get("location"), "Seattle, WA");
      assert.equal(url.searchParams.has("category"), false);
    }
  } finally {
    global.fetch = oldFetch;
  }
});

test("The Muse exact JobBubble category uses provider category parameter", async () => {
  const oldFetch = global.fetch;
  const categories = [];
  global.fetch = async (input) => {
    const url = new URL(String(input));
    categories.push(url.searchParams.get("category"));
    return new Response(JSON.stringify({ results: [{
      id: 3, name: "Store Associate", company: { name: "Shop" }, categories: [{ name: "Retail" }], contents: "Help shoppers", locations: [{ name: "Austin, TX" }], refs: { landing_page: "https://x/3" }
    }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const jobs = await fetchMuseJobs({ apiKey: "test-key", where: "Austin, TX", query: "Retail" });
    assert.equal(jobs.length, 1);
    assert.deepEqual(categories, ["Retail", "Retail", "Retail", "Retail", "Retail"]);
  } finally {
    global.fetch = oldFetch;
  }
});
