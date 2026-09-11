from pathlib import Path

p = Path('server.js')
s = p.read_text()
old = '''    } else if (provider.label === "The Muse") {\n      normalized.push(...provider.value.map(normalizeMuseJob));\n    } else if (provider.label === "CareerOneStop/NLx") {'''
new = '''    } else if (provider.label === "The Muse") {\n      const museJobs = provider.value.map(normalizeMuseJob);\n      const requestedCity = String(where || "").split(",")[0].trim().toLowerCase();\n      for (const job of museJobs) {\n        const loc = String(job.location || "").toLowerCase();\n        // The Muse API returns location text but no coordinates. If the posting is\n        // explicitly in the searched city, anchor it to the search origin immediately\n        // so the first app response is not empty while Geoapify refines the pin.\n        if (!validCoordinate(job.latitude, job.longitude) && requestedCity && loc.includes(requestedCity)) {\n          job.latitude = origin.latitude;\n          job.longitude = origin.longitude;\n          job.location_precision = "area";\n          job.location_approximate = true;\n          job.location_confidence = "low";\n          job.location_match_provider = "The Muse search area";\n        }\n      }\n      normalized.push(...museJobs);\n    } else if (provider.label === "CareerOneStop/NLx") {'''
if old not in s:
    raise SystemExit('Muse normalization target missing')
s = s.replace(old, new, 1)
p.write_text(s)
print('Applied Muse fast-result anchor fix')
