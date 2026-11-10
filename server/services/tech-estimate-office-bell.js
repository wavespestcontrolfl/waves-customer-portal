'use strict';

/**
 * The technician estimate tool, step 2b (GATE_TECH_ESTIMATES, owner 2026-11-09): when a technician saves an estimate the
 * office must check first (tech_estimates.office_first_reasons is not empty), the admin bell rings ONCE. A quote he may
 * send himself rings nothing. Nothing here texts, emails or calls a customer.
 *
 * Contract: docs/admin-notifications.md. Category `estimate` with an explicit `bell: true` (the tag the consumer-notice and
 * converter bells use), area Estimates, severity needs-you, who person, subject the estimate, link the admin estimate
 * record. dedupeKey `tech-estimate-office-first:<estimate id>` WITHOUT dedupeOpenOnly: a closed row still holds the key,
 * so the estimate can never ring a second time (no RERING entry is owed; that registry is for open-only dedupe).
 *
 * Done-when `estimate_sent_or_closed`: the relevance sweep (admin-alert-relevance.js, class tech_estimate_office_first)
 * closes the row once the estimate is sent, accepted, declined, expired or archived, or gone (a queued, in-flight or failed
 * send keeps it open). The sweep, not this file, owns clearing it.
 */

const db = require('../models/db');
const compose = require('./admin-alert-compose');
const { fitAction, lookupCustomerName, tidyName } = require('./admin-alert-names');
const { ONE_TIME_HOLD_DOLLARS } = require('./tech-estimate-price');

const KEY_PREFIX = 'tech-estimate-office-first:';
const DONE_WHEN = 'estimate_sent_or_closed';
const TECH_NAME_CHARS = 12;

// What a changed measured fact is called to the office, in the order the tool lists the facts.
const FACT_WORDS = { homeSqFt: 'the home size', lotSqFt: 'the lot size', stories: 'the number of stories', perimeterLF: 'the distance around the home' };
const FACT_ORDER = Object.keys(FACT_WORDS);

const WAITS = 'waits for your check before it goes.';
const limitText = () => `$${ONE_TIME_HOLD_DOLLARS.toLocaleString('en-US')}`;

const factOf = (reason) => (String(reason).startsWith('changed_fact:') ? String(reason).slice('changed_fact:'.length) : null);

// The first reason in a fixed priority, as one plain sentence: a changed fact, a one-time job over the limit, a price the
// engine flagged, then a possible current customer. The full list goes in `detail`.
function whyFor(detailed) {
  const changed = FACT_ORDER.find((fact) => detailed.includes(`changed_fact:${fact}`));
  if (changed) return `The technician changed ${FACT_WORDS[changed]}, so it ${WAITS}`;
  if (detailed.includes('one_time_over_limit')) return `A one-time job over ${limitText()} ${WAITS}`;
  if (detailed.includes('engine_review')) return 'The price needs your check before it goes.';
  return 'This may be a current customer, so check who it is before it goes.';
}

function detailFor(detailed) {
  const words = detailed.map((reason) => {
    const fact = factOf(reason);
    if (fact) return `the technician changed ${FACT_WORDS[fact] || 'a measured fact'}`;
    return {
      one_time_over_limit: `a one-time job is over ${limitText()}`,
      engine_review: 'the price engine flagged a line for review',
      member_address: 'the address matches a customer who is not linked to this estimate',
      phone_matches_customer: 'the phone number matches a current customer',
    }[reason] || 'a check the tool makes';
  });
  return `A technician saved this estimate and it waits for the office before it can be sent: ${words.join('; ')}.`;
}

// A name for the headline: letters, spaces, apostrophes, hyphens and ampersands only (a typed name can carry digits or
// symbols the headline rules refuse).
const plainName = (name) => tidyName(String(name || '').replace(/[^\p{L}\p{M}\s'’&-]+/gu, ' '));

async function whoFor(estimate) {
  return plainName(estimate.customer_name) || plainName(await lookupCustomerName(db, estimate.customer_id)) || 'a new customer';
}

function techFirstName(technician) {
  return plainName(String(technician?.name || '').trim().split(/\s+/)[0]).slice(0, TECH_NAME_CHARS) || 'the technician';
}

// Raises the one bell. Throws when the alert cannot be raised: the caller (tech-estimate-save.js) catches it, because the
// estimate is saved and the office also sees it in the estimate list.
async function ringOfficeFirst({ estimate, detailed, technician }) {
  const tech = techFirstName(technician);
  const who = await whoFor(estimate);
  const id = String(estimate.id);
  return compose.raiseAdminAlert('estimate', {
    area: 'Estimates',
    action: fitAction('Estimates', who, [(name) => `check ${tech}'s estimate for ${name}`]),
    why: whyFor(detailed),
    severity: 'needs-you',
    link: `/admin/estimates?estimateId=${encodeURIComponent(id)}`,
    subject: { type: 'estimate', id },
    doneWhen: DONE_WHEN,
    who: 'person',
  }, {
    bell: true,
    dedupeKey: `${KEY_PREFIX}${id}`,
    detail: detailFor(detailed),
    metadata: { estimateId: id, customerId: estimate.customer_id || null, technicianId: technician?.id || null },
  });
}

module.exports = { ringOfficeFirst, KEY_PREFIX, DONE_WHEN, _private: { whyFor, detailFor, techFirstName } };
