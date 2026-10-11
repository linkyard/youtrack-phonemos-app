import React, {memo, useCallback, useEffect, useState} from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import LoaderInline from '@jetbrains/ring-ui-built/components/loader-inline/loader-inline';

import {publishOAuthResult, readOAuthParamsFromHost} from '../shared/oauth-result';
import {
  clearPhonemosSession,
  connectPhonemos,
  ensurePhonemosTokens,
  formatUnknownError,
} from '../suggested-kb/oauth';

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

function hasOAuthResponse(params: URLSearchParams): boolean {
  return Boolean(params.get('code') || params.get('error') || params.get('error_description'));
}

type Mode = 'checking' | 'home' | 'completing' | 'done' | 'error';

const AppComponent: React.FunctionComponent = () => {
  const [mode, setMode] = useState<Mode>('checking');
  const [message, setMessage] = useState('Loading…');
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [host, setHost] = useState<Awaited<ReturnType<typeof YTApp.register>> | null>(null);

  const refreshConnection = useCallback(async (api: Awaited<ReturnType<typeof YTApp.register>>) => {
    const session = await ensurePhonemosTokens(api);
    setConnected(Boolean(session));
  }, []);

  useEffect(() => {
    let cancelled = false;
    let completed = false;

    const finishWithParams = async (
      params: URLSearchParams,
      api?: Awaited<ReturnType<typeof YTApp.register>>,
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
      setMode('completing');
      setMessage('Completing Phonemos sign-in…');

      if (api) {
        await publishOAuthResult(api, {code, state, error});
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
      setMode('done');
      setMessage(error ? `Sign-in failed: ${error}` : 'Signed in. You can close this window.');
      closePopup();
    };

    void (async () => {
      try {
        // OAuth redirect with code/error — keep the callback path intact.
        if (hasOAuthResponse(readStandaloneParams())) {
          await finishWithParams(readStandaloneParams());
          if (completed || cancelled) {
            return;
          }
        }

        if (typeof YTApp === 'undefined') {
          setMode('home');
          setMessage('Open Phonemos from a YouTrack ticket to connect and see article suggestions.');
          return;
        }

        let api!: Awaited<ReturnType<typeof YTApp.register>>;
        api = await YTApp.register({
          onAppLocationChange: (location) => {
            void finishWithParams(paramsFromLocation(location), api);
          },
        });
        if (cancelled) {
          return;
        }
        setHost(api);

        // Brief wait in case Keycloak landed on /app/phonemos/oauth-callback?... via Host navigation.
        const started = Date.now();
        while (!cancelled && !completed && Date.now() - started < 1_500) {
          const params = await readOAuthParamsFromHost(api);
          if (hasOAuthResponse(params)) {
            await finishWithParams(params, api);
            if (completed) {
              return;
            }
          }
          await new Promise((resolve) => window.setTimeout(resolve, 200));
        }

        if (cancelled || completed) {
          return;
        }

        await refreshConnection(api);
        if (!cancelled) {
          setMode('home');
        }
      } catch (e) {
        if (!cancelled) {
          setMode('error');
          setMessage(e instanceof Error ? e.message : 'Unable to open Phonemos.');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [refreshConnection]);

  const onConnect = async () => {
    if (!host || busy) {
      return;
    }
    setBusy(true);
    setMessage('');
    try {
      await connectPhonemos(host);
      await refreshConnection(host);
      setMode('home');
    } catch (e) {
      setMode('error');
      setMessage(formatUnknownError(e));
    } finally {
      setBusy(false);
    }
  };

  const onDisconnect = async () => {
    if (!host || busy) {
      return;
    }
    setBusy(true);
    try {
      await clearPhonemosSession(host);
      setConnected(false);
      setMode('home');
      setMessage('');
    } catch (e) {
      setMode('error');
      setMessage(formatUnknownError(e));
    } finally {
      setBusy(false);
    }
  };

  if (mode === 'checking' || mode === 'completing') {
    return (
      <div className="page">
        <h1>Phonemos</h1>
        <div className="row">
          <LoaderInline />
          <p>{message}</p>
        </div>
      </div>
    );
  }

  if (mode === 'done') {
    return (
      <div className="page">
        <h1>Phonemos</h1>
        <p>{message}</p>
      </div>
    );
  }

  return (
    <div className="page">
      <h1>Phonemos</h1>
      <p className="lead">
        Knowledge base suggestions for YouTrack Helpdesk. Open a ticket to see matching Phonemos
        articles under the description.
      </p>

      <div className="status">
        <p className={connected ? 'status-ok' : 'status-muted'}>
          {connected ? 'Connected to Phonemos' : 'Not connected'}
        </p>
        {busy ? <LoaderInline /> : null}
      </div>

      <div className="actions">
        {connected ? (
          <Button onClick={() => void onDisconnect()} disabled={busy || !host}>
            Disconnect
          </Button>
        ) : (
          <Button primary onClick={() => void onConnect()} disabled={busy || !host}>
            Connect to Phonemos
          </Button>
        )}
      </div>

      {mode === 'error' && message ? <p className="error">{message}</p> : null}

      <p className="hint">
        Sign-in from a ticket also works. Keycloak must allow the appResources popup callback URL
        shown under Connect on the ticket widget — not this menu page URL.
      </p>
    </div>
  );
};

export const App = memo(AppComponent);
