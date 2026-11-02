import {waitForOAuthResult} from '../shared/oauth-result';
import {deriveOAuthCallbackUrl, getRedirectDebugInfo, resolveOAuthRedirectUri} from '../shared/redirect-uri';

type HostAPI = Awaited<ReturnType<typeof YTApp.register>>;

export {deriveOAuthCallbackUrl, getRedirectDebugInfo, resolveOAuthRedirectUri};

/** Browser-visible session flag — access/refresh tokens never leave the YouTrack backend. */
export type PhonemosSession = {
  connected: true;
  expiresAt: number | null;
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
  connected?: boolean;
  expiresAt?: number | null;
};

type SessionResponse = {
  success: boolean;
  connected?: boolean;
  expiresAt?: number | null;
  message?: string;
};

let memorySession: PhonemosSession | null = null;

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

function sessionFromResponse(response: TokenResponse | SessionResponse): PhonemosSession | null {
  if (!response.success || !response.connected) {
    return null;
  }
  return {
    connected: true,
    expiresAt: response.expiresAt != null ? Number(response.expiresAt) : null,
  };
}

function isExpired(session: PhonemosSession): boolean {
  return Boolean(session.expiresAt && session.expiresAt <= Date.now());
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export async function clearPhonemosSession(host: HostAPI): Promise<void> {
  memorySession = null;
  try {
    await fetchAppOrThrow(host, 'backend/oauth/logout', {method: 'POST', body: {}});
  } catch {
    // ignore
  }
}

export async function ensurePhonemosTokens(host: HostAPI): Promise<PhonemosSession | null> {
  if (memorySession?.connected && !isExpired(memorySession)) {
    return memorySession;
  }

  const session = await fetchAppOrThrow<SessionResponse>(host, 'backend/oauth/ensure-session', {
      method: 'POST',
      body: {}
  });
  if (!session.success || !session.connected) {
    return null;
  }
  const fromSession = sessionFromResponse(session);
  if (fromSession && !isExpired(fromSession)) {
    memorySession = fromSession;
    return fromSession;
  }

  memorySession = null;
  return null;
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

/** Just the plain message, no name=/stack/JSON dump — for short, user-facing summaries. */
function shortErrorMessage(error: unknown): string {
  if (error == null) {
    return String(error);
  }
  if (typeof error === 'string') {
    return error;
  }
  const value = error as Record<string, unknown>;
  if (typeof value.message === 'string' && value.message) {
    return value.message;
  }
  return formatUnknownError(error);
}

/**
 * Thrown by connectPhonemos on failure. `message` is a short, concatenated summary
 * fit for inline display; `details` is the full diagnostic dump (stacks, per-path
 * errors, session snapshot, redirect debug info) for a "show details" view.
 */
export class PhonemosConnectionError extends Error {
  details: string;

  constructor(message: string, details: string) {
    super(message);
    this.name = 'PhonemosConnectionError';
    this.details = details;
  }
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

export async function connectPhonemos(host: HostAPI): Promise<PhonemosSession> {
  const debug: string[] = [];
  const pushDebug = (line: string) => debug.push(line);

  try {
    memorySession = null;

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
          authorize.message || 'Unable to start Phonemos connection.',
          ...debug,
          `authorizeSuccess=${String(authorize.success)}`,
        ].join('\n'),
      );
    }
    pushDebug(`authorizeUrl=${shortUrl(authorize.url)}`);

    // Unique name each attempt. Reusing a fixed name after the callback navigates
    // the previous popup to about:blank can leave Chromium with an empty window
    // that never loads the authorize URL (disconnect → connect hang).
    const popupName = `phonemos-oauth-${state.slice(0, 12)}`;
    const popup = window.open(authorize.url, popupName, 'width=480,height=720');
    if (!popup) {
      throw new Error(['Pop-up blocked. Allow pop-ups for YouTrack to connect Phonemos.', ...debug].join('\n'));
    }

    await sleep(300);
    pushDebug(`popupClosedAfter300ms=${String(popup.closed)}`);
    if (popup.closed) {
      throw new Error(
        ['Pop-up blocked or closed immediately. Allow pop-ups for YouTrack and try again.', ...debug].join('\n'),
      );
    }

    const pathErrors: {path: string; error: unknown}[] = [];

    const viaCode = async () => {
      const code = await waitForOAuthResult(state, popup);
      pushDebug(`codePath: got code len=${String(code).length}`);
      
      const tokenResponse = await fetchAppOrThrow<TokenResponse>(host, 'backend/oauth/new-session', {
        method: 'POST',
        body: {
          state,
          code,
        },
      });

      const session = sessionFromResponse(tokenResponse);
      if (!session) {
        throw new Error(tokenResponse.message || 'code-path: token exchange failed.');
      }
      memorySession = session;
      try {
        popup.close();
      } catch {
        // ignore
      }
      return session;
    };

    try {
      return await viaCode().catch((error) => {
        pathErrors.push({path: 'code', error});
        throw Error('OAuth failed.');
      });
    } catch (e) {

      console.log("error", e);
      let sessionSnapshot = 'sessionSnapshot=(unreadable)';
      try {
        const session = await fetchAppOrThrow<SessionResponse>(host, 'backend/oauth/ensure-session', {method: 'POST', body: {}});
        sessionSnapshot = `sessionSuccess=${String(session.success)} connected=${String(!!session.connected)}`;
      } catch (sessionError) {
        sessionSnapshot = `sessionSnapshotError=${formatUnknownError(sessionError)}`;
      }

      const summary = Array.from(
        new Set([shortErrorMessage(e), ...pathErrors.map((entry) => shortErrorMessage(entry.error))].filter(Boolean)),
      ).join('. ');

      const details = [
        'Phonemos connection failed.',
        formatUnknownError(e),
        ...pathErrors.map((entry) => `${entry.path}-path error:\n${formatUnknownError(entry.error)}`),
        sessionSnapshot,
        `popupClosedAtEnd=${String(popup.closed)}`,
        ...debug,
        getRedirectDebugInfo(),
      ].join('\n\n');

      throw new PhonemosConnectionError(summary || 'Phonemos connection failed.', details);
    }
  } catch (e) {
    if (e instanceof PhonemosConnectionError) {
      throw e;
    }
    throw new PhonemosConnectionError(
      shortErrorMessage(e),
      ['Phonemos connection failed.', formatUnknownError(e), ...debug, getRedirectDebugInfo()].join('\n\n'),
    );
  }
}
