/**
 * Signup runner (Build C / Phase 1b) — autonomously submits the FREE, automation-
 * safe citation listings the classifier marked `submit_free`, fail-closed on
 * anything gated, with screenshot evidence + an honest attempt ledger. NEVER pays
 * or creates accounts (payments are Phase 2).
 *
 * Supervised-first: gated OFF (signupRunner) AND a live run requires an explicit
 * allowlist of domains — without one it submits nothing. When the engine discovers
 * a gate the classifier missed (login/CAPTCHA/payment), it RECLASSIFIES the row
 * (→ needs_account / pay_and_submit) so it's never auto-retried.
 */

const logger = require('../logger');
const db = require('../../models/db');
const worker = require('./link-prospect-worker');
const { fillCitationForm } = require('./browser-form-filler');
const { uploadEvidence } = require('./signup-evidence');
const { WAVES_ADDRESS_LINE } = require('../../constants/business');

const CATEGORY = 'Pest Control';
const DESCRIPTION = 'Family-owned pest control and lawn care serving Southwest Florida — pest, lawn, mosquito, termite, and rodent control.';

function normDomain(v) {
  const raw = String(v || '').trim().toLowerCase();
  try { return new URL(raw.includes('://') ? raw : `https://${raw}`).hostname.replace(/^www\./, ''); }
  catch { return raw.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, ''); }
}

function parseAddress(line) {
  const m = String(line || '').match(/^(.*),\s*([^,]+),\s*([A-Za-z]{2})\s*(\d{5})/);
  if (!m) return { street: line || '', city: '', state: '', zip: '' };
  return { street: m[1].trim(), city: m[2].trim(), state: m[3].toUpperCase(), zip: m[4] };
}

function buildNap(profile) {
  const loc = (profile.locations || []).find((l) => l.id === profile.default_location_id) || (profile.locations || [])[0] || {};
  return {
    business_name: profile.brand,
    website: profile.website,
    email: profile.contact_email,
    phone: loc.phone || '',
    address: parseAddress(loc.address || WAVES_ADDRESS_LINE),
    category: CATEGORY,
    description: DESCRIPTION,
  };
}

async function recordAttempt(p, result, evidenceKey) {
  try {
    await db('seo_signup_attempts').insert({
      prospect_id: p.id,
      outcome: result.outcome,
      mode: 'auto',
      live_url: result.liveUrl || null,
      evidence_url: evidenceKey || null,
      screenshot_url: evidenceKey || null,
      cost_usd: 0,
      link_rel: p.offered_link_rel || 'unknown',
      error_code: result.errorCode || null,
      error_message: result.notes || null,
    });
  } catch (err) { logger.warn(`[signup-runner] attempt-ledger write failed for ${p.target_domain}: ${err.message}`); }
}

/**
 * run — submit the allowlisted submit_free citations. dryRun previews (no browser,
 * no writes) and releases its leases. Returns { claimed, placed, blocked, failed, skipped }.
 */
async function run({ batchSize = 5, dryRun = false, allow = [], launchBrowser, anthropic } = {}) {
  const allowlist = (allow && allow.length ? allow : String(process.env.SIGNUP_RUNNER_ALLOWLIST || '').split(','))
    .map((d) => normDomain(d)).filter(Boolean);

  // Live submission REQUIRES an explicit allowlist (supervised-first). Dry-run is
  // exempt — it only previews what WOULD be claimed.
  if (!dryRun && allowlist.length === 0) {
    logger.warn('[signup-runner] no allowlist (SIGNUP_RUNNER_ALLOWLIST) — refusing to submit. Set an allowlist for the supervised first run.');
    return { claimed: 0, placed: 0, blocked: 0, failed: 0, skipped: 0, note: 'no_allowlist' };
  }

  const claimed = await worker.claim({ n: batchSize, type: 'signup', automationPolicy: 'submit_free' });
  if (!claimed.length) { logger.info('[signup-runner] no submit_free prospects to claim'); return { claimed: 0, placed: 0, blocked: 0, failed: 0, skipped: 0 }; }

  const nap = buildNap(worker.businessProfile());
  const counts = { claimed: claimed.length, placed: 0, blocked: 0, failed: 0, skipped: 0 };
  const samples = [];
  const releaseAtEnd = [];

  for (const p of claimed) {
    const domain = normDomain(p.target_domain);
    const submitUrl = p.target_url || `https://${domain}/`;

    if (allowlist.length && !allowlist.includes(domain)) { releaseAtEnd.push({ id: p.id, lease_token: p.lease_token }); continue; }
    if (dryRun) { samples.push({ domain, submitUrl }); releaseAtEnd.push({ id: p.id, lease_token: p.lease_token }); continue; }

    const result = await fillCitationForm({ submitUrl, nap }, { launchBrowser, anthropic });
    const evidenceKey = result.screenshot ? await uploadEvidence(result.screenshot, domain) : null;
    await recordAttempt(p, result, evidenceKey);

    if (result.outcome === 'placed') {
      await worker.report({ prospect_id: p.id, outcome: 'placed', lease_token: p.lease_token, live_url: result.liveUrl || null, evidence_url: evidenceKey || null, pending: !!result.pending, notes: 'auto-submitted citation' });
      counts.placed++;
    } else if (result.outcome.startsWith('blocked_')) {
      // The classifier missed a gate the engine found — RECLASSIFY so it's not
      // auto-retried, and release the lease (not a retryable failure).
      const policy = result.errorCode === 'blocked_payment' ? 'pay_and_submit' : 'needs_account';
      await db('seo_link_prospects').where({ id: p.id }).update({
        automation_policy: policy,
        requires_account: result.errorCode === 'blocked_account' ? true : undefined,
        requires_captcha: result.errorCode === 'blocked_captcha' ? true : undefined,
        requires_payment: result.errorCode === 'blocked_payment' ? true : undefined,
        claimed_at: null, claimed_by: null, updated_at: new Date(),
      });
      counts.blocked++;
    } else if (result.outcome === 'skipped') {
      // No submittable form here — mark off-lane so we stop claiming it.
      await db('seo_link_prospects').where({ id: p.id }).update({ automation_policy: 'skip', claimed_at: null, claimed_by: null, updated_at: new Date() });
      counts.skipped++;
    } else {
      // Engine error / unconfirmed — retryable via the worker contract (MAX_ATTEMPTS).
      await worker.report({ prospect_id: p.id, outcome: 'failed', lease_token: p.lease_token, notes: `runner: ${result.errorCode || 'failed'}` });
      counts.failed++;
    }
  }

  if (releaseAtEnd.length) await worker.releaseClaims(releaseAtEnd).catch(() => {});
  logger.info(`[signup-runner] ${JSON.stringify(counts)}${dryRun ? ' (DRY-RUN)' : ''}`);
  return { ...counts, ...(dryRun ? { samples } : {}) };
}

module.exports = { run };
module.exports._internals = { buildNap, parseAddress, normDomain };
