/**
 * Validate admin-configured URLs before server-side outbound HTTP (SSRF hardening).
 * Requires https (http only for localhost), rejects credentials, private/link-local,
 * and cloud metadata hosts.
 */

function isLocalhost(hostname) {
  const h = String(hostname || '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
}

function ipv4Parts(hostname) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(hostname || ''));
  if (!m) {
    return null;
  }
  const parts = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] > 255) {
      return null;
    }
  }
  return parts;
}

function isPrivateOrReservedIpv4(hostname) {
  const p = ipv4Parts(hostname);
  if (!p) {
    return false;
  }
  const a = p[0];
  const b = p[1];
  // 0.0.0.0/8, 10.0.0.0/8, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16
  if (a === 0 || a === 10 || a === 127) {
    return true;
  }
  if (a === 169 && b === 254) {
    return true;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  if (a === 192 && b === 168) {
    return true;
  }
  // 100.64.0.0/10 (CGNAT)
  if (a === 100 && b >= 64 && b <= 127) {
    return true;
  }
  return false;
}

function isPrivateOrReservedIpv6(hostname) {
  const h = String(hostname || '')
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (!h || h.indexOf(':') < 0) {
    return false;
  }
  if (h === '::' || h === '::1') {
    return true;
  }
  // Unique-local fc00::/7, link-local fe80::/10
  if (h.indexOf('fc') === 0 || h.indexOf('fd') === 0 || h.indexOf('fe8') === 0 || h.indexOf('fe9') === 0) {
    return true;
  }
  if (h.indexOf('fea') === 0 || h.indexOf('feb') === 0) {
    return true;
  }
  return false;
}

function isBlockedHostname(hostname) {
  const h = String(hostname || '')
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (!h) {
    return true;
  }
  if (h === 'metadata' || h === 'metadata.google.internal' || h.indexOf('metadata.') === 0) {
    return true;
  }
  if (h === '0.0.0.0' || h === '::' || h === '0') {
    return true;
  }
  if (isPrivateOrReservedIpv4(h) || isPrivateOrReservedIpv6(h)) {
    return true;
  }
  return false;
}

/**
 * OAuth redirect_uri must be the packaged popup callback under YouTrack appResources.
 * Example: https://{host}/api/appResources/{id}/widgets/oauth-popup-callback.html
 */
function isAllowedOAuthRedirectUri(raw) {
  const parsed = parseAbsoluteUrl(raw);
  if (!parsed || parsed.hasUserInfo) {
    return false;
  }
  if (isLocalhost(parsed.hostname)) {
    if (parsed.protocol !== 'http' && parsed.protocol !== 'https') {
      return false;
    }
  } else if (parsed.protocol !== 'https') {
    return false;
  } else if (!parsed.hostname || isBlockedHostname(parsed.hostname)) {
    return false;
  }
  try {
    const URI = Java.type('java.net.URI');
    const uri = new URI(String(raw).trim());
    const path = uri.getPath() ? String(uri.getPath()) : '';
    if (uri.getQuery() || uri.getFragment()) {
      return false;
    }
    return /^\/api\/appResources\/[^/]+\/widgets\/oauth-popup-callback\.html$/i.test(path);
  } catch (e) {
    // Fall through
  }
  const match = /^https?:\/\/[^/?#]+(\/api\/appResources\/[^/?#]+\/widgets\/oauth-popup-callback\.html)$/i.exec(
    String(raw || '').trim(),
  );
  return !!match;
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

/**
 * @returns {{ok: true, url: string, hostname: string} | {ok: false, message: string}}
 */
function validateHttpsUrl(raw, label) {
  const parsed = parseAbsoluteUrl(raw);
  if (!parsed) {
    return {ok: false, message: label + ' must be a valid absolute URL.'};
  }
  if (parsed.hasUserInfo) {
    return {ok: false, message: label + ' must not include credentials.'};
  }
  // Localhost is allowed for local dev over http only.
  if (isLocalhost(parsed.hostname)) {
    if (parsed.protocol === 'http' || parsed.protocol === 'https') {
      return {ok: true, url: parsed.href, hostname: parsed.hostname};
    }
    return {ok: false, message: label + ' must use https (or http on localhost).'};
  }
  if (!parsed.hostname || isBlockedHostname(parsed.hostname)) {
    return {ok: false, message: label + ' host is not allowed.'};
  }
  if (parsed.protocol !== 'https') {
    return {
      ok: false,
      message: label + ' must use https (http is only allowed for localhost).',
    };
  }
  return {ok: true, url: parsed.href, hostname: parsed.hostname};
}

const URL_LABELS = {
  phonemosBaseUrl: 'Phonemos base URL',
  oauthAuthorizationUrl: 'OAuth authorization URL',
  oauthTokenUrl: 'OAuth token URL',
};

/**
 * Validate selected outbound URL settings. Returns an error message or null.
 */
function validateOutboundSettings(settings, keys) {
  const list = keys || Object.keys(URL_LABELS);
  let authHost = null;
  let tokenHost = null;

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
    const result = validateHttpsUrl(value, label);
    if (!result.ok) {
      return result.message;
    }
    if (key === 'oauthAuthorizationUrl') {
      authHost = result.hostname;
    }
    if (key === 'oauthTokenUrl') {
      tokenHost = result.hostname;
    }
  }

  if (authHost && tokenHost && authHost !== tokenHost) {
    return 'OAuth authorization and token URLs must use the same host.';
  }
  return null;
}

/**
 * Derive OpenID Connect revocation endpoint from the token URL (.../token → .../revoke).
 */
function revokeUrlFromTokenUrl(tokenUrl) {
  const raw = String(tokenUrl || '').trim();
  if (!raw) {
    return null;
  }
  if (/\/token\/?$/i.test(raw)) {
    return raw.replace(/\/token\/?$/i, '/revoke');
  }
  return null;
}

exports.validateHttpsUrl = validateHttpsUrl;
exports.validateOutboundSettings = validateOutboundSettings;
exports.isAllowedOAuthRedirectUri = isAllowedOAuthRedirectUri;
exports.revokeUrlFromTokenUrl = revokeUrlFromTokenUrl;
