/**
 * Hosted callback used when YouTrack embeds widgets as about:srcdoc (no file URL).
 * Served as text/html (jsDelivr/gist raw are text/plain + nosniff and will not run JS).
 */
export const DEFAULT_POPUP_CALLBACK_URL =
  'https://rawcdn.githack.com/linkyard/youtrack-phonemos-oauth-callback/3dbd8da/index.html';

function isYouTrackAppShellUrl(url: string): boolean {
  return /\/app\/[^/]+\/oauth-callback/i.test(url);
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

export function listWidgetAssetUrls(): string[] {
  const out: string[] = [];
  const nodes = [
    ...Array.from(document.querySelectorAll('script[src]')),
    ...Array.from(document.querySelectorAll('link[href]')),
  ];
  for (const node of nodes) {
    const raw = node.getAttribute('src') || node.getAttribute('href');
    if (!raw) {
      continue;
    }
    try {
      out.push(new URL(raw, window.location.href).toString());
    } catch {
      // ignore
    }
  }
  return out;
}

export function getRedirectDebugInfo(): string {
  return [
    `location=${window.location.href}`,
    `derived=${deriveOAuthCallbackUrl() || '(none)'}`,
    `default=${DEFAULT_POPUP_CALLBACK_URL}`,
  ].join('\n');
}

/**
 * Try to find a same-origin widget HTML URL. YouTrack Cloud often uses
 * about:srcdoc, in which case this returns null.
 */
export function deriveOAuthCallbackUrl(): string | null {
  if (String(window.location.href).startsWith('about:')) {
    return null;
  }

  try {
    const current = new URL(window.location.href);
    current.search = '';
    current.hash = '';
    const href = current.toString();
    if (/suggested-kb/i.test(href)) {
      return href.replace(/suggested-kb/gi, 'oauth-callback');
    }
    if (/oauth-callback\/index\.html/i.test(href)) {
      return href;
    }
  } catch {
    // ignore
  }

  try {
    for (const assetUrl of listWidgetAssetUrls()) {
      const abs = new URL(assetUrl);
      const match = abs.pathname.match(/^(.*\/widgets)\/assets\//i);
      if (match) {
        return `${abs.origin}${match[1]}/oauth-callback/index.html`;
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
  if (isUsableRedirectUri(trimmed)) {
    return trimmed;
  }

  return DEFAULT_POPUP_CALLBACK_URL;
}
