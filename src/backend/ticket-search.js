/**
 * Issue-scoped ticket search endpoints.
 * Global OAuth endpoints live in authorization.js (YouTrack forbids mixing scopes in one handler).
 * `list` starts the search as an async function and returns a job id; the widget polls `result`.
 */
const oauthSession = require('./oauth-session');
const searchJobs = require('./search-jobs');
const urlSafety = require('./url-safety');
const appSettings = require('./app-settings');
const phonemosApi = require('./phonemos-api');

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

function collapseWs(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function buildSearchQueries(issue) {
  const summary = collapseWs(stripMarkup(issue && issue.summary));
  const description = collapseWs(stripMarkup(issue && issue.description));
  const customerComment = collapseWs(latestReporterComment(issue));

  const queries = [];
  const pushUnique = function (label, q) {
    const value = collapseWs(q);
    if (!value) {
      return;
    }
    const clipped =
      value.length > phonemosApi.MAX_QUERY_CHARS
        ? value.substring(0, phonemosApi.MAX_QUERY_CHARS)
        : value;
    for (let i = 0; i < queries.length; i++) {
      if (queries[i].q === clipped) {
        return;
      }
    }
    queries.push({label: label, q: clipped});
  };

  // Short, high-signal first — hybrid often returns empty for long/noisy ticket text
  // even when a clear title match exists.
  pushUnique('summary', summary);
  if (summary) {
    pushUnique('title', '#' + summary);
  }
  pushUnique(
    'full',
    [summary, description, customerComment].filter(Boolean).join(' '),
  );
  return queries;
}

function searchFailure(ctx, settings, result) {
  const err = result.lastError || {};
  if (err.code === 401) {
    oauthSession.disconnectUser(ctx, settings);
    return {
      success: false,
      needsAuth: true,
      message: 'Phonemos rejected the session. Connect again.',
    };
  }
  return {
    success: false,
    needsAuth: false,
    message: 'Phonemos search failed with status ' + err.code + '.',
  };
}

/** Runs in the runSearch async function; returns the widget response. */
function searchIssue(ctx, settings, queries) {
  const session = oauthSession.ensureAccessToken(ctx, settings);
  if (!session.ok) {
    return {
      success: false,
      needsAuth: true,
      message: session.message || 'Connect to Phonemos first.',
    };
  }

  const result = phonemosApi.runSearchStrategies(settings, session.accessToken, queries);
  if (!result.success) {
    return searchFailure(ctx, settings, result);
  }

  return {
    success: true,
    query: result.query,
    mode: result.mode,
    items: result.items,
  };
}

exports.httpHandler = {
  endpoints: [
    {
      scope: 'issue',
      method: 'POST',
      path: 'list',
      permissions: ['READ_ISSUE'],
      handle: function handle(ctx) {
        const settings = appSettings.loadSettings(ctx);
        if (!settings.phonemosBaseUrl) {
          return ctx.response.json({
            success: false,
            message: 'Missing app settings: phonemosBaseUrl',
          });
        }
        const unsafe = urlSafety.validateOutboundSettings(settings, [
          'phonemosBaseUrl',
          'keycloakBaseUrl',
        ]);
        if (unsafe) {
          return ctx.response.json({success: false, message: unsafe});
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

        if (!oauthSession.readUserTokens(ctx)) {
          return ctx.response.json({success: false, needsAuth: true, message: 'Connect to Phonemos first.'});
        }

        const queries = buildSearchQueries(ctx.issue);
        if (!queries.length) {
          return ctx.response.json({
            success: true,
            query: '',
            mode: 'hybrid',
            items: [],
          });
        }

        const jobId = searchJobs.createJob(ctx);
        if (!jobId) {
          return ctx.response.json({success: false, message: 'Unable to start the Phonemos search.'});
        }
        // ctx.store takes primitives only and must run before invokeAsync.
        ctx.store('jobId', jobId);
        ctx.store('withinObjectId', settings.withinObjectId);
        ctx.store('queries', JSON.stringify(queries));
        ctx.invokeAsync('runSearch');
        return ctx.response.json({success: true, pending: true, jobId: jobId});
      },
    },
    {
      scope: 'issue',
      method: 'GET',
      path: 'result',
      permissions: ['READ_ISSUE'],
      handle: function handle(ctx) {
        return ctx.response.json(searchJobs.readResult(ctx, ctx.request.getParameter('jobId')));
      },
    },
  ],
  asyncFunctions: {
    runSearch: function (ctx) {
      const jobId = ctx.load('jobId');
      let payload;
      try {
        const settings = appSettings.loadSettings(ctx);
        settings.withinObjectId = ctx.load('withinObjectId');
        payload = searchIssue(ctx, settings, JSON.parse(ctx.load('queries')));
      } catch (e) {
        payload = {success: false, message: 'Phonemos search failed unexpectedly.'};
      }
      searchJobs.finishJob(ctx, jobId, payload);
    },
  },
};
