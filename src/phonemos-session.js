/**
 * Per-user Phonemos OAuth state (User extension properties).
 * Tokens, in-flight login, pending code, and rate limits stay off shared AppGlobalStorage.
 * Legacy global maps are nulled once from POST handlers and are not used for auth.
 */
const http = require('@jetbrains/youtrack-scripting-api/http');
const urlSafety = require('./url-safety');

const OAUTH_TTL_MS = 5 * 60 * 1000;
const OAUTH_RATE_WINDOW_MS = 10 * 60 * 1000;
const OAUTH_RATE_MAX = 20;

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

/** Reject guest / missing users before OAuth work that hits Keycloak. */
function requireInteractiveUser(ctx) {
  const user = ctx.currentUser;
  if (!user) {
    return 'Not authenticated.';
  }
  const login = user.login ? String(user.login) : '';
  if (user.isGuest === true || login === 'guest' || login === 'Guest') {
    return 'Guest users cannot connect to Phonemos.';
  }
  if (!currentUserId(ctx)) {
    return 'Not authenticated.';
  }
  return null;
}

function parseJsonObject(raw) {
  if (!raw) {
    return null;
  }
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (e) {
    return null;
  }
}

function parseTokenEntry(raw) {
  const parsed = parseJsonObject(raw);
  if (!parsed || !parsed.accessToken) {
    return null;
  }
  return {
    accessToken: String(parsed.accessToken),
    refreshToken: parsed.refreshToken ? String(parsed.refreshToken) : null,
    expiresAt: parsed.expiresAt != null ? Number(parsed.expiresAt) : null,
  };
}

/**
 * Drop leftover plaintext token maps on AppGlobalStorage.
 * Call only from POST handlers — YouTrack forbids database writes on GET.
 */
function purgeLegacyGlobalSecrets(ctx) {
  if (!ctx.globalStorage || !ctx.globalStorage.extensionProperties) {
    return;
  }
  const props = ctx.globalStorage.extensionProperties;
  if (props.oauthSessions || props.oauthLogins || props.oauthPending) {
    props.oauthSessions = null;
    props.oauthLogins = null;
    props.oauthPending = null;
  }
}

function readUserTokens(ctx) {
  const props = userExtensionProperties(ctx);
  if (!props) {
    return null;
  }
  return parseTokenEntry(props.phonemosOAuthSession);
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
  return true;
}

function clearUserTokens(ctx) {
  const props = userExtensionProperties(ctx);
  if (props) {
    props.phonemosOAuthSession = null;
  }
  return !!props || !!currentUserId(ctx);
}

function storeLogin(ctx, state, codeVerifier, redirectUri) {
  const props = userExtensionProperties(ctx);
  if (!props || !state || !codeVerifier || !redirectUri) {
    return false;
  }
  props.phonemosOAuthLogin = JSON.stringify({
    state: String(state),
    codeVerifier: String(codeVerifier),
    redirectUri: String(redirectUri),
    ts: Date.now(),
  });
  return true;
}

function readLogin(ctx, state) {
  if (!state) {
    return null;
  }
  const props = userExtensionProperties(ctx);
  if (!props) {
    return null;
  }
  const entry = parseJsonObject(props.phonemosOAuthLogin);
  if (!entry) {
    return null;
  }
  if (!entry.ts || Date.now() - Number(entry.ts) > OAUTH_TTL_MS) {
    props.phonemosOAuthLogin = null;
    return null;
  }
  if (
    String(entry.state) === String(state) &&
    entry.codeVerifier &&
    entry.redirectUri
  ) {
    return {
      codeVerifier: String(entry.codeVerifier),
      redirectUri: String(entry.redirectUri),
      ts: Number(entry.ts),
    };
  }
  return null;
}

function clearLogin(ctx, state) {
  const props = userExtensionProperties(ctx);
  if (props) {
    const entry = parseJsonObject(props.phonemosOAuthLogin);
    if (!state || (entry && String(entry.state) === String(state))) {
      props.phonemosOAuthLogin = null;
    }
  }
}

function storePendingResult(ctx, state, code, error) {
  const props = userExtensionProperties(ctx);
  if (!props || !state || !(code || error)) {
    return false;
  }
  props.phonemosOAuthPending = JSON.stringify({
    state: String(state),
    code: code || null,
    error: error || null,
    ts: Date.now(),
  });
  return true;
}

function readPendingResult(ctx, state) {
  if (!state) {
    return null;
  }
  const props = userExtensionProperties(ctx);
  if (!props) {
    return null;
  }
  const entry = parseJsonObject(props.phonemosOAuthPending);
  if (!entry) {
    return null;
  }
  if (!entry.ts || Date.now() - Number(entry.ts) > OAUTH_TTL_MS) {
    props.phonemosOAuthPending = null;
    return null;
  }
  if (String(entry.state) === String(state)) {
    return {
      code: entry.code || null,
      error: entry.error || null,
      state: String(state),
      ts: Number(entry.ts),
    };
  }
  return null;
}

/**
 * Read and clear pending OAuth result for this user+state (one-time consume).
 * Must only be called from POST handlers.
 */
function consumePendingResult(ctx, state) {
  const entry = readPendingResult(ctx, state);
  if (!entry) {
    return null;
  }
  clearPendingResult(ctx, state);
  return entry;
}

function clearPendingResult(ctx, state) {
  const props = userExtensionProperties(ctx);
  if (props) {
    const entry = parseJsonObject(props.phonemosOAuthPending);
    if (!state || (entry && String(entry.state) === String(state))) {
      props.phonemosOAuthPending = null;
    }
  }
}

/**
 * Simple per-user rate limit for OAuth endpoints that can hit Keycloak.
 * Must only be called from POST handlers (writes User extension properties).
 */
function consumeOAuthRateLimit(ctx) {
  const props = userExtensionProperties(ctx);
  if (!props) {
    return {ok: false, message: 'Not authenticated.'};
  }
  const now = Date.now();
  const prev = parseJsonObject(props.phonemosOAuthRate) || {};
  let windowStart = prev.windowStart != null ? Number(prev.windowStart) : now;
  let count = prev.count != null ? Number(prev.count) : 0;
  if (now - windowStart > OAUTH_RATE_WINDOW_MS) {
    windowStart = now;
    count = 0;
  }
  count += 1;
  props.phonemosOAuthRate = JSON.stringify({
    windowStart: windowStart,
    count: count,
    ts: now,
  });
  if (count > OAUTH_RATE_MAX) {
    return {
      ok: false,
      message: 'Too many Phonemos sign-in attempts. Try again in a few minutes.',
    };
  }
  return {ok: true};
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

function revokeRefreshToken(settings, refreshToken) {
  const revokeUrl = urlSafety.revokeUrlFromTokenUrl(settings.oauthTokenUrl);
  if (!revokeUrl || !refreshToken) {
    return {ok: false, message: 'Revocation endpoint unavailable.'};
  }
  const unsafe = urlSafety.validateHttpsUrl(revokeUrl, 'OAuth revocation URL');
  if (!unsafe.ok) {
    return {ok: false, message: unsafe.message};
  }
  // Auth/token hosts must match; revoke is derived from token URL so same host.
  const slash = revokeUrl.indexOf('/', revokeUrl.indexOf('://') + 3);
  const origin = slash === -1 ? revokeUrl : revokeUrl.substring(0, slash);
  const path = slash === -1 ? '/' : revokeUrl.substring(slash);

  const body =
    'token=' +
    encodeURIComponent(String(refreshToken)) +
    '&token_type_hint=refresh_token' +
    '&client_id=' +
    encodeURIComponent(String(settings.oauthClientId));

  try {
    const connection = new http.Connection(origin);
    connection.basicAuth(settings.oauthClientId, settings.oauthClientSecret);
    connection.addHeader('Content-Type', 'application/x-www-form-urlencoded');
    connection.addHeader('Accept', 'application/json');
    const response = connection.postSync(path, null, body);
    return {ok: !!(response && (response.isSuccess || response.code === 200 || response.code === 204))};
  } catch (e) {
    return {ok: false, message: 'Revocation request failed.'};
  }
}

function accessTokenStillUsable(tokens) {
  if (!tokens || !tokens.accessToken) {
    return false;
  }
  return !(tokens.expiresAt && tokens.expiresAt <= Date.now());
}

function isInvalidGrant(serviceResponse) {
  const data = parseJsonSafe(serviceResponse);
  return !!(data && String(data.error) === 'invalid_grant');
}

function concurrentRefreshWon(latest, sentRefreshToken) {
  return !!(
    latest &&
    latest.refreshToken &&
    latest.refreshToken !== sentRefreshToken &&
    accessTokenStillUsable(latest)
  );
}

/**
 * Refresh the stored session for this user.
 * Clears tokens only when Keycloak returns invalid_grant and no other request
 * already stored a newer refresh token. Timeouts and 5xx leave the session in place.
 */
function refreshStoredTokens(ctx, settings) {
  const tokens = readUserTokens(ctx);
  if (!tokens || !tokens.refreshToken) {
    return {
      ok: false,
      reason: 'not_connected',
      message: 'No stored refresh token for this user. Connect to Phonemos again.',
    };
  }
  if (!settings.oauthClientId || settings.oauthClientSecret == null || !settings.oauthTokenUrl) {
    return {
      ok: false,
      reason: 'misconfigured',
      message: 'OAuth token settings are incomplete.',
    };
  }

  const sentRefreshToken = tokens.refreshToken;
  let serviceResponse = null;
  try {
    serviceResponse = exchangeRefreshToken(settings, sentRefreshToken);
  } catch (e) {
    const latest = readUserTokens(ctx);
    if (concurrentRefreshWon(latest, sentRefreshToken)) {
      return {ok: true, accessToken: latest.accessToken, tokens: latest};
    }
    return {
      ok: false,
      reason: 'refresh_failed',
      message: 'Phonemos session refresh failed. Connect again.',
    };
  }

  const latest = readUserTokens(ctx);
  if (concurrentRefreshWon(latest, sentRefreshToken)) {
    return {ok: true, accessToken: latest.accessToken, tokens: latest};
  }

  if (!serviceResponse || !serviceResponse.isSuccess) {
    if (isInvalidGrant(serviceResponse)) {
      const again = readUserTokens(ctx);
      if (concurrentRefreshWon(again, sentRefreshToken)) {
        return {ok: true, accessToken: again.accessToken, tokens: again};
      }
      if (!again || !again.refreshToken || again.refreshToken === sentRefreshToken) {
        clearUserTokens(ctx);
      }
    }
    return {
      ok: false,
      reason: 'refresh_failed',
      message: 'Phonemos session refresh failed. Connect again.',
    };
  }

  const data = parseJsonSafe(serviceResponse);
  if (!data || !data.access_token) {
    const again = readUserTokens(ctx);
    if (concurrentRefreshWon(again, sentRefreshToken)) {
      return {ok: true, accessToken: again.accessToken, tokens: again};
    }
    return {
      ok: false,
      reason: 'refresh_failed',
      message: 'Phonemos session refresh failed. Connect again.',
    };
  }

  const expiresIn = data.expires_in != null ? Number(data.expires_in) : null;
  const next = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || sentRefreshToken,
    expiresAt: expiresIn ? Date.now() + expiresIn * 1000 - 30 * 1000 : null,
  };
  const beforeWrite = readUserTokens(ctx);
  if (concurrentRefreshWon(beforeWrite, sentRefreshToken)) {
    return {ok: true, accessToken: beforeWrite.accessToken, tokens: beforeWrite};
  }
  if (!writeUserTokens(ctx, next)) {
    return {
      ok: false,
      reason: 'store_failed',
      message: 'Unable to store Phonemos session for this YouTrack user.',
    };
  }
  return {ok: true, accessToken: next.accessToken, tokens: next};
}

/**
 * Revoke the stored refresh token at Keycloak, then delete the local session.
 * Used for logout and for a Phonemos 401. Not used when refresh fails transiently.
 */
function disconnectUser(ctx, settings) {
  const stored = readUserTokens(ctx);
  const refreshToken = stored && stored.refreshToken ? stored.refreshToken : null;
  if (
    refreshToken &&
    settings &&
    settings.oauthClientId &&
    settings.oauthClientSecret != null &&
    settings.oauthTokenUrl
  ) {
    revokeRefreshToken(settings, refreshToken);
  }
  clearUserTokens(ctx);
  return true;
}

/**
 * Return a usable access token for the current YouTrack user from server storage.
 * Refreshes via Keycloak when expired. Never trusts client-supplied tokens.
 */
function ensureAccessToken(ctx, settings) {
  const tokens = readUserTokens(ctx);
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

  const refreshed = refreshStoredTokens(ctx, settings);
  if (!refreshed.ok) {
    return refreshed;
  }
  return {ok: true, accessToken: refreshed.accessToken};
}

exports.currentUserId = currentUserId;
exports.requireInteractiveUser = requireInteractiveUser;
exports.readUserTokens = readUserTokens;
exports.writeUserTokens = writeUserTokens;
exports.clearUserTokens = clearUserTokens;
exports.storeLogin = storeLogin;
exports.readLogin = readLogin;
exports.clearLogin = clearLogin;
exports.storePendingResult = storePendingResult;
exports.readPendingResult = readPendingResult;
exports.consumePendingResult = consumePendingResult;
exports.clearPendingResult = clearPendingResult;
exports.consumeOAuthRateLimit = consumeOAuthRateLimit;
exports.ensureAccessToken = ensureAccessToken;
exports.refreshStoredTokens = refreshStoredTokens;
exports.disconnectUser = disconnectUser;
exports.purgeLegacyGlobalSecrets = purgeLegacyGlobalSecrets;
exports.revokeRefreshToken = revokeRefreshToken;
