/**
 * Shared Phonemos OAuth session storage (AppGlobalStorage).
 * Used by global OAuth handlers and the issue-scoped suggestions proxy.
 */
const http = require('@jetbrains/youtrack-scripting-api/http');

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

function readSessionMap(ctx) {
  const raw = ctx.globalStorage.extensionProperties.oauthSessions;
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

function writeSessionMap(ctx, map) {
  ctx.globalStorage.extensionProperties.oauthSessions = JSON.stringify(map);
}

function readUserTokens(ctx) {
  const userId = currentUserId(ctx);
  if (!userId) {
    return null;
  }
  const entry = readSessionMap(ctx)[userId];
  if (!entry || !entry.accessToken) {
    return null;
  }
  return {
    accessToken: String(entry.accessToken),
    refreshToken: entry.refreshToken ? String(entry.refreshToken) : null,
    expiresAt: entry.expiresAt != null ? Number(entry.expiresAt) : null,
  };
}

function writeUserTokens(ctx, tokens) {
  const userId = currentUserId(ctx);
  if (!userId || !tokens || !tokens.accessToken) {
    return false;
  }
  const map = readSessionMap(ctx);
  map[userId] = {
    accessToken: String(tokens.accessToken),
    refreshToken: tokens.refreshToken ? String(tokens.refreshToken) : null,
    expiresAt: tokens.expiresAt != null ? Number(tokens.expiresAt) : null,
    ts: Date.now(),
  };
  writeSessionMap(ctx, map);
  return true;
}

function clearUserTokens(ctx) {
  const userId = currentUserId(ctx);
  if (!userId) {
    return false;
  }
  const map = readSessionMap(ctx);
  if (!map[userId]) {
    return true;
  }
  delete map[userId];
  writeSessionMap(ctx, map);
  return true;
}

function parseJsonSafe(response) {
  try {
    return response.json();
  } catch (e) {
    return null;
  }
}

function exchangeRefreshToken(settings, refreshToken) {
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
