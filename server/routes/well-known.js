/**
 * /.well-known — universal-link association files for the native app shell.
 *
 * Apple (apple-app-site-association) and Android (assetlinks.json) fetch these
 * from https://portal.wavespestcontrol.com to verify that the Waves app is
 * allowed to open this domain's links directly. Once verified, every existing
 * portal URL — tracking links, invoices, reports, `/l/:code` short links —
 * opens inside the installed app instead of the browser, with zero template
 * changes. Customers without the app are untouched (links stay web).
 *
 * Dark by default: both files 404 until GATE_UNIVERSAL_LINKS=true, and each
 * additionally 404s while its identity inputs are missing. Killing the gate
 * un-verifies the association on the next OS re-validation; installed apps
 * simply fall back to opening links in the browser — no client update needed.
 *
 *   AASA      — team ID from APPLE_TEAM_ID (falls back to APNS_TEAM_ID, the
 *               same Apple Developer team that signs push).
 *   assetlinks — ANDROID_ASSETLINKS_SHA256: comma-separated SHA-256 cert
 *               fingerprints. MUST include the Play "App signing key
 *               certificate" fingerprint (Play re-signs every install);
 *               include the upload key too so sideloaded/dev builds verify.
 *               Both are on Play Console → Setup → App signing.
 *
 * /admin, /tech, and /api are excluded from the Apple paths: the native shell
 * is customer-only (staff surfaces redirect out of it), and /api responses
 * (PDF downloads, webhooks) should never be claimed by an app.  Android App
 * Links have no exclude syntax — the shell's existing staff-redirect handles
 * those paths there.
 */
const express = require('express');
const { isEnabled } = require('../config/feature-gates');

const router = express.Router();

const BUNDLE_ID = (process.env.APNS_BUNDLE_ID || 'com.wavespestcontrol.portal').trim();

function appleAppId() {
  const teamId = (process.env.APPLE_TEAM_ID || process.env.APNS_TEAM_ID || '').trim();
  return teamId ? `${teamId}.${BUNDLE_ID}` : null;
}

function androidFingerprints() {
  return (process.env.ANDROID_ASSETLINKS_SHA256 || '')
    .split(',')
    .map((f) => f.trim().toUpperCase())
    .filter(Boolean);
}

router.get('/apple-app-site-association', (req, res) => {
  if (!isEnabled('universalLinks')) return res.status(404).json({ error: 'Not found' });
  const appID = appleAppId();
  if (!appID) return res.status(404).json({ error: 'Not found' });

  // Apple's CDN re-fetches on its own cadence; keep the edge TTL short so a
  // gate flip (either direction) propagates quickly.
  res.set('Cache-Control', 'public, max-age=300');
  return res.json({
    applinks: {
      details: [
        {
          appIDs: [appID],
          components: [
            // Exact roots AND descendants: '/admin/*' alone would let a bare
            // '/admin' link fall through to the catch-all (codex P2).
            { '/': '/admin', exclude: true },
            { '/': '/admin/*', exclude: true },
            { '/': '/tech', exclude: true },
            { '/': '/tech/*', exclude: true },
            { '/': '/api', exclude: true },
            { '/': '/api/*', exclude: true },
            // Referral links 302 to the marketing site (referral-links.js) —
            // claiming them would strand the app's webview off-portal.
            { '/': '/r', exclude: true },
            { '/': '/r/*', exclude: true },
            { '/': '*' },
          ],
        },
      ],
    },
    webcredentials: { apps: [appID] },
  });
});

router.get('/assetlinks.json', (req, res) => {
  if (!isEnabled('universalLinks')) return res.status(404).json({ error: 'Not found' });
  const fingerprints = androidFingerprints();
  if (!fingerprints.length) return res.status(404).json({ error: 'Not found' });

  res.set('Cache-Control', 'public, max-age=300');
  return res.json([
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: BUNDLE_ID,
        sha256_cert_fingerprints: fingerprints,
      },
    },
  ]);
});

module.exports = router;
