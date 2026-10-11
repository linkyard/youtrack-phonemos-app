/**
 * Global-scope OAuth endpoints only.
 * Issue-scoped suggestions live in suggestions.js (YouTrack forbids mixing scopes in one handler).
 */
const http = require('@jetbrains/youtrack-scripting-api/http');

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
  const userId = ctx.currentUser && ctx.currentUser.id ? String(ctx.currentUser.id) : null;
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
  return {
    success: true,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || null,
    expiresIn: data.expires_in || null,
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
      method: 'GET',
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

        const state = ctx.request.getParameter('state');
        const codeChallenge = ctx.request.getParameter('code_challenge');
        if (!state || !codeChallenge) {
          return ctx.response.json({
            success: false,
            message: 'state and code_challenge query parameters are required.',
          });
        }

        const redirectUri = ctx.request.getParameter('redirect_uri') || settings.oauthRedirectUri;
        if (!redirectUri) {
          return ctx.response.json({
            success: false,
            message: 'redirect_uri is required.',
          });
        }
        const params = [
          'response_type=code',
          'client_id=' + encodeURIComponent(settings.oauthClientId),
          'redirect_uri=' + encodeURIComponent(redirectUri),
          'scope=' + encodeURIComponent('openid'),
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
        const stored = storePendingResult(ctx, state, code, error);
        if (!stored) {
          return ctx.response.json({success: false, message: 'Unable to store OAuth result.'});
        }
        return ctx.response.json({success: true});
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
        const userId = ctx.currentUser && ctx.currentUser.id ? String(ctx.currentUser.id) : null;
        if (!userId) {
          return ctx.response.json({success: false, message: 'Not authenticated.'});
        }

        const now = Date.now();
        const map = prunePendingMap(readPendingMap(ctx), now);
        const entry = map[String(state)];
        if (!entry) {
          writePendingMap(ctx, map);
          return ctx.response.json({success: true, pending: false});
        }
        if (String(entry.userId) !== userId) {
          return ctx.response.json({success: true, pending: false});
        }

        delete map[String(state)];
        writePendingMap(ctx, map);
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
        return ctx.response.json(mapTokenResponse(serviceResponse, debug));
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

        const body = ctx.request.json() || {};
        if (!body.refreshToken) {
          return ctx.response.json({
            success: false,
            message: 'refreshToken is required.',
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
          refresh_token: body.refreshToken,
        });
        return ctx.response.json(mapTokenResponse(serviceResponse, debug));
      },
    },
  ],
};
