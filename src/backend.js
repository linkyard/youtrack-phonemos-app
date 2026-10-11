/**
 * Global-scope OAuth endpoints only.
 * Issue-scoped suggestions live in suggestions.js (YouTrack forbids mixing scopes in one handler).
 */
const http = require('@jetbrains/youtrack-scripting-api/http');
const phonemosSession = require('./phonemos-session');

const OAUTH_POPUP_MESSAGE_TYPE = 'phonemos:oauth';
const OAUTH_PENDING_TTL_MS = 5 * 60 * 1000;

function trimTrailingSlash(url) {
  return String(url || '').replace(/\/+$/, '');
}

function readPendingMap(ctx) {
  const raw = ctx.globalStorage.extensionProperties.oauthPending;
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    return {};
  }
}

function writePendingMap(ctx, map) {
  ctx.globalStorage.extensionProperties.oauthPending = JSON.stringify(map);
}

function prunePendingMap(map, now) {
  Object.keys(map).forEach(function (key) {
    const entry = map[key];
    if (!entry || !entry.ts || now - Number(entry.ts) > OAUTH_PENDING_TTL_MS) {
      delete map[key];
    }
  });
  return map;
}

function storePendingResult(ctx, state, code, error) {
  const userId = currentUserId(ctx);
  if (!state || !userId || !(code || error)) {
    return false;
  }
  const now = Date.now();
  const map = prunePendingMap(readPendingMap(ctx), now);
  map[String(state)] = {
    code: code || null,
    error: error || null,
    userId: userId,
    ts: now,
  };
  writePendingMap(ctx, map);
  return true;
}

function clearPendingResult(ctx, state) {
  if (!state) {
    return;
  }
  const map = prunePendingMap(readPendingMap(ctx), Date.now());
  delete map[String(state)];
  writePendingMap(ctx, map);
}

function currentUserId(ctx) {
  return phonemosSession.currentUserId(ctx);
}

function readLoginMap(ctx) {
  const raw = ctx.globalStorage.extensionProperties.oauthLogins;
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    return {};
  }
}

function writeLoginMap(ctx, map) {
  ctx.globalStorage.extensionProperties.oauthLogins = JSON.stringify(map);
}

function storeLogin(ctx, state, codeVerifier, redirectUri) {
  const userId = currentUserId(ctx);
  if (!state || !userId || !codeVerifier || !redirectUri) {
    return false;
  }
  const now = Date.now();
  const map = prunePendingMap(readLoginMap(ctx), now);
  map[String(state)] = {
    userId: userId,
    codeVerifier: String(codeVerifier),
    redirectUri: String(redirectUri),
    ts: now,
  };
  writeLoginMap(ctx, map);
  return true;
}

function readLogin(ctx, state) {
  const userId = currentUserId(ctx);
  if (!state || !userId) {
    return null;
  }
  const entry = readLoginMap(ctx)[String(state)];
  if (!entry || String(entry.userId) !== userId) {
    return null;
  }
  if (!entry.ts || Date.now() - Number(entry.ts) > OAUTH_PENDING_TTL_MS) {
    return null;
  }
  return entry;
}

function clearLogin(ctx, state) {
  if (!state) {
    return;
  }
  const map = prunePendingMap(readLoginMap(ctx), Date.now());
  delete map[String(state)];
  writeLoginMap(ctx, map);
}

function readUserTokens(ctx) {
  return phonemosSession.readUserTokens(ctx);
}

function writeUserTokens(ctx, tokens) {
  return phonemosSession.writeUserTokens(ctx, tokens);
}

function clearUserTokens(ctx) {
  return phonemosSession.clearUserTokens(ctx);
}

function tokensFromMappedResponse(mapped) {
  if (!mapped || !mapped.success || !mapped.accessToken) {
    return null;
  }
  return {
    accessToken: mapped.accessToken,
    refreshToken: mapped.refreshToken || null,
    expiresAt: mapped.expiresAt != null ? mapped.expiresAt : null,
  };
}

/** Strip refresh tokens before sending token responses to the browser. */
function publicTokenResponse(mapped) {
  if (!mapped || typeof mapped !== 'object') {
    return mapped;
  }
  return {
    success: mapped.success,
    message: mapped.message,
    accessToken: mapped.accessToken,
    expiresIn: mapped.expiresIn,
    expiresAt: mapped.expiresAt,
    tokenType: mapped.tokenType,
    canRefresh: mapped.success ? true : undefined,
  };
}

function trimSetting(value) {
  return value == null ? value : String(value).trim();
}

function requireSettings(ctx) {
  const s = ctx.settings || {};
  return {
    phonemosBaseUrl: trimTrailingSlash(s.phonemosBaseUrl),
    oauthClientId: trimSetting(s.oauthClientId),
    oauthClientSecret: trimSetting(s.oauthClientSecret),
    oauthAuthorizationUrl: trimSetting(s.oauthAuthorizationUrl),
    oauthTokenUrl: trimSetting(s.oauthTokenUrl),
    oauthRedirectUri: trimSetting(s.oauthRedirectUri),
    // Phonemos validates Hasura claims in the access token; the Keycloak client
    // must assign the "hasura" client scope (Default) or tokens are rejected.
    oauthScope: trimSetting(s.oauthScope) || 'openid profile email offline_access hasura',
    withinObjectId: trimSetting(s.withinObjectId),
    searchLimit: s.searchLimit,
  };
}

function missingSettings(settings, keys) {
  return keys.filter(function (key) {
    return settings[key] == null || String(settings[key]).trim() === '';
  });
}

function parseJsonSafe(response) {
  try {
    return response.json();
  } catch (e) {
    return null;
  }
}

function maskSecret(value) {
  const s = value == null ? '' : String(value);
  if (!s) {
    return '(empty)';
  }
  if (/^\*+$/.test(s)) {
    return '(LOOKS LIKE UI MASK "' + s + '" — re-paste the real Keycloak secret; len=' + s.length + ')';
  }
  if (s.length <= 6) {
    return '(len=' + s.length + ', suspiciously short for a Keycloak secret)';
  }
  return s.substring(0, 2) + '…' + s.substring(s.length - 2) + ' (len=' + s.length + ')';
}

function isMaskedOrInvalidSecret(value) {
  const s = value == null ? '' : String(value).trim();
  return !s || s.length < 8 || /^\*+$/.test(s);
}

function describeHttpResponse(serviceResponse) {
  if (!serviceResponse) {
    return {status: 'null', bodyPreview: ''};
  }
  let raw = '';
  try {
    if (serviceResponse.body != null) {
      raw = String(serviceResponse.body);
    } else if (serviceResponse.response != null) {
      raw = String(serviceResponse.response);
    } else if (typeof serviceResponse.toString === 'function') {
      raw = String(serviceResponse.toString());
    }
  } catch (e) {
    raw = '';
  }
  const data = parseJsonSafe(serviceResponse);
  return {
    status: serviceResponse.code,
    isSuccess: !!serviceResponse.isSuccess,
    error: data && data.error ? String(data.error) : '',
    errorDescription: data && data.error_description ? String(data.error_description) : '',
    bodyPreview: raw ? raw.substring(0, 500) : data ? JSON.stringify(data).substring(0, 500) : '',
  };
}

function exchangeToken(settings, formFields) {
  const tokenUrl = settings.oauthTokenUrl;
  const slash = tokenUrl.indexOf('/', tokenUrl.indexOf('://') + 3);
  const origin = slash === -1 ? tokenUrl : tokenUrl.substring(0, slash);
  const path = slash === -1 ? '/' : tokenUrl.substring(slash);

  // Use client_secret_post only. Sending a bad Basic header alongside the body
  // makes Keycloak ignore the body credentials and return invalid_client.
  const fields = Object.assign({}, formFields, {
    client_id: settings.oauthClientId,
    client_secret: settings.oauthClientSecret,
  });

  const bodyParts = [];
  Object.keys(fields).forEach(function (key) {
    if (fields[key] != null) {
      bodyParts.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(fields[key])));
    }
  });

  const connection = new http.Connection(origin);
  connection.addHeader('Content-Type', 'application/x-www-form-urlencoded');
  connection.addHeader('Accept', 'application/json');
  return connection.postSync(path, null, bodyParts.join('&'));
}

function mapTokenResponse(serviceResponse, debug) {
  const httpInfo = describeHttpResponse(serviceResponse);
  if (!serviceResponse || !serviceResponse.isSuccess) {
    const detail = httpInfo.errorDescription || httpInfo.error || httpInfo.bodyPreview || '';
    return {
      success: false,
      message:
        'Token endpoint returned status ' +
        httpInfo.status +
        (detail ? ': ' + detail : '.') +
        '\nDebug: ' +
        JSON.stringify(
          Object.assign({}, debug || {}, {
            httpStatus: httpInfo.status,
            httpSuccess: httpInfo.isSuccess,
            keycloakError: httpInfo.error || null,
            keycloakErrorDescription: httpInfo.errorDescription || null,
            responseBodyPreview: httpInfo.bodyPreview || null,
          }),
        ),
    };
  }
  const data = parseJsonSafe(serviceResponse);
  if (!data || !data.access_token) {
    return {
      success: false,
      message:
        'Token endpoint did not return an access token.\nDebug: ' +
        JSON.stringify(
          Object.assign({}, debug || {}, {
            httpStatus: httpInfo.status,
            responseBodyPreview: httpInfo.bodyPreview || null,
          }),
        ),
    };
  }
  const expiresIn = data.expires_in != null ? Number(data.expires_in) : null;
  return {
    success: true,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || null,
    expiresIn: expiresIn,
    expiresAt: expiresIn
      ? Date.now() + expiresIn * 1000 - 30 * 1000
      : null,
    tokenType: data.token_type || 'Bearer',
  };
}

exports.httpHandler = {
  endpoints: [
    {
      scope: 'global',
      method: 'GET',
      path: 'oauth/config',
      handle: function handle(ctx) {
        const settings = requireSettings(ctx);
        const missing = missingSettings(settings, [
          'phonemosBaseUrl',
          'oauthClientId',
          'oauthAuthorizationUrl',
        ]);
        if (missing.length) {
          return ctx.response.json({
            success: false,
            message: 'Missing app settings: ' + missing.join(', '),
          });
        }
        return ctx.response.json({
          success: true,
          clientId: settings.oauthClientId,
          authorizationUrl: settings.oauthAuthorizationUrl,
          redirectUri: settings.oauthRedirectUri || '',
          phonemosBaseUrl: settings.phonemosBaseUrl,
          popupMessageType: OAUTH_POPUP_MESSAGE_TYPE,
        });
      },
    },
    {
      scope: 'global',
      // POST required: storing the PKCE verifier writes app global storage.
      // YouTrack forbids database modifications from GET extension endpoints.
      method: 'POST',
      path: 'oauth/authorize-url',
      handle: function handle(ctx) {
        const settings = requireSettings(ctx);
        const missing = missingSettings(settings, [
          'oauthClientId',
          'oauthAuthorizationUrl',
        ]);
        if (missing.length) {
          return ctx.response.json({
            success: false,
            message: 'Missing app settings: ' + missing.join(', '),
          });
        }

        const body = ctx.request.json() || {};
        const state = body.state || ctx.request.getParameter('state');
        const codeChallenge = body.code_challenge || ctx.request.getParameter('code_challenge');
        const codeVerifier = body.code_verifier || ctx.request.getParameter('code_verifier');
        if (!state || !codeChallenge || !codeVerifier) {
          return ctx.response.json({
            success: false,
            message: 'state, code_challenge, and code_verifier are required.',
          });
        }

        const redirectUri =
          body.redirect_uri ||
          ctx.request.getParameter('redirect_uri') ||
          settings.oauthRedirectUri;
        if (!redirectUri) {
          return ctx.response.json({
            success: false,
            message: 'redirect_uri is required.',
          });
        }
        if (!storeLogin(ctx, state, codeVerifier, redirectUri)) {
          const user = ctx.currentUser;
          return ctx.response.json({
            success: false,
            message:
              'Unable to start OAuth login — no YouTrack user key on this request ' +
              '(currentUser=' +
              (user ? 'yes' : 'no') +
              ', login=' +
              (user && user.login ? String(user.login) : '') +
              ', id=' +
              (user && user.id != null ? String(user.id) : '') +
              ').',
          });
        }
        const params = [
          'response_type=code',
          'client_id=' + encodeURIComponent(settings.oauthClientId),
          'redirect_uri=' + encodeURIComponent(redirectUri),
          'scope=' + encodeURIComponent(settings.oauthScope),
          'state=' + encodeURIComponent(state),
          'code_challenge=' + encodeURIComponent(codeChallenge),
          'code_challenge_method=S256',
        ];
        return ctx.response.json({
          success: true,
          url: settings.oauthAuthorizationUrl +
            (settings.oauthAuthorizationUrl.indexOf('?') >= 0 ? '&' : '?') +
            params.join('&'),
          redirectUri: redirectUri,
          popupMessageType: OAUTH_POPUP_MESSAGE_TYPE,
        });
      },
    },
    {
      scope: 'global',
      method: 'POST',
      path: 'oauth/complete',
      handle: function handle(ctx) {
        const body = ctx.request.json() || {};
        const state = body.state;
        const code = body.code || null;
        const error = body.error || null;
        if (!state) {
          return ctx.response.json({success: false, message: 'state is required.'});
        }
        if (!code && !error) {
          return ctx.response.json({success: false, message: 'code or error is required.'});
        }

        // Always stash the raw result so a surviving parent widget can finish.
        storePendingResult(ctx, state, code, error);

        if (error) {
          clearLogin(ctx, state);
          return ctx.response.json({success: true, connected: false, finalized: false, error: String(error)});
        }

        // Prefer finishing the token exchange here so the issue widget can remount
        // safely and just read oauth/session.
        const login = readLogin(ctx, state);
        if (!login || !login.codeVerifier || !login.redirectUri) {
          return ctx.response.json({
            success: true,
            connected: false,
            finalized: false,
            message: 'Login verifier missing; parent widget must finish token exchange.',
          });
        }

        const settings = requireSettings(ctx);
        const missing = missingSettings(settings, [
          'oauthClientId',
          'oauthClientSecret',
          'oauthTokenUrl',
        ]);
        if (missing.length) {
          return ctx.response.json({
            success: false,
            connected: false,
            finalized: false,
            message: 'Missing app settings: ' + missing.join(', '),
          });
        }
        if (isMaskedOrInvalidSecret(settings.oauthClientSecret)) {
          return ctx.response.json({
            success: false,
            connected: false,
            finalized: false,
            message: 'OAuth client secret in YouTrack settings looks invalid.',
          });
        }

        const mapped = mapTokenResponse(
          exchangeToken(settings, {
            grant_type: 'authorization_code',
            code: String(code),
            redirect_uri: String(login.redirectUri),
            code_verifier: String(login.codeVerifier),
          }),
          {
            authMethod: 'client_secret_post',
            tokenUrl: settings.oauthTokenUrl,
            clientId: settings.oauthClientId,
            clientSecret: maskSecret(settings.oauthClientSecret),
            redirectUri: login.redirectUri,
            grantType: 'authorization_code',
            source: 'oauth/complete',
          },
        );
        const tokens = tokensFromMappedResponse(mapped);
        if (!tokens) {
          clearLogin(ctx, state);
          return ctx.response.json({
            success: false,
            connected: false,
            finalized: false,
            message: mapped.message || 'Token exchange failed.',
          });
        }
        writeUserTokens(ctx, tokens);
        clearLogin(ctx, state);
        clearPendingResult(ctx, state);
        return ctx.response.json({success: true, connected: true, finalized: true});
      },
    },
    {
      scope: 'global',
      method: 'GET',
      path: 'oauth/pending',
      handle: function handle(ctx) {
        const state = ctx.request.getParameter('state');
        if (!state) {
          return ctx.response.json({success: false, message: 'state is required.'});
        }
        const userId = currentUserId(ctx);
        if (!userId) {
          return ctx.response.json({success: false, message: 'Not authenticated.'});
        }

        // Read-only: GET handlers must not write global storage.
        const entry = readPendingMap(ctx)[String(state)];
        if (!entry) {
          return ctx.response.json({success: true, pending: false});
        }
        if (String(entry.userId) !== userId) {
          return ctx.response.json({success: true, pending: false});
        }
        if (!entry.ts || Date.now() - Number(entry.ts) > OAUTH_PENDING_TTL_MS) {
          return ctx.response.json({success: true, pending: false});
        }

        return ctx.response.json({
          success: true,
          pending: true,
          type: OAUTH_POPUP_MESSAGE_TYPE,
          code: entry.code || null,
          state: String(state),
          error: entry.error || null,
        });
      },
    },
    {
      scope: 'global',
      method: 'POST',
      path: 'oauth/token',
      handle: function handle(ctx) {
        const settings = requireSettings(ctx);
        const missing = missingSettings(settings, [
          'oauthClientId',
          'oauthClientSecret',
          'oauthTokenUrl',
        ]);
        if (missing.length) {
          return ctx.response.json({
            success: false,
            message: 'Missing app settings: ' + missing.join(', '),
          });
        }

        const body = ctx.request.json() || {};
        if (!body.code || !body.code_verifier) {
          return ctx.response.json({
            success: false,
            message: 'code and code_verifier are required.',
          });
        }
        const redirectUri = body.redirect_uri || settings.oauthRedirectUri;
        if (!redirectUri) {
          return ctx.response.json({
            success: false,
            message: 'redirect_uri is required.',
          });
        }
        if (isMaskedOrInvalidSecret(settings.oauthClientSecret)) {
          return ctx.response.json({
            success: false,
            message:
              'OAuth client secret in YouTrack settings looks invalid (' +
              maskSecret(settings.oauthClientSecret) +
              '). YouTrack secret fields often save the ***** UI mask. ' +
              'Re-upload the app if needed, then paste the full Keycloak client secret into the plain-text OAuth client secret field and save.',
          });
        }

        const code = String(body.code);
        const codeVerifier = String(body.code_verifier);
        const debug = {
          authMethod: 'client_secret_post',
          tokenUrl: settings.oauthTokenUrl,
          clientId: settings.oauthClientId,
          clientSecret: maskSecret(settings.oauthClientSecret),
          redirectUri: redirectUri,
          codeLen: code.length,
          codePrefix: code.substring(0, 8),
          codeVerifierLen: codeVerifier.length,
          grantType: 'authorization_code',
        };
        const serviceResponse = exchangeToken(settings, {
          grant_type: 'authorization_code',
          code: code,
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
        });
        const mapped = mapTokenResponse(serviceResponse, debug);
        const tokens = tokensFromMappedResponse(mapped);
        if (tokens) {
          writeUserTokens(ctx, tokens);
        }
        // Do not return refresh tokens to the widget.
        return ctx.response.json(publicTokenResponse(mapped));
      },
    },
    {
      scope: 'global',
      method: 'POST',
      path: 'oauth/refresh',
      handle: function handle(ctx) {
        const settings = requireSettings(ctx);
        const missing = missingSettings(settings, [
          'oauthClientId',
          'oauthClientSecret',
          'oauthTokenUrl',
        ]);
        if (missing.length) {
          return ctx.response.json({
            success: false,
            message: 'Missing app settings: ' + missing.join(', '),
          });
        }

        // Prefer the server-stored refresh token. Ignore any client-supplied value so
        // the browser never needs (or can forge) a refresh token.
        const stored = readUserTokens(ctx);
        const refreshToken = stored && stored.refreshToken ? stored.refreshToken : null;
        if (!refreshToken) {
          return ctx.response.json({
            success: false,
            message: 'No stored refresh token for this user. Connect to Phonemos again.',
          });
        }

        const debug = {
          authMethod: 'client_secret_post',
          tokenUrl: settings.oauthTokenUrl,
          clientId: settings.oauthClientId,
          clientSecret: maskSecret(settings.oauthClientSecret),
          grantType: 'refresh_token',
        };
        const serviceResponse = exchangeToken(settings, {
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        });
        const mapped = mapTokenResponse(serviceResponse, debug);
        const tokens = tokensFromMappedResponse(mapped);
        if (tokens) {
          // Keycloak may omit refresh_token on refresh; keep the previous one.
          if (!tokens.refreshToken) {
            tokens.refreshToken = refreshToken;
          }
          writeUserTokens(ctx, tokens);
        } else {
          clearUserTokens(ctx);
        }
        return ctx.response.json(publicTokenResponse(mapped));
      },
    },
    {
      scope: 'global',
      method: 'GET',
      path: 'oauth/session',
      handle: function handle(ctx) {
        const tokens = readUserTokens(ctx);
        if (!tokens) {
          return ctx.response.json({success: true, connected: false});
        }
        // Never return refresh tokens to the browser — they stay server-side only.
        return ctx.response.json({
          success: true,
          connected: true,
          accessToken: tokens.accessToken,
          expiresAt: tokens.expiresAt,
          // Hint that a server-side refresh is available without exposing the token.
          canRefresh: !!tokens.refreshToken,
        });
      },
    },
    {
      scope: 'global',
      method: 'POST',
      path: 'oauth/logout',
      handle: function handle(ctx) {
        clearUserTokens(ctx);
        return ctx.response.json({success: true, connected: false});
      },
    },
  ],
};
