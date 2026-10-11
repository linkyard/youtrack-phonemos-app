/**
 * Global Phonemos search for the main-menu page.
 * Resolves the site via GET /v1/sites/self and searches within that site
 * (everything the connected user can access). No menu search-root setting.
 */
const phonemosSession = require('./phonemos-session');
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
  return {
    phonemosBaseUrl: trimTrailingSlash(s.phonemosBaseUrl),
    oauthClientId: trimSetting(s.oauthClientId),
    oauthClientSecret: s.oauthClientSecret,
    oauthTokenUrl: trimSetting(s.oauthTokenUrl),
    withinObjectId: null,
    searchLimit: 10,
  };
}

exports.httpHandler = {
  endpoints: [
    {
      scope: 'global',
      method: 'POST',
      path: 'query',
      handle: function handle(ctx) {
        phonemosSession.purgeLegacyGlobalSecrets(ctx);
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
          'oauthTokenUrl',
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

        const session = phonemosSession.ensureAccessToken(ctx, settings);
        if (!session.ok) {
          return ctx.response.json({
            success: false,
            needsAuth: true,
            message: session.message || 'Connect to Phonemos first.',
          });
        }

        const site = suggestions.resolveSiteObjectId(settings, session.accessToken);
        if (!site.ok) {
          if (site.status === 401) {
            phonemosSession.disconnectUser(ctx, settings);
            return ctx.response.json({
              success: false,
              needsAuth: true,
              message: 'Phonemos rejected the session. Connect again.',
            });
          }
          return ctx.response.json({success: false, message: site.message});
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
          return ctx.response.json({
            success: false,
            needsAuth: err.code === 401,
            message: message,
          });
        }

        return ctx.response.json({
          success: true,
          query: result.query,
          mode: result.mode,
          items: result.items || [],
          within: site.objectId,
        });
      },
    },
  ],
};
