from pathlib import Path

# Idempotent patch. This comment change intentionally re-runs the live verification
# workflow after the backend fix has finished deploying to Render.
p=Path('server.js')
s=p.read_text()
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
if helper not in s:
    if marker not in s: raise SystemExit('buildSearch marker missing')
    s=s.replace(marker,helper+marker,1)

needle='''  // Drop jobs that are already clearly outside the requested radius before paying
  // the cost of Geoapify refinement. Keep a small margin because refinement can move
  // an area-level pin closer to the actual workplace.
  const candidates = [];'''
replacement='''  // Muse jobs arrive without coordinates. Resolve their provider-supplied area labels
  // before the quick response is finalized; otherwise finalizeJobs drops them and the
  // app can misleadingly show only the one posting that happened to resolve quickly.
  if (normalized.some((job) => job?.source === "The Muse" && !validCoordinate(job.latitude, job.longitude))) {
    await resolveMuseAreaLocations(normalized, origin);
  }

  // Drop jobs that are already clearly outside the requested radius before paying
  // the cost of Geoapify refinement. Keep a small margin because refinement can move
  // an area-level pin closer to the actual workplace.
  const candidates = [];'''
if replacement not in s:
    if needle not in s: raise SystemExit('candidate marker missing')
    s=s.replace(needle,replacement,1)

p.write_text(s)
