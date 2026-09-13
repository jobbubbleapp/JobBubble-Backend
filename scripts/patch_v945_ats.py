from pathlib import Path

p = Path("server.js")
s = p.read_text()


def replace_once(old, new, label):
    global s
    if old not in s:
        raise SystemExit(f"ATS patch target missing ({label}):\n{old[:260]}")
    s = s.replace(old, new, 1)


replace_once(
    'const { fetchMuseJobs, normalizeMuseJob } = require("./providers/themuse");',
    'const { fetchMuseJobs, normalizeMuseJob } = require("./providers/themuse");\n'
    'const { fetchAtsJobs, getAtsBoards } = require("./providers/ats");',
    "ATS import"
)

replace_once(
    '  if (x === "themuse" || x === "the muse" || x === "muse") return "themuse";\n'
    '  if (x === "careeronestop" || x === "career one stop" || x === "career_one_stop" || x === "nlx") return "careeronestop";',
    '  if (x === "themuse" || x === "the muse" || x === "muse") return "themuse";\n'
    '  if (x === "ats" || x === "greenhouse" || x === "lever" || x === "ashby") return "ats";\n'
    '  if (x === "careeronestop" || x === "career one stop" || x === "career_one_stop" || x === "nlx") return "careeronestop";',
    "source normalization"
)

replace_once(
    '  if (source === "all" || source === "themuse") {\n'
    '    labels.push("The Muse");\n'
    '    const museWhere = validCoordinate(centerLat, centerLon)\n'
    '      ? `${centerLat},${centerLon}` : where;\n'
    '    tasks.push(fetchTheMuse(museWhere, radius, query));\n'
    '  }\n'
    '  // CareerOneStop is preserved for possible future reactivation, but intentionally',
    '  if (source === "all" || source === "themuse") {\n'
    '    labels.push("The Muse");\n'
    '    const museWhere = validCoordinate(centerLat, centerLon)\n'
    '      ? `${centerLat},${centerLon}` : where;\n'
    '    tasks.push(fetchTheMuse(museWhere, radius, query));\n'
    '  }\n'
    '  if (source === "all" || source === "ats") {\n'
    '    labels.push("ATS");\n'
    '    tasks.push(fetchAtsJobs({\n'
    '      query,\n'
    '      signal: AbortSignal.timeout(12000)\n'
    '    }));\n'
    '  }\n'
    '  // CareerOneStop is preserved for possible future reactivation, but intentionally',
    "ATS provider task"
)

replace_once(
    '      normalized.push(...museJobs);\n'
    '    } else if (provider.label === "CareerOneStop/NLx") {',
    '      normalized.push(...museJobs);\n'
    '    } else if (provider.label === "ATS") {\n'
    '      normalized.push(...provider.value);\n'
    '    } else if (provider.label === "CareerOneStop/NLx") {',
    "ATS normalization"
)

# Broaden the existing text-location resolver so public ATS postings get an area
# coordinate before radius filtering. This prevents coordinate-less ATS jobs from
# being dropped merely because other providers filled the enrichment queue first.
old_condition = '    if (job?.source !== "The Muse" || validCoordinate(job.latitude, job.longitude)) continue;'
new_condition = (
    '    const textOnlySource = job?.source === "The Muse" || '
    'String(job?.source || "").startsWith("ATS/");\n'
    '    if (!textOnlySource || validCoordinate(job.latitude, job.longitude)) continue;'
)
replace_once(old_condition, new_condition, "text location resolver first loop")

replace_once(
    '      job.location_match_provider = "The Muse/Geoapify area";',
    '      job.location_match_provider = job.source === "The Muse"\n'
    '        ? "The Muse/Geoapify area" : `${job.source}/Geoapify area`;',
    "text location provider label"
)

replace_once(old_condition, new_condition, "text location resolver fallback loop")

replace_once(
    '        job.location_match_provider = "The Muse search area";',
    '        job.location_match_provider = job.source === "The Muse"\n'
    '          ? "The Muse search area" : `${job.source} search area`;',
    "text location fallback label"
)

replace_once(
    '  if (normalized.some((job) => job?.source === "The Muse" && !validCoordinate(job.latitude, job.longitude))) {\n'
    '    await resolveMuseAreaLocations(normalized, origin);\n'
    '  }',
    '  if (normalized.some((job) =>\n'
    '    (job?.source === "The Muse" || String(job?.source || "").startsWith("ATS/")) &&\n'
    '    !validCoordinate(job.latitude, job.longitude)\n'
    '  )) {\n'
    '    await resolveMuseAreaLocations(normalized, origin);\n'
    '  }',
    "ATS area resolution trigger"
)

replace_once(
    '{ name: "JobBubble API", status: "online", version: "9.4.44" }',
    '{ name: "JobBubble API", status: "online", version: "9.4.45" }',
    "root version"
)
replace_once('        version: "9.4.44",', '        version: "9.4.45",', "health version")

replace_once(
    '        themuse: THE_MUSE_API_KEY ? "enabled" : "disabled",\n'
    '        careeronestop: "hidden",',
    '        themuse: THE_MUSE_API_KEY ? "enabled" : "disabled",\n'
    '        ats: "enabled",\n'
    '        ats_boards: getAtsBoards().length,\n'
    '        careeronestop: "hidden",',
    "health ATS status"
)

replace_once(
    '  console.log(`JobBubble backend V9.4.44 listening on port ${PORT}`);',
    '  console.log(`JobBubble backend V9.4.45 listening on port ${PORT}`);',
    "startup version"
)

replace_once(
    '  console.log("The Muse:", THE_MUSE_API_KEY ? "enabled" : "disabled");\n'
    '  console.log("CareerOneStop: hidden from public source selection");',
    '  console.log("The Muse:", THE_MUSE_API_KEY ? "enabled" : "disabled");\n'
    '  console.log("ATS feeds:", `${getAtsBoards().length} employer boards configured`);\n'
    '  console.log("CareerOneStop: hidden from public source selection");',
    "startup ATS status"
)

p.write_text(s)
print("Patched server.js for JobBubble backend V9.4.45 / public ATS feeds")
