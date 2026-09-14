#!/usr/bin/env python3
from pathlib import Path
import sys

path = Path(sys.argv[1] if len(sys.argv) > 1 else 'server.js')
s = path.read_text(encoding='utf-8')

old_finalize = '''function finalizeJobs(jobs, origin, radius) {
  const kept = [];
  for (const job of jobs) {
    const distance = setDistance(job, origin);
    if (distance == null || distance > radius) continue;
    kept.push(job);
  }
  const deduped = dedupeJobs(kept);
  deduped.sort((a, b) => Number(a.distance_miles || 0) - Number(b.distance_miles || 0));
  return deduped;
}
'''
new_finalize = old_finalize + '''
function minimumHourlyPay(job) {
  const amount = Number(job?.salary_min);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const period = String(job?.salary_period || '').trim().toLowerCase();
  if (period === 'year') return amount / 2080;
  if (period === 'month') return amount * 12 / 2080;
  if (period === 'week') return amount * 52 / 2080;
  if (period === 'day') return amount / 8;
  return amount;
}

function matchesMinimumPay(job, minPayHourly) {
  if (!Number.isFinite(minPayHourly) || minPayHourly <= 0) return true;
  const hourly = minimumHourlyPay(job);
  // Keep jobs with unknown/unparseable salary, matching the Android client's
  // long-standing behavior. Only a known advertised minimum below the user's
  // threshold is removed.
  return hourly == null || hourly >= minPayHourly;
}
'''
if 'function minimumHourlyPay(job)' not in s:
    if old_finalize not in s:
        raise SystemExit('finalizeJobs insertion target not found')
    s = s.replace(old_finalize, new_finalize, 1)

start = s.find('async function fetchAdzunaJobs(where, radius, query) {')
end = s.find('\nasync function fetchUSAJobs(', start)
if start == -1 or end == -1:
    if 'async function fetchAdzunaJobs(where, radius, query, minPayHourly = 0)' not in s:
        raise SystemExit('Adzuna function target not found')
else:
    new_adzuna = '''async function fetchAdzunaJobs(where, radius, query, minPayHourly = 0) {
  if (!ADZUNA_APP_ID || !ADZUNA_APP_KEY) {
    throw new Error("Adzuna environment variables are missing");
  }

  const makeUrl = (salaryMinAnnual = null) => {
    const url = new URL("https://api.adzuna.com/v1/api/jobs/us/search/1");
    url.searchParams.set("app_id", ADZUNA_APP_ID);
    url.searchParams.set("app_key", ADZUNA_APP_KEY);
    url.searchParams.set("results_per_page", "50");
    if (where) url.searchParams.set("where", where);
    if (query) url.searchParams.set("what", query);
    if (radius > 0) url.searchParams.set("distance", String(radius));
    if (Number.isFinite(salaryMinAnnual) && salaryMinAnnual > 0) {
      url.searchParams.set("salary_min", String(Math.round(salaryMinAnnual)));
    }
    url.searchParams.set("content-type", "application/json");
    return url;
  };

  const requestPage = async (url) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Adzuna HTTP ${response.status}: ${body.slice(0, 200)}`);
    }
    const data = await response.json();
    return Array.isArray(data.results) ? data.results : [];
  };

  const basePromise = requestPage(makeUrl());
  if (!Number.isFinite(minPayHourly) || minPayHourly <= 0) return basePromise;

  // Keep the ordinary page so salary-unknown listings are never lost. In parallel,
  // ask Adzuna for a salary-targeted page and merge it in. Adzuna's salary_min is
  // annual, while JobBubble's control is hourly, so use the same 2080 h/year
  // conversion as the Android app.
  const targetedPromise = requestPage(makeUrl(minPayHourly * 2080));
  const [base, targeted] = await Promise.allSettled([basePromise, targetedPromise]);
  if (base.status !== "fulfilled") throw base.reason;

  const merged = base.value.slice();
  const seen = new Set(merged.map((item) => String(item?.id || "")).filter(Boolean));
  if (targeted.status === "fulfilled") {
    for (const item of targeted.value) {
      const id = String(item?.id || "");
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      merged.push(item);
    }
  } else {
    console.error("Adzuna salary-targeted request failed:", targeted.reason?.message || targeted.reason);
  }
  return merged;
}
'''
    s = s[:start] + new_adzuna + s[end:]

old_key = 'function makeSearchKey({ where, radius, query, source, centerLat, centerLon }) {'
new_key = 'function makeSearchKey({ where, radius, query, source, centerLat, centerLon, minPayHourly }) {'
if old_key in s:
    s = s.replace(old_key, new_key, 1)
elif new_key not in s:
    raise SystemExit('makeSearchKey signature target not found')

old_key_tail = '''    source,
    latKey,
    lonKey
  ].join("|");'''
new_key_tail = '''    source,
    latKey,
    lonKey,
    Number.isFinite(minPayHourly) ? Number(minPayHourly).toFixed(2) : "0.00"
  ].join("|");'''
if old_key_tail in s:
    s = s.replace(old_key_tail, new_key_tail, 1)
elif 'Number.isFinite(minPayHourly) ? Number(minPayHourly).toFixed(2)' not in s:
    raise SystemExit('makeSearchKey body target not found')

old_selected = 'async function fetchSelectedProviders(source, where, radius, query, centerLat, centerLon) {'
new_selected = 'async function fetchSelectedProviders(source, where, radius, query, centerLat, centerLon, minPayHourly) {'
if old_selected in s:
    s = s.replace(old_selected, new_selected, 1)
elif new_selected not in s:
    raise SystemExit('fetchSelectedProviders signature target not found')

old_adzuna_call = 'tasks.push(fetchAdzunaJobs(where, radius, query));'
new_adzuna_call = 'tasks.push(fetchAdzunaJobs(where, radius, query, minPayHourly));'
if old_adzuna_call in s:
    s = s.replace(old_adzuna_call, new_adzuna_call, 1)
elif new_adzuna_call not in s:
    raise SystemExit('Adzuna selected-provider call target not found')

old_build = 'const { where, radius, query, source, centerLat, centerLon } = params;'
new_build = 'const { where, radius, query, source, centerLat, centerLon, minPayHourly } = params;'
if old_build in s:
    s = s.replace(old_build, new_build, 1)
elif new_build not in s:
    raise SystemExit('buildSearch destructure target not found')

old_fetch = 'const providerResults = await fetchSelectedProviders(source, where, radius, query, origin.latitude, origin.longitude);'
new_fetch = 'const providerResults = await fetchSelectedProviders(source, where, radius, query, origin.latitude, origin.longitude, minPayHourly);'
if old_fetch in s:
    s = s.replace(old_fetch, new_fetch, 1)
elif new_fetch not in s:
    raise SystemExit('buildSearch provider call target not found')

marker = '''  // Muse jobs arrive without coordinates. Resolve their provider-supplied area labels
'''
filter_block = '''  // Apply the same minimum-pay semantics as Android before location enrichment:
  // known advertised minimums below the threshold are excluded, while unknown pay
  // remains eligible. The Adzuna companion search above widens the candidate pool so
  // high-paying jobs are not hidden behind the ordinary 50-result provider page.
  const payEligible = normalized.filter((job) => matchesMinimumPay(job, minPayHourly));

'''
if 'const payEligible = normalized.filter' not in s:
    if marker not in s:
        raise SystemExit('payEligible insertion target not found')
    s = s.replace(marker, filter_block + marker, 1)

s = s.replace('if (normalized.some((job) =>\n', 'if (payEligible.some((job) =>\n', 1)
s = s.replace('areaResolutionPromise = resolveMuseAreaLocations(normalized, origin)', 'areaResolutionPromise = resolveMuseAreaLocations(payEligible, origin)', 1)
s = s.replace('for (const job of normalized) {\n    if (!validCoordinate(job.latitude, job.longitude)) {', 'for (const job of payEligible) {\n    if (!validCoordinate(job.latitude, job.longitude)) {', 1)

for needle in [
    'radius_miles: radius,\n      source_filter: source,',
    'radius_miles: radius,\n    source_filter: source,'
]:
    if needle in s and 'min_pay_hourly: minPayHourly' not in s[s.find(needle):s.find(needle)+180]:
        repl = needle.replace('source_filter: source,', 'source_filter: source,\n' + ('      ' if '      source_filter' in needle else '    ') + 'min_pay_hourly: minPayHourly,')
        s = s.replace(needle, repl, 1)

old_parse = '''    const source = normalizeSource(url.searchParams.get("source"));
    const forceRefresh = url.searchParams.get("refresh") === "1";'''
new_parse = '''    const source = normalizeSource(url.searchParams.get("source"));
    const requestedMinPay = Number(url.searchParams.get("min_pay_hourly") || 0);
    const minPayHourly = Number.isFinite(requestedMinPay) && requestedMinPay > 0
      ? Math.min(requestedMinPay, 500) : 0;
    const forceRefresh = url.searchParams.get("refresh") === "1";'''
if old_parse in s:
    s = s.replace(old_parse, new_parse, 1)
elif 'const requestedMinPay = Number(url.searchParams.get("min_pay_hourly") || 0);' not in s:
    raise SystemExit('handleJobs min pay parse target not found')

old_params = 'const params = { where, radius, query, source, centerLat, centerLon };'
new_params = 'const params = { where, radius, query, source, centerLat, centerLon, minPayHourly };'
if old_params in s:
    s = s.replace(old_params, new_params, 1)
elif new_params not in s:
    raise SystemExit('handleJobs params target not found')

s = s.replace('version: "9.4.47"', 'version: "9.4.48"')
s = s.replace('JobBubble backend V9.4.47 listening', 'JobBubble backend V9.4.48 listening')

required = [
    'min_pay_hourly',
    'function minimumHourlyPay(job)',
    'fetchAdzunaJobs(where, radius, query, minPayHourly = 0)',
    'const payEligible = normalized.filter',
    'Number(minPayHourly).toFixed(2)',
    'JobBubble backend V9.4.48 listening',
]
for token in required:
    if token not in s:
        raise SystemExit(f'missing expected patched token: {token}')

path.write_text(s, encoding='utf-8')
print('Applied JobBubble backend Step 3 minimum-pay search support (V9.4.48)')
