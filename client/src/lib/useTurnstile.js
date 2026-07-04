import { useCallback, useRef, useState } from 'react';
import { TURNSTILE_SITE_KEY } from './turnstile';

// Shared Turnstile state for the portal's public lead forms (/quote wizard).
// Keeps the solved token in a ref (read at submit without a stale closure),
// waits briefly for the async widget to solve so a fast click doesn't post an
// empty token, and remounts the widget after a failed submit so the next
// attempt gets a fresh single-use token.
//
// It NEVER blocks a submission indefinitely: server-side verification is the
// real gate and fails open on a missing token while GATE_LEAD_TURNSTILE is off,
// so an ad-blocked / slow widget must not trap a legitimate lead on the client.
export function useTurnstile() {
  const tokenRef = useRef('');
  // Bumping the nonce (used as the widget's React key) remounts it → fresh token.
  const [nonce, setNonce] = useState(0);

  const onToken = useCallback((token) => {
    tokenRef.current = token || '';
  }, []);

  // Resolve a solved token, waiting up to timeoutMs for the async solve, then
  // resolving with whatever we have ('' if none). No site key → '' immediately.
  const getToken = useCallback((timeoutMs = 2500) => {
    if (!TURNSTILE_SITE_KEY || tokenRef.current) return Promise.resolve(tokenRef.current);
    return new Promise((resolve) => {
      const start = Date.now();
      const timer = setInterval(() => {
        if (tokenRef.current || Date.now() - start >= timeoutMs) {
          clearInterval(timer);
          resolve(tokenRef.current || '');
        }
      }, 100);
    });
  }, []);

  // Call after a failed POST: the token may have been spent server-side, and
  // Turnstile tokens are single-use, so drop it and remount for a fresh one.
  const reset = useCallback(() => {
    tokenRef.current = '';
    setNonce((n) => n + 1);
  }, []);

  return { nonce, onToken, getToken, reset };
}
