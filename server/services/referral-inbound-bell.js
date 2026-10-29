'use strict';

const crypto = require('crypto');

// The new-referral bell (owner 2026-10-29: "maybe just admin notification, and can we add a button, of confirm
// idea, from the admin notification for this"; plan approved "ok go"). Before it, a card in Referrals → Queue
// rang nothing and waited until someone opened the page. Now each card (referral-inbound.js
// listInboundReferrals) gets one admin row, "Customers — confirm <name>'s referrer", that opens the Queue and
// carries two buttons (docs/admin-notifications.md section 2, part 9). Each runs the Queue's own step after the
// card is read again:
//  - Confirm <referrer> (confirmInboundReferral with deferredOnly): only for one sure referrer (the owner of the
//    link code, or the one customer whose first and last name both match the name the caller gave), only while
//    the program defers rewards to the first visit, only before the friend's first plan visit, and only when it
//    is not the referrer's 3rd, 5th or 10th referral. So nothing reaches a customer and no money moves at the tap:
//    both $25 credits and the referrer's one 9:00 AM email follow the first plan visit, as for any referral. The
//    row only hides the button; the step itself refuses each case under its locks and then saves nothing;
//  - Not a referral (dismissInboundReferral).
// The Queue can pick any other referrer. The row closes when the card is answered in the bell, the Queue or a
// script (referral-inbound.js calls closeReferralInboundBell), and the sweep closes a row whose card left the
// list for another reason. It rings once per card; a card that leaves the list and comes back rings again.
// Dark behind GATE_REFERRAL_INBOUND_BELL, and only while GATE_REFERRAL_INBOUND_CONFIRM serves the Queue.

const db = require('../models/db');
const logger = require('./logger');
const { referralInboundBellLive, referralInboundConfirmLive } = require('../config/feature-gates');
const { composeAdminAlert, raiseAdminAlert, cutAtWord, MAX_WHY_CHARS, MAX_BUTTON_LABEL_CHARS } = require('./admin-alert-compose');
const { fitAction, shortDateET, tidyName } = require('./admin-alert-names');
const episodes = require('./admin-alert-episodes');
const engine = require('./referral-engine');
const inbound = require('./referral-inbound');

const CATEGORY = 'customer';
const AREA = 'Customers';
const KEY_PREFIX = 'referral-inbound:';
const LINK = '/admin/referrals?tab=queue';
const BUTTON_KIND = 'referral_inbound';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CLOSE_RESOLUTIONS = {
  confirmed: 'Referrer confirmed',
  dismissed: 'Marked not a referral',
  gone: 'No longer waiting in Referrals → Queue',
  queue_off: 'The Referrals Queue confirm step is off',
};

const keyFor = (customerId) => `${KEY_PREFIX}${customerId}`;
const firstName = (name) => tidyName(name).split(' ')[0] || 'This customer';

// The one referrer the bell may offer, or null: none for a household's own link code, a code nobody holds, a
// name that matches nobody or several people (the Queue picks those).
function sureReferrer(card) {
  if (!card || card.selfReferral) return null;
  const sure = (card.suggestions || []).filter((s) => s.viaCode || s.exact);
  return sure.length === 1 ? sure[0] : null;
}

// Would confirming this referrer award a milestone (a bonus and a text at once)? Read-only: the promoter
// confirmInboundReferral would use (the referrer's own, else the household's; none yet = no conversions),
// judged by the engine's own rule one conversion later.
async function confirmEarnsMilestone(conn, referrerCustomerId) {
  const promoter = await conn('referral_promoters').where({ customer_id: referrerCustomerId })
    .first('total_referrals_converted', 'milestone_level')
    || await engine.findHouseholdPromoter(referrerCustomerId, conn);
  if (!promoter) return false;
  return Boolean(engine.milestoneLevelEarned(Number(promoter.total_referrals_converted || 0) + 1, promoter.milestone_level));
}

// Why Confirm is not on the row, or null when it is. `deferred`: the program pays rewards at the first visit.
function confirmBlock(card, sure, { milestone, deferred }) {
  if (card.selfReferral) return 'self';
  if (!sure) return 'no_sure_referrer';
  if (!deferred) return 'reward_not_deferred';
  if (card.creditsNow) return 'first_visit_done';
  if (milestone) return 'milestone';
  return null;
}

const fitWhy = (candidates) => candidates.find((text) => text.length <= MAX_WHY_CHARS)
  || cutAtWord(candidates[candidates.length - 1], MAX_WHY_CHARS);

function whyOf(card, sure, block) {
  const evidence = card.evidence || {};
  let how;
  if (evidence.source === 'link') {
    if (card.selfReferral) how = 'through a referral link from their own household';
    else how = sure ? `through ${tidyName(sure.name)}'s referral link` : 'through a referral link no customer holds';
  } else if (evidence.spokenName) {
    how = `and named ${tidyName(evidence.spokenName)} as the referrer`;
  } else {
    how = 'and said a customer referred them, with no name';
  }
  const next = {
    self: 'mark it not a referral',
    no_sure_referrer: 'pick the referrer in the Queue',
    reward_not_deferred: 'rewards pay at once now, so confirm in the Queue',
    first_visit_done: 'a visit is done, so confirm in the Queue for $25 each now',
    milestone: 'it earns a milestone bonus, so confirm in the Queue',
  }[block] || '$25 each after the first plan visit';
  const day = shortDateET(card.createdAt);
  return fitWhy([...(day ? [`Came in ${day} ${how}; ${next}.`] : []), `Came in ${how}; ${next}.`]);
}

function confirmLabel(referrerName) {
  const name = tidyName(referrerName);
  const full = `Confirm ${name}`;
  if (full.length <= MAX_BUTTON_LABEL_CHARS) return full;
  const words = name.split(' ');
  const short = words.length > 1 ? `Confirm ${words[0]} ${words[words.length - 1][0]}` : '';
  return short && short.length <= MAX_BUTTON_LABEL_CHARS ? short : 'Confirm the referrer';
}

function buttonsOf(name, sure, block) {
  const items = [];
  if (!block) {
    const referrer = tidyName(sure.name);
    items.push({
      id: 'confirm',
      label: confirmLabel(sure.name),
      prompt: fitWhy([
        `Make ${referrer} the referrer of ${name}, with $25 each after the first plan visit?`,
        `Make ${referrer} the referrer of ${name}?`,
      ]),
      args: { referrerCustomerId: String(sure.customerId) },
    });
  }
  items.push({
    id: 'dismiss',
    label: 'Not a referral',
    prompt: fitWhy([`Remove ${name} from the referral list for good?`, 'Remove this customer from the referral list for good?']),
  });
  return { kind: BUTTON_KIND, items };
}

// The full text behind "Show full text": the card as the Queue shows it, and what each answer does.
function detailOf(card, name, sure, block) {
  const evidence = card.evidence || {};
  const first = firstName(name);
  const rate = Number(card.plan?.monthlyRate) > 0 ? ` at $${Number(card.plan.monthlyRate).toFixed(2)} a month` : '';
  const lines = [`${name} is on a ${card.plan?.tier || 'WaveGuard'} plan${rate}.`];
  if (evidence.source === 'link') lines.push(`Came in through referral link ${evidence.code}.`);
  else if (evidence.spokenName) lines.push(`Said on the first call: "Referred by ${evidence.spokenName}".`);
  else lines.push('Said on the first call that a customer referred them, with no name.');
  if (card.selfReferral) lines.push("The link code belongs to this customer's own household, so it cannot pay a referral.");
  else if (sure) lines.push(`Likely referrer: ${tidyName(sure.name)}, ${sure.viaCode ? 'the owner of the link code' : 'the one customer with that first and last name'}.`);
  else lines.push('No single customer matches, so pick the referrer in Referrals → Queue.');
  if (!block) {
    lines.push(`Confirm makes ${tidyName(sure.name)} the referrer. Both accounts get the $25 credit at ${first}'s first completed plan visit, and the referrer then gets one thank-you email at the next 9:00 AM ET. Nothing is sent and no money moves at the tap.`);
  } else if (block === 'reward_not_deferred') {
    lines.push('The referral program pays rewards at once now, so a confirm pays and sends the reward text and email. Confirm in Referrals → Queue.');
  } else if (block === 'first_visit_done') {
    lines.push(`${first} already had a plan visit, so a confirm posts both $25 credits at once. Confirm in Referrals → Queue.`);
  } else if (block === 'milestone') {
    lines.push(`This would be ${tidyName(sure.name)}'s milestone referral, which pays a bonus and sends a text at once. Confirm in Referrals → Queue.`);
  }
  lines.push(`Not a referral removes ${first} from the list for good. Any other referrer can be picked in Referrals → Queue.`);
  return lines.join(' ');
}

// The row for one card. Pure: `milestone` is confirmEarnsMilestone for the sure referrer, `deferred` the
// program's require_service_completion setting.
function composeCard(card, { milestone = false, deferred = true } = {}) {
  const name = tidyName(card.name) || 'a new customer';
  const sure = sureReferrer(card);
  const block = confirmBlock(card, sure, { milestone, deferred });
  return {
    spec: {
      area: AREA,
      action: fitAction(AREA, name, [card.selfReferral ? (who) => `review ${who}'s referral` : (who) => `confirm ${who}'s referrer`]),
      why: whyOf(card, sure, block),
      severity: 'needs-you',
      link: LINK,
      subject: { type: 'customer', id: String(card.customerId) },
      doneWhen: 'referral_answered',
      who: 'person',
      buttons: buttonsOf(name, sure, block),
    },
    detail: detailOf(card, name, sure, block),
  };
}

// Ring a card's row, or quietly rewrite a standing one whose card changed (its first plan visit happened, a
// name was fixed). A row a person marked done stays done; a row closed because its card left the list rings
// again when the card comes back (raiseAdminAlertWithReopen). `trx` holds the row's advisory lock.
async function raiseCard(trx, card, { deferred }) {
  const sure = sureReferrer(card);
  const milestone = sure && !card.creditsNow ? await confirmEarnsMilestone(trx, sure.customerId) : false;
  const composed = composeCard(card, { milestone, deferred });
  const opts = {
    bell: true,
    dedupeKey: keyFor(card.customerId),
    trx,
    refreshOnDedupe: true,
    ringOnRefresh: () => false,
    // The buttons are content: a changed referrer id rewrites the row even when its words stay the same.
    dedupeVersion: crypto.createHash('sha1').update(JSON.stringify(composed.spec.buttons)).digest('hex').slice(0, 16),
    detail: composed.detail,
    metadata: { customerId: String(card.customerId) },
  };
  let alert;
  try {
    alert = composeAdminAlert(composed.spec);
  } catch (err) {
    // A copy violation still rings through raiseAdminAlert's fallback (and throws under tests).
    if (err.code !== 'ADMIN_ALERT_RULE') throw err;
    return raiseAdminAlert(CATEGORY, composed.spec, opts);
  }
  return episodes.raiseAdminAlertWithReopen(CATEGORY, alert.headline, alert.why, {
    ...opts, link: alert.link, metadata: { ...opts.metadata, ...alert.metadata },
  });
}

async function answerOf(conn, customerId) {
  const review = await conn('referral_inbound_reviews').where({ customer_id: customerId }).first('outcome');
  return review?.outcome === 'confirmed' || review?.outcome === 'dismissed' ? review.outcome : null;
}

// One card's row, under the row's own advisory lock (the one notifyAdmin takes) with the card read again inside
// it. closeReferralInboundBell takes the same lock, so an answer that commits while the sweep runs closes the row
// after the sweep, and an answered card is never rung again.
async function syncCard(customerId, { now = new Date(), deferred = true } = {}) {
  const dedupeKey = keyFor(customerId);
  return db.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`admin:${dedupeKey}`]);
    const [card] = await inbound.listInboundReferrals(trx, { customerId });
    if (card) {
      const result = await raiseCard(trx, card, { deferred });
      if (!result) throw new Error('referral bell row was not written');
      return result.rang ? 'raised' : 'unchanged';
    }
    const answer = await answerOf(trx, customerId);
    const closed = await episodes.closeAdminAlertKeys(trx, [dedupeKey], 'referral_answered', {
      now, resolution: CLOSE_RESOLUTIONS[answer || 'gone'],
    });
    return closed ? 'closed' : 'unchanged';
  });
}

/**
 * Fifteen-minute cron entry point. Returns { skipped } when the gate is off, else a tally of the cards and open
 * rows it went through: raised, unchanged, closed, failed. One card's failure is logged and never stops the rest.
 */
async function syncReferralInboundBells({ now = new Date() } = {}) {
  if (!referralInboundBellLive()) return { skipped: 'disabled' };
  const open = await episodes.openAdminAlertKeys(db, KEY_PREFIX);
  const tally = { raised: 0, unchanged: 0, closed: 0, failed: 0 };
  if (!referralInboundConfirmLive()) {
    // No card is served while the Queue's own gate is off: what is open closes.
    tally.closed = Number(await episodes.closeAdminAlertKeys(db, open, 'referral_queue_off', { now, resolution: CLOSE_RESOLUTIONS.queue_off })) || 0;
    return tally;
  }
  // Every listed card, plus every open row: a row whose card is gone (or past the list's first 50) is read alone.
  const ids = new Set(open.map((key) => key.slice(KEY_PREFIX.length)).filter((id) => UUID_RE.test(id)));
  for (const card of await inbound.listInboundReferrals(db)) ids.add(String(card.customerId));
  const deferred = (await engine.getSettings()).require_service_completion === true;
  for (const customerId of ids) {
    try {
      tally[await syncCard(customerId, { now, deferred })] += 1;
    } catch (err) {
      tally.failed += 1;
      logger.warn(`[referral-inbound-bell] card ${customerId} not synced: ${err.code || err.message}`);
    }
  }
  return tally;
}

// referral-inbound.js calls this after a confirm or a dismiss commits. Gate-free: a closed gate may leave rows
// open, and an answer still closes them. Returns the number of rows closed.
async function closeReferralInboundBell(customerId, outcome, { now = new Date() } = {}) {
  const dedupeKey = keyFor(customerId);
  return db.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`admin:${dedupeKey}`]);
    return episodes.closeAdminAlertKeys(trx, [dedupeKey], 'referral_answered', {
      now, resolution: CLOSE_RESOLUTIONS[outcome] || CLOSE_RESOLUTIONS.gone,
    });
  });
}

function parseMetadata(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value || '{}') || {}; } catch { return {}; }
}

// Each button's step, on the card just read again. Confirm acts only for the referrer the button names, while
// that is still the card's one sure referrer; the step refuses, under its own locks, every case that would send
// or pay now (rewards paid at once, a plan visit on record, a milestone due) and then saves nothing.
const STEPS = {
  async dismiss({ customerId, name, reviewedBy }) {
    await inbound.dismissInboundReferral({ customerId, reviewedBy });
    return { ok: true, message: `${name} is marked not a referral.`, resolution: CLOSE_RESOLUTIONS.dismissed };
  },
  async confirm({ card, item, customerId, name, reviewedBy }) {
    const sure = sureReferrer(card);
    if (!sure || String(sure.customerId) !== String(item.args?.referrerCustomerId || '')) {
      return { ok: false, code: 'referrer_changed', message: 'The likely referrer changed. Pick the referrer in Referrals → Queue.' };
    }
    await inbound.confirmInboundReferral({ customerId, referrerCustomerId: String(sure.customerId), reviewedBy, deferredOnly: true });
    return {
      ok: true,
      message: `${tidyName(sure.name)} is confirmed as ${name}'s referrer. $25 each after the first plan visit.`,
      resolution: CLOSE_RESOLUTIONS.confirmed,
    };
  },
};

// A tap (admin-alert-buttons.js runs it): the card is read again and the Queue's own step runs. Never trusts
// the row's words: the customer comes from the row's subject, and the step checks the rest again.
async function runButton({ row, item, technicianId }) {
  const step = Object.hasOwn(STEPS, item.id) ? STEPS[item.id] : null;
  if (!step) return { ok: false, code: 'unknown_action', message: 'This button is not known.' };
  const subject = parseMetadata(row.metadata).subject;
  const customerId = subject?.type === 'customer' ? String(subject.id || '') : '';
  if (!UUID_RE.test(customerId)) return { ok: false, code: 'invalid', message: 'This alert does not name a customer.' };
  const [card] = await inbound.listInboundReferrals(db, { customerId });
  if (!card) {
    const answer = await answerOf(db, customerId);
    return {
      ok: false,
      code: 'answered',
      message: answer ? 'This referral was already answered.' : 'This customer is no longer waiting in Referrals → Queue.',
      close: CLOSE_RESOLUTIONS[answer || 'gone'],
    };
  }
  try {
    return await step({
      card, item, customerId,
      name: tidyName(card.name) || 'This customer',
      reviewedBy: UUID_RE.test(String(technicianId || '')) ? String(technicianId) : null,
    });
  } catch (err) {
    if (!err.statusCode) throw err;
    // The step's own refusal, in its own words: a hold (the row stays open) or a card answered or referred
    // meanwhile (the row closes).
    const settled = err.code === 'ALREADY_REVIEWED' || err.code === 'ALREADY_REFERRED';
    return {
      ok: false,
      code: String(err.code || 'refused').toLowerCase(),
      message: err.message,
      ...(settled ? { close: CLOSE_RESOLUTIONS[(await answerOf(db, customerId)) || 'gone'] } : {}),
    };
  }
}

const buttonHandler = {
  live: () => referralInboundBellLive() && referralInboundConfirmLive(),
  run: runButton,
};

module.exports = {
  syncReferralInboundBells,
  closeReferralInboundBell,
  buttonHandler,
  _private: { composeCard, sureReferrer, confirmEarnsMilestone, syncCard, runButton, KEY_PREFIX, LINK, CATEGORY, CLOSE_RESOLUTIONS },
};
