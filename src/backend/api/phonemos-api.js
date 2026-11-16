/**
 * Phonemos REST helpers: object ids, site lookup, and objects-search.
 */
const http = require('@jetbrains/youtrack-scripting-api/http');
const urlSafety = require('./url-safety');

const DEFAULT_SEARCH_LIMIT = 5;
const MAX_QUERY_CHARS = 3500;

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

  const match = raw.match(/\/(?:t|o)\/([A-Za-z0-9_-]{22}|[0-9a-fA-F-]{36})(?:\/|$)/);
  if (match) {
    return normalizeUuid(match[1]) || slugToUuid(match[1]);
  }

  return null;
}

function objectHref(baseUrl, objectId) {
  const slug = uuidToSlug(objectId);
  if (!slug) {
    return urlSafety.trimTrailingSlash(baseUrl) + '/o/' + objectId;
  }
  return urlSafety.trimTrailingSlash(baseUrl) + '/o/' + slug;
}

function resolveSiteObjectId(settings, accessToken) {
  const unsafe = urlSafety.validateOutboundSettings(settings, ['phonemosBaseUrl']);
  if (unsafe) {
    return {ok: false, message: unsafe};
  }
  const connection = new http.Connection(settings.phonemosBaseUrl);
  connection.addHeader('Authorization', 'Bearer ' + accessToken);
  connection.addHeader('Accept', 'application/json');
  const response = connection.getSync('/_api/rest/v1/sites/self', null);
  if (!response || !response.isSuccess) {
    const code = response && response.code != null ? response.code : 'unknown';
    return {
      ok: false,
      status: response && response.code != null ? response.code : 0,
      message: 'Unable to resolve Phonemos site (HTTP ' + code + ').',
    };
  }
  let data = null;
  try {
    data = response.json();
  } catch (e) {
    data = null;
  }
  const objectId = data && (data.objectId || data.id);
  if (!objectId) {
    return {ok: false, message: 'Phonemos /sites/self did not return an objectId.'};
  }
  return {ok: true, objectId: String(objectId)};
}

function searchPhonemos(settings, accessToken, query, mode, objectTypes) {
  const unsafe = urlSafety.validateOutboundSettings(settings, ['phonemosBaseUrl']);
  if (unsafe) {
    return {isSuccess: false, code: 0, body: unsafe};
  }
  const limit = settings.searchLimit != null ? Number(settings.searchLimit) : DEFAULT_SEARCH_LIMIT;
  const safeLimit = isNaN(limit) || limit < 1 ? DEFAULT_SEARCH_LIMIT : Math.min(20, Math.floor(limit));
  const payload = {
    q: query,
    within: settings.withinObjectId,
    mode: mode,
    limit: safeLimit,
  };
  if (objectTypes && objectTypes.length) {
    payload.objectTypes = objectTypes;
  }

  const connection = new http.Connection(settings.phonemosBaseUrl);
  connection.addHeader('Authorization', 'Bearer ' + accessToken);
  connection.addHeader('Content-Type', 'application/json');
  connection.addHeader('Accept', 'application/json');
  return connection.postSync('/_api/rest/v1/objects-search', null, JSON.stringify(payload));
}

function extractHitList(data) {
  if (!data || typeof data !== 'object') {
    return [];
  }
  if (Array.isArray(data.items)) {
    return data.items;
  }
  if (Array.isArray(data.results)) {
    return data.results;
  }
  if (Array.isArray(data.hits)) {
    return data.hits;
  }
  if (Array.isArray(data.objects)) {
    return data.objects;
  }
  return [];
}

function mapSearchHits(settings, data) {
  return extractHitList(data).map(function (item) {
    const objectId = item.objectId || item.id || item.object_id;
    return {
      objectId: objectId,
      name: item.name || item.title || item.label || String(objectId || ''),
      extract: item.extract || item.snippet || item.summary || '',
      href: objectHref(settings.phonemosBaseUrl, objectId),
      score: item.score,
    };
  }).filter(function (item) {
    return !!item.objectId;
  });
}

function runSearchStrategies(settings, accessToken, queries) {
  const strategies = [];
  for (let qi = 0; qi < queries.length; qi++) {
    strategies.push({
      label: queries[qi].label,
      q: queries[qi].q,
      mode: 'hybrid',
      objectTypes: ['wikipage'],
    });
  }
  if (queries.length) {
    strategies.push({
      label: queries[0].label,
      q: queries[0].q,
      mode: 'fulltext',
      objectTypes: ['wikipage'],
    });
    strategies.push({
      label: queries[0].label,
      q: queries[0].q,
      mode: 'hybrid',
      objectTypes: null,
    });
  }

  let lastError = null;
  let anySuccess = false;

  for (let i = 0; i < strategies.length; i++) {
    const strategy = strategies[i];
    const serviceResponse = searchPhonemos(
      settings,
      accessToken,
      strategy.q,
      strategy.mode,
      strategy.objectTypes,
    );

    if (!serviceResponse || !serviceResponse.isSuccess) {
      const status = serviceResponse && serviceResponse.code != null ? serviceResponse.code : 0;
      lastError = {code: status, strategy: strategy};
      continue;
    }

    anySuccess = true;
    const data = parseJsonSafe(serviceResponse) || {};
    const items = mapSearchHits(settings, data);
    if (items.length) {
      return {
        success: true,
        query: strategy.q,
        mode: data.mode || strategy.mode,
        items: items,
      };
    }
  }

  if (lastError && !anySuccess) {
    return {success: false, lastError: lastError};
  }

  return {
    success: true,
    query: queries.length ? queries[0].q : '',
    mode: 'fulltext',
    items: [],
  };
}

function searchText(settings, accessToken, query) {
  const clipped = String(query || '').replace(/\s+/g, ' ').trim();
  if (!clipped) {
    return {
      success: true,
      query: '',
      mode: 'hybrid',
      items: [],
    };
  }
  const q = clipped.length > MAX_QUERY_CHARS ? clipped.substring(0, MAX_QUERY_CHARS) : clipped;
  return runSearchStrategies(settings, accessToken, [{label: 'query', q: q}]);
}

exports.normalizeWithinObjectId = normalizeWithinObjectId;
exports.resolveSiteObjectId = resolveSiteObjectId;
exports.runSearchStrategies = runSearchStrategies;
exports.searchText = searchText;
exports.MAX_QUERY_CHARS = MAX_QUERY_CHARS;
