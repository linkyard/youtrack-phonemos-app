import React, {memo, useCallback, useEffect, useState} from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import LoaderInline from '@jetbrains/ring-ui-built/components/loader-inline/loader-inline';
import Link from '@jetbrains/ring-ui-built/components/link/link';
import Dialog from '@jetbrains/ring-ui-built/components/dialog/dialog';

import {
  clearPhonemosSession,
  connectPhonemos,
  ensurePhonemosTokens,
  formatUnknownError,
  getRedirectDebugInfo,
  PhonemosConnectionError,
  resolveOAuthRedirectUri,
} from './oauth';
import {runSearchJob} from '../shared/search-job';

function verifyOauthRedirect(): string {
  try {
    resolveOAuthRedirectUri();
    return '';
  } catch (e) {
    return e instanceof Error ? e.message : getRedirectDebugInfo();
  }
}

type SuggestionItem = {
  objectId: string;
  name: string;
  extract: string;
  href: string;
};

type SuggestionsResponse = {
  success: boolean;
  message?: string;
  needsAuth?: boolean;
  pending?: boolean;
  jobId?: string;
  mode?: string;
  items?: SuggestionItem[];
};

type Status = 'loading' | 'needs-auth' | 'ready' | 'empty' | 'error';

const host = await YTApp.register();

const AppComponent: React.FunctionComponent = () => {
  const [status, setStatus] = useState<Status>('loading');
  const [connected, setConnected] = useState(false);
  const [items, setItems] = useState<SuggestionItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [errorDetails, setErrorDetails] = useState<string | null>(null);
  const [showErrorDetails, setShowErrorDetails] = useState(false);
  const [mode, setMode] = useState<string | null>(null);

  const loadSuggestions = useCallback(async () => {
    setStatus('loading');
    setError(null);
    setErrorDetails(null);
    try {
      // Ensure a server-side session exists; tokens never enter the widget.
      const session = await ensurePhonemosTokens(host);
      if (!session) {
        setConnected(false);
        setStatus('needs-auth');
        return;
      }
      setConnected(true);
      const response = await runSearchJob<SuggestionsResponse>(host, 'suggestions/list', 'suggestions/result', {
        scope: true,
        body: {},
      });
      if (!response.success) {
        if (response.needsAuth) {
          setConnected(false);
          const message = response.message || '';
          if (message && !/connect to phonemos first/i.test(message)) {
            setError(message);
          }
          setStatus('needs-auth');
          return;
        }
        throw new Error(response.message || 'Unable to load suggestions.');
      }
      const nextItems = response.items || [];
      setItems(nextItems);
      setMode(response.mode || null);
      setStatus(nextItems.length ? 'ready' : 'empty');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to load suggestions.');
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    void loadSuggestions();
  }, [loadSuggestions]);

  const onConnect = useCallback(async () => {
    setStatus('loading');
    setError(null);
    setErrorDetails(null);
    try {
      await connectPhonemos(host);
      await loadSuggestions();
    } catch (e) {
      if (e instanceof PhonemosConnectionError) {
        setError(e.message);
        setErrorDetails(e.details);
      } else {
        setError(formatUnknownError(e));
        setErrorDetails(null);
      }
      setStatus('error');
    }
  }, [loadSuggestions]);

  const onDisconnect = useCallback(async () => {
    setError(null);
    setErrorDetails(null);
    setItems([]);
    setMode(null);
    setConnected(false);
    try {
      await clearPhonemosSession(host);
    } catch {
    }
    setStatus('needs-auth');
  }, []);

  return (
    <div className="widget">
      <div className="header-actions">
        {mode && status === 'ready' && <span className="mode">{mode}</span>}
        {connected && (
          <Button text onClick={() => void onDisconnect()}>
            Disconnect
          </Button>
        )}
      </div>

      {status === 'loading' && (
        <div className="row">
          <LoaderInline/>
          <span>Looking for relevant Phonemos articles…</span>
        </div>
      )}

      {status === 'needs-auth' && (
        <div className="stack">
          <p className="muted">
            {error || 'Connect to Phonemos to see articles you can access for this ticket.'}
          </p>
          <Button primary onClick={() => void onConnect()}>
            Connect to Phonemos
          </Button>
          <p className="muted" style={{whiteSpace: 'pre-wrap', fontSize: '11px'}}>
            {verifyOauthRedirect()}
          </p>
        </div>
      )}

      {status === 'empty' && (
        <div className="stack">
          <p className="muted">No matching articles</p>
          <Button onClick={() => void loadSuggestions()}>Retry</Button>
        </div>
      )}

      {status === 'error' && (
        <div className="stack">
          <div className="error-row">
            <p className="error">{error}</p>
            {errorDetails && (
              <Button text onClick={() => setShowErrorDetails(true)}>
                Details
              </Button>
            )}
          </div>
          <div className="row">
            <Button onClick={() => void loadSuggestions()}>Retry</Button>
            <Button onClick={() => void onConnect()}>Connect to Phonemos</Button>
          </div>
        </div>
      )}

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

      {status === 'ready' && (
        <ul className="list">
          {items.map((item) => (
            <li key={item.objectId} className="item">
              <Link href={item.href} target="_blank" className="item-title">
                {item.name}
              </Link>
              {item.extract && <p className="extract">{item.extract}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export const App = memo(AppComponent);
