const fs = require('fs');
const path = require('path');

const serverPath = path.resolve(__dirname, '..', 'server.js');
let s = fs.readFileSync(serverPath, 'utf8');

function replaceOnce(oldText, newText, label) {
  if (s.includes(newText)) return;
  const first = s.indexOf(oldText);
  if (first < 0) throw new Error(`Step 5 patch target missing: ${label}`);
  if (s.indexOf(oldText, first + oldText.length) >= 0) {
    throw new Error(`Step 5 patch target ambiguous: ${label}`);
  }
  s = s.slice(0, first) + newText + s.slice(first + oldText.length);
}

// Provider location text can contain a street address while the provider latitude /
// longitude is only a city or search-area centroid. Do not advertise those coordinates
// as exact until the address itself has been geocoded and verified.
replaceOnce(
  `    location_precision: exact ? "exact" : "area",\n    location_approximate: !exact,\n    location_match_provider: "USAJOBS"`,
  `    location_precision: exact ? "likely" : "area",\n    location_approximate: true,\n    location_confidence: exact ? "medium" : "low",\n    location_match_provider: exact ? "USAJOBS address pending verification" : "USAJOBS"`,
  'USAJOBS unverified street metadata'
);

replaceOnce(
  `    location_precision: exact ? "exact" : "area",\n    location_approximate: !exact,\n    location_match_provider: null`,
  `    location_precision: exact ? "likely" : "area",\n    location_approximate: true,\n    location_confidence: exact ? "medium" : "low",\n    location_match_provider: exact ? "Adzuna address pending verification" : null`,
  'Adzuna unverified street metadata'
);

replaceOnce(
  `async function enrichJobLocation(job) {\n  if (!job) return job;\n\n  if (looksLikeStreetAddress(job.location)) {\n    job.location_precision = "exact";\n    job.location_approximate = false;\n    job.location_confidence = "high";\n    return job;\n  }`,
  `async function enrichJobLocation(job) {\n  if (!job) return job;\n\n  // V9.4.49: a street address in provider text is strong evidence, but the provider\n  // coordinate beside it can still be only a city/area centroid. Geocode the address\n  // itself before calling the map pin exact. If verification is unavailable or fails,\n  // keep the provider coordinate as an approximate fallback instead of dropping the job.\n  if (looksLikeStreetAddress(job.location)) {\n    const providerAddress = await geoapifyExplicitAddress(job, job.location, "provider-location-address");\n    if (providerAddress) {\n      job.latitude = providerAddress.latitude;\n      job.longitude = providerAddress.longitude;\n      job.location = providerAddress.location || job.location;\n      job.location_precision = "exact";\n      job.location_approximate = false;\n      job.location_confidence = "high";\n      job.location_match_provider = "Geoapify verified provider address";\n      rememberWorkplace(job, {\n        latitude: job.latitude,\n        longitude: job.longitude,\n        location: job.location,\n        precision: "exact",\n        confidence: "high"\n      });\n      return job;\n    }\n    if (validCoordinate(job.latitude, job.longitude)) {\n      job.location_precision = "area";\n      job.location_approximate = true;\n      job.location_confidence = "low";\n      job.location_match_provider = (job.source || "Provider") + " area estimate; street address unverified";\n    }\n  }`,
  'enrichJobLocation provider-street early return'
);

// Backend version bump.
s = s.replaceAll('9.4.48', '9.4.49');

const required = [
  'provider-location-address',
  'Geoapify verified provider address',
  'street address unverified',
  'location_precision: exact ? "likely" : "area"',
  'version: "9.4.49"',
  'backend V9.4.49 listening'
];
for (const token of required) {
  if (!s.includes(token)) throw new Error(`Step 5 generated server missing: ${token}`);
}
if (s.includes('if (looksLikeStreetAddress(job.location)) {\n    job.location_precision = "exact";')) {
  throw new Error('Step 5 old unverified exact-location early return still present');
}

fs.writeFileSync(serverPath, s, 'utf8');
console.log('Applied backend V9.4.49 provider street-address verification + approximate fallback');
