type HostAPI = Awaited<ReturnType<typeof YTApp.register>>;

type JobResponse = {
  success: boolean;
  pending?: boolean;
  jobId?: string;
};

const POLL_INTERVAL_MS = 400;
const POLL_TIMEOUT_MS = 30000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Start a backend search job and poll its result endpoint until the async function finishes.
 * The backend answers `startPath` with `{pending, jobId}` and `resultPath` with the final response.
 */
export async function runSearchJob<T extends JobResponse>(
  host: HostAPI,
  startPath: string,
  resultPath: string,
  options: {scope: boolean; body: unknown},
): Promise<T> {
  let response = await host.fetchApp<T>(startPath, {method: 'POST', scope: options.scope, body: options.body});
  const jobId = response.jobId;
  if (!response.pending || !jobId) {
    return response;
  }
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await delay(POLL_INTERVAL_MS);
    response = await host.fetchApp<T>(resultPath, {method: 'GET', scope: options.scope, query: {jobId}});
    if (!response.pending) {
      return response;
    }
  }
  throw new Error('Phonemos search timed out. Retry.');
}
