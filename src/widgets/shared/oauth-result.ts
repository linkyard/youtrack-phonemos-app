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
  return Boolean(
    data &&
      typeof data === 'object' &&
      (data as OAuthResultPayload).type === OAUTH_RESULT_TYPE,
  );
}

export function parseOAuthResult(raw: string | null | undefined): OAuthResultPayload | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isOAuthResult(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Same-origin target for opener postMessage (never '*'). */
export function oauthMessageTargetOrigin(): string {
  return window.location.origin;
}

/**
 * Publish the OAuth code to the opener (same-origin) and finish on the YouTrack backend.
 * Avoids BroadcastChannel / localStorage broadcasts that widen code exposure.
 */
export async function publishOAuthResult(
  host: HostWithStorage,
  payload: Omit<OAuthResultPayload, 'type' | 'ts'>,
): Promise<void> {
  const full: OAuthResultPayload = {
    type: OAUTH_RESULT_TYPE,
    ts: Date.now(),
    ...payload,
  };

  try {
    window.name = `phonemos-oauth:${JSON.stringify(full)}`;
  } catch {
    // ignore
  }

  const opener = window.opener || window.top?.opener || null;
  const targetOrigin = oauthMessageTargetOrigin();
  try {
    opener?.postMessage(full, targetOrigin);
  } catch {
    // ignore
  }

  if (host.storage?.setItem) {
    try {
      await host.storage.setItem(OAUTH_STORAGE_KEY, JSON.stringify(full));
    } catch {
      // ignore
    }
  }

  // Most reliable channel: authenticated YouTrack handler, polled by the ticket widget.
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

export async function clearPublishedOAuthResult(host: HostWithStorage): Promise<void> {
  if (host.storage?.removeItem) {
    try {
      await host.storage.removeItem(OAUTH_STORAGE_KEY);
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
    // Keycloak fragment mode: #code=...&state=... (not a path hash)
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
  host: HostWithStorage,
  expectedState: string,
  popup: Window | null,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const expectedOrigin = oauthMessageTargetOrigin();

    const settle = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      fn();
    };

    const accept = (data: OAuthResultPayload) => {
      // Ignore stale results from earlier attempts — never reject/close on mismatch.
      if (!data.state || data.state !== expectedState) {
        return;
      }
      if (data.error) {
        settle(() => reject(new Error(String(data.error))));
        return;
      }
      if (!data.code) {
        settle(() => reject(new Error('OAuth response did not include an authorization code.')));
        return;
      }
      settle(() => {
        void clearPublishedOAuthResult(host);
        resolve(String(data.code));
      });
    };

    const onMessage = (event: MessageEvent) => {
      // Require same origin; state matching below rejects foreign flows.
      if (event.origin !== expectedOrigin) {
        return;
      }
      if (isOAuthResult(event.data)) {
        accept(event.data);
      }
    };

    const readPopupName = (): OAuthResultPayload | null => {
      if (!popup) {
        return null;
      }
      try {
        const raw = String(popup.name || '');
        const prefix = 'phonemos-oauth:';
        if (!raw.startsWith(prefix)) {
          return null;
        }
        return parseOAuthResult(raw.slice(prefix.length));
      } catch {
        // Cross-origin until the callback navigates to about:blank
        return null;
      }
    };

    const poll = window.setInterval(() => {
      void (async () => {
        const fromName = readPopupName();
        if (fromName) {
          accept(fromName);
          return;
        }

        if (host.storage?.getItem) {
          try {
            const stored = parseOAuthResult(await host.storage.getItem(OAUTH_STORAGE_KEY));
            if (stored) {
              accept(stored);
              return;
            }
          } catch {
            // ignore
          }
        }

        if (host.fetchApp) {
          try {
            const pending = await host.fetchApp<{
              success?: boolean;
              pending?: boolean;
              type?: string;
              code?: string | null;
              state?: string | null;
              error?: string | null;
            }>('backend/oauth/pending', {
              method: 'GET',
              query: {state: expectedState},
            });
            if (pending?.success && pending.pending) {
              accept({
                type: OAUTH_RESULT_TYPE,
                code: pending.code,
                state: pending.state,
                error: pending.error,
                ts: Date.now(),
              });
            }
          } catch {
            // ignore
          }
        }
      })();
    }, 300);

    let closedGrace: number | null = null;
    const onPopupCheck = window.setInterval(() => {
      if (!popup || !popup.closed || settled) {
        return;
      }
      if (closedGrace == null) {
        // Give server finalize / storage a moment after the popup closes.
        closedGrace = window.setTimeout(() => {
          settle(() => reject(new Error('Phonemos sign-in was cancelled.')));
        }, 1500);
      }
    }, 300);

    const timeout = window.setTimeout(() => {
      settle(() => reject(new Error('Phonemos sign-in timed out.')));
    }, 5 * 60 * 1000);

    const cleanup = () => {
      window.clearTimeout(timeout);
      window.clearInterval(poll);
      window.clearInterval(onPopupCheck);
      if (closedGrace != null) {
        window.clearTimeout(closedGrace);
      }
      window.removeEventListener('message', onMessage);
      // Do not close the popup here — a parallel session waiter may still need it,
      // and rejecting on stale results must never kill an in-progress login.
    };

    window.addEventListener('message', onMessage);
    void clearPublishedOAuthResult(host);
  });
}
