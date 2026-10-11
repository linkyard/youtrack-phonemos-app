# Phonemos YouTrack app

Suggests Phonemos knowledge base articles on YouTrack Helpdesk tickets. Agents and reporters both see the widget; Phonemos permissions decide which pages each user can access.

## Features

- **Suggested knowledge base articles** widget under the ticket/issue summary (`ISSUE_BELOW_SUMMARY`)
- Hybrid Phonemos search over ticket summary, description, and the latest comment from the reporter
- Per-user OAuth2 against the Phonemos Keycloak IdP (no shared service-account token)

## Prerequisites

- Node.js 20+ (see `.nvmrc`)
- YouTrack with a Helpdesk project
- Phonemos instance with public REST API and hybrid/semantic search enabled
- Keycloak confidential OAuth client for this app

## Develop

```bash
npm install
npm run build
npm run pack
```

`npm run pack` writes `phonemos.zip`.

## Install in YouTrack

1. Administration → Apps → Add app → Upload ZIP (`phonemos.zip`)
2. Attach the app to your Helpdesk project(s)
3. Configure **global** app settings (OAuth + Phonemos base URL)
4. Configure **project** settings (`withinObjectId`, optional `searchLimit`)
5. Open a ticket — use **Connect to Phonemos** the first time

## App settings

| Setting | Scope | Description |
|---------|-------|-------------|
| Phonemos base URL | Global | e.g. `https://wiki.example.com` |
| OAuth client ID / secret | Global | Confidential Keycloak client |
| OAuth authorization / token URLs | Global | Keycloak OIDC endpoints |
| OAuth redirect URI | Global | URL of this app’s **Phonemos sign-in** page (see below) |
| Phonemos search root object ID | Project | Site or topic UUID passed as `within` to search |
| Max suggestions | Project | Default 5 |

### Keycloak client

1. Create a **confidential** client with Authorization Code + PKCE (S256).
2. **Valid redirect URIs** — YouTrack embeds widgets as `about:srcdoc`, so do **not** use `/app/phonemos/...`. Use the app’s packaged HTML via [appResources](https://youtrack.jetbrains.com/issue/JT-90146):

   `https://{youtrack}/api/appResources/{installationId}/widgets/oauth-popup-callback.html`

   The ticket widget shows the exact URL under **Connect to Phonemos**. Easiest Keycloak pattern while testing:

   `https://{youtrack}/api/appResources/*`

3. **Client scopes** — on the Keycloak client, assign at least:
   - `hasura` as **Default** (required — adds Hasura claims Phonemos needs in the access token)
   - `offline_access` as Default (refresh tokens)
   - usual OIDC defaults (`openid` / `profile` / `email`)
4. Put client id/secret and the auth/token URLs into the YouTrack app settings. **OAuth scopes** should include `hasura` (default: `openid profile email offline_access hasura`). **OAuth redirect URI** is an optional fallback; the widget prefers the derived `appResources` URL.

   Paste the **full** Keycloak client secret. If YouTrack ever shows only `*****` and token exchange fails with `unauthorized_client`, the mask was saved instead of the secret — clear the field, paste again, save once, and avoid re-saving settings without re-pasting the secret.

The callback HTML returns the authorization code to the ticket widget via `postMessage` / `window.name`.

### Search

The issue-scoped handler builds:

```text
<summary>

<description>

<latest reporter comment>
```

Then calls:

`POST {phonemosBaseUrl}/_api/rest/v1/objects-search` with `mode: "hybrid"` and `objectTypes: ["wikipage"]`.

If hybrid fails with a 4xx (for example embeddings unavailable), the handler retries with `mode: "fulltext"`.

## Auth flow

1. Widget opens a Keycloak authorize popup (PKCE).
2. Callback page `postMessage`s the authorization code to the opener.
3. YouTrack HTTP handler exchanges the code using the client secret and returns tokens to the widget (tokens stay in widget memory only).
4. Suggestions requests proxy through the handler with the user’s Bearer token so Phonemos enforces that user’s permissions.

Shared SSO (YouTrack and Phonemos on the same Keycloak) makes reconnects nearly silent; otherwise users sign in to Phonemos once per browser session.

## Optional CLI upload

```bash
npm run upload -- --host https://your-youtrack.example.com --token perm:your-token
```

## Docs

- [YouTrack app quick start](https://www.jetbrains.com/help/youtrack/devportal/apps-quick-start-guide.html)
- [Phonemos REST API](https://doc.phonemos.com/guide/ae2ce6cf-9566-45ea-8ec0-a6364055a064)
