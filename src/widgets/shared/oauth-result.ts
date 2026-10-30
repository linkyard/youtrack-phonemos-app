export const OAUTH_RESULT_TYPE = 'phonemos:oauth';
export const OAUTH_STORAGE_KEY = 'phonemos:oauth-result';

export type OAuthResultPayload = {
  type: typeof OAUTH_RESULT_TYPE;
  code?: string | null;
  state?: string | null;
  error?: string | null;
  ts: number;
};

type HostWithStorage = {
  fetchApp?: <T = unknown>(
    relativeURL: string,
    requestParams?: {
      method?: string;
      query?: Record<string, string>;
      body?: unknown;
    },
  ) => Promise<T>;
  storage?: {
    getItem: (key: string) => Promise<string | null>;
    setItem: (key: string, value: string) => Promise<void>;
    removeItem: (key: string) => Promise<void>;
  };
  navigation?: {
    getAppLocation: () => Promise<{pathname: string; search: string; hash: string}>;
  };
};

export function isOAuthResult(data: unknown): data is OAuthResultPayload {
  return Boolean(data && typeof data === 'object' && (data as OAuthResultPayload).type === OAUTH_RESULT_TYPE);
}

/** Origin of the YouTrack host (from baseURI), not the widget's about:srcdoc origin. */
export function youTrackHostOrigin(): string | null {
  for (const candidate of [document.baseURI, window.location.href]) {
    if (!candidate || candidate.startsWith('about:')) {
      continue;
    }
    try {
      return new URL(candidate).origin;
    } catch { }
  }
  return null;
}

export async function publishOAuthResult(
  host: HostWithStorage,
  payload: Omit<OAuthResultPayload, 'type' | 'ts'>,
): Promise<void> {
  const full: OAuthResultPayload = {
    type: OAUTH_RESULT_TYPE,
    ts: Date.now(),
    ...payload,
  };

  if (host.fetchApp && full.state) {
    try {
      await host.fetchApp('backend/oauth/complete', {
        method: 'POST',
        body: {
          code: full.code ?? null,
          state: full.state,
          error: full.error ?? null,
        },
      });
    } catch {
      // ignore
    }
  }
}

function paramsFromQueryOrHash(search: string, hash: string): URLSearchParams {
  const fromSearch = new URLSearchParams(search || '');
  if (fromSearch.get('code') || fromSearch.get('error') || fromSearch.get('state')) {
    return fromSearch;
  }
  if (hash) {
    const raw = hash.startsWith('#') ? hash.slice(1) : hash;
    if (raw.includes('=')) {
      return new URLSearchParams(raw);
    }
  }
  return fromSearch;
}

export async function readOAuthParamsFromHost(host: HostWithStorage): Promise<URLSearchParams> {
  if (host.navigation?.getAppLocation) {
    const appLocation = await host.navigation.getAppLocation();
    const fromApp = paramsFromQueryOrHash(appLocation.search || '', appLocation.hash || '');
    if (fromApp.get('code') || fromApp.get('error') || fromApp.get('state')) {
      return fromApp;
    }
  }

  try {
    const top = window.top;
    if (top) {
      const fromTop = paramsFromQueryOrHash(top.location.search || '', top.location.hash || '');
      if (fromTop.get('code') || fromTop.get('error') || fromTop.get('state')) {
        return fromTop;
      }
    }
  } catch {
    // Cross-origin access to the YouTrack host frame is blocked.
  }

  return paramsFromQueryOrHash(window.location.search || '', window.location.hash || '');
}

export async function waitForOAuthParams(
  host: HostWithStorage,
  timeoutMs = 15_000,
): Promise<URLSearchParams> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const params = await readOAuthParamsFromHost(host);
    if (params.get('code') || params.get('error') || params.get('error_description')) {
      return params;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 200));
  }
  return readOAuthParamsFromHost(host);
}

export function waitForOAuthResult(
  expectedState: string,
  popup: Window | null,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const hostOrigin = youTrackHostOrigin();

    const onMessage = (event: MessageEvent) => {
      const data: OAuthResultPayload = event.data;
      if (!isOAuthResult(data)) {
        return;
      }

      const fromPopup = Boolean(popup && event.source === popup);
      const fromHost = Boolean(hostOrigin && event.origin === hostOrigin);
      if (!fromPopup && !fromHost) {
        console.error('Event source and origin cannot be confirmed.', fromHost, fromPopup);
        return;
      }
      // Ignore stale results from earlier attempts — never reject/close on mismatch.
      if (!data.state || data.state !== expectedState) {
        console.error('Skipping stale result');
        return;
      }

      if (data.error) {
        reject(new Error(String(data.error)));
        cleanup();
        return;
      }
      if (!data.code) {
        reject(new Error('OAuth response did not include an authorization code'));
        cleanup();
        return;
      }
      
      resolve(String(data.code));
      cleanup();
    };

    let closedGrace: number | null = null;
    const onPopupCheck = window.setInterval(() => {
      if (!popup || !popup.closed) {
        return;
      }
      if (closedGrace == null) {
        closedGrace = window.setTimeout(() => {
          reject(new Error('Phonemos connection was cancelled.'));
          cleanup();
        }, 4000);
      }
    }, 200);

    const timeoutConnection = window.setTimeout(() => {
      reject(new Error('Phonemos connection timed out.'));
      cleanup();
    }, 5 * 60 * 1000);

    const cleanup = () => {
      window.clearTimeout(timeoutConnection);
      window.clearInterval(onPopupCheck);
      if (closedGrace != null) {
        window.clearTimeout(closedGrace);
      }
      window.removeEventListener('message', onMessage);
    };

    window.addEventListener('message', onMessage);
  });
}
