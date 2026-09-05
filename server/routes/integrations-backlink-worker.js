/**
 * Hermes acquisition worker — claim/report contract (Backlink Manager M3a).
 *
 * Machine-to-machine endpoints (service-token auth, NOT admin bearer). Mounted
 * at /api/integrations/backlink-worker. Hermes claims unworked prospects, does
 * the signup/outreach, and reports back; the portal verifies independently.
 */
const express = require('express');
const router = express.Router();
const { linkWorkerAuth, finalizeWorkerRequest } = require('../middleware/link-worker-auth');
const { isEnabled } = require('../config/feature-gates');
const worker = require('../services/seo/link-prospect-worker');

// Per-provider HMAC request signing with a bounded bearer transition for the
// external Hermes skills (plan §12/§1); every accepted request writes a
// seo_link_worker_requests audit row the handlers finalize below.
router.use(linkWorkerAuth((req) => (req.method === 'GET' ? 'claim' : 'report')));

// GET /claim?n=10&type=signup|outreach — lease unworked prospects
router.get('/claim', async (req, res, next) => {
  try {
    const type = req.query.type === 'outreach' ? 'outreach' : 'signup';
    const mode = req.query.mode || (type === 'outreach' ? 'draft' : 'acquire');
    if (!['draft', 'acquire'].includes(mode)) {
      await finalizeWorkerRequest(req, 'report_rejected');
      return res.status(400).json({ error: 'mode must be draft or acquire' });
    }
    // Acquisition is in-process only; external credentials retain their empty signup response.
    if (mode === 'acquire') {
      await finalizeWorkerRequest(req, 'empty_claim');
      return res.json({ prospects: [], note: 'acquisition runs through the in-process signup runner' });
    }
    if (mode === 'draft' && !isEnabled('outreachDrafter')) {
      await finalizeWorkerRequest(req, 'empty_claim');
      return res.json({ prospects: [], note: 'outreach drafting is disabled' });
    }
    const prospects = await worker.claim({ n: req.query.n, type, mode, provider: req.linkWorker.provider });
    await finalizeWorkerRequest(req, prospects.length ? 'leased' : 'empty_claim');
    res.json({ prospects, business_profile: worker.businessProfile() });
  } catch (err) { next(err); }
});

// The ONLY report fields an external (Hermes) worker may set. cited_homepage and location
// are deliberately EXCLUDED — they are runner-internal flags the in-process signup runner
// stamps via a direct worker.report() call. cited_homepage switches the verifier's canonical
// target from the prospect's money page to the homepage (link-prospect-verifier.expectedTargetUrl),
// so letting an authenticated Hermes report set it would let a misreported outreach/manual row
// be promoted (and Omega-submitted) off an unrelated homepage backlink instead of verifying its
// real target_page; location would likewise let an external report steer the citation de-dupe.
// Allowlist (not denylist) so any future runner-internal field is dropped by default.
const ALLOWED_REPORT_FIELDS = ['prospect_id', 'outcome', 'lease_token', 'live_url', 'claimed_anchor', 'evidence_url', 'cost', 'notes', 'pending', 'outreach_to_email', 'outreach_subject', 'outreach_body'];

// Pick ONLY the allowlisted fields — runner-internal flags (cited_homepage, location) and
// any unknown keys are dropped before the body reaches worker.report().
function sanitizeReportBody(body = {}) {
  const out = {};
  for (const k of ALLOWED_REPORT_FIELDS) { if (body && body[k] !== undefined) out[k] = body[k]; }
  return out;
}

// POST /report — { prospect_id, outcome: placed|failed|skipped, live_url, claimed_anchor, evidence_url, cost, notes, pending }
//   pending:true on a placed report = submitted to a slow-moderation directory;
//   live_url may be omitted and the verifier's domain reconcile tracks approval.
router.post('/report', async (req, res, next) => {
  try {
    const { prospect_id, outcome } = req.body || {};
    if (!prospect_id) {
      await finalizeWorkerRequest(req, 'report_rejected');
      return res.status(400).json({ error: 'prospect_id required' });
    }
    // 'drafted' = outreach lane: the worker researched + drafted a one-to-one email
    // (outreach_to_email/subject/body); it's parked for human approval, never auto-sent.
    if (!['placed', 'failed', 'skipped', 'drafted'].includes(outcome)) {
      await finalizeWorkerRequest(req, 'report_rejected');
      return res.status(400).json({ error: "outcome must be 'placed', 'failed', 'skipped', or 'drafted'" });
    }
    // Sanitize: pass ONLY the allowlisted external fields, never the runner-internal flags.
    const result = await worker.report({ ...sanitizeReportBody(req.body), provider: req.linkWorker.provider });
    if (!result.ok) {
      const status = { not_found: 404, stale_lease: 409 }[result.code] || 400;
      await finalizeWorkerRequest(req, 'report_rejected', { prospect_id });
      return res.status(status).json(result);
    }
    await finalizeWorkerRequest(req, 'report_accepted', { prospect_id });
    res.json(result);
  } catch (err) { next(err); }
});

module.exports = router;
module.exports._test = { sanitizeReportBody, ALLOWED_REPORT_FIELDS };
