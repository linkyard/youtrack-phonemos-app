/**
 * App settings from ctx.settings, plus derived Keycloak endpoints.
 */
const urlSafety = require('./url-safety');
const phonemosApi = require('./phonemos-api');

function trimSetting(value) {
  return value == null ? '' : String(value).trim();
}

function loadSettings(ctx) {
  const s = ctx.settings || {};
  const keycloak = urlSafety.keycloakEndpoints(s.keycloakBaseUrl);
  const withinRaw = s.withinObjectId == null ? '' : String(s.withinObjectId).trim();
  return {
    phonemosBaseUrl: urlSafety.trimTrailingSlash(s.phonemosBaseUrl),
    oauthClientId: trimSetting(s.oauthClientId),
    // Pass the secret setting through untouched — YouTrack injects it only in
    // http.Connection basicAuth/addHeader; stringifying/trimming breaks that.
    oauthClientSecret: s.oauthClientSecret,
    keycloakBaseUrl: urlSafety.normalizeKeycloakBaseUrl(s.keycloakBaseUrl),
    oauthAuthorizationUrl: keycloak.authorizationUrl,
    oauthTokenUrl: keycloak.tokenUrl,
    oauthRevokeUrl: keycloak.revokeUrl,
    oauthUserInfoUrl: keycloak.userInfoUrl,
    oauthVerifyNameMatch: s.oauthVerifyNameMatch !== false,
    oauthVerifyEmailMatch: s.oauthVerifyEmailMatch !== false,
    withinObjectIdRaw: withinRaw,
    withinObjectId: phonemosApi.normalizeWithinObjectId(s.withinObjectId),
    searchLimit: s.searchLimit,
  };
}

function menuSettings(ctx) {
  const settings = loadSettings(ctx);
  settings.withinObjectId = null;
  settings.searchLimit = 10;
  return settings;
}

function missingSettings(settings, keys) {
  return keys.filter(function (key) {
    if (key === 'oauthClientSecret') {
      return settings[key] == null || settings[key] === '';
    }
    return settings[key] == null || String(settings[key]).trim() === '';
  });
}

function verifySettings(ctx, requiredKeys, urlKeys) {
  const settings = loadSettings(ctx);
  const missing = missingSettings(settings, requiredKeys || []);
  if (missing.length) {
    return {ok: false, message: 'Missing app settings: ' + missing.join(', ')};
  }
  const unsafe = urlSafety.validateOutboundSettings(settings, urlKeys || []);
  if (unsafe) {
    return {ok: false, message: unsafe};
  }
  return {ok: true, settings: settings};
}

exports.loadSettings = loadSettings;
exports.menuSettings = menuSettings;
exports.verifySettings = verifySettings;
