import React, {memo, useCallback, useEffect, useState} from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Input from '@jetbrains/ring-ui-built/components/input/input';
import Link from '@jetbrains/ring-ui-built/components/link/link';
import LoaderInline from '@jetbrains/ring-ui-built/components/loader-inline/loader-inline';

import {publishOAuthResult, readOAuthParamsFromHost} from '../shared/oauth-result';
import {
  clearPhonemosSession,
  connectPhonemos,
  ensurePhonemosTokens,
  formatUnknownError,
} from '../suggested-kb/oauth';

import phonemosLogo from './phonemos-logo-full.svg?url';

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

type SearchHit = {
  objectId: string;
  name: string;
  extract: string;
  href: string;
};

type SearchResponse = {
  success: boolean;
  message?: string;
  needsAuth?: boolean;
  items?: SearchHit[];
};

const AppComponent: React.FunctionComponent = () => {
  const [mode, setMode] = useState<Mode>('checking');
  const [message, setMessage] = useState('Loading…');
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [host, setHost] = useState<Awaited<ReturnType<typeof YTApp.register>> | null>(null);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);

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
      setHits([]);
      setSearched(false);
      setSearchError(null);
      setMode('home');
      setMessage('');
    } catch (e) {
      setMode('error');
      setMessage(formatUnknownError(e));
    } finally {
      setBusy(false);
    }
  };

  const runSearch = async () => {
    if (!host || searching || busy) {
      return;
    }
    const q = query.trim();
    if (!q) {
      return;
    }
    setSearching(true);
    setSearchError(null);
    setSearched(false);
    setHits([]);
    try {
      // MAIN_MENU_ITEM defaults fetchApp to user scope — force global for kb-search.
      const response = await host.fetchApp<SearchResponse>('kb-search/query', {
        method: 'POST',
        scope: false,
        body: {q},
      });
      if (!response.success) {
        if (response.needsAuth) {
          setConnected(false);
          setHits([]);
        }
        setSearchError(response.message || 'Search failed.');
        setSearched(true);
        return;
      }
      setHits(response.items || []);
      setSearched(true);
    } catch (e) {
      setSearchError(formatUnknownError(e));
      setSearched(true);
    } finally {
      setSearching(false);
    }
  };

  const onSearch = async (event: React.FormEvent) => {
    event.preventDefault();
    await runSearch();
  };

  const brandHero = (
    <header className="hero">
      <img className="logo" src={phonemosLogo} alt="Phonemos" width={333} height={72} />
      <p className="lead">
        Search your knowledge base from YouTrack. On tickets, Phonemos also suggests articles from
        the issue text.
      </p>
    </header>
  );

  if (mode === 'checking' || mode === 'completing') {
    return (
      <div className="page">
        <div className="shell">
          {brandHero}
          <div className="panel">
            <div className="row">
              <LoaderInline />
              <p>{message}</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (mode === 'done') {
    return (
      <div className="page">
        <div className="shell">
          {brandHero}
          <div className="panel">
            <p className="empty-state">{message}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="shell">
        {brandHero}

        <section className="panel">
          <div className="panel-header">
            <h2 className="panel-title">Account</h2>
            <div className="status">
              <span className={connected ? 'status-dot on' : 'status-dot'} aria-hidden />
              <p className="status-label">
                {connected ? 'Connected' : 'Not connected'}
              </p>
              {busy ? <LoaderInline /> : null}
            </div>
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
          {!connected && (
            <p className="hint">
              Sign-in from a ticket also works. Keycloak must allow the appResources popup callback
              URL shown under Connect on the ticket widget — not this menu page URL.
            </p>
          )}
        </section>

        {connected && (
          <section className="panel">
            <div className="panel-header">
              <h2 className="panel-title">Search</h2>
            </div>
            <form className="search" onSubmit={(event) => void onSearch(event)}>
              <Input
                value={query}
                placeholder="Search articles, topics, and pages"
                onChange={(event) => setQuery(event.target.value)}
                disabled={searching || busy}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void runSearch();
                  }
                }}
              />
              <Button
                primary
                type="submit"
                disabled={searching || busy || !query.trim() || !host}
                onClick={(event) => {
                  event.preventDefault();
                  void runSearch();
                }}
              >
                Search
              </Button>
            </form>

            {searching && (
              <div className="search-status">
                <LoaderInline />
                <p>Searching…</p>
              </div>
            )}

            {searchError ? <p className="error">{searchError}</p> : null}

            {searched && !searching && !searchError && hits.length === 0 ? (
              <p className="hint">No matching articles</p>
            ) : null}

            {hits.length > 0 && (
              <ul className="results">
                {hits.map((item) => (
                  <li key={item.objectId} className="result">
                    <Link href={item.href} target="_blank" className="result-title">
                      {item.name}
                    </Link>
                    {item.extract ? <p className="extract">{item.extract}</p> : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
    </div>
  );
};

export const App = memo(AppComponent);
