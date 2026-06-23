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
 *
 * DEPLOYMENT PREREQUISITE (SSRF): this drives a real headless browser against
 * untrusted directory pages. browser-form-filler pins Chromium's DNS to a verified
 * public IP and egress-locks it to the one allowlisted host, but the required
 * network-layer backstop is an egress firewall on the Railway service blocking
 * RFC1918 / 169.254 / ::1 / fc00::/7. Do NOT set GATE_SIGNUP_RUNNER=true in prod
 * until that firewall is in place.
 */

const logger = require('../logger');
const db = require('../../models/db');
const worker = require('./link-prospect-worker');
const { fillCitationForm } = require('./browser-form-filler');
const { uploadEvidence } = require('./signup-evidence');
const { _internals: ssrf } = require('./contact-finder'); // isBlockedHostname
const { WAVES_ADDRESS_LINE } = require('../../constants/business');
const { CITY_TO_LOCATION } = require('../../config/locations'); // canonical city/service-area → GBP locId

// Filler errorCodes that are RUN-LEVEL (environment/outage), identical for every
// prospect and NOT the prospect's fault — a misconfigured/degraded run must abort the
// batch + release claims rather than burn each allowlisted prospect's attempts to
// MAX_ATTEMPTS. llm_error = the planning Anthropic call failed (timeout/5xx/outage).
const RUN_LEVEL_ERRORS = new Set(['no_anthropic', 'no_browser', 'llm_error']);

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

/**
 * SHAPE/host guard for the navigated submit URL. `target_url` is untrusted and may
 * differ from the (operator-allowlisted) `target_domain`, so reject anything that isn't
 * http(s) on the EXACT allowlisted host and not a localhost/intranet/IP-literal host.
 * These are PERMANENT-unsafe conditions → the runner parks them (skip).
 *
 * NOTE: this is deliberately SYNC and does NO DNS. The authoritative public-IP /
 * rebinding check is the browser layer's resolvePublicIps + DNS pinning (which fails
 * closed before launch). Doing DNS here too conflated a transient resolver blip with a
 * truly unsafe URL and permanently skipped valid prospects — so a host that doesn't
 * resolve public now surfaces as the filler's retryable host_not_public, not a skip.
 * Returns the canonical URL string, or null to reject.
 */
function validateSubmitUrl(rawUrl, allowedDomain) {
  let u;
  try { u = new URL(String(rawUrl || '')); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!allowedDomain || normDomain(u.hostname) !== allowedDomain) return null;
  if (ssrf.isBlockedHostname(u.hostname)) return null;
  return u.toString();
}

// Pick the GBP location for a prospect using the CANONICAL city→location map (which
// includes service-area aliases: North Port/Englewood/Nokomis/Port Charlotte → Venice,
// Siesta Key/Lido Key/Osprey → Sarasota, Palmetto/Ellenton/Ruskin/Apollo Beach →
// Parrish, Lakewood Ranch/University Park → Bradenton). Match the city/area token in the
// prospect's target page/domain → its GBP; else the default (primary). Longest city
// first so multi-word areas (e.g. 'north port') win over a shorter substring.
const SORTED_CITIES = Object.keys(CITY_TO_LOCATION).sort((a, b) => b.length - a.length);

function pickLocation(profile, prospect) {
  const locs = profile.locations || [];
  const def = locs.find((l) => l.id === profile.default_location_id) || locs[0] || {};
  if (!prospect) return def;
  const hay = `${prospect.target_page || ''} ${prospect.target_domain || ''}`.toLowerCase();
  for (const city of SORTED_CITIES) {
    if (hay.includes(city) || hay.includes(city.replace(/\s+/g, '-')) || hay.includes(city.replace(/\s+/g, ''))) {
      const loc = locs.find((l) => l.id === CITY_TO_LOCATION[city]);
      if (loc) return loc;
    }
  }
  return def;
}

function napFromLocation(profile, loc) {
  return {
    business_name: profile.brand,
    website: profile.website, // citations link to the homepage (verifier reconciles homepage)
    email: profile.contact_email,
    phone: (loc && loc.phone) || '',
    address: parseAddress((loc && loc.address) || WAVES_ADDRESS_LINE),
    category: CATEGORY,
    description: DESCRIPTION,
  };
}

function buildNap(profile, prospect = null) {
  return napFromLocation(profile, pickLocation(profile, prospect));
}

// DURABLE de-dupe: is there already an ACTIVE (placed/live/indexed) signup placement for
// this directory domain + GBP location? A multi-location business gets one listing per
// location on a directory, so a SECOND prospect row for the SAME (domain, location) is a
// duplicate — even across runs. Earlier same-run placements are already reported, so this
// one check covers both the in-batch and cross-run cases. quality_signals.location is
// stamped on every runner placement (see the placed report below).
async function alreadyPlacedAt(domain, locId) {
  const dom = normDomain(domain);
  if (!dom) return false;
  const row = await db('seo_link_prospects')
    .whereIn('status', ['placed', 'live', 'indexed'])
    .whereRaw("lower(regexp_replace(regexp_replace(target_domain, '^https?://', ''), '^www\\.', '')) = ?", [dom])
    .whereRaw("COALESCE(quality_signals->>'location','') = ?", [String(locId || 'default')])
    .first();
  return !!row;
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
 * Reclassify a prospect + release its lease, but ONLY if THIS lease is still current
 * — same optimistic claimed_at guard worker.report/releaseClaims use. If the sweep
 * released a long run and another worker reclaimed the row, claimed_at no longer
 * matches our lease_token, the update affects 0 rows, and we DON'T clobber the newer
 * lease or overwrite its automation_policy. Returns rows updated (0 = stale).
 */
async function leaseGuardedReclassify(p, patch) {
  const leaseDate = p.lease_token ? new Date(p.lease_token) : null;
  if (!leaseDate || Number.isNaN(leaseDate.getTime())) return 0;
  const n = await db('seo_link_prospects')
    .where({ id: p.id })
    .where('claimed_at', leaseDate)
    // Stamp last_classified_at so the weekly classifier treats this runtime decision as
    // fresh and won't re-pick the row and revert a parked gate (e.g. a heuristic FREEFORM
    // domain back to submit_free) before the 30-day reclassify window.
    .update({ ...patch, claimed_at: null, claimed_by: null, last_classified_at: new Date(), updated_at: new Date() });
  if (n === 0) logger.warn(`[signup-runner] stale lease on ${p.target_domain} — reclassify skipped (row was reclaimed)`);
  return n;
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

  // Live runs push the allowlist into the claim so only allowlisted rows are leased
  // (no starving the supervised target by claiming+releasing higher-ranked rows).
  // Dry-run uses a READ-ONLY preview (no lease/write) to show the full triage.
  const claimed = await worker.claim({ n: batchSize, type: 'signup', automationPolicy: 'submit_free', ...(dryRun ? { preview: true } : { domains: allowlist }) });
  if (!claimed.length) { logger.info('[signup-runner] no submit_free prospects to claim'); return { claimed: 0, placed: 0, blocked: 0, failed: 0, skipped: 0 }; }

  const profile = worker.businessProfile();
  const counts = { claimed: claimed.length, placed: 0, blocked: 0, failed: 0, skipped: 0 };
  const samples = [];
  const releaseAtEnd = [];

  for (let i = 0; i < claimed.length; i++) {
    const p = claimed[i];
    const domain = normDomain(p.target_domain);
    const rawUrl = p.target_url || `https://${domain}/`;

    // Dry-run rows are PREVIEW-only (not leased) → just sample them; nothing to release.
    if (dryRun) { samples.push({ domain, submitUrl: rawUrl }); continue; }
    if (allowlist.length && !allowlist.includes(domain)) { releaseAtEnd.push({ id: p.id, lease_token: p.lease_token }); continue; }

    const loc = pickLocation(profile, p); // the GBP location this prospect maps to
    if (await alreadyPlacedAt(domain, loc.id)) {
      await leaseGuardedReclassify(p, { automation_policy: 'skip' });
      await recordAttempt(p, { outcome: 'skipped', errorCode: 'duplicate_placement', notes: `already placed for ${domain} / ${loc.id || 'default'}` }, null);
      counts.skipped++;
      continue;
    }

    // SSRF: validate the ACTUAL navigated URL (target_url can differ from the
    // allowlisted target_domain) before launching a browser at it. An unsafe URL
    // (bad scheme / host mismatch / localhost-literal) is PERMANENT → parked (skip).
    // A host that can't resolve public is handled later by the filler (retryable).
    const submitUrl = validateSubmitUrl(rawUrl, domain);
    if (!submitUrl) {
      logger.warn(`[signup-runner] unsafe/non-allowlisted submit URL for ${domain} — parking (skip)`);
      await leaseGuardedReclassify(p, { automation_policy: 'skip' });
      await recordAttempt(p, { outcome: 'skipped', errorCode: 'unsafe_url', notes: 'target_url failed host/SSRF validation' }, null);
      counts.skipped++;
      continue;
    }

    const nap = napFromLocation(profile, loc); // per-location NAP (Venice/Parrish/… address+phone)
    const result = await fillCitationForm({ submitUrl, expectedHost: domain, nap }, { launchBrowser, anthropic });

    // Run-level/environment/outage error (no LLM client, no browser, planning-LLM
    // outage) — same for EVERY prospect and not theirs to pay for. ABORT the batch
    // BEFORE any ledger write: release this + all remaining claims, no attempts
    // consumed, and NO seo_signup_attempts row (a misconfigured cron would otherwise
    // append a failed row for the same released prospect every run, skewing the ledger).
    if (RUN_LEVEL_ERRORS.has(result.errorCode)) {
      logger.error(`[signup-runner] run-level error '${result.errorCode}' — aborting batch, releasing ${claimed.length - i} claim(s), no attempts/ledger consumed`);
      for (let j = i; j < claimed.length; j++) releaseAtEnd.push({ id: claimed[j].id, lease_token: claimed[j].lease_token });
      counts.aborted = result.errorCode;
      break;
    }

    const evidenceKey = result.screenshot ? await uploadEvidence(result.screenshot, domain) : null;
    await recordAttempt(p, result, evidenceKey);

    if (result.outcome === 'placed') {
      // No confirmed live URL → report as PENDING (slow-moderation), never as a
      // resolved placement worker.report would reject for a missing live_url.
      const pending = !!result.pending || !result.liveUrl;
      // cited_homepage: the runner submits the HOMEPAGE as the listing website, so the
      // verifier must reconcile THIS row against the homepage (not its money-page
      // target_page). A durable flag scopes the homepage rule to runner-created rows only —
      // manual/strategy directory rows keep target_page.
      const rep = await worker.report({ prospect_id: p.id, outcome: 'placed', lease_token: p.lease_token, live_url: result.liveUrl || null, evidence_url: evidenceKey || null, pending, cited_homepage: true, location: String(loc.id || 'default'), notes: 'auto-submitted citation' });
      if (rep && rep.ok) { counts.placed++; }
      else {
        // report rejected (e.g. stale lease) — don't claim success; the row stays
        // claimable for the sweep. Count as failed so the run total is honest.
        logger.warn(`[signup-runner] placed report rejected for ${domain}: ${rep && rep.code}`);
        counts.failed++;
      }
    } else if (result.outcome.startsWith('blocked_')) {
      // The classifier missed a gate the engine found — RECLASSIFY so it's not
      // auto-retried, and release the lease (not a retryable failure). Build the
      // patch without undefined keys (knex rejects undefined bindings).
      const patch = { automation_policy: result.errorCode === 'blocked_payment' ? 'pay_and_submit' : 'needs_account' };
      if (result.errorCode === 'blocked_account') patch.requires_account = true;
      if (result.errorCode === 'blocked_captcha') patch.requires_captcha = true;
      if (result.errorCode === 'blocked_payment') patch.requires_payment = true;
      await leaseGuardedReclassify(p, patch);
      counts.blocked++;
    } else if (result.outcome === 'skipped') {
      // No submittable form here — mark off-lane so we stop claiming it.
      await leaseGuardedReclassify(p, { automation_policy: 'skip' });
      counts.skipped++;
    } else if (result.errorCode === 'submit_blocked' || result.errorCode === 'submit_rejected') {
      // submit_blocked = the submit endpoint is off the pinned host (can't auto-submit);
      // submit_rejected = the directory returned a rejection/error page. Either way
      // retrying the same data is futile → park it (skip) so we stop re-claiming it.
      await leaseGuardedReclassify(p, { automation_policy: 'skip' });
      counts.skipped++;
    } else {
      // Engine error / no_submit_evidence / unconfirmed — retryable via the worker
      // contract (MAX_ATTEMPTS). Nothing was observably submitted → safe to retry.
      await worker.report({ prospect_id: p.id, outcome: 'failed', lease_token: p.lease_token, notes: `runner: ${result.errorCode || 'failed'}` });
      counts.failed++;
    }
  }

  if (releaseAtEnd.length) await worker.releaseClaims(releaseAtEnd).catch(() => {});
  logger.info(`[signup-runner] ${JSON.stringify(counts)}${dryRun ? ' (DRY-RUN)' : ''}`);
  return { ...counts, ...(dryRun ? { samples } : {}) };
}

module.exports = { run };
module.exports._internals = { buildNap, parseAddress, normDomain, validateSubmitUrl, leaseGuardedReclassify };
