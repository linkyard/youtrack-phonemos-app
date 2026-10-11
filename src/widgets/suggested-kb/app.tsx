import React, {memo, useCallback, useEffect, useState} from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import LoaderInline from '@jetbrains/ring-ui-built/components/loader-inline/loader-inline';
import Link from '@jetbrains/ring-ui-built/components/link/link';

import {
  clearMemoryTokens,
  connectPhonemos,
  DEFAULT_POPUP_CALLBACK_URL,
  ensurePhonemosTokens,
  getMemoryTokens,
  resolveOAuthRedirectUri,
} from './oauth';

type SuggestionItem = {
  objectId: string;
  name: string;
  extract: string;
  href: string;
};

type SuggestionsResponse = {
  success: boolean;
  message?: string;
  mode?: string;
  items?: SuggestionItem[];
};

type Status = 'loading' | 'needs-auth' | 'ready' | 'empty' | 'error';

const host = await YTApp.register();

const AppComponent: React.FunctionComponent = () => {
  const [status, setStatus] = useState<Status>('loading');
  const [items, setItems] = useState<SuggestionItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<string | null>(null);

  const loadSuggestions = useCallback(async () => {
    setStatus('loading');
    setError(null);
    try {
      if (!getMemoryTokens()) {
        setStatus('needs-auth');
        return;
      }
      const tokens = await ensurePhonemosTokens(host);
      const response = await host.fetchApp<SuggestionsResponse>('suggestions/list', {
        method: 'POST',
        scope: true,
        body: {accessToken: tokens.accessToken},
      });
      if (!response.success) {
        if (/401|403|unauthorized|invalid.?token/i.test(response.message || '')) {
          clearMemoryTokens();
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
    try {
      await connectPhonemos(host);
      await loadSuggestions();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Phonemos sign-in failed.');
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
            {`Keycloak Valid redirect URIs must include:\n${resolveOAuthRedirectUri()}`}
          </p>
        </div>
      )}

      {status === 'empty' && (
        <p className="muted">No matching articles</p>
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
