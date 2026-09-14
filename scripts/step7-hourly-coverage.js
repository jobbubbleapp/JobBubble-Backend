const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const atsPath = path.join(root, 'providers', 'ats.js');
const serverPath = path.join(root, 'server.js');
let ats = fs.readFileSync(atsPath, 'utf8');
let server = fs.readFileSync(serverPath, 'utf8');

const anchor = '  { provider: "lever", board: "insomniacookies", company: "Insomnia Cookies" },\n';
const additions = [
  '  { provider: "lever", board: "gopuff", company: "Gopuff / BevMo!" },',
  '  { provider: "lever", board: "bluebottlecoffee", company: "Blue Bottle Coffee" },',
  '  { provider: "lever", board: "thuma", company: "Thuma" },'
].join('\n') + '\n';
if (!ats.includes('board: "gopuff"')) {
  if (!ats.includes(anchor)) throw new Error('Step 7 board insertion anchor missing');
  ats = ats.replace(anchor, anchor + additions);
}

const oldFilter = `function filterAtsJobs(jobs, { query = "", provider = "" } = {}) {\n  const providerKey = normalizeProvider(provider);\n  let filtered = providerKey\n    ? jobs.filter((job) => String(job?.ats_provider || "").toLowerCase() === providerKey)\n    : jobs;\n  if (!query) return filtered;\n  return filtered.filter((job) => tokenMatch([\n    job.title, job.company, job.category, job.description\n  ].join(" "), query));\n}`;

const newFilter = `function hourlyCategoryMatch(job, query) {\n  const key = String(query || "").trim().toLowerCase();\n  const text = [job?.title, job?.company, job?.category]\n    .join(" ").toLowerCase();\n\n  // The Android category picker intentionally sends compact backend terms. Expand\n  // only those exact category terms so hourly employer feeds participate in the\n  // existing filters without changing free-text search behavior. Keep the matching\n  // to title/company/category fields; full descriptions often contain employer\n  // boilerplate that would make these category filters much too broad.\n  if (key === "restaurant") {\n    return /\\b(restaurant|cafe|coffee|barista|kitchen|cook|food|hospitality|crew|team member)\\b/i.test(text);\n  }\n  if (key === "retail") {\n    return /\\b(retail|store|sales associate|shop|cashier|merchandising|key holder)\\b/i.test(text);\n  }\n  if (key === "warehouse") {\n    return /\\b(warehouse|fulfillment|distribution|forklift|operations associate|inventory|picker|packer)\\b/i.test(text);\n  }\n  return null;\n}\n\nfunction filterAtsJobs(jobs, { query = "", provider = "" } = {}) {\n  const providerKey = normalizeProvider(provider);\n  let filtered = providerKey\n    ? jobs.filter((job) => String(job?.ats_provider || "").toLowerCase() === providerKey)\n    : jobs;\n  if (!query) return filtered;\n  return filtered.filter((job) => {\n    const categoryMatch = hourlyCategoryMatch(job, query);\n    if (categoryMatch != null) return categoryMatch;\n    return tokenMatch([\n      job.title, job.company, job.category, job.description\n    ].join(" "), query);\n  });\n}`;

if (!ats.includes('function hourlyCategoryMatch(job, query)')) {
  if (!ats.includes(oldFilter)) throw new Error('Step 7 ATS filter target missing');
  ats = ats.replace(oldFilter, newFilter);
}

// If an earlier Step 7 test materialized the first matcher revision, tighten it in
// place rather than leaving description boilerplate in the category match surface.
ats = ats.replace(
  'const text = [job?.title, job?.company, job?.category, job?.description]\\n    .join(" ").toLowerCase();',
  'const text = [job?.title, job?.company, job?.category]\\n    .join(" ").toLowerCase();'
);
ats = ats.replace(
  '  // existing filters without changing free-text search behavior.\\n',
  '  // existing filters without changing free-text search behavior. Keep the matching\\n  // to title/company/category fields; full descriptions often contain employer\\n  // boilerplate that would make these category filters much too broad.\\n'
);

for (const board of ['gopuff','bluebottlecoffee','thuma']) {
  if (!ats.includes(`board: "${board}"`)) throw new Error(`Missing Step 7 board ${board}`);
}
if (!ats.includes('function hourlyCategoryMatch(job, query)')) throw new Error('Step 7 category expansion missing');
if (ats.includes('const text = [job?.title, job?.company, job?.category, job?.description]')) {
  throw new Error('Broad Step 7 description-based category matcher remains');
}

server = server.replaceAll('9.4.50', '9.4.51');
if (!server.includes('version: "9.4.51"')) throw new Error('Step 7 health version missing');
if (!server.includes('JobBubble backend V9.4.51 listening')) throw new Error('Step 7 startup version missing');

fs.writeFileSync(atsPath, ats, 'utf8');
fs.writeFileSync(serverPath, server, 'utf8');
console.log('Applied backend V9.4.51 hourly/local-service coverage');
