/**
 * Validate admin-configured URLs before server-side outbound HTTP (SSRF hardening).
 * Requires https (http only for localhost), rejects credentials and metadata/link-local hosts.
 */

function isLocalhost(hostname) {
  const h = String(hostname || '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
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
  // IPv4 link-local / cloud metadata range
  if (h === '169.254.169.254' || /^169\.254\./.test(h)) {
    return true;
  }
  return false;
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
  if (!parsed.hostname || isBlockedHostname(parsed.hostname)) {
    return {ok: false, message: label + ' host is not allowed.'};
  }
  if (parsed.protocol === 'http') {
    if (!isLocalhost(parsed.hostname)) {
      return {
        ok: false,
        message: label + ' must use https (http is only allowed for localhost).',
      };
    }
  } else if (parsed.protocol !== 'https') {
    return {ok: false, message: label + ' must use https.'};
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

exports.validateHttpsUrl = validateHttpsUrl;
exports.validateOutboundSettings = validateOutboundSettings;
