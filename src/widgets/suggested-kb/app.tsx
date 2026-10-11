import React, {memo, useCallback, useEffect, useState} from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import LoaderInline from '@jetbrains/ring-ui-built/components/loader-inline/loader-inline';
import Link from '@jetbrains/ring-ui-built/components/link/link';

import {
  clearPhonemosSession,
  connectPhonemos,
  ensurePhonemosTokens,
  formatUnknownError,
  getRedirectDebugInfo,
  resolveOAuthRedirectUri,
} from './oauth';

function oauthRedirectHint(): string {
  try {
    return 'Keycloak Valid redirect URIs must include:\n' + resolveOAuthRedirectUri();
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

type SearchAttempt = {
  label?: string;
  mode?: string;
  objectTypes?: string;
  status?: number;
  hits?: number;
  error?: string;
  responseKeys?: string;
};

type SuggestionsResponse = {
  success: boolean;
  message?: string;
  mode?: string;
  query?: string;
  queryLabel?: string;
  within?: string;
  attempts?: SearchAttempt[];
  items?: SuggestionItem[];
};

type Status = 'loading' | 'needs-auth' | 'ready' | 'empty' | 'error';

const host = await YTApp.register();

const AppComponent: React.FunctionComponent = () => {
  const [status, setStatus] = useState<Status>('loading');
  const [items, setItems] = useState<SuggestionItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<string | null>(null);
  const [debug, setDebug] = useState<string | null>(null);

  const loadSuggestions = useCallback(async () => {
    setStatus('loading');
    setError(null);
    setDebug(null);
    try {
      const tokens = await ensurePhonemosTokens(host);
      if (!tokens) {
        setStatus('needs-auth');
        return;
      }
      const response = await host.fetchApp<SuggestionsResponse>('suggestions/list', {
        method: 'POST',
        scope: true,
        body: {accessToken: tokens.accessToken},
      });
      if (!response.success) {
        // Keep the error visible (do not silently bounce to Connect). Clear the
        // session so the next Connect picks up a new token after Keycloak fixes.
        if (/401|403|unauthorized|invalid.?token|invalid.?bearer/i.test(response.message || '')) {
          await clearPhonemosSession(host);
          setError(response.message || 'Phonemos rejected the access token.');
          setStatus('error');
          return;
        }
        throw new Error(response.message || 'Unable to load suggestions.');
      }
      const nextItems = response.items || [];
      setItems(nextItems);
      setMode(response.mode || null);
      if (!nextItems.length) {
        const attemptLines = (response.attempts || []).map((attempt) =>
          `${attempt.label || '?'}/${attempt.mode || '?'} types=${attempt.objectTypes || '?'} ` +
          `status=${attempt.status ?? '?'} hits=${attempt.hits ?? 0}` +
          (attempt.error ? ` error=${attempt.error}` : '') +
          (attempt.responseKeys ? ` keys=${attempt.responseKeys}` : ''),
        );
        setDebug(
          [
            `queryLabel=${response.queryLabel || ''}`,
            `query=${response.query || ''}`,
            `within=${response.within || ''}`,
            ...attemptLines,
          ].join('\n'),
        );
      }
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
    try {
      await connectPhonemos(host);
      await loadSuggestions();
    } catch (e) {
      setError(formatUnknownError(e));
      setStatus('error');
    }
  }, [loadSuggestions]);

  return (
    <div className="widget">
      <div className="header">
        <h2 className="title">Suggested knowledge base articles</h2>
        {mode && status === 'ready' && <span className="mode">{mode}</span>}
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
            Sign in to Phonemos to see articles you can access for this ticket.
          </p>
          <Button primary onClick={() => void onConnect()}>
            Connect to Phonemos
          </Button>
          <p className="muted" style={{whiteSpace: 'pre-wrap', fontSize: '11px'}}>
            {oauthRedirectHint()}
          </p>
        </div>
      )}

      {status === 'empty' && (
        <div className="stack">
          <p className="muted">No matching articles</p>
          {debug && (
            <p className="muted" style={{whiteSpace: 'pre-wrap', fontSize: '11px'}}>
              {debug}
            </p>
          )}
          <Button onClick={() => void loadSuggestions()}>Retry</Button>
        </div>
      )}

      {status === 'error' && (
        <div className="stack">
          <p className="error">{error}</p>
          <div className="row">
            <Button onClick={() => void loadSuggestions()}>Retry</Button>
            <Button onClick={() => void onConnect()}>Connect to Phonemos</Button>
          </div>
        </div>
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
