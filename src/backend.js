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

function jsString(value) {
  return JSON.stringify(value == null ? null : String(value));
}

function oauthCallbackHtml(payload) {
  const message = payload.error
    ? 'Sign-in failed: ' + String(payload.error)
    : 'Signed in. You can close this window.';
  return (
    '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Phonemos</title>' +
    '<style>body{font-family:system-ui,sans-serif;padding:24px;color:#1b1b1b;background:#fff}' +
    '@media (prefers-color-scheme:dark){body{color:#f2f2f2;background:#1b1b1b}}</style></head><body>' +
    '<h1>Phonemos</h1><p id="msg">' +
    String(message)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;') +
    '</p><script>(function(){' +
    'var payload={type:' +
    jsString(OAUTH_POPUP_MESSAGE_TYPE) +
    ',code:' +
    jsString(payload.code) +
    ',state:' +
    jsString(payload.state) +
    ',error:' +
    jsString(payload.error) +
    ',ts:Date.now()};' +
    'try{if(window.opener){window.opener.postMessage(payload,"*");}}catch(e){}' +
    'try{localStorage.setItem("phonemos:oauth-result",JSON.stringify(payload));}catch(e){}' +
    'try{var c=new BroadcastChannel("phonemos-oauth");c.postMessage(payload);c.close();}catch(e){}' +
    'setTimeout(function(){try{window.close();}catch(e){}},500);' +
    '})();</script></body></html>'
  );
}

function requireSettings(ctx) {
  const s = ctx.settings || {};
  return {
    phonemosBaseUrl: trimTrailingSlash(s.phonemosBaseUrl),
    oauthClientId: s.oauthClientId,
    oauthClientSecret: s.oauthClientSecret,
    oauthAuthorizationUrl: s.oauthAuthorizationUrl,
    oauthTokenUrl: s.oauthTokenUrl,
    oauthRedirectUri: s.oauthRedirectUri,
    withinObjectId: s.withinObjectId,
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

function bytesToBase64(bytes) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += chars[a >> 2];
    out += chars[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < bytes.length ? chars[((b & 15) << 2) | (c >> 6)] : '=';
    out += i + 2 < bytes.length ? chars[c & 63] : '=';
  }
  return out;
}

function stringToUtf8Bytes(str) {
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    let code = str.charCodeAt(i);
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }
  return bytes;
}

function basicAuthHeader(clientId, clientSecret) {
  return 'Basic ' + bytesToBase64(stringToUtf8Bytes(clientId + ':' + clientSecret));
}

function exchangeToken(settings, formFields) {
  const tokenUrl = settings.oauthTokenUrl;
  const slash = tokenUrl.indexOf('/', tokenUrl.indexOf('://') + 3);
  const origin = slash === -1 ? tokenUrl : tokenUrl.substring(0, slash);
  const path = slash === -1 ? '/' : tokenUrl.substring(slash);

  const bodyParts = [];
  Object.keys(formFields).forEach(function (key) {
    if (formFields[key] != null) {
      bodyParts.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(formFields[key])));
    }
  });

  const connection = new http.Connection(origin);
  connection.addHeader('Content-Type', 'application/x-www-form-urlencoded');
  connection.addHeader('Authorization', basicAuthHeader(settings.oauthClientId, settings.oauthClientSecret));
  connection.addHeader('Accept', 'application/json');
  return connection.postSync(path, null, bodyParts.join('&'));
}

function mapTokenResponse(serviceResponse) {
  if (!serviceResponse || !serviceResponse.isSuccess) {
    return {
      success: false,
      message: 'Token endpoint returned status ' + (serviceResponse ? serviceResponse.code : 'unknown') + '.',
    };
  }
  const data = parseJsonSafe(serviceResponse);
  if (!data || !data.access_token) {
    return {success: false, message: 'Token endpoint did not return an access token.'};
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
          'oauthRedirectUri',
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
          redirectUri: settings.oauthRedirectUri,
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
          'oauthRedirectUri',
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
      method: 'GET',
      path: 'oauth/callback',
      handle: function handle(ctx) {
        const code = ctx.request.getParameter('code');
        const state = ctx.request.getParameter('state');
        const error =
          ctx.request.getParameter('error_description') || ctx.request.getParameter('error');
        const userId = ctx.currentUser && ctx.currentUser.id ? String(ctx.currentUser.id) : null;
        const now = Date.now();

        if (state && userId && (code || error)) {
          const map = prunePendingMap(readPendingMap(ctx), now);
          map[String(state)] = {
            code: code || null,
            error: error || null,
            userId: userId,
            ts: now,
          };
          writePendingMap(ctx, map);
        }

        const html = oauthCallbackHtml({
          code: code || null,
          state: state || null,
          error: error || (!code ? 'Missing authorization code.' : null),
        });
        ctx.response.addHeader('Content-Type', 'text/html; charset=utf-8');
        ctx.response.body = html;
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
          'oauthRedirectUri',
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

        const serviceResponse = exchangeToken(settings, {
          grant_type: 'authorization_code',
          code: body.code,
          redirect_uri: body.redirect_uri || settings.oauthRedirectUri,
          code_verifier: body.code_verifier,
        });
        return ctx.response.json(mapTokenResponse(serviceResponse));
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

        const serviceResponse = exchangeToken(settings, {
          grant_type: 'refresh_token',
          refresh_token: body.refreshToken,
        });
        return ctx.response.json(mapTokenResponse(serviceResponse));
      },
    },
  ],
};
