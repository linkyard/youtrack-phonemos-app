export const OAUTH_RESULT_TYPE = 'phonemos:oauth';
export const OAUTH_BROADCAST_CHANNEL = 'phonemos-oauth';
export const OAUTH_STORAGE_KEY = 'phonemos:oauth-result';
export const OAUTH_LOCAL_STORAGE_KEY = 'phonemos:oauth-result';

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
    requestParams?: {method?: string; query?: Record<string, string>},
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

export async function publishOAuthResult(
  host: HostWithStorage,
  payload: Omit<OAuthResultPayload, 'type' | 'ts'>,
): Promise<void> {
  const full: OAuthResultPayload = {
    type: OAUTH_RESULT_TYPE,
    ts: Date.now(),
    ...payload,
  };

  const opener = window.opener || window.top?.opener || null;
  try {
    opener?.postMessage(full, '*');
  } catch {
    // ignore
  }

  try {
    window.parent?.postMessage(full, '*');
  } catch {
    // ignore
  }

  try {
    const channel = new BroadcastChannel(OAUTH_BROADCAST_CHANNEL);
    channel.postMessage(full);
    channel.close();
  } catch {
    // ignore
  }

  try {
    localStorage.setItem(OAUTH_LOCAL_STORAGE_KEY, JSON.stringify(full));
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
}

export async function clearPublishedOAuthResult(host: HostWithStorage): Promise<void> {
  try {
    localStorage.removeItem(OAUTH_LOCAL_STORAGE_KEY);
  } catch {
    // ignore
  }
  if (host.storage?.removeItem) {
    try {
      await host.storage.removeItem(OAUTH_STORAGE_KEY);
    } catch {
      // ignore
    }
  }
}

export async function readOAuthParamsFromHost(host: HostWithStorage): Promise<URLSearchParams> {
  if (host.navigation?.getAppLocation) {
    const appLocation = await host.navigation.getAppLocation();
    const fromSearch = new URLSearchParams(appLocation.search || '');
    if (fromSearch.get('code') || fromSearch.get('error') || fromSearch.get('state')) {
      return fromSearch;
    }
    if (appLocation.hash) {
      const hash = appLocation.hash.startsWith('#') ? appLocation.hash.slice(1) : appLocation.hash;
      const fromHash = new URLSearchParams(hash.includes('=') ? hash : hash.replace(/^\/?/, ''));
      if (fromHash.get('code') || fromHash.get('error') || fromHash.get('state')) {
        return fromHash;
      }
    }
  }

  try {
    const topSearch = window.top?.location.search;
    if (topSearch) {
      return new URLSearchParams(topSearch);
    }
  } catch {
    // Cross-origin
  }

  return new URLSearchParams(window.location.search);
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

    const settle = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      fn();
    };

    const accept = (data: OAuthResultPayload) => {
      if (data.state && data.state !== expectedState) {
        settle(() => reject(new Error('OAuth state mismatch.')));
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
      if (isOAuthResult(event.data)) {
        accept(event.data);
      }
    };

    let channel: BroadcastChannel | null = null;
    try {
      channel = new BroadcastChannel(OAUTH_BROADCAST_CHANNEL);
      channel.onmessage = (event) => {
        if (isOAuthResult(event.data)) {
          accept(event.data);
        }
      };
    } catch {
      channel = null;
    }

    const onStorage = (event: StorageEvent) => {
      if (event.key !== OAUTH_LOCAL_STORAGE_KEY) {
        return;
      }
      const parsed = parseOAuthResult(event.newValue);
      if (parsed) {
        accept(parsed);
      }
    };

    const poll = window.setInterval(() => {
      void (async () => {
        try {
          const local = parseOAuthResult(localStorage.getItem(OAUTH_LOCAL_STORAGE_KEY));
          if (local && (!local.state || local.state === expectedState)) {
            accept(local);
            return;
          }
        } catch {
          // ignore
        }

        if (host.storage?.getItem) {
          try {
            const stored = parseOAuthResult(await host.storage.getItem(OAUTH_STORAGE_KEY));
            if (stored && (!stored.state || stored.state === expectedState)) {
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
        // Give storage/broadcast a moment after the popup closes.
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
      window.removeEventListener('storage', onStorage);
      try {
        channel?.close();
      } catch {
        // ignore
      }
      try {
        popup?.close();
      } catch {
        // ignore
      }
    };

    window.addEventListener('message', onMessage);
    window.addEventListener('storage', onStorage);
    void clearPublishedOAuthResult(host);
  });
}
