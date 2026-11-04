import React, {memo, useCallback, useEffect, useState} from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Dialog from '@jetbrains/ring-ui-built/components/dialog/dialog';
import Input from '@jetbrains/ring-ui-built/components/input/input';
import Link from '@jetbrains/ring-ui-built/components/link/link';
import LoaderInline from '@jetbrains/ring-ui-built/components/loader-inline/loader-inline';

import {
  clearPhonemosSession,
  connectPhonemos,
  ensurePhonemosTokens,
  formatUnknownError,
  PhonemosConnectionError,
} from '../common/oauth';
import {runSearchJob} from '../common/search-job';

import phonemosLogo from './phonemos-logo-full.svg?url';
import phonemosLogoDark from './phonemos-logo-full-dark.svg?url';

type Mode = 'checking' | 'home' | 'error';

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
  pending?: boolean;
  jobId?: string;
  items?: SearchHit[];
};

const PhonemosLogo = () => (
  <>
    <img className="logo logo-light" src={phonemosLogo} alt="Phonemos" width={333} height={72} />
    <img className="logo logo-dark" src={phonemosLogoDark} alt="Phonemos" width={333} height={72} />
  </>
);

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
  const [errorDetails, setErrorDetails] = useState<string | null>(null);
  const [showErrorDetails, setShowErrorDetails] = useState(false);

  const refreshConnection = useCallback(async (api: Awaited<ReturnType<typeof YTApp.register>>) => {
    const session = await ensurePhonemosTokens(api);
    setConnected(Boolean(session));
  }, []);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        if (typeof YTApp === 'undefined') {
          setMode('home');
          setMessage('This page is the Phonemos search menu. Open it from the YouTrack main menu.');
          return;
        }

        const api = await YTApp.register();
        if (cancelled) {
          return;
        }
        setHost(api);
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
    setErrorDetails(null);
    try {
      await connectPhonemos(host);
      await refreshConnection(host);
      setMode('home');
    } catch (e) {
      setMode('error');
      if (e instanceof PhonemosConnectionError) {
        setMessage(e.message);
        setErrorDetails(e.details);
      } else {
        setMessage(formatUnknownError(e));
      }
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
      setErrorDetails(null);
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
      // MAIN_MENU_ITEM defaults fetchApp to user scope — force global for the search handler.
      const response = await runSearchJob<SearchResponse>(host, 'global-search/query', 'global-search/result', {
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

  const accountBar = (
    <div className="account">
      <div className="status">
        <span className={connected ? 'status-dot on' : 'status-dot'} aria-hidden />
        <p className="status-label">{connected ? 'Connected' : 'Not connected'}</p>
        {busy ? <LoaderInline /> : null}
      </div>
      {connected ? (
        <Button text onClick={() => void onDisconnect()} disabled={busy || !host}>
          Disconnect
        </Button>
      ) : (
        <Button primary onClick={() => void onConnect()} disabled={busy || !host}>
          Connect
        </Button>
      )}
    </div>
  );

  const brandHero = (
    <header className="hero">
      <div className="hero-main">
        <PhonemosLogo/>
        <p className="lead">
          Search your knowledge base from YouTrack. On tickets, Phonemos also suggests articles from
          the issue text.
        </p>
      </div>
      {accountBar}
    </header>
  );

  if (mode === 'checking') {
    return (
      <div className="page">
        <div className="shell">
          <header className="hero">
            <div className="hero-main">
              <PhonemosLogo/>
            </div>
          </header>
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

  return (
    <div className="page">
      <div className="shell">
        {brandHero}

        {mode === 'error' && message ? (
          <div className="error-row banner-error">
            <p className="error">{message}</p>
            {errorDetails && (
              <Button text onClick={() => setShowErrorDetails(true)}>
                Details
              </Button>
            )}
          </div>
        ) : null}

        {errorDetails && (
          <Dialog
            show={showErrorDetails}
            label="Connection error details"
            showCloseButton
            onCloseClick={() => setShowErrorDetails(false)}
            onCloseAttempt={() => setShowErrorDetails(false)}
            onOverlayClick={() => setShowErrorDetails(false)}
            onEscPress={() => setShowErrorDetails(false)}
          >
            <div className="error-details-header">Connection error details</div>
            <pre className="error-details">{errorDetails}</pre>
          </Dialog>
        )}
        {connected && (
          <section className="panel">
            <div className="panel-header">
              <h2 className="panel-title">Search</h2>
            </div>
            <div className="search" role="search">
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
                type="button"
                onClick={() => void runSearch()}
                disabled={searching || busy || !query.trim() || !host}
              >
                Search
              </Button>
            </div>

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
