import {clearPublishedOAuthResult, waitForOAuthResult} from '../shared/oauth-result';
import {deriveOAuthCallbackUrl, getRedirectDebugInfo, resolveOAuthRedirectUri} from '../shared/redirect-uri';

type HostAPI = Awaited<ReturnType<typeof YTApp.register>>;

export {deriveOAuthCallbackUrl, getRedirectDebugInfo, resolveOAuthRedirectUri};

export type PhonemosTokens = {
  accessToken: string;
  expiresAt: number | null;
  canRefresh?: boolean;
};

type OAuthConfig = {
  success: boolean;
  message?: string;
  clientId?: string;
  authorizationUrl?: string;
  redirectUri?: string;
  phonemosBaseUrl?: string;
};

type TokenResponse = {
  success: boolean;
  message?: string;
  accessToken?: string;
  expiresIn?: number | null;
  expiresAt?: number | null;
  canRefresh?: boolean;
};

type SessionResponse = {
  success: boolean;
  connected?: boolean;
  accessToken?: string;
  expiresAt?: number | null;
  canRefresh?: boolean;
  message?: string;
};

let memoryTokens: PhonemosTokens | null = null;

function toBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  bytes.forEach((b) => {
    binary += String.fromCharCode(b);
  });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomUrlSafe(bytes = 32): string {
  const array = new Uint8Array(bytes);
  crypto.getRandomValues(array);
  return toBase64Url(array.buffer);
}

async function pkceChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return toBase64Url(digest);
}

function tokensFromResponse(response: TokenResponse | SessionResponse): PhonemosTokens | null {
  if (!response.success || !('accessToken' in response) || !response.accessToken) {
    return null;
  }
  const expiresAt =
    response.expiresAt != null
      ? Number(response.expiresAt)
      : 'expiresIn' in response && response.expiresIn
        ? Date.now() + Number(response.expiresIn) * 1000 - 30_000
        : null;
  return {
    accessToken: response.accessToken,
    expiresAt,
    canRefresh: Boolean(response.canRefresh),
  };
}

function isExpired(tokens: PhonemosTokens): boolean {
  return Boolean(tokens.expiresAt && tokens.expiresAt <= Date.now());
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function getMemoryTokens(): PhonemosTokens | null {
  return memoryTokens;
}

export async function clearPhonemosSession(host: HostAPI): Promise<void> {
  memoryTokens = null;
  try {
    await fetchAppOrThrow(host, 'backend/oauth/logout', {method: 'POST', body: {}});
  } catch {
    // ignore
  }
}

/** @deprecated use clearPhonemosSession */
export function clearMemoryTokens(): void {
  memoryTokens = null;
}

async function refreshServerSession(host: HostAPI): Promise<PhonemosTokens | null> {
  // Refresh token never leaves the YouTrack backend — empty body is enough.
  const refreshed = await fetchAppOrThrow<TokenResponse>(host, 'backend/oauth/refresh', {
    method: 'POST',
    body: {},
  });
  const next = tokensFromResponse(refreshed);
  if (next) {
    memoryTokens = next;
    return next;
  }
  return null;
}

async function fetchSession(host: HostAPI): Promise<PhonemosTokens | null> {
  const session = await fetchAppOrThrow<SessionResponse>(host, 'backend/oauth/session', {method: 'GET'});
  if (!session.success || !session.connected) {
    return null;
  }
  const fromSession = tokensFromResponse(session);
  if (fromSession && !isExpired(fromSession)) {
    memoryTokens = fromSession;
    return fromSession;
  }
  if (session.canRefresh || fromSession?.canRefresh) {
    return refreshServerSession(host);
  }
  return null;
}

export async function loadPhonemosSession(host: HostAPI): Promise<PhonemosTokens | null> {
  if (memoryTokens?.accessToken && !isExpired(memoryTokens)) {
    return memoryTokens;
  }

  try {
    const tokens = await fetchSession(host);
    if (tokens) {
      return tokens;
    }
  } catch {
    // Fall through — treat as signed out.
  }

  memoryTokens = null;
  return null;
}

/**
 * Restore a stored session (and refresh if needed). Does not open the OAuth popup.
 * Returns null when the user still needs to connect.
 */
export async function ensurePhonemosTokens(host: HostAPI): Promise<PhonemosTokens | null> {
  return loadPhonemosSession(host);
}

/**
 * YouTrack widgets run in a sandboxed iframe. Host/API failures are often
 * cross-realm Error-like objects where `instanceof Error` is false, or plain
 * response objects. Always duck-type and JSON-serialize.
 */
export function formatUnknownError(error: unknown): string {
  if (error == null) {
    return String(error);
  }
  if (typeof error === 'string') {
    return error;
  }

  const value = error as Record<string, unknown>;
  const parts: string[] = [];

  if (typeof value.name === 'string' && value.name) {
    parts.push(`name=${value.name}`);
  }
  if (typeof value.message === 'string' && value.message) {
    parts.push(value.message);
  }
  if (value.status != null) {
    parts.push(`status=${String(value.status)}`);
  }
  if (typeof value.statusText === 'string' && value.statusText) {
    parts.push(`statusText=${value.statusText}`);
  }
  if (value.data != null) {
    try {
      parts.push('data=' + JSON.stringify(value.data).slice(0, 1500));
    } catch {
      parts.push('data=(unserializable)');
    }
  }
  for (const key of ['error', 'error_description', 'description', 'error_children', 'errorCode']) {
    if (value[key] != null && key !== 'message') {
      try {
        parts.push(`${key}=${typeof value[key] === 'string' ? value[key] : JSON.stringify(value[key])}`);
      } catch {
        // ignore
      }
    }
  }

  try {
    const json = JSON.stringify(error, Object.getOwnPropertyNames(Object(error)), 2);
    if (json && json !== '{}') {
      parts.push(json.slice(0, 2000));
    }
  } catch {
    // ignore
  }

  if (parts.length) {
    return parts.join('\n');
  }

  try {
    return Object.prototype.toString.call(error) + ' keys=' + Object.keys(value).join(',');
  } catch {
    return String(error);
  }
}

function errorText(error: unknown): string {
  return formatUnknownError(error);
}

async function fetchAppOrThrow<T>(
  host: HostAPI,
  path: string,
  requestParams?: Parameters<HostAPI['fetchApp']>[1],
): Promise<T> {
  try {
    return await host.fetchApp<T>(path, requestParams);
  } catch (e) {
    throw new Error(`${path} failed:\n${formatUnknownError(e)}`);
  }
}

function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

async function waitForSession(
  host: HostAPI,
  popup: Window | null,
  timeoutMs = 5 * 60 * 1000,
): Promise<PhonemosTokens> {
  const started = Date.now();
  let sawClosed = false;
  let closedAt = 0;
  let lastSessionError: string | null = null;
  let polls = 0;

  while (Date.now() - started < timeoutMs) {
    polls += 1;
    try {
      const tokens = await fetchSession(host);
      if (tokens) {
        try {
          popup?.close();
        } catch {
          // ignore
        }
        return tokens;
      }
    } catch (e) {
      lastSessionError = errorText(e);
    }

    if (popup?.closed) {
      if (!sawClosed) {
        sawClosed = true;
        closedAt = Date.now();
      } else if (Date.now() - closedAt > 2500) {
        const last = await fetchSession(host).catch((e) => {
          lastSessionError = errorText(e);
          return null;
        });
        if (last) {
          return last;
        }
        throw new Error(
          [
            'session-path: popup closed without a stored Phonemos session',
            `polls=${polls}`,
            `elapsedMs=${Date.now() - started}`,
            lastSessionError ? `lastSessionError=${lastSessionError}` : 'lastSessionError=(none)',
          ].join('\n'),
        );
      }
    }

    await sleep(400);
  }

  throw new Error(
    [
      'session-path: timed out waiting for oauth/session',
      `polls=${polls}`,
      `elapsedMs=${Date.now() - started}`,
      lastSessionError ? `lastSessionError=${lastSessionError}` : 'lastSessionError=(none)',
    ].join('\n'),
  );
}

export async function connectPhonemos(host: HostAPI): Promise<PhonemosTokens> {
  const debug: string[] = [];
  const pushDebug = (line: string) => {
    debug.push(line);
  };

  try {
    memoryTokens = null;
    await clearPublishedOAuthResult(host);

    const config = await fetchAppOrThrow<OAuthConfig>(host, 'backend/oauth/config', {method: 'GET'});
    if (!config.success) {
      throw new Error(config.message || 'Phonemos OAuth is not configured.');
    }

    let redirectUri: string;
    try {
      redirectUri = resolveOAuthRedirectUri(config.redirectUri);
    } catch (e) {
      throw new Error(
        formatUnknownError(e) + '\n' + getRedirectDebugInfo(),
      );
    }
    pushDebug(`redirectUri=${redirectUri}`);
    pushDebug(`derivedCallback=${deriveOAuthCallbackUrl() || '(none)'}`);

    const state = randomUrlSafe(16);
    const codeVerifier = randomUrlSafe(32);
    const codeChallenge = await pkceChallenge(codeVerifier);
    pushDebug(`statePrefix=${state.slice(0, 8)}…`);
    pushDebug(`codeVerifierLen=${codeVerifier.length}`);
    pushDebug(`codeChallengeLen=${codeChallenge.length}`);

    const authorize = await fetchAppOrThrow<{success: boolean; message?: string; url?: string}>(
      host,
      'backend/oauth/authorize-url',
      {
        method: 'POST',
        body: {
          state,
          code_challenge: codeChallenge,
          code_verifier: codeVerifier,
          redirect_uri: redirectUri,
        },
      },
    );

    if (!authorize.success || !authorize.url) {
      throw new Error(
        [
          authorize.message || 'Unable to start Phonemos sign-in.',
          ...debug,
          `authorizeSuccess=${String(authorize.success)}`,
        ].join('\n'),
      );
    }
    pushDebug(`authorizeUrl=${shortUrl(authorize.url)}`);

    const popup = window.open(authorize.url, 'phonemos-oauth', 'width=480,height=720');
    if (!popup) {
      throw new Error(['Pop-up blocked. Allow pop-ups for YouTrack to connect Phonemos.', ...debug].join('\n'));
    }

    // Some browsers return a Window that is already closed when the pop-up is blocked.
    await sleep(300);
    pushDebug(`popupClosedAfter300ms=${String(popup.closed)}`);
    if (popup.closed) {
      throw new Error(
        ['Pop-up blocked or closed immediately. Allow pop-ups for YouTrack and try again.', ...debug].join('\n'),
      );
    }

    // Primary: popup calls oauth/complete and writes the session (survives widget remount).
    // Secondary: if this frame stays alive, finish via authorization code.
    let settled = false;
    const pathErrors: {path: string; error: string}[] = [];

    const viaSession = waitForSession(host, popup).then((tokens) => {
      settled = true;
      return tokens;
    });

    const viaCode = (async () => {
      const code = await waitForOAuthResult(host, state, popup);
      pushDebug(`codePath: got code len=${String(code).length}`);
      if (settled) {
        const tokens = await fetchSession(host);
        if (!tokens) {
          throw new Error('code-path: session missing after OAuth code handoff (session-path already settled).');
        }
        return tokens;
      }
      const tokenResponse = await fetchAppOrThrow<TokenResponse>(host, 'backend/oauth/token', {
        method: 'POST',
        body: {
          code,
          code_verifier: codeVerifier,
          redirect_uri: redirectUri,
        },
      });
      const tokens = tokensFromResponse(tokenResponse);
      if (!tokens) {
        throw new Error(tokenResponse.message || 'code-path: token exchange failed (no access token).');
      }
      memoryTokens = tokens;
      settled = true;
      try {
        popup.close();
      } catch {
        // ignore
      }
      return tokens;
    })();

    try {
      return await new Promise<PhonemosTokens>((resolve, reject) => {
        let failures = 0;
        const onFail = (path: string, error: unknown) => {
          pathErrors.push({path, error: formatUnknownError(error)});
          failures += 1;
          if (!settled && failures >= 2) {
            reject(new Error('both OAuth completion paths failed'));
          }
        };
        void viaSession.then(resolve, (error) => onFail('session', error));
        void viaCode.then(resolve, (error) => onFail('code', error));
      });
    } catch (e) {
      let sessionSnapshot = 'sessionSnapshot=(unreadable)';
      try {
        const session = await fetchAppOrThrow<SessionResponse>(host, 'backend/oauth/session', {method: 'GET'});
        sessionSnapshot =
          `sessionSuccess=${String(session.success)} connected=${String(!!session.connected)} ` +
          `hasAccessToken=${String(!!session.accessToken)} canRefresh=${String(!!session.canRefresh)}`;
      } catch (sessionError) {
        sessionSnapshot = `sessionSnapshotError=${formatUnknownError(sessionError)}`;
      }

      throw new Error(
        [
          'Phonemos sign-in failed.',
          formatUnknownError(e),
          ...pathErrors.map((entry) => `${entry.path}-path error:\n${entry.error}`),
          sessionSnapshot,
          `popupClosedAtEnd=${String(popup.closed)}`,
          ...debug,
          getRedirectDebugInfo(),
        ].join('\n\n'),
      );
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('Phonemos sign-in failed.')) {
      throw e;
    }
    throw new Error(
      ['Phonemos sign-in failed.', formatUnknownError(e), ...debug, getRedirectDebugInfo()].join('\n\n'),
    );
  }
}
