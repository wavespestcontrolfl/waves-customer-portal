import { useEffect, useRef } from 'react';
import { loadTurnstile, TURNSTILE_SITE_KEY } from '../lib/turnstile';

// Cloudflare Turnstile widget for the portal's public lead forms. Renders
// nothing when VITE_TURNSTILE_SITE_KEY is unset (local dev / preview) so forms
// keep working unchanged. Hands the solved token up via onToken; clears it on
// expiry/error so a stale token is never submitted.
export default function TurnstileWidget({ onToken, className }) {
  const containerRef = useRef(null);
  const widgetIdRef = useRef(null);
  // Hold the latest onToken in a ref so the render effect runs once (empty
  // deps) without capturing a stale callback.
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;

  useEffect(() => {
    if (!TURNSTILE_SITE_KEY) return undefined;
    let cancelled = false;
    loadTurnstile().then((turnstile) => {
      if (cancelled || !turnstile || !containerRef.current || widgetIdRef.current) return;
      widgetIdRef.current = turnstile.render(containerRef.current, {
        sitekey: TURNSTILE_SITE_KEY,
        // Force the white widget: the 'auto' default follows the visitor's OS
        // dark mode and renders a black box on the light quote form.
        theme: 'light',
        callback: (token) => onTokenRef.current(token),
        'expired-callback': () => onTokenRef.current(''),
        'error-callback': () => onTokenRef.current(''),
      });
    });
    return () => {
      cancelled = true;
      const turnstile = window.turnstile;
      if (widgetIdRef.current && turnstile && turnstile.remove) {
        try { turnstile.remove(widgetIdRef.current); } catch { /* widget already gone */ }
      }
      widgetIdRef.current = null;
      // Clear the parent's token — it belongs to this now-removed widget. Leaving
      // it set would let a stale/expired token be reused if the widget remounts
      // (e.g. Back off the final /quote step, then return).
      onTokenRef.current('');
    };
  }, []);

  if (!TURNSTILE_SITE_KEY) return null;
  return <div ref={containerRef} className={className} />;
}
