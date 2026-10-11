/**
 * YouTrack serves packaged widget files at:
 *   https://{host}/api/appResources/{appInstallId}/widgets/...
 * See JT-90146 — use that URL as OAuth redirect_uri (not /app/... and not about:srcdoc).
 */
export const OAUTH_POPUP_CALLBACK_FILE = 'oauth-popup-callback.html';

function isYouTrackAppShellUrl(url: string): boolean {
  return /\/app\/[^/]+\/(?:search|oauth-callback)(?:[/?#]|$)/i.test(url);
}

function isUsableRedirectUri(url: string): boolean {
  if (!url || !/^https?:\/\//i.test(url)) {
    return false;
  }
  if (isYouTrackAppShellUrl(url)) {
    return false;
  }
  if (url.startsWith('about:')) {
    return false;
  }
  return true;
}

function resolveAgainstWidgetBase(ref: string): string | null {
  try {
    const base = document.baseURI || window.location.href;
    return new URL(ref, base).toString();
  } catch {
    return null;
  }
}

/** URLs that may contain /api/appResources/{id}/widgets/ */
export function listWidgetResourceHints(): string[] {
  const out: string[] = [];
  const push = (value: string | null | undefined) => {
    if (value && !out.includes(value)) {
      out.push(value);
    }
  };

  try {
    push(document.baseURI);
  } catch {
    // ignore
  }

  try {
    const baseHref = document.querySelector('base')?.getAttribute('href');
    if (baseHref) {
      push(resolveAgainstWidgetBase(baseHref));
    }
  } catch {
    // ignore
  }

  const nodes = [
    ...Array.from(document.querySelectorAll('script[src]')),
    ...Array.from(document.querySelectorAll('link[href]')),
  ];
  for (const node of nodes) {
    const raw = node.getAttribute('src') || node.getAttribute('href');
    if (!raw) {
      continue;
    }
    push(resolveAgainstWidgetBase(raw));
  }

  try {
    for (const entry of performance.getEntriesByType('resource') as PerformanceResourceTiming[]) {
      if (/appResources/i.test(entry.name)) {
        push(entry.name);
      }
    }
  } catch {
    // ignore
  }

  return out;
}

export function callbackUrlFromAppResourcesHint(url: string): string | null {
  try {
    const absolute = new URL(url, document.baseURI || window.location.href);
    const match = absolute.pathname.match(/^(.*\/api\/appResources\/[^/]+\/widgets)\//i);
    if (!match) {
      return null;
    }
    return `${absolute.origin}${match[1]}/${OAUTH_POPUP_CALLBACK_FILE}`;
  } catch {
    return null;
  }
}

export function getRedirectDebugInfo(): string {
  return [
    `location=${window.location.href}`,
    `baseURI=${document.baseURI}`,
    `derived=${deriveOAuthCallbackUrl() || '(none)'}`,
    `hints=${listWidgetResourceHints().slice(0, 5).join(' | ') || '(none)'}`,
  ].join('\n');
}

/**
 * Build OAuth redirect URI for the static popup callback under appResources.
 */
export function deriveOAuthCallbackUrl(): string | null {
  for (const hint of listWidgetResourceHints()) {
    const fromHint = callbackUrlFromAppResourcesHint(hint);
    if (fromHint) {
      return fromHint;
    }
  }

  // Non-srcdoc fallbacks (local/dev).
  try {
    if (!String(window.location.href).startsWith('about:')) {
      const current = new URL(window.location.href);
      current.search = '';
      current.hash = '';
      if (/\/widgets\/(?:suggested-kb|search|oauth-callback)\//i.test(current.href)) {
        const path = current.pathname.replace(/\/widgets\/[^/]+\/.*$/i, `/widgets/${OAUTH_POPUP_CALLBACK_FILE}`);
        if (path.includes('/widgets/')) {
          current.pathname = path;
          return current.toString();
        }
      }
    }
  } catch {
    // ignore
  }

  return null;
}

export function resolveOAuthRedirectUri(configured?: string): string {
  const derived = deriveOAuthCallbackUrl();
  if (derived && isUsableRedirectUri(derived)) {
    return derived;
  }

  const trimmed = configured?.trim() || '';
  if (isUsableRedirectUri(trimmed) && /appResources/i.test(trimmed)) {
    return trimmed;
  }

  throw new Error(
    'Unable to determine YouTrack appResources OAuth callback URL from this widget. ' +
      'Expected document.baseURI like https://{youtrack}/api/appResources/{appId}/widgets/...\n' +
      getRedirectDebugInfo(),
  );
}
