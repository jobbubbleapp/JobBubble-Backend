const fs = require("fs");
const path = require("path");

// GeoCache V2 can legitimately spend several seconds resolving text-only ATS/Muse
// locations on a cold cache. That work must not block the first /jobs response,
// otherwise the Android client can time out and show no jobs even though providers
// returned valid postings. This wrapper lets the existing GeoCache V2 bootstrap keep
// doing the full refinement in the background while the first response is released
// quickly with any immediately usable coordinates.

const serverPath = path.join(__dirname, "server.js");
const originalReadFileSync = fs.readFileSync.bind(fs);

function replaceOnce(source, needle, replacement, label) {
  const first = source.indexOf(needle);
  if (first < 0) throw new Error(`Fast-response patch target missing: ${label}`);
  if (source.indexOf(needle, first + needle.length) >= 0) {
    throw new Error(`Fast-response patch target ambiguous: ${label}`);
  }
  return source.slice(0, first) + replacement + source.slice(first + needle.length);
}

function patchFastFirstResponse(source) {
  source = replaceOnce(
    source,
    `  if (normalized.some((job) =>\n    (job?.source === "The Muse" || String(job?.source || "").startsWith("ATS/")) &&\n    !validCoordinate(job.latitude, job.longitude)\n  )) {\n    await resolveMuseAreaLocations(normalized, origin);\n  }`,
    `  let areaResolutionPromise = Promise.resolve();\n  if (normalized.some((job) =>\n    (job?.source === "The Muse" || String(job?.source || "").startsWith("ATS/")) &&\n    !validCoordinate(job.latitude, job.longitude)\n  )) {\n    areaResolutionPromise = resolveMuseAreaLocations(normalized, origin)\n      .catch((error) => console.error("Background text-location refinement failed:", error.message));\n    // Exact-city anchors are assigned synchronously inside resolveMuseAreaLocations.\n    // Give nearby text locations a brief chance to resolve, then return usable jobs\n    // instead of making the app wait for every cold-cache geocode.\n    await Promise.race([\n      areaResolutionPromise,\n      new Promise((resolve) => setTimeout(resolve, 900))\n    ]);\n  }`,
    "blocking Muse/ATS area geocoding"
  );

  source = replaceOnce(
    source,
    `  const enrichmentPromise = runWithConcurrency(\n    toEnrich,\n    ENRICH_CONCURRENCY,\n    async (job) => { await enrichJobLocation(job); }\n  ).then(() => {`,
    `  const directEnrichmentPromise = runWithConcurrency(\n    toEnrich,\n    ENRICH_CONCURRENCY,\n    async (job) => { await enrichJobLocation(job); }\n  );\n  const enrichmentPromise = Promise.allSettled([\n    directEnrichmentPromise,\n    areaResolutionPromise\n  ]).then(() => {`,
    "background refinement join"
  );

  return source;
}

fs.readFileSync = function patchedReadFileSync(file, options) {
  const resolved = path.resolve(String(file));
  const value = originalReadFileSync(file, options);
  if (resolved !== path.resolve(serverPath)) return value;
  const encoding = typeof options === "string" ? options : options?.encoding;
  const text = Buffer.isBuffer(value) ? value.toString(encoding || "utf8") : String(value);
  const patched = patchFastFirstResponse(text);
  return encoding ? patched : Buffer.from(patched, "utf8");
};

try {
  require("./bootstrap.js");
} finally {
  fs.readFileSync = originalReadFileSync;
}
