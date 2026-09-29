// Server-provided asset paths (e.g. the token-scoped estimate map proxy,
// /api/estimates/:token/map/satellite) are written against the default
// '/api' mount. When the client is built against a different API origin
// (VITE_API_URL), rebase them so an <img src> still reaches the API.
export function resolveApiAssetUrl(src, apiBase = import.meta.env.VITE_API_URL || '/api') {
  if (typeof src !== 'string' || !src.startsWith('/api/')) return src;
  const base = String(apiBase || '/api').replace(/\/+$/, '');
  if (base === '/api') return src;
  return `${base}${src.slice('/api'.length)}`;
}
