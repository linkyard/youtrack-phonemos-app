import {waitForOAuthResult} from '../shared/oauth-result';
import {deriveOAuthCallbackUrl, getRedirectDebugInfo, resolveOAuthRedirectUri} from '../shared/redirect-uri';

type HostAPI = Awaited<ReturnType<typeof YTApp.register>>;

export {deriveOAuthCallbackUrl, getRedirectDebugInfo, resolveOAuthRedirectUri};

export type PhonemosTokens = {
  accessToken: string;
  refreshToken: string | null;
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
  accessToken?: string;
  refreshToken?: string | null;
  expiresIn?: number | null;
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

function tokensFromResponse(response: TokenResponse): PhonemosTokens | null {
  if (!response.success || !response.accessToken) {
    return null;
  }
  return {
    accessToken: response.accessToken,
    refreshToken: response.refreshToken ?? null,
    expiresAt: response.expiresIn
      ? Date.now() + Number(response.expiresIn) * 1000 - 30_000
      : null,
  };
}

export function getMemoryTokens(): PhonemosTokens | null {
  return memoryTokens;
}

export function clearMemoryTokens(): void {
  memoryTokens = null;
}

export async function ensurePhonemosTokens(host: HostAPI): Promise<PhonemosTokens> {
  if (memoryTokens?.accessToken) {
    if (!memoryTokens.expiresAt || memoryTokens.expiresAt > Date.now()) {
      return memoryTokens;
    }
    if (memoryTokens.refreshToken) {
      const refreshed = await host.fetchApp<TokenResponse>('backend/oauth/refresh', {
        method: 'POST',
        body: {refreshToken: memoryTokens.refreshToken},
      });
      const next = tokensFromResponse(refreshed);
      if (next) {
        memoryTokens = next;
        return next;
      }
    }
    memoryTokens = null;
  }
  return connectPhonemos(host);
}

export async function connectPhonemos(host: HostAPI): Promise<PhonemosTokens> {
  const config = await host.fetchApp<OAuthConfig>('backend/oauth/config', {method: 'GET'});
  if (!config.success) {
    throw new Error(config.message || 'Phonemos OAuth is not configured.');
  }

  let redirectUri: string;
  try {
    redirectUri = resolveOAuthRedirectUri(config.redirectUri);
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : 'OAuth redirect URI is not configured.');
  }

  const state = randomUrlSafe(16);
  const codeVerifier = randomUrlSafe(32);
  const codeChallenge = await pkceChallenge(codeVerifier);

  const authorize = await host.fetchApp<{success: boolean; message?: string; url?: string}>(
    'backend/oauth/authorize-url',
    {
      method: 'GET',
      query: {
        state,
        code_challenge: codeChallenge,
        redirect_uri: redirectUri,
      },
    },
  );

  if (!authorize.success || !authorize.url) {
    throw new Error(authorize.message || 'Unable to start Phonemos sign-in.');
  }

  const popup = window.open(authorize.url, 'phonemos-oauth', 'width=480,height=720');
  if (!popup) {
    throw new Error('Pop-up blocked. Allow pop-ups for YouTrack to connect Phonemos.');
  }

  const code = await waitForOAuthResult(host, state, popup);
  const tokenResponse = await host.fetchApp<TokenResponse>('backend/oauth/token', {
    method: 'POST',
    body: {
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
    },
  });

  const tokens = tokensFromResponse(tokenResponse);
  if (!tokens) {
    throw new Error(tokenResponse.message || 'Phonemos sign-in failed.');
  }
  memoryTokens = tokens;
  return tokens;
}
