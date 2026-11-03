/**
 * URL checks for admin settings and OAuth redirect_uri.
 * Admin-configured outbound URLs are trusted aside from basic shape (absolute
 * http(s), no embedded credentials). Redirect URIs come from the widget and
 * must be the packaged appResources popup callback on this YouTrack host —
 * including installs served under a context path (e.g. /youtrack).
 */

var APP_RESOURCES_CALLBACK_PATH =
  /^(?:\/[^/]+)*\/api\/appResources\/[^/]+\/widgets\/oauth-popup-callback\.html$/i;

var APP_RESOURCES_CALLBACK_URL =
  /^https?:\/\/[^/?#]+(?:\/[^/?#]+)*\/api\/appResources\/[^/?#]+\/widgets\/oauth-popup-callback\.html$/i;

function hostNameFromHeader(hostHeader) {
  const raw = String(hostHeader || '').trim().toLowerCase();
  if (!raw) {
    return '';
  }
  if (raw.charAt(0) === '[') {
    const end = raw.indexOf(']');
    return end > 0 ? raw.substring(1, end) : '';
  }
  const colon = raw.lastIndexOf(':');
  if (colon > 0 && raw.indexOf(':') === colon) {
    return raw.substring(0, colon);
  }
  return raw;
}

function parseAbsoluteUrl(raw) {
  const input = String(raw == null ? '' : raw).trim();
  if (!input) {
    return null;
  }

  try {
    const URI = Java.type('java.net.URI');
    const uri = new URI(input);
    const protocol = uri.getScheme() ? String(uri.getScheme()).toLowerCase() : '';
    const host = uri.getHost() ? String(uri.getHost()).toLowerCase() : '';
    const userInfo = uri.getUserInfo();
    if (!protocol || !host) {
      return null;
    }
    return {
      href: input,
      protocol: protocol,
      hostname: host,
      hasUserInfo: !!(userInfo && String(userInfo).length),
    };
  } catch (e) {
    // Fall through to regex for environments without Java interop.
  }

  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]+)([/?#][\s\S]*)?$/.exec(input);
  if (!match) {
    return null;
  }
  const protocol = String(match[1]).toLowerCase();
  let authority = match[2];
  if (authority.indexOf('@') >= 0) {
    return {href: input, protocol: protocol, hostname: '', hasUserInfo: true};
  }
  let hostname = authority;
  if (hostname.charAt(0) === '[') {
    const end = hostname.indexOf(']');
    if (end < 0) {
      return null;
    }
    hostname = hostname.substring(1, end);
  } else {
    const colon = hostname.lastIndexOf(':');
    if (colon >= 0) {
      hostname = hostname.substring(0, colon);
    }
  }
  return {
    href: input,
    protocol: protocol,
    hostname: String(hostname).toLowerCase(),
    hasUserInfo: false,
  };
}

function redirectPathAllowed(raw) {
  try {
    const URI = Java.type('java.net.URI');
    const uri = new URI(String(raw).trim());
    const path = uri.getPath() ? String(uri.getPath()) : '';
    if (uri.getQuery() || uri.getFragment()) {
      return false;
    }
    return APP_RESOURCES_CALLBACK_PATH.test(path);
  } catch (e) {
    // Fall through
  }
  return APP_RESOURCES_CALLBACK_URL.test(String(raw || '').trim());
}

/**
 * OAuth redirect_uri must be the packaged popup callback on this YouTrack host.
 * expectedHost is the request Host header (not X-Forwarded-Host).
 * Allows an optional context-path prefix before /api/appResources/….
 */
function isAllowedOAuthRedirectUri(raw, expectedHost) {
  const parsed = parseAbsoluteUrl(raw);
  if (!parsed || parsed.hasUserInfo) {
    return false;
  }
  if (parsed.protocol !== 'http' && parsed.protocol !== 'https') {
    return false;
  }
  const expected = hostNameFromHeader(expectedHost);
  if (!expected || parsed.hostname !== expected) {
    return false;
  }
  return redirectPathAllowed(raw);
}

function validateOutboundUrl(raw, label) {
  const parsed = parseAbsoluteUrl(raw);
  if (!parsed) {
    return {ok: false, message: label + ' must be a valid absolute URL.'};
  }
  if (parsed.hasUserInfo) {
    return {ok: false, message: label + ' must not include credentials.'};
  }
  if (parsed.protocol !== 'http' && parsed.protocol !== 'https') {
    return {ok: false, message: label + ' must use http or https.'};
  }
  return {ok: true, url: parsed.href, hostname: parsed.hostname};
}

const URL_LABELS = {
  phonemosBaseUrl: 'Phonemos base URL',
  keycloakBaseUrl: 'Keycloak base URL',
};

/**
 * Validate selected outbound URL settings. Returns an error message or null.
 */
function validateOutboundSettings(settings, keys) {
  const list = keys || Object.keys(URL_LABELS);
  for (let i = 0; i < list.length; i++) {
    const key = list[i];
    const label = URL_LABELS[key];
    if (!label) {
      continue;
    }
    const value = settings[key];
    if (value == null || String(value).trim() === '') {
      continue;
    }
    const result = validateOutboundUrl(value, label);
    if (!result.ok) {
      return result.message;
    }
  }
  return null;
}

/**
 * Normalize the Keycloak base URL setting to the realm URL
 * (http(s)://{host}[/auth]/realms/{realm}). Tolerates a pasted
 * …/protocol/openid-connect[/…] suffix.
 */
function normalizeKeycloakBaseUrl(raw) {
  return String(raw == null ? '' : raw)
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/protocol\/openid-connect(?:\/.*)?$/i, '');
}

/**
 * Keycloak OpenID Connect endpoints derived from the realm URL.
 */
function keycloakEndpoints(baseUrl) {
  const realm = normalizeKeycloakBaseUrl(baseUrl);
  if (!realm) {
    return {authorizationUrl: null, tokenUrl: null, revokeUrl: null, userInfoUrl: null};
  }
  const oidc = realm + '/protocol/openid-connect';
  return {
    authorizationUrl: oidc + '/auth',
    tokenUrl: oidc + '/token',
    revokeUrl: oidc + '/revoke',
    userInfoUrl: oidc + '/userinfo',
  };
}

exports.validateOutboundUrl = validateOutboundUrl;
exports.validateOutboundSettings = validateOutboundSettings;
exports.isAllowedOAuthRedirectUri = isAllowedOAuthRedirectUri;
exports.normalizeKeycloakBaseUrl = normalizeKeycloakBaseUrl;
exports.keycloakEndpoints = keycloakEndpoints;
