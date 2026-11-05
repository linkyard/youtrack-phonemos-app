/**
 * Per-user Phonemos OAuth state (User extension properties).
 * Tokens, in-flight login, and rate limits stay off shared AppGlobalStorage.
 */
const oauthApi = require('./oauth-api');

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

/** Reject guest / missing users before OAuth work that hits OAuth. */
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

function normalizeIdentity(value) {
  return value ? String(value).trim().toLowerCase() : '';
}

/**
 * OAuth issues the authorization code to whoever actually completed the login in
 * their browser, not to whoever is redeeming it via our API. If an attacker starts
 * their own PKCE login (legitimately, under their own YouTrack account) and then lures
 * a victim with a live OAuth SSO session into opening that authorize URL, the code
 * that comes back is bound to the victim's OAuth identity, not the attacker's — but
 * our server-side state/verifier storage alone can't tell the two apart, since the
 * attacker owns that state entry. Asking OAuth's userinfo endpoint who the access
 * token belongs to asserts who really authenticated; it must match the YouTrack user
 * redeeming the code, or we'd bind the victim's Phonemos identity to the attacker's
 * YouTrack account. (A local, unverified id_token decode would tell us the same thing,
 * but without checking the signature — asking OAuth live is both simpler to
 * implement in this script sandbox and strictly more trustworthy.)
 */
function verifyIdentity(ctx, settings, accessToken) {
  const requireName = settings.oauthVerifyNameMatch !== false;
  const requireEmail = settings.oauthVerifyEmailMatch !== false;
  if (!requireName && !requireEmail) {
    return {ok: true};
  }

  const info = oauthApi.fetchUserInfo(settings, accessToken);
  if (!info.ok) {
    return {ok: false, message: 'Unable to verify the Phonemos identity for this connection (' + info.message + ').'};
  }
  const claims = info.claims;
  const user = ctx.currentUser;
  const expectedEmail = normalizeIdentity(user && user.email);
  const expectedLogin = normalizeIdentity(user && user.login);
  const tokenEmail = normalizeIdentity(claims.email);
  const tokenUsername = normalizeIdentity(claims.preferred_username);
  const emailMatches = !!(expectedEmail && tokenEmail && expectedEmail === tokenEmail);
  const usernameMatches = !!(expectedLogin && tokenUsername && expectedLogin === tokenUsername);

  const errors = [];
  if (requireName && !usernameMatches) {
    errors.push('The OAuth username (' + tokenUsername + ') returned for this login does not match your YouTrack account (' + expectedLogin + ').');
  }
  if (requireEmail && !emailMatches) {
    errors.push('The OAuth e-mail (' + tokenEmail + ') returned for this login does not match your YouTrack account (' + expectedEmail + ').');
  }

  if (errors.length !== 0) {
    errors.push('This is required by the app\'s global settings.');
    return {ok: false, message: errors.join(' ')};
  }
  return {ok: true};
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

function readUserTokens(ctx) {
  const props = userExtensionProperties(ctx);
  if (!props) {
    return null;
  }
  const parsed = parseJsonObject(props.phonemosOAuthSession);
  if (!parsed || !parsed.accessToken) {
    return null;
  }
  return {
    accessToken: String(parsed.accessToken),
    refreshToken: parsed.refreshToken ? String(parsed.refreshToken) : null,
    expiresAt: parsed.expiresAt != null ? Number(parsed.expiresAt) : null,
  };
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

/**
 * Simple per-user rate limit for OAuth endpoints that can hit OAuth.
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
  });
  if (count > OAUTH_RATE_MAX) {
    return {
      ok: false,
      message: 'Too many Phonemos connection attempts. Try again in a few minutes.',
    };
  }
  return {ok: true};
}

function accessTokenStillUsable(tokens) {
  if (!tokens || !tokens.accessToken) {
    return false;
  }
  return !(tokens.expiresAt && tokens.expiresAt <= Date.now());
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
 * Clears tokens only when OAuth returns invalid_grant and no other request
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
    serviceResponse = oauthApi.exchangeToken(settings, {
      grant_type: 'refresh_token',
      refresh_token: sentRefreshToken,
    });
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

  const mapped = oauthApi.mapTokenResponse(serviceResponse);
  if (!mapped.success || !mapped.accessToken) {
    if (oauthApi.isInvalidGrant(serviceResponse)) {
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

  const next = {
    accessToken: mapped.accessToken,
    refreshToken: mapped.refreshToken || sentRefreshToken,
    expiresAt: mapped.expiresAt,
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
 * Revoke the stored refresh token at OAuth, then delete the local session.
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
    oauthApi.revokeRefreshToken(settings, refreshToken);
  }
  clearUserTokens(ctx);
  return true;
}

/**
 * Return a usable access token for the current YouTrack user from server storage.
 * Refreshes via OAuth when expired. Never trusts client-supplied tokens.
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

exports.requireInteractiveUser = requireInteractiveUser;
exports.verifyIdentity = verifyIdentity;
exports.readUserTokens = readUserTokens;
exports.writeUserTokens = writeUserTokens;
exports.storeLogin = storeLogin;
exports.readLogin = readLogin;
exports.clearLogin = clearLogin;
exports.consumeOAuthRateLimit = consumeOAuthRateLimit;
exports.ensureAccessToken = ensureAccessToken;
exports.disconnectUser = disconnectUser;
