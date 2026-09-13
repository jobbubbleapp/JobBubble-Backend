from pathlib import Path

p = Path('server.js')
s = p.read_text()


def replace_once(old, new, label):
    global s
    if old not in s:
        raise SystemExit(f'Missing patch target: {label}')
    s = s.replace(old, new, 1)

replace_once(
    'const THE_MUSE_API_KEY = process.env.THE_MUSE_API_KEY;\n',
    'const THE_MUSE_API_KEY = process.env.THE_MUSE_API_KEY;\n'
    'const GITHUB_ISSUES_TOKEN = process.env.GITHUB_ISSUES_TOKEN;\n'
    'const GITHUB_ISSUES_REPO = process.env.GITHUB_ISSUES_REPO || "jobbubbleapp/JobBubbleApp";\n'
    'const BUG_REPORT_WINDOW_MS = 10 * 60 * 1000;\n'
    'const BUG_REPORT_MAX_PER_WINDOW = 5;\n',
    'bug report environment constants'
)

replace_once(
    'const workplaceReadInFlight = new Map();\n',
    'const workplaceReadInFlight = new Map();\nconst bugReportAttempts = new Map();\n',
    'bug report rate limit map'
)

replace_once(
    '  pruneTimedCache(workplaceCache, 2500, WORKPLACE_CACHE_TTL_MS);\n',
    '  pruneTimedCache(workplaceCache, 2500, WORKPLACE_CACHE_TTL_MS);\n'
    '  const now = Date.now();\n'
    '  for (const [key, entry] of bugReportAttempts) {\n'
    '    if (!entry || now - entry.windowStartedAt > BUG_REPORT_WINDOW_MS * 2) bugReportAttempts.delete(key);\n'
    '  }\n',
    'bug report rate limit cleanup'
)

send_json_marker = '''function validCoordinate(lat, lon) {'''
if send_json_marker not in s:
    raise SystemExit('Missing sendJson insertion marker')

bug_helpers = r'''
function readJsonBody(req, maxBytes = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      size += Buffer.byteLength(chunk, "utf8");
      if (size > maxBytes) {
        const error = new Error("Request body is too large");
        error.statusCode = 413;
        reject(error);
        req.destroy();
        return;
      }
      raw += chunk;
    });
    req.on("end", () => {
      if (!raw.trim()) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (_) {
        const error = new Error("Invalid JSON body");
        error.statusCode = 400;
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function cleanBugReportField(value, maxLength) {
  return String(value == null ? "" : value)
    .replace(/\u0000/g, "")
    .trim()
    .slice(0, maxLength);
}

function bugReportClientKey(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const address = forwarded || req.socket?.remoteAddress || "unknown";
  return crypto.createHash("sha256").update(address).digest("hex");
}

function takeBugReportRateLimit(req) {
  const key = bugReportClientKey(req);
  const now = Date.now();
  const entry = bugReportAttempts.get(key);
  if (!entry || now - entry.windowStartedAt >= BUG_REPORT_WINDOW_MS) {
    bugReportAttempts.set(key, { windowStartedAt: now, count: 1 });
    return true;
  }
  if (entry.count >= BUG_REPORT_MAX_PER_WINDOW) return false;
  entry.count += 1;
  return true;
}

function githubIssueRepoParts() {
  const match = String(GITHUB_ISSUES_REPO || "").trim().match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!match) throw new Error("GITHUB_ISSUES_REPO must be in owner/repository format");
  return { owner: match[1], repo: match[2] };
}

function bugIssueTitle(description) {
  const firstLine = String(description || "").split(/\r?\n/).map((x) => x.trim()).find(Boolean) || "User submitted bug";
  const compact = firstLine.replace(/\s+/g, " ").slice(0, 72);
  return `[Bug Report] ${compact}`;
}

async function createGithubBugIssue(report) {
  if (!GITHUB_ISSUES_TOKEN) {
    const error = new Error("GitHub issue reporting is not configured on the server");
    error.statusCode = 503;
    throw error;
  }

  const { owner, repo } = githubIssueRepoParts();
  const submittedAt = new Date().toISOString();
  const body = [
    "## User description",
    report.description,
    "",
    "## Device / app information",
    `- App version: ${report.appVersion || "Not provided"}`,
    `- Android version: ${report.androidVersion || "Not provided"}`,
    `- Device model: ${report.deviceModel || "Not provided"}`,
    `- App screen: ${report.screen || "Not provided"}`,
    `- Submitted: ${submittedAt}`,
    "",
    "_Submitted from the JobBubble in-app bug reporter._"
  ].join("\n");

  const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`, {
    method: "POST",
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${GITHUB_ISSUES_TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "JobBubble-Backend/9.4.47",
      "X-GitHub-Api-Version": "2022-11-28"
    },
    body: JSON.stringify({
      title: bugIssueTitle(report.description),
      body,
      labels: ["bug", "user-report"]
    }),
    signal: AbortSignal.timeout(10000)
  });

  const responseText = await response.text();
  let data = {};
  try { data = responseText ? JSON.parse(responseText) : {}; } catch (_) {}
  if (!response.ok) {
    throw new Error(`GitHub issue creation failed with HTTP ${response.status}: ${String(data?.message || responseText).slice(0, 220)}`);
  }
  return {
    number: Number(data.number),
    url: String(data.html_url || "")
  };
}

async function handleBugReport(req, res) {
  try {
    if (!takeBugReportRateLimit(req)) {
      return sendJson(res, 429, { error: "Too many bug reports. Please wait a few minutes and try again." });
    }

    const payload = await readJsonBody(req);
    const report = {
      description: cleanBugReportField(payload.description, 5000),
      appVersion: cleanBugReportField(payload.app_version || payload.appVersion, 80),
      androidVersion: cleanBugReportField(payload.android_version || payload.androidVersion, 120),
      deviceModel: cleanBugReportField(payload.device_model || payload.deviceModel, 160),
      screen: cleanBugReportField(payload.screen, 120)
    };

    if (report.description.length < 5) {
      return sendJson(res, 400, { error: "Please describe the bug before submitting." });
    }

    const issue = await createGithubBugIssue(report);
    return sendJson(res, 201, {
      ok: true,
      issue_number: issue.number,
      issue_url: issue.url
    });
  } catch (error) {
    const status = Number(error.statusCode) || 500;
    console.error("Bug report submission failed:", error.message);
    return sendJson(res, status, {
      error: status === 503
        ? "Bug reporting is temporarily unavailable."
        : status >= 500
          ? "Unable to submit the bug report right now."
          : error.message
    });
  }
}

'''
s = s.replace(send_json_marker, bug_helpers + send_json_marker, 1)

replace_once(
    '        "Access-Control-Allow-Methods": "GET,OPTIONS",',
    '        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",',
    'CORS POST support'
)

replace_once(
    '    if (req.method === "GET" && url.pathname === "/jobs") {\n      return handleJobs(req, res, url);\n    }\n',
    '    if (req.method === "GET" && url.pathname === "/jobs") {\n      return handleJobs(req, res, url);\n    }\n\n'
    '    if (req.method === "POST" && url.pathname === "/report-bug") {\n      return handleBugReport(req, res);\n    }\n',
    'bug report route'
)

replace_once(
    '        posting_page_cache_entries: postingPageCache.size,\n        searches_in_flight: inFlightSearches.size',
    '        posting_page_cache_entries: postingPageCache.size,\n'
    '        github_bug_reporting: GITHUB_ISSUES_TOKEN ? "enabled" : "needs_token",\n'
    '        github_issues_repo: GITHUB_ISSUES_REPO,\n'
    '        searches_in_flight: inFlightSearches.size',
    'bug report health status'
)

for old, new, label in [
    ('version: "9.4.46"', 'version: "9.4.47"', 'health version'),
    ('version: "9.4.46"', 'version: "9.4.47"', 'root version'),
    ('JobBubble backend V9.4.46 listening', 'JobBubble backend V9.4.47 listening', 'startup version')
]:
    replace_once(old, new, label)

replace_once(
    '  console.log("Posting address lookup: enabled");\n',
    '  console.log("Posting address lookup: enabled");\n'
    '  console.log("GitHub bug reporting:", GITHUB_ISSUES_TOKEN ? `enabled -> ${GITHUB_ISSUES_REPO}` : "needs GITHUB_ISSUES_TOKEN");\n',
    'startup bug reporting status'
)

p.write_text(s)
print('Patched JobBubble backend V9.4.47 bug reporting')
