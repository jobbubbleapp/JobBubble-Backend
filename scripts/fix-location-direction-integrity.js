'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const serverPath = path.join(root, 'server.js');
let text = fs.readFileSync(serverPath, 'utf8');

function replaceOnce(oldText, newText, label) {
  const count = text.split(oldText).length - 1;
  if (count !== 1) throw new Error(`${label}: expected 1 match, found ${count}`);
  text = text.replace(oldText, newText);
}

function replaceInSection(startMarker, endMarker, oldText, newText, label) {
  const start = text.indexOf(startMarker);
  if (start < 0) throw new Error(`${label}: section start missing`);
  const end = text.indexOf(endMarker, start + startMarker.length);
  if (end < 0) throw new Error(`${label}: section end missing`);
  let section = text.slice(start, end);
  const count = section.split(oldText).length - 1;
  if (count !== 1) throw new Error(`${label}: expected 1 section match, found ${count}`);
  section = section.replace(oldText, newText);
  text = text.slice(0, start) + section + text.slice(end);
}

replaceOnce(
  'const { fetchAtsJobs, getAtsBoards } = require("./providers/ats");',
  'const { fetchAtsJobs, getAtsBoards } = require("./providers/ats");\nconst { extractStreetAddress: extractStreetAddressStrict, geocoderResultMatchesAddress } = require("./location-integrity");',
  'location integrity import'
);

replaceOnce('const GEO_CACHE_VERSION = "v2";', 'const GEO_CACHE_VERSION = "v3";', 'geo cache version');
replaceOnce(
  'const WORKPLACE_CACHE_TTL_MS = 90 * 24 * 60 * 60 * 1000;',
  'const WORKPLACE_CACHE_TTL_MS = 90 * 24 * 60 * 60 * 1000;\nconst WORKPLACE_CACHE_VERSION = "v2";',
  'workplace cache version'
);

const oldExtractor = `function extractStreetAddress(text) {
  const plain = String(text || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\\s+/g, " ")
    .trim();

  const match = plain.match(
    /\\b\\d{1,6}\\s+[A-Za-z0-9.'#&\\- ]{2,55}\\s(?:st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|way|ct|court|pl|place|pkwy|parkway|hwy|highway)\\b(?:\\s*(?:,|#|suite|ste)\\s*[A-Za-z0-9.\\- ]{0,30})?/i
  );
  return match ? match[0].trim() : null;
}`;
replaceOnce(
  oldExtractor,
  `function extractStreetAddress(text) {\n  return extractStreetAddressStrict(text);\n}`,
  'strict street extractor'
);

replaceOnce(
  `  if (validCoordinate(job?.latitude, job?.longitude)) {
    url.searchParams.set("bias", \`proximity:\${job.longitude},\${job.latitude}\`);
  }
  url.searchParams.set("format", "json");`,
  `  // A complete street address must stand on its own. Do not bias an exact-address\n  // geocode toward a provider centroid because that can pull SE/SW or NE/NW streets\n  // to the wrong side of a city.\n  url.searchParams.set("format", "json");`,
  'remove explicit-address proximity bias'
);

replaceOnce(
  `      const lat = Number(result.lat), lon = Number(result.lon);
      if (!validCoordinate(lat, lon)) continue;
      // An address explicitly supplied by the posting is stronger than an approximate`,
  `      const lat = Number(result.lat), lon = Number(result.lon);
      if (!validCoordinate(lat, lon)) continue;
      if (!geocoderResultMatchesAddress(address, result)) continue;
      // An address explicitly supplied by the posting is stronger than an approximate`,
  'validate explicit geocoder result'
);

replaceInSection(
  'async function geoapifyAddressCandidate(job) {',
  'function locationContextTokens(value) {',
  `  if (validCoordinate(job.latitude, job.longitude)) {
    url.searchParams.set("bias", \`proximity:\${job.longitude},\${job.latitude}\`);
  }
  url.searchParams.set("format", "json");`,
  `  // Do not let an approximate provider pin bias a street-address lookup onto a\n  // different directional street segment. The returned address is validated below.\n  url.searchParams.set("format", "json");`,
  'remove description-address proximity bias'
);

replaceInSection(
  'async function geoapifyAddressCandidate(job) {',
  'function locationContextTokens(value) {',
  `      const lat = Number(result.lat);
      const lon = Number(result.lon);
      if (!validCoordinate(lat, lon)) continue;

      if (validCoordinate(job.latitude, job.longitude)) {`,
  `      const lat = Number(result.lat);
      const lon = Number(result.lon);
      if (!validCoordinate(lat, lon)) continue;
      if (!geocoderResultMatchesAddress(\`${'${address}'}, ${'${job.location || ""}'}\`, result)) continue;

      if (validCoordinate(job.latitude, job.longitude)) {`,
  'validate description geocoder result'
);

replaceOnce(
  '  return `${company}|${location}|${anchor}`;',
  '  return `${WORKPLACE_CACHE_VERSION}|${company}|${location}|${anchor}`;',
  'version workplace cache key'
);

replaceOnce('{ name: "JobBubble API", status: "online", version: "9.4.51" }', '{ name: "JobBubble API", status: "online", version: "9.4.52" }', 'root version');
replaceOnce('        version: "9.4.51",', '        version: "9.4.52",', 'health version');
replaceOnce('GeoCache V2 startup hydration failed:', 'GeoCache V3 startup hydration failed:', 'startup cache log');
replaceOnce('JobBubble backend V9.4.51 listening on port', 'JobBubble backend V9.4.52 listening on port', 'startup version log');
replaceOnce('GeoCache V2: normalized LRU, short negative TTL, request dedupe, persistent job-location cache', 'GeoCache V3: directional-address integrity, normalized LRU, request dedupe, persistent job-location cache', 'cache feature log');

fs.writeFileSync(serverPath, text);
console.log('Applied JobBubble backend V9.4.52 directional street-address integrity fix');
