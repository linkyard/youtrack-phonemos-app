/**
 * Global-scope OAuth endpoints only.
 * Issue-scoped ticket search lives in ticket-search.js (YouTrack forbids mixing scopes in one handler).
 */
const oauthSession = require('./oauth-session');
const oauthApi = require('./oauth-api');
const appSettings = require('./app-settings');
const urlSafety = require('./url-safety');

// Phonemos validates Hasura claims in the access token; the Keycloak client
// must assign the "hasura" client scope (Default) or tokens are rejected.
const OAUTH_SCOPE = 'openid profile email offline_access hasura';

/** Host header only. Do not trust X-Forwarded-Host. */
function requestHostHeader(ctx) {
  const headers = ctx.request && ctx.request.headers;
  if (!headers) {
    return '';
  }
  if (Array.isArray(headers)) {
    for (let i = 0; i < headers.length; i++) {
      const item = headers[i];
      if (!item || item.name == null) {
        continue;
      }
      if (String(item.name).toLowerCase() === 'host') {
        return item.value != null ? String(item.value) : '';
      }
    }
    return '';
  }
  try {
    if (typeof headers.get === 'function') {
      const fromGet = headers.get('Host') || headers.get('host');
      if (fromGet) {
        return String(fromGet);
      }
    }
  } catch (e) {
    // ignore
  }
  if (headers.Host != null) {
    return String(headers.Host);
  }
  if (headers.host != null) {
    return String(headers.host);
  }
  return '';
}

/**
 * Redirect must be the popup callback on this request's host — always the one
 * the widget generated, never an admin-specified override.
 * Returns an error message, or null when the URI is allowed.
 */
function rejectRedirectUri(ctx, redirectUri) {
  if (!urlSafety.isAllowedOAuthRedirectUri(redirectUri, requestHostHeader(ctx))) {
    return (
      'redirect_uri must be the appResources popup callback on this YouTrack host ' +
      '(…/api/appResources/{id}/widgets/oauth-popup-callback.html).'
    );
  }
  return null;
}

function gateOAuth(ctx, requiredKeys, rateLimit) {
  const authError = oauthSession.requireInteractiveUser(ctx);
  if (authError) {
    return {ok: false, body: {success: false, message: authError}};
  }
  const settingsCheck = appSettings.verifySettings(ctx, requiredKeys, ['keycloakBaseUrl']);
  if (!settingsCheck.ok) {
    return {ok: false, body: {success: false, message: settingsCheck.message}};
  }
  if (rateLimit) {
    const rate = oauthSession.consumeOAuthRateLimit(ctx);
    if (!rate.ok) {
      return {ok: false, body: {success: false, message: rate.message}};
    }
  }
  return {ok: true, settings: settingsCheck.settings};
}

exports.httpHandler = {
  endpoints: [
    {
      scope: 'global',
      // POST required: storing the PKCE verifier writes user extension properties.
      // YouTrack forbids database modifications from GET extension endpoints.
      method: 'POST',
      path: 'oauth/authorize-url',
      handle: function handle(ctx) {
        const gate = gateOAuth(ctx, ['oauthClientId', 'keycloakBaseUrl'], true);
        if (!gate.ok) {
          return ctx.response.json(gate.body);
        }
        const settings = gate.settings;

        const body = ctx.request.json() || {};
        const state = body.state;
        const codeChallenge = body.code_challenge;
        const codeVerifier = body.code_verifier;
        if (!state || !codeChallenge || !codeVerifier) {
          return ctx.response.json({
            success: false,
            message: 'state, code_challenge, and code_verifier are required.',
          });
        }

        const redirectUri = body.redirect_uri;
        if (!redirectUri) {
          return ctx.response.json({
            success: false,
            message: 'redirect_uri is required.',
          });
        }
        const redirectError = rejectRedirectUri(ctx, redirectUri);
        if (redirectError) {
          return ctx.response.json({success: false, message: redirectError});
        }
        if (!oauthSession.storeLogin(ctx, state, codeVerifier, redirectUri)) {
          return ctx.response.json({
            success: false,
            message: 'Unable to start OAuth login for the current YouTrack user.',
          });
        }
        const params = [
          'response_type=code',
          'client_id=' + encodeURIComponent(settings.oauthClientId),
          'redirect_uri=' + encodeURIComponent(redirectUri),
          'scope=' + encodeURIComponent(OAUTH_SCOPE),
          'state=' + encodeURIComponent(state),
          'code_challenge=' + encodeURIComponent(codeChallenge),
          'code_challenge_method=S256',
        ];
        return ctx.response.json({
          success: true,
          url: settings.oauthAuthorizationUrl +
            (settings.oauthAuthorizationUrl.indexOf('?') >= 0 ? '&' : '?') +
            params.join('&'),
        });
      },
    },
    {
      scope: 'global',
      method: 'POST',
      path: 'oauth/new-session',
      handle: function handle(ctx) {
        const gate = gateOAuth(ctx, ['oauthClientId', 'oauthClientSecret', 'keycloakBaseUrl'], true);
        if (!gate.ok) {
          return ctx.response.json(gate.body);
        }
        const settings = gate.settings;

        const body = ctx.request.json() || {};
        const state = body.state;
        const code = body.code ? String(body.code) : '';
        if (!state || !code) {
          return ctx.response.json({
            success: false,
            message: 'state and code are required.',
          });
        }

        // Bind exchange to the server-stored PKCE login — never trust client verifier/redirect.
        const login = oauthSession.readLogin(ctx, state);
        if (!login || !login.codeVerifier || !login.redirectUri) {
          return ctx.response.json({
            success: false,
            message: 'Login verifier missing. Start Connect again.',
          });
        }
        const redirectError = rejectRedirectUri(ctx, login.redirectUri);
        if (redirectError) {
          oauthSession.clearLogin(ctx, state);
          return ctx.response.json({
            success: false,
            message: redirectError,
          });
        }

        const serviceResponse = oauthApi.exchangeToken(settings, {
          grant_type: 'authorization_code',
          code: code,
          redirect_uri: String(login.redirectUri),
          code_verifier: String(login.codeVerifier),
        });
        const mapped = oauthApi.mapTokenResponse(serviceResponse);
        const tokens = oauthApi.tokensFromMappedResponse(mapped);
        if (tokens) {
          const identity = oauthSession.verifyIdentity(ctx, settings, tokens.accessToken);
          if (!identity.ok) {
            // The code was redeemed, but for a different OAuth identity than this
            // YouTrack user — do not persist it. Revoke so the leaked code is dead either way.
            oauthApi.revokeRefreshToken(settings, tokens.refreshToken);
            oauthSession.clearLogin(ctx, state);
            return ctx.response.json({success: false, message: identity.message});
          }
          if (!oauthSession.writeUserTokens(ctx, tokens)) {
            return ctx.response.json({
              success: false,
              message: 'Unable to store Phonemos session for this YouTrack user.',
            });
          }
          oauthSession.clearLogin(ctx, state);
        }
        return ctx.response.json(oauthApi.publicTokenResponse(mapped));
      },
    },
    {
      scope: 'global',
      method: 'POST',
      path: 'oauth/ensure-session',
      handle: function handle(ctx) {
        // Not rate-limited: the menu page uses this as a connection-status check.
        const gate = gateOAuth(ctx, ['oauthClientId', 'oauthClientSecret', 'keycloakBaseUrl'], false);
        if (!gate.ok) {
          return ctx.response.json(gate.body);
        }
        const accessTokenCheck = oauthSession.ensureAccessToken(ctx, gate.settings);
        if (!accessTokenCheck.ok) {
          return ctx.response.json({success: false, message: accessTokenCheck.message});
        }
        return ctx.response.json(oauthApi.publicSessionResponse(oauthSession.readUserTokens(ctx)));
      },
    },
    {
      scope: 'global',
      method: 'POST',
      path: 'oauth/logout',
      handle: function handle(ctx) {
        const authError = oauthSession.requireInteractiveUser(ctx);
        if (authError) {
          return ctx.response.json({success: false, message: authError});
        }
        oauthSession.disconnectUser(ctx, appSettings.loadSettings(ctx));
        oauthSession.clearLogin(ctx, null);
        return ctx.response.json({success: true, connected: false});
      },
    },
  ],
};
