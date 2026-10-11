/**
 * Issue-scoped suggestions endpoint.
 * Global OAuth endpoints live in backend.js (YouTrack forbids mixing scopes in one handler).
 */
const http = require('@jetbrains/youtrack-scripting-api/http');

const MAX_QUERY_CHARS = 3500;
const DEFAULT_SEARCH_LIMIT = 5;

function trimTrailingSlash(url) {
  return String(url || '').replace(/\/+$/, '');
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
    withinObjectId: normalizeWithinObjectId(s.withinObjectId),
    withinObjectIdRaw: s.withinObjectId == null ? '' : String(s.withinObjectId).trim(),
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

function uuidToSlug(uuid) {
  const hex = String(uuid).replace(/-/g, '');
  if (hex.length !== 32) {
    return null;
  }
  const bytes = [];
  for (let i = 0; i < 32; i += 2) {
    bytes.push(parseInt(hex.substring(i, i + 2), 16));
  }
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').substring(0, 22);
}

function base64UrlToBytes(value) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let input = String(value || '')
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  while (input.length % 4) {
    input += '=';
  }
  const bytes = [];
  for (let i = 0; i < input.length; i += 4) {
    const a = chars.indexOf(input.charAt(i));
    const b = chars.indexOf(input.charAt(i + 1));
    const c = input.charAt(i + 2) === '=' ? -1 : chars.indexOf(input.charAt(i + 2));
    const d = input.charAt(i + 3) === '=' ? -1 : chars.indexOf(input.charAt(i + 3));
    if (a < 0 || b < 0) {
      return null;
    }
    bytes.push((a << 2) | (b >> 4));
    if (c >= 0) {
      bytes.push(((b & 15) << 4) | (c >> 2));
    }
    if (d >= 0) {
      bytes.push(((c & 3) << 6) | d);
    }
  }
  return bytes;
}

function slugToUuid(slug) {
  const raw = String(slug || '');
  if (!/^[A-Za-z0-9_-]{22}$/.test(raw)) {
    return null;
  }
  const bytes = base64UrlToBytes(raw);
  if (!bytes || bytes.length < 16) {
    return null;
  }
  let hex = '';
  for (let i = 0; i < 16; i++) {
    const h = bytes[i].toString(16);
    hex += h.length === 1 ? '0' + h : h;
  }
  return (
    hex.substring(0, 8) +
    '-' +
    hex.substring(8, 12) +
    '-' +
    hex.substring(12, 16) +
    '-' +
    hex.substring(16, 20) +
    '-' +
    hex.substring(20, 32)
  );
}

function normalizeUuid(value) {
  const hex = String(value || '').replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) {
    return null;
  }
  return (
    hex.substring(0, 8) +
    '-' +
    hex.substring(8, 12) +
    '-' +
    hex.substring(12, 16) +
    '-' +
    hex.substring(16, 20) +
    '-' +
    hex.substring(20, 32)
  );
}

/**
 * Accept project setting as UUID, Phonemos slug, or topic/object URL.
 * Examples:
 *   01234567-89ab-cdef-0123-456789abcdef
 *   hgZU0Gy-S5ObkiUPdABgrQ
 *   https://showcase.phonemos.cloud/t/hgZU0Gy-S5ObkiUPdABgrQ/start
 */
function normalizeWithinObjectId(value) {
  let raw = String(value == null ? '' : value).trim();
  if (
    (raw.charAt(0) === '"' && raw.charAt(raw.length - 1) === '"') ||
    (raw.charAt(0) === "'" && raw.charAt(raw.length - 1) === "'")
  ) {
    raw = raw.substring(1, raw.length - 1).trim();
  }
  if (!raw) {
    return null;
  }

  const asUuid = normalizeUuid(raw);
  if (asUuid) {
    return asUuid;
  }

  const asSlug = slugToUuid(raw);
  if (asSlug) {
    return asSlug;
  }

  // URL or path: /t/{slug}/… or /o/{slug|uuid}/…
  const match = raw.match(/\/(?:t|o)\/([A-Za-z0-9_-]{22}|[0-9a-fA-F-]{36})(?:\/|$)/);
  if (match) {
    return normalizeUuid(match[1]) || slugToUuid(match[1]);
  }

  return null;
}

function objectHref(baseUrl, objectId) {
  const slug = uuidToSlug(objectId);
  if (!slug) {
    return trimTrailingSlash(baseUrl) + '/o/' + objectId;
  }
  return trimTrailingSlash(baseUrl) + '/o/' + slug;
}

function stripMarkup(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[#*_`>~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function latestReporterComment(issue) {
  if (!issue || !issue.reporter || !issue.comments) {
    return '';
  }
  const reporterLogin = issue.reporter.login;
  let latest = null;
  let latestCreated = -1;
  issue.comments.forEach(function (comment) {
    if (!comment || !comment.author || comment.author.login !== reporterLogin) {
      return;
    }
    const created = comment.created ? Number(comment.created) : 0;
    if (created >= latestCreated) {
      latestCreated = created;
      latest = comment;
    }
  });
  return latest ? stripMarkup(latest.text) : '';
}

function buildSearchQuery(issue) {
  const parts = [];
  if (issue.summary) {
    parts.push(stripMarkup(issue.summary));
  }
  if (issue.description) {
    parts.push(stripMarkup(issue.description));
  }
  const customerComment = latestReporterComment(issue);
  if (customerComment) {
    parts.push(customerComment);
  }
  let q = parts.join('\n\n').trim();
  if (q.length > MAX_QUERY_CHARS) {
    q = q.substring(0, MAX_QUERY_CHARS);
  }
  return q;
}

function base64UrlToString(value) {
  const normalized = String(value || '')
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const pad = normalized.length % 4 === 0 ? '' : new Array(5 - (normalized.length % 4)).join('=');
  const input = normalized + pad;
  try {
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(input, 'base64').toString('utf8');
    }
  } catch (e) {
    // continue
  }
  try {
    const Base64 = Java.type('java.util.Base64');
    return new java.lang.String(Base64.getDecoder().decode(input), 'UTF-8');
  } catch (e2) {
    return null;
  }
}

function describeAccessTokenClaims(accessToken) {
  const raw = String(accessToken || '');
  const parts = raw.split('.');
  if (parts.length < 2) {
    return 'token is opaque/not a JWT (len=' + raw.length + ')';
  }
  const json = base64UrlToString(parts[1]);
  if (!json) {
    return 'unable to decode JWT payload (len=' + raw.length + ')';
  }
  try {
    const payload = JSON.parse(json);
    const hasura = payload['https://hasura.io/jwt/claims'] || payload.hasura || null;
    const keys = Object.keys(payload).slice(0, 12).join(',');
    return (
      'jwt aud=' +
      JSON.stringify(payload.aud || null) +
      ' azp=' +
      JSON.stringify(payload.azp || null) +
      ' scope=' +
      JSON.stringify(payload.scope || null) +
      ' hasHasuraClaims=' +
      String(!!hasura) +
      ' claimKeys=' +
      keys
    );
  } catch (e) {
    return 'JWT payload is not JSON';
  }
}

function searchPhonemos(settings, accessToken, query, mode) {
  const limit = settings.searchLimit != null ? Number(settings.searchLimit) : DEFAULT_SEARCH_LIMIT;
  const safeLimit = isNaN(limit) || limit < 1 ? DEFAULT_SEARCH_LIMIT : Math.min(20, Math.floor(limit));
  const payload = {
    q: query,
    within: settings.withinObjectId,
    mode: mode,
    objectTypes: ['wikipage'],
    limit: safeLimit,
  };

  const connection = new http.Connection(settings.phonemosBaseUrl);
  connection.addHeader('Authorization', 'Bearer ' + accessToken);
  connection.addHeader('Content-Type', 'application/json');
  connection.addHeader('Accept', 'application/json');
  return connection.postSync('/_api/rest/v1/objects-search', null, JSON.stringify(payload));
}

function mapSearchHits(settings, data) {
  const items = (data && data.items) || [];
  return items.map(function (item) {
    return {
      objectId: item.objectId,
      name: item.name,
      extract: item.extract || '',
      href: objectHref(settings.phonemosBaseUrl, item.objectId),
      score: item.score,
    };
  });
}

exports.httpHandler = {
  endpoints: [
    {
      scope: 'issue',
      method: 'POST',
      path: 'list',
      permissions: ['READ_ISSUE'],
      handle: function handle(ctx) {
        const settings = requireSettings(ctx);
        if (!settings.phonemosBaseUrl) {
          return ctx.response.json({
            success: false,
            message: 'Missing app settings: phonemosBaseUrl',
          });
        }
        if (!settings.withinObjectId) {
          return ctx.response.json({
            success: false,
            message:
              'Invalid Phonemos search root. Set the project setting to an object UUID, ' +
              'a 22-character Phonemos slug, or a topic URL like ' +
              'https://showcase.phonemos.cloud/t/{slug}/start.' +
              (settings.withinObjectIdRaw
                ? '\nCurrent value: ' + settings.withinObjectIdRaw
                : ''),
          });
        }

        const body = ctx.request.json() || {};
        if (!body.accessToken) {
          return ctx.response.json({
            success: false,
            message: 'accessToken is required.',
          });
        }

        const query = buildSearchQuery(ctx.issue);
        if (!query) {
          return ctx.response.json({
            success: true,
            query: '',
            mode: 'hybrid',
            items: [],
          });
        }

        let mode = 'hybrid';
        let serviceResponse = searchPhonemos(settings, body.accessToken, query, mode);
        if (!serviceResponse.isSuccess && serviceResponse.code >= 400 && serviceResponse.code < 500) {
          mode = 'fulltext';
          serviceResponse = searchPhonemos(settings, body.accessToken, query, mode);
        }

        if (!serviceResponse.isSuccess) {
          const errBody = serviceResponse.body ? String(serviceResponse.body).substring(0, 300) : '';
          let message =
            'Phonemos search failed with status ' +
            serviceResponse.code +
            (errBody ? ': ' + errBody : '.');
          if (serviceResponse.code === 401 || /unauthorized|invalid.?bearer|invalid.?token/i.test(errBody)) {
            message +=
              '\n\nPhonemos rejected the access token. In Keycloak, open this app’s client → Client scopes ' +
              'and assign the realm scope "hasura" as Default (it adds the Hasura claims Phonemos requires). ' +
              'Also request scope "hasura" (app setting OAuth scopes). Then disconnect/reconnect in the widget.';
            const claimHint = describeAccessTokenClaims(body.accessToken);
            if (claimHint) {
              message += '\n\nToken debug: ' + claimHint;
            }
          }
          return ctx.response.json({
            success: false,
            message: message,
          });
        }

        const data = parseJsonSafe(serviceResponse) || {};
        return ctx.response.json({
          success: true,
          query: query,
          mode: data.mode || mode,
          items: mapSearchHits(settings, data),
        });
      },
    },
  ],
};
