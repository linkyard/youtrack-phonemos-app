/**
 * Global Phonemos search for the main-menu page.
 * Resolves the site via GET /v1/sites/self and searches within that site
 * (everything the connected user can access). No menu search-root setting.
 * `query` starts the search as an async function and returns a job id; the widget polls `result`.
 */
const phonemosSession = require('./phonemos-session');
const searchJobs = require('./search-jobs');
const urlSafety = require('./url-safety');
const suggestions = require('./suggestions');

const MAX_QUERY_CHARS = 500;

function trimTrailingSlash(url) {
  return String(url || '').replace(/\/+$/, '');
}

function trimSetting(value) {
  return value == null ? '' : String(value).trim();
}

function menuSettings(ctx) {
  const s = ctx.settings || {};
  const keycloak = urlSafety.keycloakEndpoints(s.keycloakBaseUrl);
  return {
    phonemosBaseUrl: trimTrailingSlash(s.phonemosBaseUrl),
    oauthClientId: trimSetting(s.oauthClientId),
    oauthClientSecret: s.oauthClientSecret,
    keycloakBaseUrl: urlSafety.normalizeKeycloakBaseUrl(s.keycloakBaseUrl),
    oauthTokenUrl: keycloak.tokenUrl,
    oauthRevokeUrl: keycloak.revokeUrl,
    withinObjectId: null,
    searchLimit: 10,
  };
}

/** Runs in the runSearch async function; returns the widget response. */
function searchSite(ctx, settings, query) {
  const session = phonemosSession.ensureAccessToken(ctx, settings);
  if (!session.ok) {
    return {
      success: false,
      needsAuth: true,
      message: session.message || 'Connect to Phonemos first.',
    };
  }

  const site = suggestions.resolveSiteObjectId(settings, session.accessToken);
  if (!site.ok) {
    if (site.status === 401) {
      phonemosSession.disconnectUser(ctx, settings);
      return {
        success: false,
        needsAuth: true,
        message: 'Phonemos rejected the session. Connect again.',
      };
    }
    return {success: false, message: site.message};
  }
  settings.withinObjectId = site.objectId;

  const result = suggestions.searchText(settings, session.accessToken, query);
  if (!result.success) {
    const err = result.lastError || {};
    let message = 'Phonemos search failed with status ' + err.code + '.';
    if (err.code === 401) {
      phonemosSession.disconnectUser(ctx, settings);
      message = 'Phonemos rejected the session. Connect again.';
    }
    return {
      success: false,
      needsAuth: err.code === 401,
      message: message,
    };
  }

  return {
    success: true,
    query: result.query,
    mode: result.mode,
    items: result.items || [],
    within: site.objectId,
  };
}

exports.httpHandler = {
  endpoints: [
    {
      scope: 'global',
      method: 'POST',
      path: 'query',
      handle: function handle(ctx) {
        const authError = phonemosSession.requireInteractiveUser(ctx);
        if (authError) {
          return ctx.response.json({success: false, needsAuth: true, message: authError});
        }

        const settings = menuSettings(ctx);
        if (!settings.phonemosBaseUrl) {
          return ctx.response.json({
            success: false,
            message: 'Missing app setting: Phonemos base URL.',
          });
        }
        const unsafe = urlSafety.validateOutboundSettings(settings, [
          'phonemosBaseUrl',
          'keycloakBaseUrl',
        ]);
        if (unsafe) {
          return ctx.response.json({success: false, message: unsafe});
        }

        const body = ctx.request.json() || {};
        const query = String(body.q == null ? '' : body.q).replace(/\s+/g, ' ').trim();
        if (!query) {
          return ctx.response.json({success: false, message: 'Enter a search query.'});
        }
        if (query.length > MAX_QUERY_CHARS) {
          return ctx.response.json({
            success: false,
            message: 'Search query is limited to ' + MAX_QUERY_CHARS + ' characters.',
          });
        }

        if (!phonemosSession.readUserTokens(ctx)) {
          return ctx.response.json({success: false, needsAuth: true, message: 'Connect to Phonemos first.'});
        }

        const jobId = searchJobs.createJob(ctx);
        if (!jobId) {
          return ctx.response.json({success: false, message: 'Unable to start the Phonemos search.'});
        }
        // ctx.store takes primitives only and must run before invokeAsync.
        ctx.store('jobId', jobId);
        ctx.store('query', query);
        ctx.invokeAsync('runSearch');
        return ctx.response.json({success: true, pending: true, jobId: jobId});
      },
    },
    {
      scope: 'global',
      method: 'GET',
      path: 'result',
      handle: function handle(ctx) {
        const authError = phonemosSession.requireInteractiveUser(ctx);
        if (authError) {
          return ctx.response.json({success: false, needsAuth: true, message: authError});
        }
        return ctx.response.json(searchJobs.readResult(ctx, ctx.request.getParameter('jobId')));
      },
    },
  ],
  asyncFunctions: {
    runSearch: function (ctx) {
      const jobId = ctx.load('jobId');
      let payload;
      try {
        payload = searchSite(ctx, menuSettings(ctx), ctx.load('query'));
      } catch (e) {
        payload = {success: false, message: 'Phonemos search failed unexpectedly.'};
      }
      searchJobs.finishJob(ctx, jobId, payload);
    },
  },
};
