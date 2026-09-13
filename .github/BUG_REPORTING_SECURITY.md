# Bug-report security boundary

The Android app sends reports only to the JobBubble backend. GitHub authorization remains server-side in `GITHUB_ISSUES_TOKEN`.

The APK must never contain the GitHub token. The backend validates request size/content, rate-limits submissions, and creates GitHub Issues in the configured repository.
