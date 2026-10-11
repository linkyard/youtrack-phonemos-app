import React, {memo, useEffect, useState} from 'react';

import {publishOAuthResult, waitForOAuthParams} from '../shared/oauth-result';

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

const AppComponent: React.FunctionComponent = () => {
  const [message, setMessage] = useState('Completing Phonemos sign-in…');

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const host = await YTApp.register();
        const params = await waitForOAuthParams(host);
        if (cancelled) {
          return;
        }

        const code = params.get('code');
        const state = params.get('state');
        const error = params.get('error_description') || params.get('error');

        if (code || error) {
          await publishOAuthResult(host, {code, state, error});
          if (cancelled) {
            return;
          }
          setMessage(error ? `Sign-in failed: ${error}` : 'Signed in. You can close this window.');
          closePopup();
          return;
        }

        const appLocation = host.navigation?.getAppLocation
          ? await host.navigation.getAppLocation()
          : null;
        setMessage(
          `This page completes Phonemos sign-in for the YouTrack app. Open a ticket to connect from the suggestions widget.${
            appLocation
              ? ` (debug: search="${appLocation.search || ''}" hash="${appLocation.hash || ''}")`
              : ''
          }`,
        );
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
