# JobBubble in-app bug reporting

The Android app submits bug reports to `POST /report-bug` on the JobBubble backend. The backend creates the GitHub Issue so no GitHub credential is stored in the APK.

## Production configuration

Set these Render environment variables:

- `GITHUB_ISSUES_REPO=jobbubbleapp/JobBubbleApp`
- `GITHUB_ISSUES_TOKEN=<fine-grained GitHub token>`

The token should be limited to the JobBubbleApp repository and only needs **Issues: Read and write** permission.

Never commit the real token or place it in Android resources/source code.

## Request fields

- `description` — required, 5–5000 characters
- `app_version`
- `android_version`
- `device_model`
- `screen`

The endpoint rate-limits repeated submissions and rejects oversized/invalid requests.
