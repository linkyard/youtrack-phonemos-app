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
        const missing = missingSettings(settings, ['phonemosBaseUrl', 'withinObjectId']);
        if (missing.length) {
          return ctx.response.json({
            success: false,
            message: 'Missing app settings: ' + missing.join(', '),
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
          return ctx.response.json({
            success: false,
            message: 'Phonemos search failed with status ' + serviceResponse.code +
              (errBody ? ': ' + errBody : '.'),
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
