/**
 * Draft→sent learning loop for AI-composed estimates (estimator backlog PR4).
 *
 * The problem: reviseAdminEstimate replaces estimate_data WHOLESALE (only
 * lead_id/scheduled_service_id survive), so the AI's original composition is
 * destroyed by the first admin edit and nothing measures how much the
 * operator changed a draft before sending it. This module captures that
 * baseline lazily — on the first PRE-SEND revise — and stamps one learning
 * event per estimate at first send with a structured edit summary.
 *
 * Lazy capture is correct by construction: every operator EDIT funnels
 * through reviseAdminEstimate, and the one write path that replaces a
 * draft's composition without it — Agent Estimate's revise-in-place, where
 * the AGENT re-composes the draft — resets the baseline instead (see
 * resetDraftBaseline). Invariant: "no baseline row at send time" proves the
 * draft went out exactly as the AI last composed it. No creation-site hooks
 * needed.
 *
 * Concurrency contract: the WRITE paths (baseline capture, baseline reset)
 * run inside their caller's transaction — atomic with the composition
 * change they describe, so no commit gap can let a concurrent send diff
 * against a missing or obsolete baseline, and the estimates row lock
 * serializes racing writers. Inside a transaction there is no try/catch: a
 * caught PG error still poisons the enclosing transaction, so pretending
 * to be fail-soft there would be a lie. The statements are a guarded
 * insert/update/delete on our own tables — realistic failures are
 * connection-level, where the transaction is doomed regardless. The SEND
 * path stamp (recordSentLearningEvent) stays fail-soft on the root
 * connection: it runs after the send finalized and must never turn a
 * delivered estimate into an error.
 *
 * Internal-only data: edit summaries hold keys/booleans/numbers, never free
 * text, and nothing here may touch the estimates.notes column (that column
 * is customer-visible via the public estimate endpoint).
 */

const db = require('../models/db');
const logger = require('./logger');

// Two AI composers write sendable drafts today: the call-triggered engine
// AND the Agent Estimate workspace both stamp source='estimator_engine'
// (the SMS-thread lane included — it shares the engine pipeline); the
// legacy IB quoting tool stamps source='ai_agent'. Everything else
// (manual, quote_wizard, email_inquiry, lead_webhook, sms_intake,
// lead_agent, booking_assessment) is out of scope for edit distance —
// human-authored, customer-self-served, template-built, or bare unpriced
// intake shells (booking_assessment included: an assessment pre-draft
// carries no AI-composed pricing to measure edits against).
const AI_DRAFT_SOURCES = new Set(['estimator_engine', 'ai_agent']);

function parseData(raw) {
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
  } catch {
    return {};
  }
}

function money(value) {
  const num = parseFloat(value);
  return Number.isFinite(num) ? Math.round(num * 100) / 100 : 0;
}

function norm(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function baselineFieldsFrom(row) {
  return {
    address: row.address || null,
    customer_name: row.customer_name || null,
    customer_phone: row.customer_phone || null,
    customer_email: row.customer_email || null,
    monthly_total: money(row.monthly_total),
    annual_total: money(row.annual_total),
    onetime_total: money(row.onetime_total),
    waveguard_tier: row.waveguard_tier || null,
    service_interest: row.service_interest || null,
    category: row.category || null,
  };
}

// Service keys across the persisted shapes: engine + ai_agent drafts store
// pricing inputs at engineInputs.services (object keyed by ENGINE service
// key: pest, lawn, oneTimePest); the admin builder's save persists the raw
// /calculate-estimate payload, whose engineRequest.selectedServices is an
// ARRAY of BUILDER codes (PEST, LAWN, OT_PEST). The two vocabularies are
// different names for the same services, so a code array is run through the
// builder's own translator (translateV2CallToV1Input, the same one the save
// path reprices with) before the diff. Comparing them raw reported a remove
// plus an add on every send (60-day read 2026-10-03: 37 of 49 "service
// changes" were pest vs PEST). Absent a readable shape, or when the codes
// cannot be translated, the side is not comparable and the diff omits the
// service arrays rather than reporting a false change or a false empty set.
function translateBuilderCodes(engineRequest, codes) {
  if (!codes.length) return [];
  let translate;
  try {
    // Lazy: the route adapter requires services that require this module.
    translate = require('../routes/property-lookup-v2').translateV2CallToV1Input;
  } catch {
    return null;
  }
  if (typeof translate !== 'function') return null;
  try {
    const input = translate(engineRequest.profile || {}, codes, engineRequest.options || {});
    const keys = Object.keys(input?.services || {});
    // Codes the translator does not know yield nothing: unknown, not "none".
    return keys.length ? keys.sort() : null;
  } catch {
    return null;
  }
}

function serviceKeysFrom(data) {
  const services = data?.engineInputs?.services
    || data?.engineRequest?.services
    || data?.inputs?.services;
  if (services && typeof services === 'object' && !Array.isArray(services)) {
    return Object.keys(services).sort();
  }
  const selected = data?.engineRequest?.selectedServices;
  if (Array.isArray(selected)) {
    const codes = [...new Set(selected.filter((key) => typeof key === 'string'))];
    return translateBuilderCodes(data.engineRequest, codes);
  }
  return null;
}

// The same address in another FORMAT is not an edit. The engine draft
// holds the address as the caller gave it; the builder's save replaces it
// with the autocomplete form (suffix spelled out, country appended, commas
// dropped). Two addresses are the same only when they are equal word for
// word after punctuation is dropped, suffix and direction words are
// abbreviated and a trailing country is removed. The one part allowed to
// differ is the ending state and ZIP: each may be missing on one side.
// Anything else is a change: another house number, street word, direction,
// unit or city, a different ZIP, or a word added anywhere. No other address
// part is guessed at, so the rule can over-count an edit and never hide one.
const STREET_WORDS = Object.freeze({
  street: 'st', avenue: 'ave', av: 'ave', road: 'rd', drive: 'dr', boulevard: 'blvd', lane: 'ln',
  court: 'ct', circle: 'cir', place: 'pl', terrace: 'ter', terr: 'ter', trail: 'trl', parkway: 'pkwy',
  highway: 'hwy', north: 'n', south: 's', east: 'e', west: 'w',
  northeast: 'ne', northwest: 'nw', southeast: 'se', southwest: 'sw',
  florida: 'fl',
});
const COUNTRY_TAIL = [['usa'], ['us'], ['united', 'states'], ['united', 'states', 'of', 'america']];

function addressTokens(value) {
  const tokens = norm(value).replace(/[^a-z0-9 ]/g, ' ').split(' ').filter(Boolean).map((t) => STREET_WORDS[t] || t);
  // The country says nothing about which property it is.
  for (const tail of COUNTRY_TAIL) {
    if (tokens.length > tail.length && tail.every((t, i) => tokens[tokens.length - tail.length + i] === t)) {
      return tokens.slice(0, -tail.length);
    }
  }
  return tokens;
}

// Split off the ending "[state] [ZIP[+4]]" (in that order; a +4 only
// straight after a 5-digit ZIP, so a lone "#1234" stays in the core as the
// unit it is). The core keeps a house number, a street word and one more
// word at least; with less than that nothing is split off.
function splitAddress(tokens) {
  const core = tokens.slice();
  const out = { core: tokens, state: '', zip: '', plus4: '' };
  let plus4 = '';
  let zip = '';
  let state = '';
  if (core.length >= 2 && /^\d{4}$/.test(core[core.length - 1]) && /^\d{5}$/.test(core[core.length - 2])) plus4 = core.pop();
  if (/^\d{5}$/.test(core[core.length - 1] || '')) zip = core.pop();
  if (core[core.length - 1] === 'fl') state = core.pop();
  if (core.length < 3 || !(zip || state)) return out;
  return { core, state, zip, plus4 };
}

function sameProperty(a, b) {
  const x = splitAddress(addressTokens(a));
  const y = splitAddress(addressTokens(b));
  if (x.core.length !== y.core.length || !x.core.every((t, i) => y.core[i] === t)) return false;
  // Each ending part may be missing on one side; present on both, it must agree.
  return ['state', 'zip', 'plus4'].every((k) => !x[k] || !y[k] || x[k] === y[k]);
}

// The WaveGuard setup fee stored two ways is not an edit. The builder's
// save folds it into the stored one-time total (result.oneTime.membershipFee,
// which the mapper takes from the pest line's initialFee); the engine
// draft's stored one-time total leaves the same fee out (60-day read
// 2026-10-03: 34 of 36 one-time changes were exactly this fee). So when the
// baseline is an engine draft whose own pest line already owed the fee, a
// builder-saved row is compared net of it (setupFeeExcluded records the
// amount). A fee the baseline did NOT owe (a bundle edited down to a
// single-service plan) is a real price change and stays in the diff.
const isBuilderShape = (data) => Array.isArray(data?.engineRequest?.selectedServices);
const positive = (value) => {
  const num = parseFloat(value);
  return Number.isFinite(num) && num > 0 ? money(num) : 0;
};

function builderSetupFee(data) {
  if (!isBuilderShape(data)) return 0;
  const root = data.result && typeof data.result === 'object' ? data.result : data;
  return positive(root?.oneTime?.membershipFee);
}

function engineOwedSetupFee(data) {
  if (isBuilderShape(data)) return 0;
  const lines = data?.engineResult?.lineItems;
  if (!Array.isArray(lines)) return 0;
  return positive(lines.find((line) => line?.service === 'pest_control')?.initialFee);
}

/**
 * Pure diff between the captured baseline row and the sent estimate row.
 * baseline === null ⇒ never revised ⇒ sent exactly as composed.
 */
function computeEditSummary({ baseline, sentRow }) {
  if (!baseline) {
    return { reviseCount: 0, baselineCapture: null, sentUnedited: true };
  }
  const fields = parseData(baseline.baseline_fields);
  const baselineData = parseData(baseline.baseline_estimate_data);
  const sentData = parseData(sentRow.estimate_data);
  const summary = {
    reviseCount: baseline.revise_count || 0,
    baselineCapture: baseline.capture_point || 'first_revise',
  };

  const totals = {};
  for (const key of ['monthly_total', 'annual_total', 'onetime_total']) {
    const from = money(fields[key]);
    let to = money(sentRow[key]);
    if (key === 'onetime_total') {
      // Net of the fee only up to what the engine baseline already owed. A
      // one-time discount can leave the stored total under the fee; the net
      // is then negative, which is the discount showing as a decrease.
      const fee = Math.min(builderSetupFee(sentData), engineOwedSetupFee(baselineData));
      if (fee > 0) {
        to = money(to - fee);
        summary.setupFeeExcluded = fee;
      }
    }
    if (from !== to) totals[key] = { from, to };
  }
  if (Object.keys(totals).length) summary.totalsChanged = totals;

  if (!sameProperty(fields.address, sentRow.address)) summary.addressChanged = true;
  if (
    norm(fields.customer_name) !== norm(sentRow.customer_name)
    || norm(fields.customer_phone) !== norm(sentRow.customer_phone)
    || norm(fields.customer_email) !== norm(sentRow.customer_email)
  ) summary.contactChanged = true;
  if (norm(fields.waveguard_tier) !== norm(sentRow.waveguard_tier)) summary.tierChanged = true;
  if (norm(fields.category) !== norm(sentRow.category)) summary.categoryChanged = true;

  const baseKeys = serviceKeysFrom(baselineData);
  const sentKeys = serviceKeysFrom(sentData);
  if (baseKeys && sentKeys) {
    const added = sentKeys.filter((k) => !baseKeys.includes(k));
    const removed = baseKeys.filter((k) => !sentKeys.includes(k));
    if (added.length) summary.servicesAdded = added;
    if (removed.length) summary.servicesRemoved = removed;
    summary.servicesComparable = true;
  } else {
    summary.servicesComparable = false;
  }
  // service_interest is a display label: the engine writes the caller's
  // words ("Quarterly Pest Control Service"), the builder its own category
  // name ("Pest Control"). When the service keys are comparable they are the
  // record of what changed; the label counts only when they are not.
  if (!summary.servicesComparable && norm(fields.service_interest) !== norm(sentRow.service_interest)) {
    summary.serviceInterestChanged = true;
  }

  summary.sentUnedited = summary.reviseCount === 0
    && !summary.totalsChanged
    && !summary.addressChanged
    && !summary.contactChanged
    && !summary.tierChanged
    && !summary.serviceInterestChanged
    && !summary.categoryChanged
    && !summary.servicesAdded
    && !summary.servicesRemoved;
  return summary;
}

/**
 * Called by reviseAdminEstimate INSIDE its revise transaction (pass trx),
 * after the guarded UPDATE won, with the PRE-EDIT row. Atomicity matters:
 * were the rewrite committed before this insert, a concurrent send would
 * read the revised draft as "unedited", and an Agent Estimate recompose
 * could reset nothing and then have a stale baseline appear afterward.
 * First pre-send revise captures the baseline; later ones only bump the
 * counter. Post-send revises are the edit-of-sent lane, not draft
 * calibration — skipped.
 */
async function recordPreSendRevision({ priorEstimate, trx = db }) {
  if (!priorEstimate?.id) return null;
  if (!AI_DRAFT_SOURCES.has(priorEstimate.source)) return null;
  if (priorEstimate.sent_at) return null;

  const inserted = await trx('estimate_draft_baselines')
    .insert({
      estimate_id: priorEstimate.id,
      source: priorEstimate.source,
      baseline_estimate_data: JSON.stringify(parseData(priorEstimate.estimate_data)),
      baseline_fields: JSON.stringify(baselineFieldsFrom(priorEstimate)),
      capture_point: 'first_revise',
      revise_count: 1,
      first_revised_at: trx.fn.now(),
      last_revised_at: trx.fn.now(),
    })
    .onConflict('estimate_id')
    .ignore()
    .returning('id');

  if (!inserted || !inserted.length) {
    await trx('estimate_draft_baselines')
      .where({ estimate_id: priorEstimate.id })
      .update({
        revise_count: trx.raw('revise_count + 1'),
        last_revised_at: trx.fn.now(),
        updated_at: trx.fn.now(),
      });
  }
  return true;
}

// "No baseline ⇒ never edited" only holds for drafts created after the
// capture hook was LIVE — an AI draft edited before that but sent after
// has no baseline because the hook didn't exist, not because it went out
// untouched. knex_migrations gives when the ledger migration ran, but
// Railway runs migrations BEFORE the app rollout, so old hook-less pods
// keep writing for a few more minutes — the margin conservatively covers
// that migrate→rollout window (drafts inside it read as unknown, never as
// falsely unedited). A lookup failure is not cached (retry next send) and
// degrades to 0 = treat drafts as post-cutover.
const LEDGER_ROLLOUT_MARGIN_MS = 60 * 60 * 1000;
let ledgerCutoverPromise = null;
function ledgerCutoverMs() {
  if (!ledgerCutoverPromise) {
    ledgerCutoverPromise = db('knex_migrations')
      .where('name', 'like', '%estimate_learning_loop%')
      .first()
      .then((migrationRow) => {
        const ts = new Date(migrationRow?.migration_time ?? NaN).getTime();
        if (!Number.isFinite(ts) || ts <= 0) {
          // Absent/unreadable row — don't cache, retry on the next send.
          ledgerCutoverPromise = null;
          return 0;
        }
        return ts;
      })
      .catch((err) => {
        logger.warn(`[estimate-learning] ledger cutover lookup failed: ${err.message}`);
        ledgerCutoverPromise = null;
        return 0;
      });
  }
  return ledgerCutoverPromise;
}

/**
 * Called from the send path after the send finalizes. Stamps one 'sent'
 * learning event per estimate (first send wins; the unique constraint makes
 * resends no-ops). Lane comes from the baseline's estimatorEngine snapshot
 * when a revise destroyed it on the live row. Drafts that predate the
 * ledger stamp an explicit unknown (sent_unedited: null) instead of a
 * false "unedited".
 *
 * sentRow is REQUIRED and must be the caller's claimed PRE-FINALIZE
 * snapshot, never a re-read of the live row, for two reasons: a customer
 * can accept between delivery and this stamp (routine on the superseded
 * path), and acceptance rewrites totals and estimate_data with the
 * CUSTOMER's frequency/service choices — which must never read as
 * pre-send operator edits. And the snapshot's own sent_at gates first-send
 * detection: a resend's snapshot carries the prior send's timestamp and is
 * skipped, so a first-send stamp that was lost to a transient failure can
 * never be back-filled later by a resend's post-edit composition.
 */
async function recordSentLearningEvent({ estimateId, sentRow = null }) {
  try {
    if (!estimateId || !sentRow) return null;
    const row = sentRow;
    if (!AI_DRAFT_SOURCES.has(row.source)) return null;
    if (row.sent_at) return null;
    // Commercial proposal rows are excluded from edit calibration: the
    // proposal PUT is an operator-authored layer that never passes through
    // reviseAdminEstimate (which itself refuses COMMERCIAL rows), so a
    // missing baseline on a proposal send proves nothing about edits. The
    // commercial lane gets its own instrumentation when it gets its own
    // composer.
    if (String(row.category || '').toUpperCase() === 'COMMERCIAL'
      || parseData(row.estimate_data)?.proposal) return null;

    const baseline = await db('estimate_draft_baselines')
      .where({ estimate_id: row.id })
      .first();
    let summary;
    if (baseline) {
      summary = computeEditSummary({ baseline, sentRow: row });
    } else {
      // No baseline: "never edited" and "edited before the ledger was live"
      // are distinguished only by the cutover. When that lookup fails, the
      // stamp is unknown — first-send-wins makes a wrong guess permanent.
      const createdMs = new Date(row.created_at ?? NaN).getTime();
      const cutoverMs = await ledgerCutoverMs();
      if (!cutoverMs) {
        summary = { reviseCount: null, baselineCapture: 'cutover_unknown', sentUnedited: null };
      } else if (Number.isFinite(createdMs) && createdMs < cutoverMs + LEDGER_ROLLOUT_MARGIN_MS) {
        summary = { reviseCount: null, baselineCapture: 'pre_ledger', sentUnedited: null };
      } else {
        summary = computeEditSummary({ baseline: null, sentRow: row });
      }
    }
    const lane = (baseline && parseData(baseline.baseline_estimate_data)?.estimatorEngine?.lane)
      || parseData(row.estimate_data)?.estimatorEngine?.lane
      || null;

    await db('estimate_learning_events')
      .insert({
        estimate_id: row.id,
        event_type: 'sent',
        source: row.source,
        lane,
        edit_summary: JSON.stringify(summary),
        sent_unedited: summary.sentUnedited ?? null,
      })
      .onConflict(['estimate_id', 'event_type'])
      .ignore();
    return summary;
  } catch (err) {
    logger.warn(`[estimate-learning] sent event failed for estimate ${estimateId}: ${err.message}`);
    return null;
  }
}

/**
 * Called when an AI composer REPLACES a draft's composition wholesale
 * (Agent Estimate's revise-in-place). The captured baseline describes the
 * replaced composition — drop it so the live row is once again "the latest
 * AI composition" and a later operator edit captures a fresh baseline.
 * Keeping it would count the agent's own re-composition as operator edit
 * distance.
 *
 * Unlike the capture paths, this runs INSIDE the recomposition's
 * transaction (pass trx): the delete must be atomic with the composition
 * swap — a commit gap would let a concurrent send diff the new composition
 * against the obsolete baseline — and a rollback then preserves the
 * baseline automatically. The trade-off is accepted: a delete can only
 * realistically fail on connection-level errors, where the enclosing
 * transaction is doomed regardless, so joining it cannot poison an
 * otherwise-healthy revise. No try/catch here — inside an aborted PG
 * transaction a caught error would still poison the caller.
 */
async function resetDraftBaseline({ estimateId, trx = db }) {
  if (!estimateId) return null;
  await trx('estimate_draft_baselines').where({ estimate_id: estimateId }).del();
  return true;
}

module.exports = {
  AI_DRAFT_SOURCES,
  computeEditSummary,
  recordPreSendRevision,
  recordSentLearningEvent,
  resetDraftBaseline,
  _private: {
    baselineFieldsFrom,
    serviceKeysFrom,
    sameProperty,
    builderSetupFee,
    engineOwedSetupFee,
    money,
    norm,
    // Test-only: the cutover is cached for the process lifetime.
    resetLedgerCutoverCache: () => {
      ledgerCutoverPromise = null;
    },
  },
};
