# Phonemos YouTrack app

Hello-world spike: a YouTrack app that shows **Hello from Phonemos** under the issue summary.

## Prerequisites

- Node.js 20+ (see `.nvmrc`)
- A YouTrack instance where you can install apps (Update Project permission)

## Develop

```bash
npm install
npm run build
npm run pack
```

`npm run pack` writes `phonemos.zip` from `dist/`.

## Install in YouTrack

1. Administration → Apps → Add app → Upload ZIP file
2. Select `phonemos.zip`
3. Attach the app to a project (Apps tab on the app, or the project’s Apps settings)
4. Open an issue in that project — the Hello widget appears below the summary

Optional CLI upload (needs a permanent token):

```bash
npm run upload -- --host https://your-youtrack.example.com --token perm:your-token
```

## Widget

| Field | Value |
|-------|--------|
| Key | `hello` |
| Extension point | `ISSUE_BELOW_SUMMARY` |
| Behavior | Registers with `YTApp.register()`, renders hello text plus issue id and current user when available |

No Phonemos API calls yet.

## Docs

- [YouTrack app quick start](https://www.jetbrains.com/help/youtrack/devportal/apps-quick-start-guide.html)
- [Host API](https://www.jetbrains.com/help/youtrack/devportal/apps-host-api.html)
