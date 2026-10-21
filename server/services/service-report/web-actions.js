// ============================================================
// web-actions.js — the simple web service report's two customer-started
// actions (GATE_REPORT_WEB_ACTIONS, owner 2026-10-20 "OK BUILD THEM ALL"):
//
//   1. finding -> offer tile. One tile at most, tied to a finding recorded on
//      THIS visit, linking (through the existing click-to-estimate tap) to an
//      estimate page. The offer is the one the report's cross-sell builder
//      already picks for this customer; this module only checks that a real
//      finding points at the same service family. Fixed sentences, no price.
//   2. "Seen something since?" photo check. The route runs the existing
//      customer photo ID handlers; this module turns their reply into a fixed
//      sentence and a yes/no "plan covers it".
//
// Nothing here sends a customer message or books a visit.
// ============================================================

const { WAVES_SUPPORT_PHONE_DISPLAY } = require('../../constants/business');

// The finding tile maps ONLY from structured identity the report already carries: the category of an
// insight card (reportV2.insights[]) on a report of a specific service line, through this explicit table.
// No free text (titles, details, labels) is ever read to decide a kind. A finding with no row here gets
// no tile, which is the safe answer for everything the table does not name (fungal leaf spots on a
// shrub, specialty pests, household pests with no structured category, unreviewed notes).
//   line      the report's service line (data.serviceLine): lawn weeds only on a LAWN-line report
//   category  the insight card's category
//   family    the one service family that treats it (compared with the offer the cross-sell builder picks)
const STRUCTURED_FINDING_TABLE = [
  { line: 'lawn', category: 'weeds', family: 'lawn_care', kind: 'weeds', sentence: 'We saw weeds on this visit.' },
  { line: 'tree_shrub', category: 'pest_pressure', family: 'tree_shrub', kind: 'shrub_pests', sentence: 'We noted signs of plant pests on this visit.' },
];
// An insight is a finding only when it shows a concern (the same statuses the report's own issue lists use).
const CONCERN_STATUSES = new Set(['watch', 'needs_attention', 'urgent']);

// Metadata key the tile's tap carries so the events route can recheck the tile's own gates.
const WEB_TILE_SOURCE = 'web_actions_finding_tile';

// The table rows this visit's structured insights match, in table order, no repeats.
function findingKinds(data) {
  const insights = Array.isArray(data?.reportV2?.insights) ? data.reportV2.insights : [];
  return STRUCTURED_FINDING_TABLE.filter((row) => row.line === data?.serviceLine
    && insights.some((card) => card && card.category === row.category && CONCERN_STATUSES.has(card.status)));
}

// Payload for the finding tile, or null. `buildCrossSell` is injected so the
// route passes the real builder and tests pass a stub.
async function buildFindingTile(data, { buildCrossSell }) {
  const kinds = findingKinds(data);
  if (!kinds.length) return null;
  const offer = await buildCrossSell();
  // Click-to-estimate mints only from a priced offer; a quote-only offer has no
  // estimate page to link to, so it makes no tile.
  if (!offer || offer.mode !== 'priced' || !offer.serviceKey) return null;
  const match = kinds.find((entry) => entry.family === offer.serviceKey);
  if (!match) return null;
  const label = String(offer.label || '').trim();
  if (!label) return null;
  return {
    kind: match.kind,
    sentence: match.sentence,
    body: `${label} can take care of this. Tap below to see your estimate. Nothing is booked or charged.`,
    button: 'See your estimate',
    // The exact metadata the existing cross_sell_requested tap sends. The server
    // recomputes the offer on the tap and rejects any drift; the page never
    // shows these fields.
    tap: {
      // Names the web report tile, so the server rechecks its gates when it is tapped.
      source: WEB_TILE_SOURCE,
      // The structured finding the tile was made for; the tap re-derives it from the current report.
      kind: match.kind,
      serviceKey: offer.serviceKey,
      serviceLabel: offer.label,
      optionId: offer.option?.id || null,
      perApplication: offer.option?.perVisit || null,
      offerMode: offer.mode,
      fingerprint: offer.fingerprint || null,
    },
  };
}

// The plant handler's subject for the report's service line: a palm report is read as palm (the handler
// scopes the engine to palm), everything else keeps its own handler's default.
function photoSubjectForLine(serviceLine) {
  return serviceLine === 'palm' ? 'palm' : null;
}

// True only when the visit is PROVABLY at the customer's primary home, by the shared
// visit-scope chain (visit-property-scope.js): the visit's own address stamp (unit
// included), else its property link, else its creating estimate, compared with the
// customer's own address; a visit with no evidence at all counts only on an account
// proven to have a single premises. Anything unproven, or any failed read, is false,
// and the photo answer then never says "covered" and never offers the booking button
// (the re-service picker books the on-file address, so another unit or a linked
// secondary property must not read as covered).
async function visitIsAtPrimaryHome(row, knex) {
  try {
    const linkage = require('../estimate-property-linkage');
    const { resolveVisitPropertyScope, sameResolvedProperty, customerHasOnlyPrimaryPremises } = require('./visit-property-scope');
    const mirrorKey = linkage.normalizedStampedStreet(row.cust_address_line1, row.cust_address_line2, row.cust_city, row.cust_zip) || null;
    if (!mirrorKey) return false;
    let failed = false;
    const scope = await resolveVisitPropertyScope(row, knex, { onLookupFailure: () => { failed = true; } });
    if (failed) return false;
    if (scope.hasEvidence) return !!scope.key && sameResolvedProperty(scope.key, mirrorKey);
    // The single-premises fallback proves nothing from a customer address with no locality.
    if (linkage.scopeKeyLacksLocality(mirrorKey)) return false;
    const customer = await knex('customers').where({ id: row.customer_id }).first('has_multi_home');
    return await customerHasOnlyPrimaryPremises(knex, row.customer_id, customer, mirrorKey, { unresolvedFails: true });
  } catch (err) {
    require('../logger').warn(`[web-actions] home check failed, coverage withheld: ${err.message}`);
    return false;
  }
}

// The tile's tap is the existing cross_sell_requested event. When the event names the tile, the tile's own
// gates must still be live (the page may have loaded before a gate went dark); otherwise the caller answers
// the same 409 a stale offer gets. Taps that do not name the tile are the old card's and are unaffected.
function webTileTapAllowed(metadata, gates) {
  if (!metadata || metadata.source !== WEB_TILE_SOURCE) return true;
  return webActionsLive(gates) === true && gates.isEnabled('reportClickToEstimate') === true;
}

// Photo ID handler type for the report's service line.
function photoTypeForLine(serviceLine) {
  if (serviceLine === 'lawn') return 'lawn';
  // Palm has no handler of its own: the plant handler reads it with the tree & shrub engine.
  if (serviceLine === 'tree_shrub' || serviceLine === 'palm') return 'tree_shrub';
  return 'pest';
}

const CALL_LINE = `Call us at ${WAVES_SUPPORT_PHONE_DISPLAY} and we will help with next steps.`;

// What the customer reads for each photo ID outcome. `reservice` is the only
// outcome that offers the booking button, and only the existing coverage check
// (plan lane covered, primary property, self-serve gates on) produces it.
const OUTCOME_COPY = {
  reservice: 'Your plan covers this. You can book a free re-service in your Waves account.',
  none: 'Based on what we can see, no action is needed right now.',
  inspection: `A photo can suggest what this is, but our team confirms it in person. Call us at ${WAVES_SUPPORT_PHONE_DISPLAY} and we will set up a visit.`,
  unclear: `We could not get a clear read from this photo. Call us at ${WAVES_SUPPORT_PHONE_DISPLAY} and we will take a look.`,
  request: CALL_LINE,
  referral: CALL_LINE,
  fix_conditions: `This looks like a growing-conditions problem, not a pest. Call us at ${WAVES_SUPPORT_PHONE_DISPLAY} and we will tell you what to change.`,
};

function headlineFrom(type, body) {
  const fromV2 = body?.v2?.answer?.headline;
  if (typeof fromV2 === 'string' && fromV2.trim()) return fromV2.trim().slice(0, 140);
  const result = body?.result || {};
  const plain = type === 'pest' ? result.label : type === 'lawn' ? result.observations : result.summary;
  return typeof plain === 'string' && plain.trim() && !/^we couldn.?t/i.test(plain) ? plain.trim().slice(0, 240) : null;
}

// Fixed-sentence answer from a photo ID reply ({ status, body }). Never echoes
// the standing re-service token (the photo ID reply carries it as next_step.url);
// the booking button goes to the signed-in Schedule tab, as the report's
// existing re-service card does.
function photoAnswer(type, reply) {
  if (!reply || reply.status !== 200 || !reply.body) {
    const status = reply?.status;
    // The handler's own 503 and 4xx copy is customer-safe and already carries the office line.
    const message = typeof reply?.body?.error === 'string' && reply.body.error
      ? reply.body.error
      : `We could not check this photo right now. Call us at ${WAVES_SUPPORT_PHONE_DISPLAY}.`;
    return { ok: false, status: status >= 400 && status < 600 ? status : 502, message };
  }
  const kind = reply.body.next_step?.kind;
  // The plant engine's fix_conditions hint maps to next_step.kind 'none' (no booking), which must not
  // read as "no action is needed": conditions have to change. Checked first. Never covered.
  if (reply.body.v2?.next_step_hint?.kind === 'fix_conditions') {
    return { ok: true, headline: headlineFrom(type, reply.body), message: OUTCOME_COPY.fix_conditions, canRebook: false };
  }
  const message = OUTCOME_COPY[kind] || CALL_LINE;
  return {
    ok: true,
    headline: headlineFrom(type, reply.body),
    message,
    canRebook: kind === 'reservice',
  };
}

// Both report gates live: web actions only exist beside the simple web report.
// A partial gates module reads as off.
function webActionsLive(gates) {
  return typeof gates.reportSimpleWebLive === 'function' && gates.reportSimpleWebLive()
    && typeof gates.reportWebActionsLive === 'function' && gates.reportWebActionsLive();
}

// Sets the report payload's `webActions` key; leaves the payload untouched when
// neither action applies (not a live simple-web view, an internal-only report,
// or the gate is off).
// Photo button: only while the customer photo ID is live (the route reuses it).
// Finding tile: only while the cross-sell and click-to-estimate gates are live,
// never on a complaint-driven (callback) visit, and best-effort: any failure
// leaves the tile out and the report as it was.
async function attachWebActions(service, data, { db, gates, simpleWeb }) {
  if (!simpleWeb || data?.internalOnly || !webActionsLive(gates)) return;
  const out = {};
  if (service?.customer_id && gates.isEnabled('customerPhotoId')) {
    out.photo = { type: photoTypeForLine(data?.serviceLine) };
  }
  // A callback visit never gets a sales tile, whatever GATE_RESERVICE_REPORT_COPY says (the payload carries isCallback
  // on its own).
  if (data?.isCallback !== true && gates.isEnabled('reportCrossSell') && gates.isEnabled('reportClickToEstimate')) {
    try {
      const { buildReportCrossSell } = require('./cross-sell');
      const finding = await buildFindingTile(data, { buildCrossSell: () => buildReportCrossSell(service, db) });
      if (finding) out.finding = finding;
    } catch (err) {
      require('../logger').warn(`[web-actions] finding tile skipped: ${err.message}`);
    }
  }
  if (out.photo || out.finding) data.webActions = out;
}

module.exports = {
  attachWebActions,
  webActionsLive,
  webTileTapAllowed,
  WEB_TILE_SOURCE,
  buildFindingTile,
  findingKinds,
  photoTypeForLine,
  photoSubjectForLine,
  visitIsAtPrimaryHome,
  photoAnswer,
  STRUCTURED_FINDING_TABLE,
  OUTCOME_COPY,
};
