// Cloudflare Turnstile loader for the portal's public lead forms (the /quote
// wizard). The PUBLIC site key is injected at build time; when it's absent
// (local dev / preview) callers no-op so forms keep working. The matching
// secret + server-side verification live in server/utils/turnstile.js
// (POST /api/leads), gated behind GATE_LEAD_TURNSTILE. Use the SAME Turnstile
// widget as the Astro fleet — just add the portal hostname to it.
export const TURNSTILE_SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY || '';

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let loadPromise = null;

// Inject the Turnstile API script once (explicit-render mode) and resolve with
// window.turnstile when ready. Resolves null when there is no site key or the
// script fails to load, so callers degrade to today's no-verification behavior.
export function loadTurnstile() {
  if (typeof window === 'undefined' || !TURNSTILE_SITE_KEY) return Promise.resolve(null);
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (loadPromise) return loadPromise;

  loadPromise = new Promise((resolve) => {
    const finish = () => resolve(window.turnstile || null);
    const existing = document.querySelector('script[data-turnstile]');
    if (existing) {
      if (window.turnstile) return finish();
      existing.addEventListener('load', finish, { once: true });
      existing.addEventListener('error', () => resolve(null), { once: true });
      return;
    }
    const script = document.createElement('script');
    script.src = SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.setAttribute('data-turnstile', '');
    script.addEventListener('load', finish, { once: true });
    script.addEventListener('error', () => resolve(null), { once: true });
    document.head.appendChild(script);
  });
  return loadPromise;
}
