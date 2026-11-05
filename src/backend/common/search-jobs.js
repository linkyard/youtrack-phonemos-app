/**
 * Per-user search jobs (User extension property phonemosSearchJobs).
 * Search endpoints return a job id and run the Phonemos calls in an async function,
 * because async functions only run after the endpoint has responded. The async
 * function stores the final response here; the widget polls a GET result endpoint.
 */
const JOB_TTL_MS = 5 * 60 * 1000;
const MAX_JOBS = 5;

function userExtensionProperties(ctx) {
  const user = ctx.currentUser;
  return user && user.extensionProperties ? user.extensionProperties : null;
}

function liveJobs(props) {
  let jobs = {};
  try {
    jobs = props.phonemosSearchJobs ? JSON.parse(props.phonemosSearchJobs) || {} : {};
  } catch (e) {
    jobs = {};
  }
  const now = Date.now();
  const live = {};
  Object.keys(jobs).forEach(function (id) {
    const job = jobs[id];
    if (job && job.ts && now - Number(job.ts) <= JOB_TTL_MS) {
      live[id] = job;
    }
  });
  return live;
}

function writeJob(ctx, jobId, job) {
  const props = userExtensionProperties(ctx);
  if (!props) {
    return false;
  }
  const jobs = liveJobs(props);
  jobs[jobId] = job;
  const kept = {};
  Object.keys(jobs)
    .sort(function (a, b) {
      return Number(jobs[b].ts) - Number(jobs[a].ts);
    })
    .slice(0, MAX_JOBS)
    .forEach(function (id) {
      kept[id] = jobs[id];
    });
  props.phonemosSearchJobs = JSON.stringify(kept);
  return true;
}

function createJob(ctx) {
  const jobId = Date.now().toString(36) + Math.random().toString(36).substring(2, 10);
  return writeJob(ctx, jobId, {status: 'pending', ts: Date.now()}) ? jobId : null;
}

function finishJob(ctx, jobId, payload) {
  return writeJob(ctx, String(jobId), {status: 'done', ts: Date.now(), result: payload});
}

function readResult(ctx, jobId) {
  const props = userExtensionProperties(ctx);
  if (!props) {
    return {success: false, needsAuth: true, message: 'Not authenticated.'};
  }
  const job = jobId ? liveJobs(props)[jobId] : null;
  if (!job) {
    return {success: false, message: 'The search result is no longer available. Retry.'};
  }
  if (job.status !== 'done') {
    return {success: true, pending: true, jobId: String(jobId)};
  }
  return job.result;
}

exports.createJob = createJob;
exports.finishJob = finishJob;
exports.readResult = readResult;

