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

replaceOnce(
  'const { extractStreetAddress: extractStreetAddressStrict, geocoderResultMatchesAddress } = require("./location-integrity");',
  'const { extractStreetAddress: extractStreetAddressStrict, extractContextualStreetAddress, geocoderResultMatchesAddress, canRefineAreaToStreet } = require("./location-integrity");',
  'location integrity imports'
);

replaceOnce(
`    for (const script of scripts.slice(0, 30)) {
      const bodyMatch = script.match(/>([\\s\\S]*?)<\\/script>/i);
      if (!bodyMatch) continue;
      const body = bodyMatch[1].trim().replace(/^<!--|-->$/g, "").trim();
      if (!body) continue;
      try {
        const parsed = JSON.parse(body);
        const postings = walkJsonForJobPosting(parsed);
        for (const posting of postings) {
          const address = addressFromJobPosting(posting);
          if (address) {
            postingPageCache.set(cacheKey, { time: Date.now(), value: address });
            return address;
          }
        }
      } catch (_) {}
    }
`,
`    for (const script of scripts.slice(0, 30)) {
      const bodyMatch = script.match(/>([\\s\\S]*?)<\\/script>/i);
      if (!bodyMatch) continue;
      const body = bodyMatch[1].trim().replace(/^<!--|-->$/g, "").trim();
      if (!body) continue;
      try {
        const parsed = JSON.parse(body);
        const postings = walkJsonForJobPosting(parsed);
        for (const posting of postings) {
          const address = addressFromJobPosting(posting);
          if (address) {
            postingPageCache.set(cacheKey, { time: Date.now(), value: address });
            return address;
          }
        }
      } catch (_) {}
    }

    // Some providers (including The Muse) expose the true workplace address in the
    // visible job body instead of JobPosting JSON-LD. Only accept a visible address
    // when it is tied to explicit workplace/location context for this posting.
    const contextualAddress = extractContextualStreetAddress(html, job?.location || "");
    if (contextualAddress) {
      postingPageCache.set(cacheKey, { time: Date.now(), value: contextualAddress });
      return contextualAddress;
    }
`,
  'visible posting address fallback'
);

replaceOnce(
`async function geoapifyLikelyWorkplace(job) {
  if (!GEOAPIFY_API_KEY || !job || looksLikeStreetAddress(job.location) ||
      isGenericCompanyName(job.company)) return null;
`,
`async function geoapifyLikelyWorkplace(job) {
  if (!GEOAPIFY_API_KEY || !job || looksLikeStreetAddress(job.location) ||
      isGenericCompanyName(job.company)) return null;

  // Never turn a city/area centroid into a street-level branch merely by searching
  // for the employer name. Chains can have many branches in one city; choosing the
  // closest one to a city centroid creates convincing but false pins. Exact posting
  // evidence is handled earlier. Without it, keep the honest area estimate.
  if (!canRefineAreaToStreet(job)) return null;
`,
  'area branch guard'
);

replaceOnce('const WORKPLACE_CACHE_VERSION = "v2";', 'const WORKPLACE_CACHE_VERSION = "v3";', 'workplace cache version');
replaceOnce('{ name: "JobBubble API", status: "online", version: "9.4.52" }', '{ name: "JobBubble API", status: "online", version: "9.4.53" }', 'root version');
replaceOnce('        version: "9.4.52",', '        version: "9.4.53",', 'health version');
replaceOnce('JobBubble backend V9.4.52 listening on port', 'JobBubble backend V9.4.53 listening on port', 'startup version log');

fs.writeFileSync(serverPath, text);
console.log('Applied JobBubble backend V9.4.53 posting-evidence and no-guessed-branch location fix');
