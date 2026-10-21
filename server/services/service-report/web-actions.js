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

// Finding text -> the service family that treats it. Ordered: the first kind
// that matches a finding wins for that finding. Matching reads the finding's
// title and detail only to classify; the text itself is never shown.
const SPECIALTY_PEST_RE = /\b(rodents?|mice|mouse|rats?|bed ?bugs?|termites?|mosquito(es)?|fleas?|ticks?|wasps?|hornets?|yellow ?jackets?|bees?|fire ants?|carpenter ants?|mites?|wildlife|squirrels?|raccoons?|opossums?|snakes?|bats?|palm)\b/i;

const FINDING_KINDS = [
  { kind: 'weeds', family: 'lawn_care', sentence: 'We saw weeds on this visit.', re: /\b(weeds?|crabgrass|dollarweed|sedges?|spurge|beggarweed|torpedograss|kyllinga)\b/i },
  { kind: 'turf', family: 'lawn_care', sentence: 'We saw lawn damage on this visit.', re: /\b(chinch|sod webworms?|armyworms?|grubs?|brown patch|take-?all|dollar spot|gray leaf spot|fungus|fungal|bare spots?|dead patches?|thinning turf)\b/i },
  { kind: 'shrubs', family: 'tree_shrub', sentence: 'We saw plant pests on this visit.', re: /\b(whiteflies|whitefly|aphids?|mealybugs?|sooty mold|lace ?bugs?|spider mites?|(armored|soft) scale|scale insects?)\b/i },
  // General household pests only: the offered program is recurring pest control (pest-quarterly). Specialty
  // problems (rodents, bed bugs, termites, mosquitoes, fleas, ticks, stinging insects, wildlife) are separate
  // programs the offer does not cover, so a finding that names one never makes this tile.
  { kind: 'pests', family: 'pest_control', sentence: 'We saw pest activity on this visit.', re: /\b(ants?|roach(es)?|cockroaches?|spiders?|silverfish|earwigs?)\b/i, veto: SPECIALTY_PEST_RE },
];

// "No ants seen" is not a finding. Titles that deny the pest never classify.
const NEGATED_RE = /\b(no|not|none|without|free of|clear of|negative)\b/i;

function recordedFindingTexts(data) {
  // Same provenance rule the document prints by: a finding counts only when it
  // came through the findings pipeline (it carries detail or a recommendation),
  // and the all-clear / raw-observation categories never count.
  const rows = (Array.isArray(data?.findings) ? data.findings : [])
    .filter((f) => f && String(f.title || '').trim())
    .filter((f) => f.category !== 'no_activity' && f.category !== 'observation')
    .filter((f) => String(f.detail || '').trim() || String(f.recommendation || '').trim())
    .filter((f) => !NEGATED_RE.test(String(f.title)))
    .map((f) => `${f.title} ${f.detail || ''}`);
  // Technician-reviewed photo findings ("What the photos showed") count too.
  const photoLabels = (Array.isArray(data?.reportV2?.photoFindings) ? data.reportV2.photoFindings : [])
    .map((f) => String(f?.label || '').trim())
    .filter((label) => label && !NEGATED_RE.test(label));
  return [...rows, ...photoLabels];
}

// The finding kinds this visit recorded, in FINDING_KINDS order, no repeats.
function findingKinds(data) {
  const texts = recordedFindingTexts(data);
  return FINDING_KINDS.filter((entry) => texts.some((text) => entry.re.test(text) && !(entry.veto && entry.veto.test(text))));
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
      serviceKey: offer.serviceKey,
      serviceLabel: offer.label,
      optionId: offer.option?.id || null,
      perApplication: offer.option?.perVisit || null,
      offerMode: offer.mode,
      fingerprint: offer.fingerprint || null,
    },
  };
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

// Photo ID handler type for the report's service line.
function photoTypeForLine(serviceLine) {
  if (serviceLine === 'lawn') return 'lawn';
  if (serviceLine === 'tree_shrub') return 'tree_shrub';
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
  const { reserviceReportCopyGateOn } = require('./reservice-report');
  const callback = reserviceReportCopyGateOn() && data?.isCallback === true;
  if (!callback && gates.isEnabled('reportCrossSell') && gates.isEnabled('reportClickToEstimate')) {
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
  buildFindingTile,
  findingKinds,
  photoTypeForLine,
  visitIsAtPrimaryHome,
  photoAnswer,
  FINDING_KINDS,
  OUTCOME_COPY,
};
