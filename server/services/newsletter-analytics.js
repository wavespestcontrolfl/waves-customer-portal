/**
 * Newsletter analytics — derived engagement rates from the per-send
 * counters the SendGrid webhook maintains on `newsletter_sends`.
 *
 * Pure functions, no DB access. The route layer feeds in rows and returns
 * the computed rates to the admin History view, so rate math lives in one
 * tested place instead of being re-derived in the client.
 *
 * Denominator conventions (industry-standard):
 *   - deliveryRate / bounceRate: over recipient_count (everyone we tried)
 *   - openRate / clickRate / unsubscribeRate / complaintRate: over delivered
 *   - clickToOpenRate (CTOR): clicked over opened
 *
 * Rates are returned as fractions in [0, 1], or null when the denominator
 * is zero (so the UI can render "—" instead of a misleading 0%).
 */

function rate(numerator, denominator) {
  const n = Number(numerator || 0);
  const d = Number(denominator || 0);
  if (d <= 0) return null;
  return n / d;
}

/**
 * Derived rates for a single newsletter_sends row.
 * @param {Object} send - a newsletter_sends row (raw counters)
 * @returns {{deliveryRate:number|null, openRate:number|null, clickRate:number|null, clickToOpenRate:number|null, bounceRate:number|null, unsubscribeRate:number|null, complaintRate:number|null}}
 */
function computeSendRates(send = {}) {
  const recipients = Number(send.recipient_count || 0);
  const delivered = Number(send.delivered_count || 0);
  const opened = Number(send.opened_count || 0);
  const clicked = Number(send.clicked_count || 0);
  const bounced = Number(send.bounced_count || 0);
  const unsubscribed = Number(send.unsubscribed_count || 0);
  const complained = Number(send.complained_count || 0);

  return {
    deliveryRate: rate(delivered, recipients),
    openRate: rate(opened, delivered),
    clickRate: rate(clicked, delivered),
    clickToOpenRate: rate(clicked, opened),
    bounceRate: rate(bounced, recipients),
    unsubscribeRate: rate(unsubscribed, delivered),
    complaintRate: rate(complained, delivered),
  };
}

/**
 * Pooled rates from a summed totals object. Shared by both the array-based
 * aggregateSendMetrics and the route's DB-summed aggregate (which must sum
 * across ALL sent campaigns, not just the History page's row window).
 *
 * @param {{recipients:number, delivered:number, opened:number, clicked:number, bounced:number, unsubscribed:number, complained:number}} totals
 * @returns {Object} rates keyed like computeSendRates
 */
function ratesFromTotals(totals = {}) {
  const recipients = Number(totals.recipients || 0);
  const delivered = Number(totals.delivered || 0);
  const opened = Number(totals.opened || 0);
  const clicked = Number(totals.clicked || 0);
  const bounced = Number(totals.bounced || 0);
  const unsubscribed = Number(totals.unsubscribed || 0);
  const complained = Number(totals.complained || 0);

  return {
    deliveryRate: rate(delivered, recipients),
    openRate: rate(opened, delivered),
    clickRate: rate(clicked, delivered),
    clickToOpenRate: rate(clicked, opened),
    bounceRate: rate(bounced, recipients),
    unsubscribeRate: rate(unsubscribed, delivered),
    complaintRate: rate(complained, delivered),
  };
}

/**
 * Pooled aggregate across an array of sends. Only completed campaigns with
 * at least one recipient count toward the numbers (drafts/scheduled/failed
 * and zero-recipient rows are ignored so the rates aren't diluted).
 *
 * Rates are computed from summed totals (a pooled rate), NOT an average of
 * per-send rates — a 10k-recipient send should weigh more than a 50-recipient
 * one.
 *
 * NOTE: the History route does NOT use this for its summary — it sums across
 * all sent rows in the DB (see GET /sends), because this would only see the
 * capped row window. This stays as a tested pure utility for array inputs.
 *
 * @param {Object[]} sends - newsletter_sends rows
 * @returns {{campaignCount:number, totals:Object, rates:Object}}
 */
function aggregateSendMetrics(sends = []) {
  const completed = (Array.isArray(sends) ? sends : []).filter(
    (s) => s && s.status === 'sent' && Number(s.recipient_count || 0) > 0,
  );

  const totals = completed.reduce(
    (acc, s) => {
      acc.recipients += Number(s.recipient_count || 0);
      acc.delivered += Number(s.delivered_count || 0);
      acc.opened += Number(s.opened_count || 0);
      acc.clicked += Number(s.clicked_count || 0);
      acc.bounced += Number(s.bounced_count || 0);
      acc.unsubscribed += Number(s.unsubscribed_count || 0);
      acc.complained += Number(s.complained_count || 0);
      return acc;
    },
    { recipients: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, unsubscribed: 0, complained: 0 },
  );

  return { campaignCount: completed.length, totals, rates: ratesFromTotals(totals) };
}

module.exports = { computeSendRates, aggregateSendMetrics, ratesFromTotals };
