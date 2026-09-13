from pathlib import Path


def replace_once(text, old, new, label):
    if old not in text:
        raise SystemExit(f"Patch target missing ({label}):\n{old[:300]}")
    return text.replace(old, new, 1)

# ---- providers/ats.js ----
p = Path("providers/ats.js")
s = p.read_text()

s = replace_once(
    s,
    '''function safeNumber(value) {\n  const number = Number(value);\n  return Number.isFinite(number) ? number : null;\n}''',
    '''function safeNumber(value) {\n  if (value == null || String(value).trim() === "") return null;\n  const number = Number(value);\n  return Number.isFinite(number) ? number : null;\n}''',
    "safeNumber null handling"
)

s = replace_once(
    s,
    '''function filterAtsJobs(jobs, { query = "" } = {}) {\n  if (!query) return jobs;\n  return jobs.filter((job) => tokenMatch([\n    job.title, job.company, job.category, job.description\n  ].join(" "), query));\n}\n\nasync function fetchAtsJobs({ query = "", signal } = {}) {''',
    '''function filterAtsJobs(jobs, { query = "", provider = "" } = {}) {\n  const providerKey = normalizeProvider(provider);\n  let filtered = providerKey\n    ? jobs.filter((job) => String(job?.ats_provider || "").toLowerCase() === providerKey)\n    : jobs;\n  if (!query) return filtered;\n  return filtered.filter((job) => tokenMatch([\n    job.title, job.company, job.category, job.description\n  ].join(" "), query));\n}\n\nasync function fetchAtsJobs({ query = "", provider = "", signal } = {}) {''',
    "provider-aware ATS filtering"
)

s = replace_once(
    s,
    '''  return filterAtsJobs(jobs, { query });''',
    '''  return filterAtsJobs(jobs, { query, provider });''',
    "pass provider filter"
)

p.write_text(s)

# ---- server.js ----
p = Path("server.js")
s = p.read_text()

s = replace_once(
    s,
    '''const ENRICH_CONCURRENCY = 12;''',
    '''const ENRICH_CONCURRENCY = 12;\n// Prevent a nationwide ATS feed from turning one local search into hundreds of\n// pre-response geocoding calls. Exact-city jobs are anchored immediately; only a\n// bounded set of remaining location groups is geocoded before radius filtering.\nconst MAX_TEXT_LOCATION_GEOCODES_PER_SEARCH = 24;''',
    "ATS geocode safety constant"
)

s = replace_once(
    s,
    '''  if (x === "themuse" || x === "the muse" || x === "muse") return "themuse";\n  if (x === "ats" || x === "greenhouse" || x === "lever" || x === "ashby") return "ats";''',
    '''  if (x === "themuse" || x === "the muse" || x === "muse") return "themuse";\n  if (x === "ats") return "ats";\n  if (x === "greenhouse") return "greenhouse";\n  if (x === "lever") return "lever";\n  if (x === "ashby") return "ashby";''',
    "distinct ATS source aliases"
)

s = replace_once(
    s,
    '''  if (source === "all" || source === "ats") {\n    labels.push("ATS");\n    tasks.push(fetchAtsJobs({\n      query,\n      signal: AbortSignal.timeout(12000)\n    }));\n  }''',
    '''  if (["all", "ats", "greenhouse", "lever", "ashby"].includes(source)) {\n    labels.push("ATS");\n    const atsProvider = ["greenhouse", "lever", "ashby"].includes(source) ? source : "";\n    tasks.push(fetchAtsJobs({\n      query,\n      provider: atsProvider,\n      signal: AbortSignal.timeout(12000)\n    }));\n  }''',
    "source-specific ATS fetch"
)

old_resolver = '''async function resolveMuseAreaLocations(jobs, origin) {\n  // Muse does not provide coordinates. Resolve each distinct provider location before\n  // building the first response so valid Muse jobs are not discarded merely because\n  // slower workplace/address enrichment has not finished yet.\n  const groups = new Map();\n  for (const job of jobs) {\n    const textOnlySource = job?.source === "The Muse" || String(job?.source || "").startsWith("ATS/");\n    if (!textOnlySource || validCoordinate(job.latitude, job.longitude)) continue;\n    const location = String(job.location || "").trim();\n    if (!location || /\\b(remote|anywhere|multiple locations)\\b/i.test(location)) continue;\n    const key = location.toLowerCase();\n    if (!groups.has(key)) groups.set(key, { location, jobs: [] });\n    groups.get(key).jobs.push(job);\n  }\n\n  await runWithConcurrency(Array.from(groups.values()), 8, async (group) => {\n    let area = null;\n    try { area = await geoapifySearchOrigin(group.location, null, null); }\n    catch (error) { console.error("Muse area geocode failed:", error.message); }\n    if (!area || !validCoordinate(area.latitude, area.longitude)) return;\n    for (const job of group.jobs) {\n      job.latitude = area.latitude;\n      job.longitude = area.longitude;\n      job.location_precision = "area";\n      job.location_approximate = true;\n      job.location_confidence = "low";\n      job.location_match_provider = job.source === "The Muse"\n        ? "The Muse/Geoapify area" : `${job.source}/Geoapify area`;\n    }\n  });\n\n  const requestedCity = String(origin?.label || "").split(",")[0].trim().toLowerCase();\n  if (requestedCity && validCoordinate(origin?.latitude, origin?.longitude)) {\n    for (const job of jobs) {\n      const textOnlySource = job?.source === "The Muse" || String(job?.source || "").startsWith("ATS/");\n    if (!textOnlySource || validCoordinate(job.latitude, job.longitude)) continue;\n      if (String(job.location || "").toLowerCase().includes(requestedCity)) {\n        job.latitude = origin.latitude;\n        job.longitude = origin.longitude;\n        job.location_precision = "area";\n        job.location_approximate = true;\n        job.location_confidence = "low";\n        job.location_match_provider = job.source === "The Muse"\n          ? "The Muse search area" : `${job.source} search area`;\n      }\n    }\n  }\n}'''

new_resolver = '''async function resolveMuseAreaLocations(jobs, origin) {\n  // Muse and public ATS feeds often provide text locations without coordinates.\n  // Anchor exact-city matches for free, then geocode only a bounded number of the\n  // remaining distinct locations so a large nationwide ATS feed cannot fan out into\n  // hundreds of Geoapify requests during one user search.\n  const originParts = String(origin?.label || "").split(",").map((x) => x.trim()).filter(Boolean);\n  const requestedCity = String(originParts[0] || "").toLowerCase();\n  const requestedRegion = String(originParts[1] || "").toLowerCase();\n\n  if (requestedCity && validCoordinate(origin?.latitude, origin?.longitude)) {\n    for (const job of jobs) {\n      const textOnlySource = job?.source === "The Muse" || String(job?.source || "").startsWith("ATS/");\n      if (!textOnlySource || validCoordinate(job.latitude, job.longitude)) continue;\n      const location = String(job.location || "").toLowerCase();\n      if (!location.includes(requestedCity)) continue;\n      job.latitude = origin.latitude;\n      job.longitude = origin.longitude;\n      job.location_precision = "area";\n      job.location_approximate = true;\n      job.location_confidence = "low";\n      job.location_match_provider = job.source === "The Muse"\n        ? "The Muse search area" : `${job.source} search area`;\n    }\n  }\n\n  const groups = new Map();\n  for (const job of jobs) {\n    const textOnlySource = job?.source === "The Muse" || String(job?.source || "").startsWith("ATS/");\n    if (!textOnlySource || validCoordinate(job.latitude, job.longitude)) continue;\n    const location = String(job.location || "").trim();\n    if (!location || /\\b(remote|anywhere|multiple locations)\\b/i.test(location)) continue;\n    const key = location.toLowerCase();\n    if (!groups.has(key)) groups.set(key, {\n      location,\n      jobs: [],\n      priority: requestedRegion && key.includes(requestedRegion) ? 0 : 1\n    });\n    groups.get(key).jobs.push(job);\n  }\n\n  const groupsToResolve = Array.from(groups.values())\n    .sort((a, b) => a.priority - b.priority)\n    .slice(0, MAX_TEXT_LOCATION_GEOCODES_PER_SEARCH);\n\n  await runWithConcurrency(groupsToResolve, 8, async (group) => {\n    let area = null;\n    try { area = await geoapifySearchOrigin(group.location, null, null); }\n    catch (error) { console.error("Text location geocode failed:", error.message); }\n    if (!area || !validCoordinate(area.latitude, area.longitude)) return;\n    for (const job of group.jobs) {\n      job.latitude = area.latitude;\n      job.longitude = area.longitude;\n      job.location_precision = "area";\n      job.location_approximate = true;\n      job.location_confidence = "low";\n      job.location_match_provider = job.source === "The Muse"\n        ? "The Muse/Geoapify area" : `${job.source}/Geoapify area`;\n    }\n  });\n}'''

s = replace_once(s, old_resolver, new_resolver, "bounded ATS/Muse text location resolution")

s = replace_once(
    s,
    '''{ name: "JobBubble API", status: "online", version: "9.4.45" }''',
    '''{ name: "JobBubble API", status: "online", version: "9.4.46" }''',
    "root version"
)
s = replace_once(s, '        version: "9.4.45",', '        version: "9.4.46",', "health version")
s = replace_once(s, '  console.log(`JobBubble backend V9.4.45 listening on port ${PORT}`);', '  console.log(`JobBubble backend V9.4.46 listening on port ${PORT}`);', "startup version")

p.write_text(s)
print("Patched JobBubble backend V9.4.46 ATS post-merge issues")
