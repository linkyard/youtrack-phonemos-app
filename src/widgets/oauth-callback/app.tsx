import React, {memo, useEffect, useState} from 'react';

import {publishOAuthResult, readOAuthParamsFromHost} from '../shared/oauth-result';

function closePopup(): void {
  window.setTimeout(() => {
    try {
      window.top?.close();
    } catch {
      // ignore
    }
    try {
      window.close();
    } catch {
      // ignore
    }
  }, 500);
}

function paramsFromLocation(location: {search?: string; hash?: string} | null | undefined): URLSearchParams {
  if (!location) {
    return new URLSearchParams();
  }
  const fromSearch = new URLSearchParams(location.search || '');
  if (fromSearch.get('code') || fromSearch.get('error') || fromSearch.get('state')) {
    return fromSearch;
  }
  if (location.hash) {
    const hash = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
    if (hash.includes('=')) {
      return new URLSearchParams(hash);
    }
  }
  return fromSearch;
}

function readStandaloneParams(): URLSearchParams {
  return paramsFromLocation({
    search: window.location.search,
    hash: window.location.hash,
  });
}

const AppComponent: React.FunctionComponent = () => {
  const [message, setMessage] = useState('Completing Phonemos sign-in…');

  useEffect(() => {
    let cancelled = false;
    let completed = false;

    const finishWithParams = async (
      params: URLSearchParams,
      host?: Awaited<ReturnType<typeof YTApp.register>>,
    ) => {
      if (cancelled || completed) {
        return;
      }
      const code = params.get('code');
      const state = params.get('state');
      const error = params.get('error_description') || params.get('error');
      if (!(code || error)) {
        return;
      }
      completed = true;

      if (host) {
        await publishOAuthResult(host, {code, state, error});
      } else {
        // Standalone static HTML (Keycloak redirected here top-level).
        const payload = {
          type: 'phonemos:oauth' as const,
          code,
          state,
          error,
          ts: Date.now(),
        };
        try {
          window.name = `phonemos-oauth:${JSON.stringify(payload)}`;
        } catch {
          // ignore
        }
        try {
          (window.opener || window.top?.opener)?.postMessage(payload, window.location.origin);
        } catch {
          // ignore
        }
      }

      if (cancelled) {
        return;
      }
      setMessage(error ? `Sign-in failed: ${error}` : 'Signed in. You can close this window.');
      closePopup();
    };

    void (async () => {
      try {
        // 1) Top-level redirect onto this HTML file (preferred).
        await finishWithParams(readStandaloneParams());
        if (completed || cancelled) {
          return;
        }

        // 2) Embedded in YouTrack app shell — try Host API navigation.
        if (typeof YTApp === 'undefined') {
          setMessage('No authorization response found. You can close this window.');
          return;
        }

        let host!: Awaited<ReturnType<typeof YTApp.register>>;
        host = await YTApp.register({
          onAppLocationChange: (location) => {
            void finishWithParams(paramsFromLocation(location), host);
          },
        });

        const started = Date.now();
        while (!cancelled && !completed && Date.now() - started < 8_000) {
          await finishWithParams(await readOAuthParamsFromHost(host), host);
          if (completed) {
            return;
          }
          await new Promise((resolve) => window.setTimeout(resolve, 200));
        }

        if (!cancelled && !completed) {
          setMessage(
            'This page completes Phonemos sign-in. Connect from a ticket — Keycloak must redirect to the oauth-callback widget HTML URL (not /app/phonemos/...).',
          );
        }
      } catch (e) {
        if (!cancelled) {
          setMessage(e instanceof Error ? e.message : 'Unable to complete Phonemos sign-in.');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="callback">
      <h1>Phonemos</h1>
      <p>{message}</p>
    </div>
  );
};

export const App = memo(AppComponent);
