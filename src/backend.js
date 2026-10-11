/**
 * Global-scope OAuth endpoints only.
 * Issue-scoped suggestions live in suggestions.js (YouTrack forbids mixing scopes in one handler).
 */
const http = require('@jetbrains/youtrack-scripting-api/http');
const phonemosSession = require('./phonemos-session');
const urlSafety = require('./url-safety');

const OAUTH_POPUP_MESSAGE_TYPE = 'phonemos:oauth';

function trimTrailingSlash(url) {
  return String(url || '').replace(/\/+$/, '');
}

function storePendingResult(ctx, state, code, error) {
  return phonemosSession.storePendingResult(ctx, state, code, error);
}

function clearPendingResult(ctx, state) {
  return phonemosSession.clearPendingResult(ctx, state);
}

function storeLogin(ctx, state, codeVerifier, redirectUri) {
  return phonemosSession.storeLogin(ctx, state, codeVerifier, redirectUri);
}

function readLogin(ctx, state) {
  return phonemosSession.readLogin(ctx, state);
}

function clearLogin(ctx, state) {
  return phonemosSession.clearLogin(ctx, state);
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

function rejectIfUnauthorized(ctx) {
  return phonemosSession.requireInteractiveUser(ctx);
}

function rejectIfRateLimited(ctx) {
  const rate = phonemosSession.consumeOAuthRateLimit(ctx);
  return rate.ok ? null : rate.message;
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

/** Session/token API responses never include access or refresh tokens. */
function publicSessionResponse(tokens) {
  if (!tokens) {
    return {success: true, connected: false};
  }
  return {
    success: true,
    connected: true,
    expiresAt: tokens.expiresAt != null ? tokens.expiresAt : null,
    canRefresh: !!tokens.refreshToken,
  };
}

function publicTokenResponse(mapped) {
  if (!mapped || typeof mapped !== 'object') {
    return mapped;
  }
  return {
    success: mapped.success,
    message: mapped.message,
    connected: !!mapped.success,
    expiresAt: mapped.expiresAt != null ? mapped.expiresAt : null,
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
    // Pass the secret setting through untouched — YouTrack injects it only in
    // http.Connection basicAuth/addHeader; stringifying/trimming breaks that.
    oauthClientSecret: s.oauthClientSecret,
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
    if (key === 'oauthClientSecret') {
      return settings[key] == null || settings[key] === '';
    }
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

function describeHttpResponse(serviceResponse) {
  if (!serviceResponse) {
    return {status: 'null', error: '', errorDescription: ''};
  }
  const data = parseJsonSafe(serviceResponse);
  return {
    status: serviceResponse.code,
    isSuccess: !!serviceResponse.isSuccess,
    error: data && data.error ? String(data.error) : '',
    errorDescription: data && data.error_description ? String(data.error_description) : '',
  };
}

function exchangeToken(settings, formFields) {
  const unsafe = urlSafety.validateOutboundSettings(settings, ['oauthTokenUrl']);
  if (unsafe) {
    return {isSuccess: false, code: 0, body: unsafe};
  }
  const tokenUrl = settings.oauthTokenUrl;
  const slash = tokenUrl.indexOf('/', tokenUrl.indexOf('://') + 3);
  const origin = slash === -1 ? tokenUrl : tokenUrl.substring(0, slash);
  const path = slash === -1 ? '/' : tokenUrl.substring(slash);

  // client_secret_basic: send the YouTrack secret setting via basicAuth so it is
  // never readable as a plain string in scripts or responses. Do not also put
  // client_secret in the body (Keycloak then ignores Basic and fails).
  const fields = Object.assign({}, formFields, {
    client_id: settings.oauthClientId,
  });

  const bodyParts = [];
  Object.keys(fields).forEach(function (key) {
    if (fields[key] != null) {
      bodyParts.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(fields[key])));
    }
  });

  const connection = new http.Connection(origin);
  connection.basicAuth(settings.oauthClientId, settings.oauthClientSecret);
  connection.addHeader('Content-Type', 'application/x-www-form-urlencoded');
  connection.addHeader('Accept', 'application/json');
  return connection.postSync(path, null, bodyParts.join('&'));
}

function mapTokenResponse(serviceResponse) {
  const httpInfo = describeHttpResponse(serviceResponse);
  if (!serviceResponse || !serviceResponse.isSuccess) {
    // Local validation failures use code 0 + plain-text body; IdP errors use JSON fields only.
    const localMessage =
      serviceResponse && serviceResponse.code === 0 && serviceResponse.body
        ? String(serviceResponse.body)
        : '';
    if (localMessage) {
      return {success: false, message: localMessage};
    }
    const detail = httpInfo.errorDescription || httpInfo.error || '';
    return {
      success: false,
      message:
        'Token endpoint returned status ' +
        httpInfo.status +
        (detail ? ': ' + detail : '.'),
    };
  }
  const data = parseJsonSafe(serviceResponse);
  if (!data || !data.access_token) {
    return {
      success: false,
      message: 'Token endpoint did not return an access token.',
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
        const authError = rejectIfUnauthorized(ctx);
        if (authError) {
          return ctx.response.json({success: false, message: authError});
        }
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
        const unsafe = urlSafety.validateOutboundSettings(settings, [
          'phonemosBaseUrl',
          'oauthAuthorizationUrl',
          'oauthTokenUrl',
        ]);
        if (unsafe) {
          return ctx.response.json({success: false, message: unsafe});
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
      // POST required: storing the PKCE verifier writes user extension properties.
      // YouTrack forbids database modifications from GET extension endpoints.
      method: 'POST',
      path: 'oauth/authorize-url',
      handle: function handle(ctx) {
        const authError = rejectIfUnauthorized(ctx);
        if (authError) {
          return ctx.response.json({success: false, message: authError});
        }
        const rateError = rejectIfRateLimited(ctx);
        if (rateError) {
          return ctx.response.json({success: false, message: rateError});
        }
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
        const unsafe = urlSafety.validateOutboundSettings(settings, [
          'oauthAuthorizationUrl',
          'oauthTokenUrl',
        ]);
        if (unsafe) {
          return ctx.response.json({success: false, message: unsafe});
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
          return ctx.response.json({
            success: false,
            message: 'Unable to start OAuth login for the current YouTrack user.',
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
        const authError = rejectIfUnauthorized(ctx);
        if (authError) {
          return ctx.response.json({success: false, message: authError});
        }
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

        // Stash before rate-limit / token work so the parent can still finish via
        // oauth/pending + oauth/token if this request cannot finalize.
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

        const rateError = rejectIfRateLimited(ctx);
        if (rateError) {
          return ctx.response.json({
            success: false,
            connected: false,
            finalized: false,
            message: rateError,
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
        const mapped = mapTokenResponse(
          exchangeToken(settings, {
            grant_type: 'authorization_code',
            code: String(code),
            redirect_uri: String(login.redirectUri),
            code_verifier: String(login.codeVerifier),
          }),
        );
        const tokens = tokensFromMappedResponse(mapped);
        if (!tokens) {
          // Keep pending + login so the parent can retry token exchange.
          return ctx.response.json({
            success: false,
            connected: false,
            finalized: false,
            message: mapped.message || 'Token exchange failed.',
          });
        }
        if (!writeUserTokens(ctx, tokens)) {
          return ctx.response.json({
            success: false,
            connected: false,
            finalized: false,
            message: 'Unable to store Phonemos session for this YouTrack user.',
          });
        }
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
        const authError = rejectIfUnauthorized(ctx);
        if (authError) {
          return ctx.response.json({success: false, message: authError});
        }
        const state = ctx.request.getParameter('state');
        if (!state) {
          return ctx.response.json({success: false, message: 'state is required.'});
        }

        // Read-only: GET handlers must not write storage.
        const entry = phonemosSession.readPendingResult(ctx, state);
        if (!entry) {
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
        const authError = rejectIfUnauthorized(ctx);
        if (authError) {
          return ctx.response.json({success: false, message: authError});
        }
        const rateError = rejectIfRateLimited(ctx);
        if (rateError) {
          return ctx.response.json({success: false, message: rateError});
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
        const code = String(body.code);
        const codeVerifier = String(body.code_verifier);
        const serviceResponse = exchangeToken(settings, {
          grant_type: 'authorization_code',
          code: code,
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
        });
        const mapped = mapTokenResponse(serviceResponse);
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
        const authError = rejectIfUnauthorized(ctx);
        if (authError) {
          return ctx.response.json({success: false, message: authError});
        }
        const rateError = rejectIfRateLimited(ctx);
        if (rateError) {
          return ctx.response.json({success: false, message: rateError});
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

        const serviceResponse = exchangeToken(settings, {
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        });
        const mapped = mapTokenResponse(serviceResponse);
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
        const authError = rejectIfUnauthorized(ctx);
        if (authError) {
          return ctx.response.json({success: false, message: authError});
        }
        // Never return access/refresh tokens to the browser.
        return ctx.response.json(publicSessionResponse(readUserTokens(ctx)));
      },
    },
    {
      scope: 'global',
      method: 'POST',
      path: 'oauth/logout',
      handle: function handle(ctx) {
        const authError = rejectIfUnauthorized(ctx);
        if (authError) {
          return ctx.response.json({success: false, message: authError});
        }
        clearUserTokens(ctx);
        clearLogin(ctx, null);
        clearPendingResult(ctx, null);
        return ctx.response.json({success: true, connected: false});
      },
    },
  ],
};
