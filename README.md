# Phonemos YouTrack app

Suggests Phonemos knowledge base articles on YouTrack Helpdesk tickets, and lets users search the Phonemos site from the main menu. Agents and reporters both see the ticket widget; Phonemos permissions decide which pages each user can access.

## Features

- **Suggested knowledge base articles** widget under the ticket description (`ISSUE_ABOVE_ACTIVITY_STREAM`)
- Hybrid Phonemos search over ticket summary, description, and the latest comment from the reporter
- **Phonemos search** main-menu page: connection status and search across the whole site the signed-in user can access
- Per-user OAuth2 against the Phonemos Keycloak IdP (no shared service-account token)
- **Disconnect** on the ticket widget and the menu page (revokes the Keycloak refresh token when it can)

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
5. Open the **Phonemos search** menu item, or a ticket, and use **Connect** the first time

## App settings

| Setting | Scope | Description |
|---------|-------|-------------|
| Phonemos base URL | Global | e.g. `https://wiki.example.com` |
| OAuth client ID / secret | Global | Confidential Keycloak client |
| OAuth authorization / token URLs | Global | Keycloak OIDC endpoints |
| OAuth redirect URI | Global | Optional. Empty accepts the derived popup callback on this YouTrack host. If set, it must be that exact URL |
| Phonemos search root | Project | UUID, 22-character slug, or topic URL. Used as `within` for ticket suggestions. The menu search ignores this and uses the whole site. |
| Max suggestions | Project | Ticket widget only. Default 5, maximum 20. Menu search returns up to 10. |

### Keycloak client

1. Create a **confidential** client with Authorization Code + PKCE (S256).
2. **Valid redirect URIs** — YouTrack embeds widgets as `about:srcdoc`, so do **not** use `/app/phonemos/...`. Use the app’s packaged HTML via [appResources](https://youtrack.jetbrains.com/issue/JT-90146):

   `https://{youtrack}/api/appResources/{installationId}/widgets/oauth-popup-callback.html`

   The ticket widget shows the exact URL under **Connect to Phonemos**. A Keycloak test pattern is:

   `https://{youtrack}/api/appResources/*`

   The app itself only accepts a redirect on this YouTrack host (the request `Host` header). Leave **OAuth redirect URI** empty, or set it to the exact popup callback the widget shows. A different host, or a different value than that setting, is rejected.

3. **Client scopes** — on the Keycloak client, assign at least:
   - `hasura` as **Default** (required — adds Hasura claims Phonemos needs in the access token)
   - `offline_access` as Default (refresh tokens)
   - usual OIDC defaults (`openid` / `profile` / `email`)
4. Put client id/secret and the auth/token URLs into the YouTrack app settings. **OAuth scopes** should include `hasura` (default: `openid profile email offline_access hasura`). **OAuth redirect URI** is optional. The widget uses the derived `appResources` URL. If the setting is filled in, it must equal that URL.

   **OAuth client secret** is a YouTrack secret setting: paste the Keycloak secret once and save. After that the UI only shows a mask; the real value is injected only into outbound token requests via HTTP Basic (`client_secret_basic`). If token exchange fails after an app upgrade, clear the secret field, paste the full Keycloak secret again, and save.

Outbound URLs (`Phonemos base URL`, OAuth authorization/token URLs) must be `https` (or `http` on localhost). Other private and reserved IP addresses, and cloud metadata hostnames, are rejected. Authorization and token URLs must share the same host.

The callback finishes on the YouTrack backend and notifies the opener via `postMessage` (target `*`, because widgets run in `about:srcdoc`) with `event.source` + OAuth `state` checks on receive.

### Search

Both searches call `POST {phonemosBaseUrl}/_api/rest/v1/objects-search` and stop at the first strategy that returns hits, with at most five Phonemos calls:

1. Hybrid, `wikipage` only, once per query (in order)
2. Fulltext, `wikipage` only, on the first query
3. Hybrid with no type filter, on the first query

#### Ticket suggestions

The issue-scoped handler builds these queries from the ticket (markup stripped, each clipped to 3500 characters):

1. Ticket summary
2. Title search: `#` plus the summary
3. Summary, description, and the latest comment from the reporter, joined

`within` is the project search root. A slug or topic URL is converted to a UUID before the call. The result limit is the project **Max suggestions** setting.

If every attempt returns zero hits, the widget shows **No matching articles**.

#### Menu search

The **Phonemos search** main-menu page searches the whole site. It resolves the site with `GET {phonemosBaseUrl}/_api/rest/v1/sites/self` and uses that object id as `within`. It does not use the project search root. The typed query is limited to 500 characters, and the result limit is 10. The same fallback chain runs on that single query. An empty result is **No matching articles**.

## Auth flow

1. Widget opens a Keycloak authorize popup (PKCE).
2. Callback page finishes via authenticated `oauth/complete` and notifies the opener (`postMessage` with `*` so `about:srcdoc` widgets receive it; the opener accepts only its popup / YouTrack host origin and matching `state`).
3. YouTrack HTTP handler exchanges the code using the client secret and the **server-stored** PKCE verifier/`redirect_uri` (the `appResources` popup callback on this YouTrack host). Tokens are stored on the YouTrack User (`phonemosOAuthSession`). Access and refresh tokens never leave the YouTrack backend; the widget only sees `{connected: true}`.
4. Pending authorization codes are handed out once via `POST oauth/pending` (consumed). Disconnect, and a Phonemos 401, revoke the Keycloak refresh token when possible.
5. Ticket suggestions and menu search use the **server-stored** access token for the current YouTrack user (the widget never sends a Bearer token). Phonemos still enforces that user’s permissions. Refresh sends the stored refresh token to the Keycloak token endpoint. `invalid_grant` clears the local session; a timeout or token-endpoint 5xx leaves it in place.

OAuth endpoints reject guest users and rate-limit sign-in attempts per YouTrack user.

Shared SSO (YouTrack and Phonemos on the same Keycloak) makes reconnects nearly silent; otherwise users sign in to Phonemos once per browser session.

## Optional CLI upload

```bash
npm run upload -- --host https://your-youtrack.example.com --token perm:your-token
```

## Docs

- [YouTrack app quick start](https://www.jetbrains.com/help/youtrack/devportal/apps-quick-start-guide.html)
- [Phonemos REST API](https://doc.phonemos.com/guide/ae2ce6cf-9566-45ea-8ec0-a6364055a064)
