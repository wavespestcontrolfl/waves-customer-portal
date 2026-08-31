// Pure display helpers for the tech Visit Brief (StopRow + VisitBriefPanel).
// Money is DISPLAY-ONLY here and never re-derived: the headline number is
// the day payload's billingLane.prediction (server-computed, already nets
// prepaid/credit and prefers the attached invoice), and the invoice detail
// comes from the canonical attachedVisitInvoice helper. Checkout math stays
// exclusively in MobileCheckoutSheet — the brief displays, checkout charges.
import { attachedVisitInvoice, visitInvoiceStatusNote } from '../../components/schedule/visitInvoice';

export function fmtMoney(n) {
  // null/undefined/'' are "no value", never $0 — Number(null) is 0.
  if (n == null || n === '') return null;
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return `$${v.toFixed(2).replace(/\.00$/, '')}`;
}

/** Street portion of a full address — everything before the first comma. */
export function shortAddress(address) {
  const s = String(address || '').trim();
  if (!s) return null;
  const street = s.split(',')[0].trim();
  return street || s;
}

// tel:/sms: need a plain dial string; the payload's phone can carry
// formatting. Keep a leading +, strip everything else non-digit; refuse
// obviously-not-a-phone strings rather than rendering a dead link.
function dialString(phone) {
  const raw = String(phone || '').trim();
  if (!raw) return null;
  const plus = raw.startsWith('+') ? '+' : '';
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 7) return null;
  return `${plus}${digits}`;
}

export function telHref(phone) {
  const d = dialString(phone);
  return d ? `tel:${d}` : null;
}

export function smsHref(phone) {
  const d = dialString(phone);
  return d ? `sms:${d}` : null;
}

// Per-kind copy for billingLane.prediction — the kinds the server emits
// (billing-lane.js / predictionFromAttachedInvoice): invoice, auto_charge,
// payer, prepaid, covered_membership, covered_annual, no_charge. Only
// `invoice` with a positive amount means money changes hands at the door.
const PREDICTION_COPY = {
  invoice: (amt) => (amt > 0 ? `Collect ${fmtMoney(amt)} today` : 'No charge today'),
  auto_charge: (amt) => (amt > 0 ? `${fmtMoney(amt)} auto-charges on completion` : 'Nothing to charge'),
  payer: () => 'Billed to payer — do not collect',
  prepaid: () => 'Prepaid — nothing to collect',
  covered_membership: () => 'Covered by plan — nothing to collect',
  covered_annual: () => 'Covered by annual plan — nothing to collect',
  no_charge: () => 'No charge',
};

/**
 * The "Amount due today" row for one day-payload service row.
 * Returns { kind, amount, collectNeeded, headline, note, invoice } —
 * headline null when the payload carries no billingLane (older payload
 * shape): fail toward NOT flagging, matching the server's own
 * chargeable-method probe convention.
 */
export function visitMoneySummary(service) {
  const invoice = attachedVisitInvoice(service);
  const note = invoice ? visitInvoiceStatusNote(invoice) : null;
  const prediction = service?.billingLane?.prediction || null;
  const kind = prediction?.kind || null;
  if (!kind) {
    return { kind: null, amount: null, collectNeeded: false, headline: null, note, invoice };
  }
  const rawAmount = Number(prediction.amount);
  const amount = Number.isFinite(rawAmount) ? rawAmount : null;
  const copy = PREDICTION_COPY[kind];
  return {
    kind,
    amount,
    collectNeeded: kind === 'invoice' && amount > 0,
    headline: copy ? copy(amount) : null,
    note,
    invoice,
  };
}

/** "Prepaid $120 (card)" line from the visit's recorded prepayment. */
export function prepaidLine(service) {
  const method = String(service?.prepaidMethod || '');
  // The annual-prepay stamp is a historical marker, not proof of live
  // coverage: after a refund/void/expired term the prediction rejects it
  // and returns kind 'invoice'. Only the term-validated covered_annual
  // prediction may claim coverage — and never the stamp's amount (the
  // billing lane zeroes it as non-authoritative).
  if (method === 'annual_prepay_invoice') {
    return service?.billingLane?.prediction?.kind === 'covered_annual'
      ? 'Annual prepay on file'
      : null;
  }
  const amount = Number(service?.prepaidAmount);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return `Prepaid ${fmtMoney(amount)}${method ? ` (${method.replace(/_/g, ' ')})` : ''}`;
}

/**
 * Cadence-aware price label for one estimate-source line: the accepted
 * per-application price wins, then the monthly price, then the accepted
 * one-time price. Only what the estimate proved — never a catalog price.
 * A bare `price` gets the one-time unit only when the LINE is provably
 * one-time (source/cadence): scheduleLinesFromEstimate deliberately
 * withholds per-application provenance for discounted/legacy recurring
 * lines while still returning their recurring price, and labeling that
 * "$115 one-time" would misstate the accepted terms — render the bare
 * amount with no unit instead.
 */
export function quotedLineLabel(line) {
  const per = Number(line?.perApplicationPrice);
  if (Number.isFinite(per) && per > 0) return `${fmtMoney(per)} /application`;
  const mo = Number(line?.monthlyPrice);
  if (Number.isFinite(mo) && mo > 0) return `${fmtMoney(mo)} /mo`;
  // PRESENCE, not positivity (same rule as EstimateProvenanceCard): the
  // server legitimately emits acceptedOneTimePrice 0 when a discount fully
  // covers the line, and a $0 accepted line must never fall back to the
  // gross price.
  const one = Number(line?.acceptedOneTimePrice);
  if (line?.acceptedOneTimePrice != null && Number.isFinite(one) && one >= 0) {
    return `${fmtMoney(one)} one-time`;
  }
  const price = Number(line?.price);
  if (!Number.isFinite(price) || price <= 0) return null;
  const provablyOneTime = line?.source === 'one_time' || line?.cadence === 'one_time';
  return provablyOneTime ? `${fmtMoney(price)} one-time` : fmtMoney(price);
}

/**
 * Honest quoted framing for a whole linked estimate (owner ruling
 * 2026-08-02, mirrored from EstimateProvenanceCard): a blended
 * "monthly + one-time" total matches nothing the customer ever pays at
 * once. When EVERY recurring line carries a proven unit price the label
 * reads "$115/application + $89/mo + $99 one-time"; otherwise the legacy
 * blended total tells the whole truth.
 */
export function quotedTermsLabel(estimate) {
  if (!estimate?.linked) return null;
  const lines = Array.isArray(estimate.lines) ? estimate.lines : [];
  const shaped = lines.map((l) => {
    const recurring = !!(l?.cadence && l.cadence !== 'one_time');
    const perApp = recurring && Number(l?.perApplicationPrice) > 0 ? Number(l.perApplicationPrice) : null;
    const monthly = recurring && perApp == null && Number(l?.monthlyPrice) > 0 ? Number(l.monthlyPrice) : null;
    return { recurring, perApp, monthly };
  });
  const perApp = shaped.map((s) => s.perApp).filter((p) => p != null);
  const monthly = shaped.map((s) => s.monthly).filter((p) => p != null);
  const recurringCount = shaped.filter((s) => s.recurring).length;
  const oneTime = Number(estimate.onetimeTotal) || 0;
  const allRecurringProven = recurringCount > 0 && perApp.length + monthly.length === recurringCount;
  if (allRecurringProven) {
    return [
      ...(perApp.length ? [`${perApp.map(fmtMoney).join(' + ')}/application`] : []),
      ...monthly.map((m) => `${fmtMoney(m)}/mo`),
      ...(oneTime > 0 ? [`${fmtMoney(oneTime)} one-time`] : []),
    ].join(' + ');
  }
  return fmtMoney(estimate.quotedTotal);
}

// Operational wording for a lawn protocol product's structured gates —
// many seeded rows carry gates (premiumTier, maxTempF, soil thresholds)
// with no convenience `trigger`, and "conditional" alone tells the tech
// nothing. Bookkeeping keys that are not field conditions are skipped;
// unknown keys degrade to a humanized key:value so nothing is dropped.
const GATE_SKIP_KEYS = new Set(['gateProduct', 'frac', 'annualCounter']);
const humanizeKey = (k) => String(k).replace(/([A-Z])/g, ' $1').toLowerCase().trim();

export function lawnGateLabels(gates) {
  if (!gates || typeof gates !== 'object') return [];
  const out = [];
  for (const [key, value] of Object.entries(gates)) {
    if (value == null || value === false || GATE_SKIP_KEYS.has(key)) continue;
    switch (key) {
      case 'trigger': out.push(String(value).replace(/_/g, ' ')); break;
      case 'premiumTier': out.push('premium plan only'); break;
      case 'maxTempF': out.push(`skip above ${value}°F`); break;
      case 'soilPIndexBelow': out.push(`soil P index below ${value}`); break;
      case 'soilPIndexAtOrAbove': out.push(`soil P index at/above ${value}`); break;
      case 'soilKGatePpmBelow': out.push(`soil K below ${value} ppm`); break;
      case 'requiresZeroNP': out.push('blackout: zero N-P only'); break;
      case 'blackoutSensitive': out.push('blackout-sensitive'); break;
      case 'finalNBeforeBlackout': out.push('final N before blackout'); break;
      case 'finalN': out.push('final N of season'); break;
      case 'sdsPreventive': out.push('SDS preventive'); break;
      case 'blockInOrdinanceZones':
        out.push(`not in ${(Array.isArray(value) ? value : [value]).map((z) => String(z).replace(/_/g, ' ')).join(', ')}`);
        break;
      case 'annualMaxApps': out.push(`max ${value} apps/year`); break;
      case 'minIntervalDays': out.push(`min ${value} days between apps`); break;
      case 'minLabelRate': out.push(`label rate min ${value}`); break;
      case 'maxLabelRate': out.push(`label rate max ${value}`); break;
      case 'postAppIrrigation': out.push('irrigate after application'); break;
      case 'targetN': out.push(`target ${value}`); break;
      // Customer-specific application-limit violations arrive as
      // [{severity, type, message}] — render every message, never the
      // default array-to-string collapse.
      case 'applicationLimits':
        for (const v of Array.isArray(value) ? value : []) {
          if (v?.message) out.push(String(v.message));
        }
        break;
      default: out.push(value === true ? humanizeKey(key) : `${humanizeKey(key)}: ${value}`);
    }
  }
  // The trigger convenience field mirrors the first application-limit
  // message — dedupe identical wording.
  return [...new Set(out)];
}

/**
 * Stop-level collection summary: grouped-visit siblings keep separate
 * invoices and billing lanes, so the collect signal must aggregate EVERY
 * member service — a prepaid primary with an invoice-due sibling still
 * needs the chip, with the summed amount.
 */
export function stopCollectSummary(stop) {
  let collectNeeded = false;
  let amount = 0;
  for (const s of stop?.services || []) {
    const m = visitMoneySummary(s);
    if (m.collectNeeded) {
      collectNeeded = true;
      amount += m.amount;
    }
  }
  return { collectNeeded, amount: collectNeeded ? Math.round(amount * 100) / 100 : null };
}

/** Collapsed-row chip signals from a stop's deduped property alerts. */
export function stopAccessIndicator(alerts) {
  const list = Array.isArray(alerts) ? alerts : [];
  let hasChemical = false;
  let hasNoCard = false;
  let count = 0;
  for (const a of list) {
    const text = typeof a === 'string' ? a : a && a.text;
    if (!text) continue;
    count += 1;
    if (a && a.type === 'chemical') hasChemical = true;
    if (a && a.type === 'no_card_on_file') hasNoCard = true;
  }
  return { hasAlerts: count > 0, count, hasChemical, hasNoCard };
}
