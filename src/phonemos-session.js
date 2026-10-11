/**
 * Per-user Phonemos OAuth session storage (User extension property).
 * Falls back to legacy AppGlobalStorage.oauthSessions for one-time migration.
 */
const http = require('@jetbrains/youtrack-scripting-api/http');
const urlSafety = require('./url-safety');

function currentUserId(ctx) {
  const user = ctx.currentUser;
  if (!user) {
    return null;
  }
  if (user.login) {
    return String(user.login);
  }
  if (user.id != null && String(user.id) !== '') {
    return String(user.id);
  }
  return null;
}

function userExtensionProperties(ctx) {
  const user = ctx.currentUser;
  if (!user || !user.extensionProperties) {
    return null;
  }
  return user.extensionProperties;
}

function parseTokenEntry(raw) {
  if (!raw) {
    return null;
  }
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== 'object' || !parsed.accessToken) {
      return null;
    }
    return {
      accessToken: String(parsed.accessToken),
      refreshToken: parsed.refreshToken ? String(parsed.refreshToken) : null,
      expiresAt: parsed.expiresAt != null ? Number(parsed.expiresAt) : null,
    };
  } catch (e) {
    return null;
  }
}

function readLegacySessionMap(ctx) {
  const raw = ctx.globalStorage && ctx.globalStorage.extensionProperties
    ? ctx.globalStorage.extensionProperties.oauthSessions
    : null;
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

function writeLegacySessionMap(ctx, map) {
  if (!ctx.globalStorage || !ctx.globalStorage.extensionProperties) {
    return;
  }
  ctx.globalStorage.extensionProperties.oauthSessions = JSON.stringify(map);
}

function readLegacyUserTokens(ctx) {
  const userId = currentUserId(ctx);
  if (!userId) {
    return null;
  }
  return parseTokenEntry(readLegacySessionMap(ctx)[userId]);
}

function clearLegacyUserTokens(ctx) {
  const userId = currentUserId(ctx);
  if (!userId || !ctx.globalStorage || !ctx.globalStorage.extensionProperties) {
    return;
  }
  const map = readLegacySessionMap(ctx);
  if (!map[userId]) {
    return;
  }
  delete map[userId];
  writeLegacySessionMap(ctx, map);
}

function readUserTokens(ctx) {
  const props = userExtensionProperties(ctx);
  if (props) {
    const fromUser = parseTokenEntry(props.phonemosOAuthSession);
    if (fromUser) {
      return fromUser;
    }
  }
  return readLegacyUserTokens(ctx);
}

function writeUserTokens(ctx, tokens) {
  const props = userExtensionProperties(ctx);
  if (!props || !tokens || !tokens.accessToken) {
    return false;
  }
  props.phonemosOAuthSession = JSON.stringify({
    accessToken: String(tokens.accessToken),
    refreshToken: tokens.refreshToken ? String(tokens.refreshToken) : null,
    expiresAt: tokens.expiresAt != null ? Number(tokens.expiresAt) : null,
    ts: Date.now(),
  });
  // Drop this user's entry from the shared legacy blob if present.
  clearLegacyUserTokens(ctx);
  return true;
}

function clearUserTokens(ctx) {
  const props = userExtensionProperties(ctx);
  if (props) {
    props.phonemosOAuthSession = null;
  }
  clearLegacyUserTokens(ctx);
  return !!props || !!currentUserId(ctx);
}

function parseJsonSafe(response) {
  try {
    return response.json();
  } catch (e) {
    return null;
  }
}

function exchangeRefreshToken(settings, refreshToken) {
  const unsafe = urlSafety.validateOutboundSettings(settings, ['oauthTokenUrl']);
  if (unsafe) {
    return {isSuccess: false, code: 0, body: unsafe};
  }
  const tokenUrl = settings.oauthTokenUrl;
  const slash = tokenUrl.indexOf('/', tokenUrl.indexOf('://') + 3);
  const origin = slash === -1 ? tokenUrl : tokenUrl.substring(0, slash);
  const path = slash === -1 ? '/' : tokenUrl.substring(slash);

  // Same as backend exchangeToken: secret via basicAuth only (YouTrack secret setting).
  const fields = {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: settings.oauthClientId,
  };
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

/**
 * Return a usable access token for the current YouTrack user from server storage.
 * Refreshes via Keycloak when expired. Never trusts client-supplied tokens.
 */
function ensureAccessToken(ctx, settings) {
  let tokens = readUserTokens(ctx);
  if (!tokens) {
    return {ok: false, reason: 'not_connected', message: 'Connect to Phonemos first.'};
  }

  const expired = tokens.expiresAt && tokens.expiresAt <= Date.now();
  if (!expired) {
    return {ok: true, accessToken: tokens.accessToken};
  }

  if (!tokens.refreshToken) {
    clearUserTokens(ctx);
    return {
      ok: false,
      reason: 'expired',
      message: 'Phonemos session expired. Connect again.',
    };
  }

  if (!settings.oauthClientId || settings.oauthClientSecret == null || !settings.oauthTokenUrl) {
    return {
      ok: false,
      reason: 'misconfigured',
      message: 'OAuth token settings are incomplete.',
    };
  }

  const serviceResponse = exchangeRefreshToken(settings, tokens.refreshToken);
  if (!serviceResponse || !serviceResponse.isSuccess) {
    clearUserTokens(ctx);
    return {
      ok: false,
      reason: 'refresh_failed',
      message: 'Phonemos session refresh failed. Connect again.',
    };
  }

  const data = parseJsonSafe(serviceResponse);
  if (!data || !data.access_token) {
    clearUserTokens(ctx);
    return {
      ok: false,
      reason: 'refresh_failed',
      message: 'Phonemos session refresh failed. Connect again.',
    };
  }

  const expiresIn = data.expires_in != null ? Number(data.expires_in) : null;
  const next = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || tokens.refreshToken,
    expiresAt: expiresIn ? Date.now() + expiresIn * 1000 - 30 * 1000 : null,
  };
  writeUserTokens(ctx, next);
  return {ok: true, accessToken: next.accessToken};
}

exports.currentUserId = currentUserId;
exports.readUserTokens = readUserTokens;
exports.writeUserTokens = writeUserTokens;
exports.clearUserTokens = clearUserTokens;
exports.ensureAccessToken = ensureAccessToken;
