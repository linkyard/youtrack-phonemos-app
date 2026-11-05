export const OAUTH_RESULT_TYPE = 'phonemos:oauth';

export type OAuthResultPayload = {
  type: typeof OAUTH_RESULT_TYPE;
  code?: string | null;
  state?: string | null;
  error?: string | null;
  ts: number;
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
    } catch {
      // ignore
    }
  }
  return null;
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
