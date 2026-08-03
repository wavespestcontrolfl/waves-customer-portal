/**
 * Canonical portal-URL helper.
 *
 * Reads the public-facing portal origin (the URL customers see in their
 * SMS / email links) from a single source of truth: `PUBLIC_PORTAL_URL`.
 *
 * The repo previously read FOUR different env vars for the same value
 * across ~30 call sites (`PORTAL_DOMAIN`, `PORTAL_URL`, `CLIENT_URL`,
 * `PUBLIC_PORTAL_URL`). They drifted in format too — `admin-reviews.js`
 * read `PORTAL_DOMAIN` as a bare hostname (no protocol) while
 * `invoice-email.js` read the same var as a full URL — so a one-place
 * env edit could break the other site. This helper normalizes the read:
 * always returns a full URL with `https://` and no trailing slash.
 *
 * Fallback chain (back-compat — Railway has the legacy vars set today;
 * removing them is a future cleanup):
 *   1. `PUBLIC_PORTAL_URL`  (canonical)
 *   2. `PORTAL_URL`
 *   3. `CLIENT_URL`
 *   4. `PORTAL_DOMAIN`
 *   5. `https://portal.wavespestcontrol.com`  (production default)
 *
 * Callers that need a specific path should use `portalUrl('/pay/abc')`
 * — the helper trims the trailing slash on the base before joining so
 * the result is always exactly one slash between origin and path.
 */

const PRODUCTION_DEFAULT = 'https://portal.wavespestcontrol.com';

function pickEnvUrl() {
  return (
    process.env.PUBLIC_PORTAL_URL
    || process.env.PORTAL_URL
    || process.env.CLIENT_URL
    || process.env.PORTAL_DOMAIN
    || PRODUCTION_DEFAULT
  );
}

function normalize(raw) {
  if (!raw) return PRODUCTION_DEFAULT;
  let v = String(raw).trim();
  if (!v) return PRODUCTION_DEFAULT;
  // PORTAL_DOMAIN historically held bare hostnames ("portal.wavespestcontrol.com").
  // Prepend https:// when the value has no scheme — never assume http://.
  if (!/^https?:\/\//i.test(v)) v = `https://${v}`;
  // Strip trailing slash so `${base}/path` never produces `//path`.
  return v.replace(/\/+$/, '');
}

/**
 * Returns the canonical portal origin (no trailing slash).
 * Example: `https://portal.wavespestcontrol.com`
 */
function publicPortalUrl() {
  return normalize(pickEnvUrl());
}

/**
 * Returns the portal origin joined with `path`. `path` should start with
 * a slash; if it doesn't, one is inserted.
 * Example: `portalUrl('/pay/abc')` → `https://portal.wavespestcontrol.com/pay/abc`
 */
function portalUrl(path) {
  const base = publicPortalUrl();
  if (!path) return base;
  const p = String(path);
  return `${base}${p.startsWith('/') ? '' : '/'}${p}`;
}

/**
 * The canonical public origin ONLY when it has been explicitly configured —
 * '' otherwise. publicPortalUrl() always resolves to something (it falls back
 * to CLIENT_URL and then to the production default), which is right for
 * server-side link building but wrong for deciding whether a rendered
 * artifact should trust it: a preview deployment configured only through
 * CLIENT_URL / SERVICE_REPORT_PDF_BASE_URL would otherwise be handed the
 * production origin and bake a preview-only token into a link that cannot
 * resolve. CLIENT_URL is deliberately excluded — on prod it is the raw
 * Railway hostname, which is what made this distinction necessary.
 */
function configuredPublicPortalOrigin() {
  const explicit = process.env.PUBLIC_PORTAL_URL
    || process.env.PORTAL_URL
    || process.env.PORTAL_DOMAIN;
  return explicit ? normalize(explicit) : '';
}

module.exports = { publicPortalUrl, portalUrl, configuredPublicPortalOrigin };
