'use strict';

/**
 * Bid Desk Packet Readiness & Commercial Margin Analyzer (admin only).
 *
 * Pure deterministic cross-check (`evaluateBidPacketReadiness`) + thin DB loader
 * (`loadBidPacketReadiness`). Reuses Waves' canonical Bid Kit catalog, checklist
 * templates, kit-to-checklist map, `normalizeProposal`/`computeProposalTotals`,
 * and `computeProjectCosts` — zero duplicated calculations, zero paid API calls,
 * zero outbound customer/buyer sends.
 */

const { templateRows, SECTION_STOP } = require('../../../shared/bid-checklist-templates.cjs');
const { kitKeysForLine, REFERENCE_TARGET } = require('../../../shared/bid-checklist-kit-map.cjs');
const catalog = require('../../../shared/bid-kit-catalog.cjs');
const { computeProjectCosts, proposalRevenueIssue } = require('../../../shared/proposal-bid.cjs');
const { normalizeProposal, computeProposalTotals } = require('../estimate-proposal');
const { proposalExpiry } = require('../proposal-bid');
const { OPEN_STATUSES } = require('./rules');
const { etDateString } = require('../../utils/datetime-et');

const THIN_MARGIN_THRESHOLD_PCT = 35;

function parseJsonObject(raw) {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof raw === 'object' ? raw : {};
}

function requiredKitKeysForBid(bid, checklistItems, archivedTemplateKeys = []) {
  const allItems = checklistItems || [];
  const liveChecklist = allItems.filter((item) => !item.archived_at);
  const archivedKeys = new Set([
    ...(archivedTemplateKeys || []),
    ...allItems.filter((item) => item.archived_at && item.template_key).map((item) => item.template_key),
  ]);
  const sourceLines = liveChecklist.length
    ? liveChecklist.filter((item) => item.required === true)
    : templateRows(bid?.solicitation_type).filter((item) => item.required !== false && !archivedKeys.has(item.template_key));
  const keys = new Set();
  for (const line of sourceLines) {
    for (const key of kitKeysForLine(line.template_key)) keys.add(key);
  }
  return [...keys];
}

function perBidCompletionByKey(checklistItems) {
  const liveRequired = (checklistItems || []).filter((item) => !item.archived_at && item.required === true);
  const stats = new Map();
  for (const line of liveRequired) {
    for (const key of kitKeysForLine(line.template_key)) {
      const cur = stats.get(key) || { liveRequired: 0, unchecked: 0 };
      cur.liveRequired += 1;
      if (!line.checked_at) cur.unchecked += 1;
      stats.set(key, cur);
    }
  }
  return stats;
}

function evaluateReferenceRequirement(rows, today, dueDay) {
  const refs = rows.filter((r) => !r.archived_at && r.item_key === 'reference' && r.kind === 'reference');
  const readyToday = refs.filter((r) => {
    const s = catalog.itemStatus(r, { today });
    return s === catalog.STATUS.READY || s === catalog.STATUS.EXPIRING;
  });
  const readyOnDue = dueDay
    ? readyToday.filter((r) => {
      const s = catalog.itemStatus(r, { today: dueDay });
      return s === catalog.STATUS.READY || s === catalog.STATUS.EXPIRING;
    })
    : readyToday;
  const ok = readyOnDue.length >= REFERENCE_TARGET;
  return {
    key: 'reference',
    label: 'Client references',
    status: ok ? 'ready' : 'insufficient_references',
    ready_count: readyOnDue.length,
    target_count: REFERENCE_TARGET,
    per_bid: false,
    notarized: false,
    ok,
  };
}

function evaluateSingleKitKey(key, rows, today, dueDay) {
  const item = catalog.catalogItem(key);
  const label = item?.label || key;
  const matching = rows.filter((r) => !r.archived_at && r.item_key === key && (!item || r.kind === item.kind));
  if (!matching.length) {
    return {
      key,
      label,
      status: catalog.STATUS.MISSING,
      per_bid: Boolean(item?.perBid),
      notarized: Boolean(item?.notarized),
      ok: false,
    };
  }
  const best = matching[0];
  const statusToday = catalog.itemStatus(best, { today });
  const validToday = statusToday === catalog.STATUS.READY || statusToday === catalog.STATUS.EXPIRING;
  if (!validToday) {
    return {
      key,
      label,
      status: statusToday,
      expires_on: best.expires_on || null,
      per_bid: Boolean(item?.perBid),
      notarized: Boolean(item?.notarized),
      ok: false,
    };
  }
  if (dueDay) {
    const statusAtDue = catalog.itemStatus(best, { today: dueDay });
    if (statusAtDue === catalog.STATUS.EXPIRED) {
      return {
        key,
        label,
        status: 'expires_before_due',
        expires_on: best.expires_on || null,
        per_bid: Boolean(item?.perBid),
        notarized: Boolean(item?.notarized),
        ok: false,
      };
    }
  }
  return {
    key,
    label,
    status: statusToday,
    expires_on: best.expires_on || null,
    per_bid: Boolean(item?.perBid),
    notarized: Boolean(item?.notarized),
    ok: true,
  };
}

function evaluateKitRequirements(bid, checklistItems, bidKitRows, today, dueDay, kitUnavailable, archivedTemplateKeys = []) {
  const keys = requiredKitKeysForBid(bid, checklistItems, archivedTemplateKeys);
  if (kitUnavailable) {
    return {
      kit_coverage: { ready: 0, total: keys.length, percent: null, unavailable: true, items: [] },
      blockers: [{ code: 'kit_unavailable', message: 'Bid Kit could not be read right now — reload before verifying required papers.' }],
      perBidActions: [],
    };
  }

  const perBidCompletion = perBidCompletionByKey(checklistItems);
  const items = keys.map((key) => (
    key === 'reference'
      ? evaluateReferenceRequirement(bidKitRows, today, dueDay)
      : evaluateSingleKitKey(key, bidKitRows, today, dueDay)
  ));

  const blockers = [];
  const perBidActions = [];
  for (const entry of items) {
    if (!entry.ok) {
      const detail = entry.status === 'expires_before_due'
        ? `${entry.label} expires on ${entry.expires_on} (before the bid due date ${dueDay})`
        : entry.status === 'insufficient_references'
          ? `Only ${entry.ready_count} of ${entry.target_count} approved references are ready in Bid Kit`
          : `${entry.label} is ${catalog.STATUS_LABEL[entry.status] || entry.status} in Bid Kit`;
      blockers.push({ code: entry.status === 'expires_before_due' ? 'kit_expires_before_due' : 'kit_item_not_ready', key: entry.key, message: detail });
    }
    const completion = perBidCompletion.get(entry.key);
    const checklistDoneForKey = completion && completion.liveRequired > 0 && completion.unchecked === 0;
    if (entry.per_bid && !checklistDoneForKey) {
      perBidActions.push({
        key: entry.key,
        notarized: entry.notarized,
        message: entry.notarized
          ? `${entry.label}: prepare, sign, and notarize a fresh copy for this bid`
          : `${entry.label}: request a fresh copy naming this agency/GC for this bid`,
      });
    }
  }

  const readyCount = items.filter((e) => e.ok).length;
  const total = items.length;
  return {
    kit_coverage: {
      ready: readyCount,
      total,
      percent: total ? Math.round((readyCount / total) * 100) : 100,
      unavailable: false,
      items,
    },
    blockers,
    perBidActions,
  };
}

function resolveOfferExpiry(estimate) {
  const fixed = proposalExpiry(estimate);
  if (fixed) return { at: fixed, source: 'valid_through' };
  if (estimate.expires_at) {
    const parsed = new Date(estimate.expires_at);
    if (!Number.isNaN(parsed.getTime())) return { at: parsed, source: 'expires_at' };
  }
  return { at: null, source: null };
}

const UNUSABLE_ESTIMATE_STATUSES = new Set(['declined', 'rejected', 'expired', 'void', 'voided', 'cancelled', 'canceled']);

function checkEstimateUsability(estimate) {
  if (estimate.archived_at) {
    return { code: 'estimate_archived', message: 'Linked estimate/proposal has been archived — link an active commercial proposal before submitting.' };
  }
  const status = String(estimate.status || '').trim().toLowerCase();
  if (UNUSABLE_ESTIMATE_STATUSES.has(status)) {
    return { code: 'estimate_not_usable', message: `Linked estimate/proposal status is "${status}" — revise or link an active proposal before submitting.` };
  }
  return null;
}

function checkProposalExpiry(estimate, bid, validThrough, now) {
  try {
    const { at, source } = resolveOfferExpiry(estimate);
    if (!at) return null;
    const label = source === 'valid_through' && validThrough ? validThrough : etDateString(at);
    if (at < now) {
      return { code: 'proposal_expired', message: `Linked estimate/proposal validity date (${label}) has already passed.` };
    }
    if (bid?.due_confirmed === true && bid?.due_at && at < new Date(bid.due_at)) {
      return { code: 'proposal_expires_before_due', message: `Linked estimate/proposal expires (${label}) before the bid due date.` };
    }
    return null;
  } catch {
    return { code: 'proposal_invalid_date', message: 'Linked proposal has an invalid Valid through date — review it in the proposal builder.' };
  }
}

function revenueInputForProposal(normalized) {
  return {
    buildings: normalized.buildings || [],
    programs: normalized.programs || [],
    correctiveWork: normalized.correctiveWork || [],
    taxRate: normalized.taxRate,
  };
}

function evaluatePricingWarnings(costs) {
  if (!costs.costsComplete) {
    return [{ code: 'missing_project_costing', message: 'Linked proposal has no complete cost build-up yet — add labor/material costs before finalizing price.' }];
  }
  if (!(costs.revenue > 0)) {
    return [{ code: 'missing_proposal_revenue', message: 'Linked proposal has project costs but $0 priced revenue — add pricing lines before submitting.' }];
  }
  if (costs.marginPercent !== null && costs.marginPercent < THIN_MARGIN_THRESHOLD_PCT) {
    return [{
      code: 'thin_margin',
      message: `Estimated gross margin is ${costs.marginPercent}% (below ${THIN_MARGIN_THRESHOLD_PCT}% target floor) — review pricing before submitting.`,
    }];
  }
  return [];
}

function evaluatePricingReadiness(bid, estimate, now) {
  const blockers = [];
  if (!estimate) {
    if (bid?.status === 'bid') {
      blockers.push({ code: 'missing_estimate', message: 'No commercial estimate/proposal is linked to this active bid yet.' });
    }
    return {
      pricing: { linked: false, estimate_id: null, valid_through: null, revenue_total: null, cost_total: null, gross_margin_pct: null, costing_complete: false },
      blockers,
      warnings: [],
    };
  }

  const usabilityBlocker = checkEstimateUsability(estimate);
  if (usabilityBlocker) blockers.push(usabilityBlocker);

  const data = parseJsonObject(estimate.estimate_data ?? estimate.estimateData);
  const proposal = data.proposal && typeof data.proposal === 'object' ? data.proposal : {};
  // Proposal builder persists costing under estimate_data.proposalCosting.
  const costing = data.proposalCosting && typeof data.proposalCosting === 'object' ? data.proposalCosting : null;
  const validThrough = proposal.validThrough || null;
  const expiryBlocker = checkProposalExpiry(estimate, bid, validThrough, now);
  if (expiryBlocker) blockers.push(expiryBlocker);

  const normalized = normalizeProposal(estimate);
  const totals = computeProposalTotals(normalized);
  const revenueIssue = proposalRevenueIssue(revenueInputForProposal(normalized));
  const costs = computeProjectCosts(costing, totals, { revenueIssue });
  const warnings = evaluatePricingWarnings(costs);

  return {
    pricing: {
      linked: true,
      estimate_id: estimate.id,
      valid_through: validThrough,
      revenue_total: costs.revenue,
      cost_total: costs.costsComplete ? costs.cost : null,
      gross_margin_pct: costs.marginPercent,
      costing_complete: costs.costsComplete,
    },
    blockers,
    warnings,
  };
}

function evaluateBidSchedule(bid, now) {
  const blockers = [];
  const warnings = [];
  if (bid?.source_active === false) {
    blockers.push({ code: 'source_inactive', message: 'The solicitation source reports this notice as closed or inactive — verify status before submitting.' });
  }
  if (bid?.needs_date_confirmation) {
    blockers.push({ code: 'addendum_date_check', message: 'An addendum or later email flagged the due date — confirm the current deadline.' });
  }
  if (!bid?.due_at || bid?.due_confirmed !== true) {
    warnings.push({ code: 'due_date_unconfirmed', message: 'Confirm the bid due date so 14/7/2-day reminders and expiry checks lock in.' });
  } else if (OPEN_STATUSES.includes(bid.status) && !bid.submitted_at && new Date(bid.due_at) < now) {
    blockers.push({ code: 'bid_due_passed', message: `Confirmed bid due date (${etDateString(new Date(bid.due_at))}) has already passed with no submission recorded.` });
  }
  if (bid?.job_walk_mandatory && (!bid?.job_walk_at || bid?.job_walk_confirmed !== true)) {
    blockers.push({ code: 'mandatory_job_walk_unconfirmed', message: 'Mandatory pre-bid site visit/job walk is not confirmed yet.' });
  }
  return { blockers, warnings };
}

function evaluateChecklistProgress(checklistItems) {
  const blockers = [];
  const warnings = [];
  const live = (checklistItems || []).filter((i) => !i.archived_at);
  if (!live.length) {
    warnings.push({ code: 'checklist_not_started', message: 'Per-bid compliance checklist has not been started yet.' });
    return { blockers, warnings };
  }
  const uncheckedStops = live.filter((i) => i.required === true && i.section === SECTION_STOP && !i.checked_at);
  if (uncheckedStops.length) {
    blockers.push({
      code: 'unchecked_stop_checks',
      message: `${uncheckedStops.length} required go/no-go stop check(s) still unchecked on the bid checklist.`,
    });
  }
  const uncheckedRequired = live.filter((i) => i.required === true && i.section !== SECTION_STOP && !i.checked_at);
  if (uncheckedRequired.length) {
    warnings.push({
      code: 'unchecked_required_items',
      message: `${uncheckedRequired.length} required compliance checklist line(s) still unchecked.`,
    });
  }
  return { blockers, warnings };
}

function evaluateBidPacketReadiness({ bid, checklistItems = [], archivedTemplateKeys = [], bidKitRows = [], estimate = null, now = new Date(), kitUnavailable = false } = {}) {
  const today = catalog.etToday(now);
  const dueDay = bid?.due_at ? etDateString(new Date(bid.due_at)) : null;
  const confirmedDueDay = bid?.due_confirmed === true ? dueDay : null;

  const kit = evaluateKitRequirements(bid, checklistItems, bidKitRows, today, confirmedDueDay, kitUnavailable, archivedTemplateKeys);
  const schedule = evaluateBidSchedule(bid, now);
  const checklistEval = evaluateChecklistProgress(checklistItems);
  const pricingEval = evaluatePricingReadiness(bid, estimate, now);

  const blockers = [...kit.blockers, ...schedule.blockers, ...checklistEval.blockers, ...pricingEval.blockers];
  const warnings = [...schedule.warnings, ...checklistEval.warnings, ...pricingEval.warnings];
  const status = blockers.length ? 'blocked' : (warnings.length || kit.perBidActions.length ? 'action_needed' : 'ready');

  return {
    status,
    due_day: dueDay,
    blockers,
    warnings,
    per_bid_actions: kit.perBidActions,
    kit_coverage: kit.kit_coverage,
    pricing: pricingEval.pricing,
  };
}

async function loadBidPacketReadiness({ bid, checklistItems = [], archivedTemplateKeys = [], estimate = null, now = new Date(), listKitItems = null } = {}) {
  const loader = listKitItems || require('../bid-kit-store').listItems;
  let bidKitRows = [];
  let kitUnavailable = false;
  try {
    bidKitRows = await loader();
  } catch {
    kitUnavailable = true;
  }
  return evaluateBidPacketReadiness({ bid, checklistItems, archivedTemplateKeys, bidKitRows, estimate, now, kitUnavailable });
}

module.exports = {
  THIN_MARGIN_THRESHOLD_PCT,
  evaluateBidPacketReadiness,
  loadBidPacketReadiness,
};
