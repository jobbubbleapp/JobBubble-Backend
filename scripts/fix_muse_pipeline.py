from pathlib import Path

p=Path('server.js')
s=p.read_text()

# Remove every previous copy of this helper before inserting the one canonical
# implementation below. Earlier patch versions could add a second definition,
# which made the active behavior depend on declaration order.
def remove_async_function(text, name):
    marker=f'async function {name}('
    while marker in text:
        start=text.index(marker)
        brace=text.find('{', start)
        if brace < 0:
            raise SystemExit(f'opening brace missing for {name}')
        depth=0
        i=brace
        quote=None
        escape=False
        regex=False
        while i < len(text):
            ch=text[i]
            if quote:
                if escape:
                    escape=False
                elif ch == '\\':
                    escape=True
                elif ch == quote:
                    quote=None
                i+=1
                continue
            if regex:
                if escape:
                    escape=False
                elif ch == '\\':
                    escape=True
                elif ch == '/':
                    regex=False
                i+=1
                continue
            if ch in ('"', "'", '`'):
                quote=ch
            elif ch == '/' and i+1 < len(text) and text[i+1] not in ('/','*'):
                # The helper contains a regular expression but no division expression.
                regex=True
            elif ch == '{':
                depth+=1
            elif ch == '}':
                depth-=1
                if depth == 0:
                    end=i+1
                    while end < len(text) and text[end] in '\r\n':
                        end+=1
                    text=text[:start]+text[end:]
                    break
            i+=1
        else:
            raise SystemExit(f'closing brace missing for {name}')
    return text

s=remove_async_function(s,'resolveMuseAreaLocations')

marker='async function buildSearch(params, cacheKey) {'
helper=r'''async function resolveMuseAreaLocations(jobs, origin) {
  // Muse does not provide coordinates. Resolve each distinct provider location before
  // building the first response so valid Muse jobs are not discarded merely because
  // slower workplace/address enrichment has not finished yet.
  const groups = new Map();
  for (const job of jobs) {
    if (job?.source !== "The Muse" || validCoordinate(job.latitude, job.longitude)) continue;
    const location = String(job.location || "").trim();
    if (!location || /\b(remote|anywhere|multiple locations)\b/i.test(location)) continue;
    const key = location.toLowerCase();
    if (!groups.has(key)) groups.set(key, { location, jobs: [] });
    groups.get(key).jobs.push(job);
  }

  await runWithConcurrency(Array.from(groups.values()), 8, async (group) => {
    let area = null;
    try { area = await geoapifySearchOrigin(group.location, null, null); }
    catch (error) { console.error("Muse area geocode failed:", error.message); }
    if (!area || !validCoordinate(area.latitude, area.longitude)) return;
    for (const job of group.jobs) {
      job.latitude = area.latitude;
      job.longitude = area.longitude;
      job.location_precision = "area";
      job.location_approximate = true;
      job.location_confidence = "low";
      job.location_match_provider = "The Muse/Geoapify area";
    }
  });

  const requestedCity = String(origin?.label || "").split(",")[0].trim().toLowerCase();
  if (requestedCity && validCoordinate(origin?.latitude, origin?.longitude)) {
    for (const job of jobs) {
      if (job?.source !== "The Muse" || validCoordinate(job.latitude, job.longitude)) continue;
      if (String(job.location || "").toLowerCase().includes(requestedCity)) {
        job.latitude = origin.latitude;
        job.longitude = origin.longitude;
        job.location_precision = "area";
        job.location_approximate = true;
        job.location_confidence = "low";
        job.location_match_provider = "The Muse search area";
      }
    }
  }
}

'''
if marker not in s:
    raise SystemExit('buildSearch marker missing')
s=s.replace(marker,helper+marker,1)

# Route authoritative search coordinates only to The Muse. Adzuna and USAJOBS keep
# receiving the human-readable city/state string they expect. The Muse provider can
# reverse-geocode coordinates into its preferred city/state-code format, eliminating
# the Everett, Washington vs Everett, WA mismatch that produced different result sets.
old_sig='async function fetchSelectedProviders(source, where, radius, query) {'
new_sig='async function fetchSelectedProviders(source, where, radius, query, centerLat, centerLon) {'
if old_sig in s:
    s=s.replace(old_sig,new_sig,1)
elif new_sig not in s:
    raise SystemExit('fetchSelectedProviders signature missing')

old_muse='''  if (source === "all" || source === "themuse") {
    labels.push("The Muse");
    tasks.push(fetchTheMuse(where, radius, query));
  }'''
new_muse='''  if (source === "all" || source === "themuse") {
    labels.push("The Muse");
    const museWhere = validCoordinate(centerLat, centerLon)
      ? `${centerLat},${centerLon}` : where;
    tasks.push(fetchTheMuse(museWhere, radius, query));
  }'''
if old_muse in s:
    s=s.replace(old_muse,new_muse,1)
elif new_muse not in s:
    raise SystemExit('Muse provider task block missing')

old_call='const providerResults = await fetchSelectedProviders(source, where, radius, query);'
new_call='const providerResults = await fetchSelectedProviders(source, where, radius, query, origin.latitude, origin.longitude);'
if old_call in s:
    s=s.replace(old_call,new_call,1)
elif new_call not in s:
    raise SystemExit('buildSearch provider call missing')

if s.count('async function resolveMuseAreaLocations(') != 1:
    raise SystemExit('resolveMuseAreaLocations must exist exactly once after patch')
if new_sig not in s or new_muse not in s or new_call not in s:
    raise SystemExit('Muse coordinate-aware routing patch is incomplete')

p.write_text(s)
print('Applied coordinate-aware Muse provider routing and removed duplicate Muse helper')
