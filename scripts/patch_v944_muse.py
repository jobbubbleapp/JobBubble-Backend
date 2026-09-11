from pathlib import Path

p = Path('server.js')
s = p.read_text()

repls = [
('const CAREERONESTOP_API_TOKEN = process.env.CAREERONESTOP_API_TOKEN;\nconst { fetchCareerOneStopJobs, normalizeCareerOneStopJob } = require("./providers/careeronestop");',
 'const CAREERONESTOP_API_TOKEN = process.env.CAREERONESTOP_API_TOKEN;\nconst THE_MUSE_API_KEY = process.env.THE_MUSE_API_KEY;\nconst { fetchCareerOneStopJobs, normalizeCareerOneStopJob } = require("./providers/careeronestop");\nconst { fetchMuseJobs, normalizeMuseJob } = require("./providers/themuse");'),
('async function fetchCareerOneStop(where, radius, query) {\n  return fetchCareerOneStopJobs({\n    userId: CAREERONESTOP_USER_ID,\n    apiToken: CAREERONESTOP_API_TOKEN,\n    where, radius, query, pageSize: 50, days: 60,\n    signal: AbortSignal.timeout(12000)\n  });\n}\n\nfunction normalizeSource(value) {',
 'async function fetchCareerOneStop(where, radius, query) {\n  return fetchCareerOneStopJobs({\n    userId: CAREERONESTOP_USER_ID,\n    apiToken: CAREERONESTOP_API_TOKEN,\n    where, radius, query, pageSize: 50, days: 60,\n    signal: AbortSignal.timeout(12000)\n  });\n}\n\nasync function fetchTheMuse(where, radius, query) {\n  return fetchMuseJobs({\n    apiKey: THE_MUSE_API_KEY,\n    where, query, page: 1,\n    signal: AbortSignal.timeout(12000)\n  });\n}\n\nfunction normalizeSource(value) {'),
('  if (x === "careeronestop" || x === "career one stop" || x === "career_one_stop" || x === "nlx") return "careeronestop";\n  return "all";',
 '  if (x === "themuse" || x === "the muse" || x === "muse") return "themuse";\n  if (x === "careeronestop" || x === "career one stop" || x === "career_one_stop" || x === "nlx") return "careeronestop";\n  return "all";'),
('  if (source === "all" || source === "careeronestop") {\n    labels.push("CareerOneStop/NLx");\n    tasks.push(fetchCareerOneStop(where, radius, query));\n  }',
 '  if (source === "all" || source === "themuse") {\n    labels.push("The Muse");\n    tasks.push(fetchTheMuse(where, radius, query));\n  }\n  // CareerOneStop is preserved for possible future reactivation, but intentionally\n  // excluded from the public All Sources path.\n  if (source === "careeronestop") {\n    labels.push("CareerOneStop/NLx");\n    tasks.push(fetchCareerOneStop(where, radius, query));\n  }'),
('      } else if (provider.label === "CareerOneStop/NLx") {\n      normalized.push(...provider.value.map(normalizeCareerOneStopJob));',
 '    } else if (provider.label === "The Muse") {\n      normalized.push(...provider.value.map(normalizeMuseJob));\n    } else if (provider.label === "CareerOneStop/NLx") {\n      normalized.push(...provider.value.map(normalizeCareerOneStopJob));'),
('{ name: "JobBubble API", status: "online", version: "9.4.42" }',
 '{ name: "JobBubble API", status: "online", version: "9.4.44" }'),
('        version: "9.4.42",', '        version: "9.4.44",'),
('      careeronestop: CAREERONESTOP_USER_ID && CAREERONESTOP_API_TOKEN ? "enabled" : "disabled",',
 '        themuse: THE_MUSE_API_KEY ? "enabled" : "disabled",\n        careeronestop: "hidden",'),
('JobBubble backend V9.4.42 listening on port', 'JobBubble backend V9.4.44 listening on port'),
('  console.log("USAJOBS:", USAJOBS_API_KEY && USAJOBS_EMAIL ? "enabled" : "disabled");',
 '  console.log("USAJOBS:", USAJOBS_API_KEY && USAJOBS_EMAIL ? "enabled" : "disabled");\n  console.log("The Muse:", THE_MUSE_API_KEY ? "enabled" : "disabled");\n  console.log("CareerOneStop: hidden from public source selection");')
]

for old, new in repls:
    if old not in s:
        raise SystemExit(f'Patch target missing:\n{old[:180]}')
    s = s.replace(old, new, 1)

p.write_text(s)
print('Patched server.js for JobBubble backend V9.4.44 / The Muse')
