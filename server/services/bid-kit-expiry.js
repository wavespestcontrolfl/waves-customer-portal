'use strict';

// Bid kit daily expiry check (GATE_BID_KIT, dark). Once a day, in the 6 a.m. ET compliance slot, one admin bell per kit
// item that expired or expires within 30 days, once a week per item. The audience is the admin bell only; nothing is sent
// to a customer, an agency or anyone else. Gate off = the job returns before any query.
const { bidKitLive } = require('../config/feature-gates');
const store = require('./bid-kit-store');
const catalog = require('../../shared/bid-kit-catalog.cjs');
const logger = require('./logger');
const { raiseAdminAlert, cutAtWord, breaksAlertRules, MAX_WHY_CHARS } = require('./admin-alert-compose');
const { fitAction, shortDateET } = require('./admin-alert-names');

const AREA = 'Estimates';
const CATEGORY = 'system';
const DEDUPE_DAYS = 7;

const keyFor = (item) => `bid-kit:expiry:${item.id}`;

// The item's name as a person says it. A custom label with a code-shaped word falls back to the catalog's own words.
function nameOf(item) {
  const entry = catalog.catalogItem(item.item_key);
  const label = String(item.label || '').replace(/\s+/g, ' ').trim();
  if (label && !breaksAlertRules(label)) return label;
  return entry ? entry.label : 'a bid paper';
}

// "Expires Nov 4" / "Expired Oct 20", from the date itself (an Eastern calendar day, never a clock instant).
function whenWords(expiresOn, today) {
  const left = catalog.daysBetween(today, expiresOn);
  const date = shortDateET(new Date(`${expiresOn}T12:00:00Z`));
  if (left < 0) return { headline: (n) => `renew ${n}, expired`, why: `Expired ${date}; agencies reject an expired paper.` };
  if (left === 0) return { headline: (n) => `renew ${n}, expires today`, why: `Expires today, ${date}; agencies reject an expired paper.` };
  return { headline: (n) => `renew ${n}, expires ${date}`, why: `Expires ${date}, in ${left} ${left === 1 ? 'day' : 'days'}; bids need a current copy.` };
}

function specFor(item, today) {
  const name = nameOf(item);
  const words = whenWords(item.expires_on, today);
  return {
    spec: {
      area: AREA,
      action: fitAction(AREA, name, [words.headline, (n) => `renew ${n}`]),
      why: cutAtWord(words.why, MAX_WHY_CHARS),
      severity: 'needs-you',
      link: `/admin/bid-kit?item=${item.id}`,
      subject: { type: 'check', id: item.id },
      doneWhen: 'item_renewed',
      who: 'person',
    },
    detail: `Bid kit: ${name} ${words.why}`,
  };
}

// Returns { skipped } with the gate off; otherwise { scanned, rang }.
async function runBidKitExpiryCheck({ now = new Date() } = {}) {
  if (!bidKitLive()) return { skipped: 'gate_off' };
  const today = catalog.etToday(now);
  let rows;
  try {
    rows = await store.listItems();
  } catch (err) {
    logger.warn(`[bid-kit] expiry scan failed: ${err?.name || 'Error'}`);
    return { scanned: 0, rang: 0 };
  }
  const due = rows.filter((row) => {
    if (row.archived_at || !row.expires_on) return false;
    const status = catalog.itemStatus({ ...row, has_file: row.has_file === true }, { today });
    return status === catalog.STATUS.EXPIRED || status === catalog.STATUS.EXPIRING;
  });
  let rang = 0;
  for (const item of due) {
    try {
      const { spec, detail } = specFor(item, today);
      const result = await raiseAdminAlert(CATEGORY, spec, {
        bell: true,
        dedupeKey: keyFor(item),
        dedupeWindowMs: DEDUPE_DAYS * 86400000,
        detail,
        metadata: { bidKitItemId: item.id },
      });
      if (result && result.id && !result.deduped) rang += 1;
    } catch (err) {
      logger.warn(`[bid-kit] expiry alert failed: ${err?.name || 'Error'}`);
    }
  }
  logger.info(`[bid-kit] expiry check scanned=${due.length} rang=${rang}`);
  return { scanned: due.length, rang };
}

module.exports = { runBidKitExpiryCheck, specFor, keyFor, DEDUPE_DAYS };
