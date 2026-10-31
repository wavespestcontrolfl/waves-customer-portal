// Customer email links the installed Waves app opens.
//
// SendGrid click tracking rewrites every <a href> to the branded click host
// (click.wavespestcontrol.com). The app claims only the portal host, so every
// tracked email link opened the browser instead of the app, and a sign-in
// portal tab (/?tab=billing) asked an app customer to sign in on the web.
// Anchors to the customer pages below skip that rewrite (SendGrid's per-link
// `clicktracking=off`, honored only BEFORE href) and go straight to the
// portal, where iOS universal links and Android App Links hand them to the
// app. Every other link (marketing site, the portal's redirects to it, API
// files, staff pages, static assets) stays tracked. The skipped links keep
// first-party signals: /l/ short-link clicks (short_code_clicks) and
// token-page views.
//
// APP_LINK_PATH_PREFIXES is also the Android App Links allowlist:
// scripts/mobile/bootstrap-android.sh APP_LINK_PREFIXES lists the same
// prefixes (server/tests/mobile-bootstrap-pinning.test.js). They are plain
// string prefixes, as Android's pathPrefix matches; '/l/' keeps its slash so
// it never swallows /login or /lawn-report. The portal root '/' (customer
// portal tabs) matches exactly, like Android's android:path="/".
const { publicPortalUrl } = require('../../utils/portal-url');
const { estimateMarketingRedirectTarget } = require('../../config/estimate-marketing-redirects');

const APP_LINK_PATH_PREFIXES = Object.freeze([
  '/l/', '/track', '/pay', '/billing', '/receipt', '/report', '/pest-report', '/rate', '/prep',
  '/reschedule', '/estimate', '/contract', '/recap', '/review', '/book', '/login', '/quote',
  '/lawn-report', '/service-outlines', '/appointment', '/secure', '/visit', '/reservice',
  '/inspection', '/price-change',
]);

// Customer-reachable pages that open in the browser on purpose. Android's
// allowlist leaves them out and the iOS association file excludes them
// (routes/well-known.js).
const BROWSER_ONLY_PATH_ROOTS = Object.freeze([
  '/card', // a tech's business card for prospects: Save contact downloads a vCard
  '/careers', // job applicants, not customers
  '/newsletter', // public newsletter pages
]);

// /quote, bare /estimate and the /estimate/<service> pages redirect to the
// marketing site, so the app would only bounce them to the browser.
function isAppLinkPath(pathname) {
  if (estimateMarketingRedirectTarget(pathname)) return false;
  return pathname === '/' || APP_LINK_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

const ANCHOR_RE = /<a\b([^>]*)>/gi;
const HREF_RE = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;

// GATE_EMAIL_APP_LINKS, off by default. A device test on 2026-10-31 found that
// the iPhone app opens on Home, not on the tapped page (/?tab=billing, /book),
// so untracked email links took app users to Home instead of the right page
// in the browser. Turn it on once the app lands on the tapped page. Read
// defensively: a test that mocks feature-gates without this reader gets off.
function emailAppLinksLive() {
  const gates = require('../../config/feature-gates');
  return typeof gates.emailAppLinksLive === 'function' && gates.emailAppLinksLive();
}

// Adds clicktracking=off to each anchor that points at a customer page on the
// portal host. Anything unparseable stays as written (and so stays tracked).
function untrackAppLinks(html) {
  if (typeof html !== 'string' || !html || !emailAppLinksLive()) return html;
  let portalHost;
  try {
    portalHost = new URL(publicPortalUrl()).host;
  } catch {
    return html;
  }
  return html.replace(ANCHOR_RE, (tag, attrs) => {
    if (/\bclicktracking\s*=/i.test(attrs)) return tag;
    const href = HREF_RE.exec(attrs);
    if (!href) return tag;
    let url;
    try {
      url = new URL(href[1] ?? href[2] ?? href[3]);
    } catch {
      return tag;
    }
    const appLink = /^https?:$/.test(url.protocol) && url.host === portalHost && isAppLinkPath(url.pathname);
    return appLink ? `<a clicktracking=off${attrs}>` : tag;
  });
}

module.exports = { APP_LINK_PATH_PREFIXES, BROWSER_ONLY_PATH_ROOTS, untrackAppLinks };
