/**
 * Completion comms context — F1 of the universal one-time services plan
 * (ratified 2026-07-12, Q13).
 *
 * ONE windowed builder for the "Include recent customer calls/texts/emails
 * in AI draft" context, replacing the two near-duplicate uncapped builders
 * (admin-projects getCustomerCommunicationContext, admin-dispatch
 * loadFindingsRecapCommsContext). Those pulled the customer's most-recent
 * 3 calls / 4 texts / 3 emails with NO date floor — a sparse-comms
 * customer's "recent" context could reach back a year (the exact owner
 * complaint the ratified windows fix).
 *
 * Window (ratified numbers):
 *  - RECURRING service: since the customer's last COMPLETED visit of the
 *    same service line (the inter-visit window), hard cap 120 days.
 *  - ONE-TIME / project: since the job's origin (estimate accepted_at →
 *    booking created_at → caller-supplied originDate), hard cap 180 days.
 *  - No resolvable anchor → the hard cap alone. Never uncapped
 *    most-recent-N: the floor is always applied; per-channel limits are a
 *    secondary size guard inside the window.
 *
 * Floors are real Date objects passed to knex (waves-db §2 — never naive
 * ISO strings), and the caps are ROLLING windows from now, not calendar-day
 * boundaries, so there is no ET/UTC day-edge to leak.
 *
 * Service relevance v1 (ratified): window + a service-line hint for the
 * prompt with an explicit "ignore unrelated topics" instruction — NOT a
 * hard keyword prefilter (which would drop "ants in the kitchen" texts that
 * never name the service). Drafts stay tech-reviewed.
 */

const db = require('../models/db');
const logger = require('./logger');
const { detectServiceLine } = require('./service-report/service-line-configs');
const { excludeUnresolvedSendReservations } = require('./messaging/review-ask-reservation');
const { whereNotSandboxCall } = require('./voice-agent/relay-protocol');
const { stripQuotedAndSignature, emailPlainText } = require('./email/email-strip');
const ContextAggregator = require('./context-aggregator');
const { etDateString } = require('../utils/datetime-et');
const { isSmsReaction } = require('./sms-intent');
const { PEST_TARGET_SUGGESTIONS } = require('../config/treatment-target-vocabulary');

const { redactAccessCodes } = ContextAggregator;

const RECURRING_CAP_DAYS = 120;
const ONE_TIME_CAP_DAYS = 180;
const MAX_CONTEXT_LINES = 8;

function compactText(value, max = 280) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 3).trim()}...` : text;
}

function contextDate(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

function contextTs(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}

function daysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function asDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Resolve the context window floor for a completion.
 *
 * @returns {{ floor: Date, reason: string, serviceLine: string|null,
 *   isRecurring: boolean }}
 */
async function resolveContextWindow({
  customerId,
  scheduledServiceId = null,
  originDate = null,
  knex = db,
}) {
  let svc = null;
  if (scheduledServiceId) {
    svc = await knex('scheduled_services')
      .where({ id: scheduledServiceId })
      .first('id', 'customer_id', 'service_type', 'service_id', 'recurring_parent_id', 'is_recurring', 'source_estimate_id', 'created_at', 'scheduled_date')
      .catch(() => null);
  }
  const serviceLine = svc ? detectServiceLine(svc.service_type) : null;

  // Recurring vs one-time: the catalog profile's billing type is the truth
  // when resolvable; a recurring_parent_id chain is recurring by
  // construction. Fail toward one-time (the wider 180d window with a job
  // origin still beats the old unbounded behavior).
  let isRecurring = false;
  if (svc) {
    // Parent rows of a recurring series carry is_recurring with a null
    // recurring_parent_id (Codex r3) — both shapes are recurring by
    // construction before the profile is even consulted.
    if (svc.recurring_parent_id || svc.is_recurring === true) {
      isRecurring = true;
    } else {
      try {
        const { resolveCompletionProfileForScheduledService } = require('./service-completion-profiles');
        const profile = await resolveCompletionProfileForScheduledService(svc, knex);
        isRecurring = String(profile?.billingType || '').toLowerCase() === 'recurring';
      } catch (err) {
        logger.warn(`[comms-context] profile resolution failed (${err.message}) — treating as one-time`);
      }
    }
  }

  if (isRecurring) {
    const cap = daysAgo(RECURRING_CAP_DAYS);
    // Last completed visit of the SAME service line before this visit.
    // service_type stores display names, so line-match happens in JS over a
    // small recent set (waves-db: names, not keys, live on the rows).
    let lastVisit = null;
    try {
      let query = knex('scheduled_services')
        .where({ customer_id: customerId, status: 'completed' })
        .whereNot({ id: svc.id })
        // Bound by the cap instead of an arbitrary row limit (Codex r2):
        // a match older than the cap loses to the cap anyway, and limiting
        // BEFORE the JS line-filter could miss the true prior same-line
        // visit behind >N other-line completions.
        .where('scheduled_date', '>=', cap);
      // Drafting a HISTORICAL visit must anchor to the last completion
      // BEFORE that visit — the customer's most recent completion overall
      // could postdate it and move the floor past the drafted visit
      // (Codex r1).
      const svcDate = asDate(svc.scheduled_date);
      if (svcDate) query = query.where('scheduled_date', '<', svcDate);
      const recent = await query
        .orderBy('scheduled_date', 'desc')
        .limit(200)
        .select('service_type', 'scheduled_date', 'completed_at');
      lastVisit = recent.find((row) => detectServiceLine(row.service_type) === serviceLine) || null;
    } catch (err) {
      logger.warn(`[comms-context] last-visit lookup failed: ${err.message}`);
    }
    // Anchor at COMPLETION time when recorded (Codex r2): scheduled_date is
    // a midnight date, so pre/during-visit coordination chatter from that
    // day would leak into the next draft; legacy rows without completed_at
    // fall back to the schedule date.
    const lastDate = asDate(lastVisit?.completed_at) || asDate(lastVisit?.scheduled_date);
    if (lastDate && lastDate > cap) {
      return { floor: lastDate, reason: `since the last completed ${serviceLine || 'service'} visit (${contextDate(lastDate)})`, serviceLine, isRecurring };
    }
    return { floor: cap, reason: `last ${RECURRING_CAP_DAYS} days`, serviceLine, isRecurring };
  }

  // One-time: job origin = estimate accepted_at → booking created_at →
  // caller-supplied origin (projects pass their created_at).
  const cap = daysAgo(ONE_TIME_CAP_DAYS);
  let origin = null;
  let originLabel = null;
  if (svc?.source_estimate_id) {
    try {
      const est = await knex('estimates')
        .where({ id: svc.source_estimate_id })
        .first('accepted_at');
      // accepted_at ONLY (Codex P2): an unaccepted/legacy estimate's
      // creation time is pre-booking chatter — fall through to the
      // booking's created_at instead.
      origin = asDate(est?.accepted_at);
      if (origin) originLabel = `since the estimate was accepted (${contextDate(origin)})`;
    } catch (err) {
      logger.warn(`[comms-context] estimate origin lookup failed: ${err.message}`);
    }
  }
  if (!origin && svc) {
    origin = asDate(svc.created_at);
    if (origin) originLabel = `since the booking (${contextDate(origin)})`;
  }
  if (!origin && originDate) {
    origin = asDate(originDate);
    if (origin) originLabel = `since the job was opened (${contextDate(origin)})`;
  }
  if (origin && origin > cap) {
    return { floor: origin, reason: originLabel, serviceLine, isRecurring };
  }
  return { floor: cap, reason: `last ${ONE_TIME_CAP_DAYS} days`, serviceLine, isRecurring };
}

/**
 * Build the compact comms-context block for an AI draft.
 *
 * @returns {{ text: string, floor: Date, reason: string,
 *   serviceLine: string|null, promptHint: string }} text is '' when the
 *   window holds nothing.
 */
async function buildCompletionCommsContext({
  customerId,
  scheduledServiceId = null,
  originDate = null,
  knex = db,
} = {}) {
  if (!customerId) return { text: '', floor: null, reason: '', serviceLine: null, promptHint: '' };
  const { floor, reason, serviceLine } = await resolveContextWindow({
    customerId, scheduledServiceId, originDate, knex,
  });

  const [calls, sms, emails] = await Promise.all([
    knex('call_log')
      .where({ customer_id: customerId })
      .where('created_at', '>=', floor)
      .select('created_at', 'direction', 'call_outcome', 'lead_synopsis', 'transcription', 'notes')
      .orderBy('created_at', 'desc')
      .limit(6)
      .catch((err) => {
        logger.warn(`[comms-context] call context unavailable: ${err.message}`);
        return [];
      }),
    // codex #4331 P2 (structural pass): an unresolved review-ask
    // reservation must not read as a delivered message in this context.
    excludeUnresolvedSendReservations(knex('sms_log')
      .where({ customer_id: customerId }))
      .where('created_at', '>=', floor)
      .select('created_at', 'direction', 'message_body', 'message_type')
      .orderBy('created_at', 'desc')
      .limit(8)
      .catch((err) => {
        logger.warn(`[comms-context] sms context unavailable: ${err.message}`);
        return [];
      }),
    knex('emails')
      .where({ customer_id: customerId })
      .where('received_at', '>=', floor)
      .select('received_at', 'subject', 'snippet', 'body_text')
      .orderBy('received_at', 'desc')
      .limit(6)
      .catch((err) => {
        logger.warn(`[comms-context] email context unavailable: ${err.message}`);
        return [];
      }),
  ]);

  const entries = [];
  for (const call of calls) {
    const summary = compactText(call.lead_synopsis || call.notes || call.transcription);
    if (summary) {
      entries.push({
        ts: contextTs(call.created_at),
        line: `Call ${contextDate(call.created_at)} (${call.direction || 'unknown'}${call.call_outcome ? `, ${call.call_outcome}` : ''}): ${summary}`,
      });
    }
  }
  for (const msg of sms) {
    const summary = compactText(msg.message_body, 260);
    if (summary) {
      entries.push({
        ts: contextTs(msg.created_at),
        line: `Text ${contextDate(msg.created_at)} (${msg.direction || 'unknown'}${msg.message_type ? `, ${msg.message_type}` : ''}): ${summary}`,
      });
    }
  }
  for (const email of emails) {
    const summary = compactText(email.snippet || email.body_text, 260);
    const subject = compactText(email.subject, 120);
    if (summary || subject) {
      entries.push({
        ts: contextTs(email.received_at),
        line: `Email ${contextDate(email.received_at)}${subject ? ` "${subject}"` : ''}: ${summary || '[no body preview]'}`,
      });
    }
  }

  const text = entries
    .sort((a, b) => b.ts - a.ts)
    .slice(0, MAX_CONTEXT_LINES)
    .map((entry) => entry.line)
    .join('\n');

  // Ratified relevance rule: window + prompt hint, never a keyword filter.
  const promptHint = serviceLine
    ? `These are the customer's recent communications (${reason}). Use only what is relevant to this ${serviceLine} visit; ignore unrelated topics.`
    : `These are the customer's recent communications (${reason}). Use only what is relevant to this visit; ignore unrelated topics.`;

  return { text, floor, reason, serviceLine, promptHint };
}

// ---------------------------------------------------------------------------
// GATE_REPORT_WRITER_RULES: what the customer told us, for the report writer.
// Same window as above, but only the customer's own words: inbound texts and
// emails, and call summaries labeled by who called (a summary covers both
// sides of the call). Waves' own texts and mail never appear, and every line
// is scrubbed before it is cut, since the writer turns these into "You
// mentioned…" copy.

// Every customer-words line is scrubbed the same way: the canonical redactor,
// then every credential-shaped token masked outright. A token (a run of
// non-space characters, surrounding punctuation aside) is credential-shaped
// when it carries a digit, unless it is a one- or two-digit count or an
// ordinal ("4821", "A12B", "AB-12", "A#12", "$120", "9:30"), or when its
// letters are all capitals ("BLUE", "AB-CD"; "A/C" passes). The context
// that anchors a bare code ("4821", "BLUE") is often gone here (the Waves
// question is left out, a quote is stripped, a summary drops the noun), and
// these lines become "You mentioned…" copy.
// A sentence typed in capitals ("ANTS ARE ALL OVER THE KITCHEN") is prose,
// not a run of codes: only its digit-bearing tokens are masked.
function credentialShaped(token, shouted = false) {
  if (/\d/.test(token)) return !/^\d{1,2}$/.test(token) && !/^\d+(?:st|nd|rd|th)$/i.test(token);
  return !shouted && /^[A-Z][A-Z#*-]{2,}$/.test(token);
}
function shoutedSentence(sentence) {
  const words = sentence.match(/[A-Za-z]{2,}/g) || [];
  return words.length >= 3 && words.filter((word) => word === word.toUpperCase()).length / words.length >= 0.6;
}
// Access details never reach the writer: a sentence about getting in (a
// code, lockbox, keypad, alarm, "for entry") is dropped whole, since a
// lowercase code ("blue", "open sesame") looks like any other word.
const ACCESS_SENTENCE_RE = /\b(?:codes?|lock\s*box(?:es)?|keypad|alarm|pins?|pass(?:code|word|phrase)s?|for\s+entry|entry\s+code|to\s+get\s+in|let\s+(?:yourself|you|them)\s+in|access\s+(?:word|phrase|number|key)s?|key\s*words?|secret\s+words?|magic\s+words?|(?:I|you|we|techs?|technicians?)\s+(?:can\s+|will\s+|could\s+)?get\s+in|how\s+(?:I|you|we|to)\s+get\s+in|get\s+(?:yourself|you|me|us)\s+in|(?:gets?|lets?)\s+(?:me|us|you|him|her)\s+(?:in|into|inside|through|past)\s+(?:[\w-]+\s+){0,3}?(?:gates?|doors?|garage|locks?|deadbolts?|keypads?|entr(?:y|ance)|fobs?|remotes?|panels?|house|home|unit|apartment|condo|building))\b/i;
// So is a sentence about working a gate, door or lock ("blue works at the
// side gate where the ants are", "use the side gate", "punch it in at the
// door"), pest talk or not; "ants come in under the back door" stays.
const ACCESS_POINT_RE = /\b(?:gates?|doors?|garage|locks?|deadbolts?|keypads?|entr(?:y|ance)|fobs?|remotes?|panels?)\b/i;
const ACCESS_USE_RE = /\b(?:works?|worked|opens|opened|unlocks?|unlocked|use|using|enter|entering|type|typing|punch(?:ing)?|press(?:ing)?|dial|key\s+in|(?:I|you|we|techs?|technicians?)\s+(?:can\s+|will\s+)?access)\b/i;
// Judged on the whole sentence, never per clause: a fronted or pronoun-linked
// access point ("For the side gate, use blue…", "The side gate is on the left
// and blue opens it") must still drop it.
// "combination of …" passes ACCESS_SENTENCE_RE as pest talk ("a combination
// of ants and roaches"), but beside any access point in the same sentence
// ("blue is the combination of the side gate") it is a credential (Codex r11).
// combo / combination is an access word except as "a combination of <pest>"
// (context-aggregator.js COMBINATION_NOUN, Codex r13); beside any access
// point in the same sentence it is one regardless (Codex r11).
const COMBINATION_CREDENTIAL_RE = new RegExp(`\\b${ContextAggregator.COMBINATION_NOUN}\\b`, 'i');
const COMBINATION_WORD_RE = /\b(?:combo|combination)s?\b/i;
const COMBINATION_LOCK_RE = /\b(?:padlocks?|lock\s*box(?:es)?|sheds?)\b/i;
const accessSentence = (sentence) => ACCESS_SENTENCE_RE.test(sentence)
  || COMBINATION_CREDENTIAL_RE.test(sentence)
  || (ACCESS_POINT_RE.test(sentence) && ACCESS_USE_RE.test(sentence))
  || (COMBINATION_WORD_RE.test(sentence) && (ACCESS_POINT_RE.test(sentence) || COMBINATION_LOCK_RE.test(sentence)));
// And a sentence reaches the writer only when it talks about pests or the
// signs they leave: scheduling, thanks, a bare reply, and any other way of
// phrasing an access detail ("blue works at the side gate") never do.
// Common Spanish pest words count too.
const PEST_TALK_RE = /\b(?:pests?|bugs?|insects?|critters?|wildlife|animals?|ants?|roach(?:es)?|cockroach(?:es)?|spiders?|webs?|cobwebs?|webbing|rodents?|rats?|mice|mouse|squirrels?|raccoons?|o?possums?|armadillos?|iguanas?|bats?|birds?|snakes?|lizards?|geckos?|frogs?|toads?|termites?|swarm(?:ers?|ing|s)?|wings?|mud\s+tubes?|mosquito(?:e?s)?|no-?see-?ums?|bites?|bitten|(?<=\b(?:get|gets|getting|got|gotten|been|being|was|were)\s)bit|itch(?:y|ing)?|fleas?|ticks?|bed\s*bugs?|bees?|wasps?|hornets?|yellow\s*jackets?|nests?|hives?|stings?|stung|silverfish|earwigs?|crickets?|centipedes?|millipedes?|scorpions?|beetles?|moths?|fl(?:y|ies)|gnats?|weevils?|pill\s*bugs?|stink\s*bugs?|love\s*bugs?|whitefl(?:y|ies)|aphids?|mealybugs?|chinch\s*bugs?|grubs?|droppings?|poop|feces|urine|smells?|smelly|odou?rs?|stench|noises?|scratch(?:ing|es)?|chew(?:ed|ing)?|gnaw(?:ed|ing)?|holes?|gaps?|openings?|damaged?|frass|sawdust|eggs?|larvae?|activity|infest\w*|traps?|bait(?:s|ed)?|stations?|dead|crawling|trails?|trailing|hormigas?|cucarachas?|ratas?|ratones?|ara[nñ]as?|termitas?|pulgas?|garrapatas?|chinches?|avispas?|abejas?|bichos?|plagas?)\b/i;
// Every pest the completion picker offers counts as pest talk too
// (springtails, booklice, mud daubers, yellowjackets…), singular or plural.
const singularPest = (word) => (/(?:mice|lice|fish)$/.test(word)
  ? word
  : word.replace(/ies$/, 'y').replace(/(ch|sh|x|o)es$/, '$1').replace(/s$/, ''));
const CANONICAL_PEST_RE = new RegExp(`\\b(?:${[...new Set(PEST_TARGET_SUGGESTIONS
  .flatMap((target) => target.toLowerCase().split(/\s*[&/()]\s*/))
  .map((part) => part.trim().split(/[\s-]+/).pop())
  .flatMap((head) => [head, singularPest(head)])
  .filter((word) => word && word.length >= 3))].join('|')})\\b`, 'i');
// And the conditions a visit is for: standing water and containers for
// mosquitoes, openings and roofline for exclusion, moisture and wood for
// termites, and what draws pests in.
const CONDITION_TALK_RE = /\b(?:standing\s+water|pool(?:s|ing)?\s+(?:of\s+)?water|water\s+(?:is\s+)?(?:pooling|collecting|standing)|puddles?|buckets?|saucers?|containers?|gutters?|downspouts?|breed(?:ing|s)?|soffits?|vents?|eaves?|attic|crawl\s*space|roof(?:line)?|rafters?|screens?|loose|torn|ripped|broken|rott?(?:ed|ing|en)?|wood\s+damage|soft\s+wood|leak(?:s|ing)?|moisture|damp|mulch|overgrown|debris|clutter|trash|garbage|compost|pet\s+food|bird\s*seed)\b/i;
const pestTalk = (sentence) => PEST_TALK_RE.test(sentence) || CANONICAL_PEST_RE.test(sentence) || CONDITION_TALK_RE.test(sentence);
// Lawn talk, for a caller that opts in with { lane: 'lawn' } (the re-service
// report card on a lawn callback). Same access-detail and credential
// protections; only the relevance test widens. Default callers are unchanged.
const LAWN_TALK_RE = /\b(?:lawn|grass|turf|sod|yard|weeds?|weedy|crabgrass|dollarweed|clover|sedge|nutsedge|brown(?:ing)?|yellow(?:ing)?|dead|dying|patch(?:es|y)?|spots?|thin(?:ning)?|bare|fungus|fungal|mushrooms?|disease|chinch|grubs?|armyworms?|webworms?|mole\s*crickets?|fertiliz\w*|sprinklers?|irrigation|watering)\b/i;
function scrub(text, { lane } = {}) {
  const relevant = lane === 'lawn'
    ? (sentence) => pestTalk(sentence) || LAWN_TALK_RE.test(sentence)
    : pestTalk;
  return redactAccessCodes(String(text || '')).trim().split(/(?<=[.!?])\s+/)
    .filter((sentence) => !accessSentence(sentence) && relevant(sentence))
    .map((sentence) => {
      const shouted = shoutedSentence(sentence);
      return sentence.replace(/\S+/g, (word) => {
        const [, lead, token, trail] = /^([("'“‘]*)(.*?)([.,!?;:)"'”’]*)$/.exec(word);
        return credentialShaped(token, shouted) ? `${lead}[redacted]${trail}` : word;
      });
    })
    .join(' ');
}
// The communication's calendar day in Eastern time (an 8 PM text is still
// that day in Florida).
function etDay(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : etDateString(d);
}

// A mailbox copy of something Waves sent (Gmail SENT label or a Waves
// address). The query already leaves these out; this guards the lines.
function wavesSentEmail(email) {
  const labels = Array.isArray(email?.label_ids) ? email.label_ids : [];
  return labels.includes('SENT') || /@wavespestcontrol\.com\s*>?\s*$/i.test(String(email?.from_address || ''));
}

// Only what the customer wrote: the body (an HTML-only body converted, its
// quoted blocks dropped), quoted history and signature stripped so a quoted
// Waves promise is never read as theirs, and scrubbed before the preview is
// cut. Never Gmail's snippet, which can run the quoted thread into the reply
// without the markers the stripper needs.
function customerEmailText(email) {
  return compactText(scrub(stripQuotedAndSignature(emailPlainText(email))), 260);
}

const CALLER = { inbound: 'the customer called', outbound: 'Waves called the customer' };

// One entry per channel: its query, which rows count, how many are kept,
// and its line.
const CUSTOMER_WORDS_CHANNELS = Object.freeze([
  {
    name: 'call',
    // The canonical call reader's exclusions (context-aggregator
    // getRecentCalls): caller-ID linkage happens before classification, so
    // sandbox, spam and wrong-number calls can carry this customer's id. The
    // whole bounded window is read and extraction-classified misdials are
    // dropped before six are kept, so they never use up the pick.
    read: (knex, customerId, floor) => whereNotSandboxCall(knex('call_log')
      .where({ customer_id: customerId })
      .where('created_at', '>=', floor))
      .where((q) => q.whereNull('call_outcome').orWhereNotIn('call_outcome', ['wrong_number', 'spam']))
      .select('created_at', 'direction', 'call_summary', 'lead_synopsis', 'processing_status', 'ai_extraction', 'ai_extraction_enriched', 'v2_extraction_status')
      .orderBy('created_at', 'desc')
      .limit(50),
    keep: (row) => !ContextAggregator.isExcludedCall(row),
    max: 6,
    // The call's AI summary (the canonical call_summary, else the lead
    // synopsis). Never the raw transcript, which mixes both speakers, and
    // never notes, which also hold operational text.
    line: (row) => {
      const summary = compactText(scrub(row.call_summary || row.lead_synopsis || ''));
      return summary && `Call ${etDay(row.created_at)} (${CALLER[row.direction] || 'caller unknown'}; AI summary of the whole conversation, not verified): ${summary}`;
    },
    ts: (row) => row.created_at,
  },
  {
    name: 'sms',
    read: (knex, customerId, floor) => excludeUnresolvedSendReservations(knex('sms_log')
      .where({ customer_id: customerId }))
      .where('created_at', '>=', floor)
      .where('direction', 'inbound')
      .select('created_at', 'direction', 'message_body', 'message_type')
      .orderBy('created_at', 'desc')
      // Over-fetch: tapbacks are dropped below before eight are kept.
      .limit(24),
    // A tapback ("Liked \"Your visit is confirmed…\"") quotes a Waves text,
    // quiet or loud, and is never the customer's own words.
    keep: (row) => row.direction === 'inbound' && row.message_type !== 'sms_reaction' && !isSmsReaction(row.message_body),
    max: 8,
    line: (row) => {
      const summary = compactText(scrub(row.message_body), 260);
      return summary && `Customer text ${etDay(row.created_at)}: ${summary}`;
    },
    ts: (row) => row.created_at,
  },
  {
    name: 'email',
    read: (knex, customerId, floor) => knex('emails')
      .where({ customer_id: customerId })
      .where('received_at', '>=', floor)
      .whereRaw("NOT (COALESCE(label_ids, '[]'::jsonb) @> '[\"SENT\"]'::jsonb)")
      .whereRaw("COALESCE(from_address, '') NOT ILIKE '%@wavespestcontrol.com%'")
      .select('received_at', 'body_text', 'body_html', 'from_address', 'label_ids')
      .orderBy('received_at', 'desc')
      // Over-fetch: quoted-only and off-topic mail is dropped below before
      // six are kept.
      .limit(24),
    keep: (row) => !wavesSentEmail(row),
    max: 6,
    // The body only: a reply's subject keeps what Waves wrote ("Re:
    // Activity found in the garage"), and a subject can be a bare code.
    line: (row) => {
      const summary = customerEmailText(row);
      return summary && `Customer email ${etDay(row.received_at)}: ${summary}`;
    },
    ts: (row) => row.received_at,
  },
]);

/**
 * The customer's own words for the report writer (GATE_REPORT_WRITER_RULES).
 * Same window rules as buildCompletionCommsContext.
 *
 * @returns {{ text: string, promptHint: string }} text is '' when the window
 *   holds nothing the customer said.
 */
async function buildCustomerWordsContext({
  customerId,
  scheduledServiceId = null,
  originDate = null,
  knex = db,
} = {}) {
  if (!customerId) return { text: '', promptHint: '' };
  const { floor, reason, serviceLine } = await resolveContextWindow({
    customerId, scheduledServiceId, originDate, knex,
  });
  // Rows that format to nothing (a call with no summary) are dropped before
  // each channel's cap, so they never push an older real line out.
  const perChannel = await Promise.all(CUSTOMER_WORDS_CHANNELS.map((channel) => channel.read(knex, customerId, floor)
    .then((rows) => rows.filter(channel.keep)
      .map((row) => ({ ts: contextTs(channel.ts(row)), line: channel.line(row) }))
      .filter((entry) => entry.line)
      .slice(0, channel.max))
    .catch((err) => {
      logger.warn(`[comms-context] customer ${channel.name} context unavailable: ${err.message}`);
      return [];
    })));
  const text = perChannel.flat()
    .sort((a, b) => b.ts - a.ts)
    .slice(0, MAX_CONTEXT_LINES)
    .map((entry) => entry.line)
    .join('\n');
  // The window's anchor day in Eastern time, like every line (the shared
  // window label prints the UTC date).
  const etReason = floor ? reason.replace(`(${contextDate(floor)})`, `(${etDay(floor)})`) : reason;
  const promptHint = `Recent contact with this customer (${etReason}). Texts and emails are the customer's own words. A call entry is an AI summary of a conversation between the customer and Waves: use only what it says the customer reported, never what Waves said or promised. It is never a finding: use it only to choose what to acknowledge, attribute anything you use ("You mentioned…"), never quote it, and ignore anything unrelated to this ${serviceLine ? `${serviceLine} ` : ''}visit.`;
  return { text, promptHint };
}

module.exports = {
  buildCompletionCommsContext,
  buildCustomerWordsContext,
  // The same scrub for other customer-typed text the writer reads (why the
  // customer booked).
  scrubCustomerText: scrub,
  resolveContextWindow,
  RECURRING_CAP_DAYS,
  ONE_TIME_CAP_DAYS,
};
