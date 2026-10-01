// Recipient double opt-in (#2948 follow-up, owner-authorized 2026-07-23).
//
// When the account holder adds an on-location contact in the portal, that
// third party gets ONE confirmation text ("Reply YES…") and appointment
// texts to them hold until they confirm. Layered on the existing rails:
// the Twilio webhook already treats YES as opt-in and STOP as suppression;
// this module just records per-recipient state and answers "may we text
// this service contact yet?".
//
// Grandfather rule: a phone with NO recipient_optin row is allowed (every
// pre-existing contact predates this flow and already carries the row-level
// consent artifact from 20260723000003). Only phones the flow has touched
// (status pending/declined) hold texts.
//
// Dark by default: nothing sends unless BOTH the GATE_RECIPIENT_DOUBLE_OPTIN
// gate is on AND the recipient_optin_request template row is activated by
// the owner (renderSmsTemplate returns null while is_active=false, and no
// pending row is written when the template doesn't render).
const db = require('../models/db');
const logger = require('./logger');

const OPTIN_TEMPLATE_KEY = 'recipient_optin_request';
const OPTIN_TEMPLATE_VERSION = 'portal-2026-07-23';

function isDoubleOptinEnabled() {
  const { isEnabled } = require('../config/feature-gates');
  return isEnabled('recipientDoubleOptin');
}

// True only when the opt-in rail can actually ASK a recipient: the double
// opt-in gate is on AND the recipient_optin_request template row exists and is
// active (the same lookup claimRecipientOptins uses to decide "dark"). The
// call pipeline's on-site consent rule needs this: with the rail dark, a
// stamped phone would be texted with no confirmation ever asked (owner
// 2026-09-30 audit). Any read failure counts as NOT live (fail closed).
async function isOptinRailLive() {
  if (!isDoubleOptinEnabled()) return false;
  try {
    const row = await db('sms_templates').where({ template_key: OPTIN_TEMPLATE_KEY }).first();
    return !!row && row.is_active !== false;
  } catch (err) {
    logger.warn(`[recipient-optin] rail check failed (${err.code || err.name || 'error'}) — treating as dark`);
    return false;
  }
}

// Durable "demote the caller once THIS recipient confirms" marker, written on
// the customer row (customers.service_preferences jsonb) by the call pipeline
// at booking time (owner 2026-09-30: the account holder who booked for an
// on-site person stops getting appointment texts, but only once that person
// has actually said YES). The marker is keyed by RECIPIENT PHONE, then by
// VISIT — service_preferences.demote_primary_on_optin =
// { "<last10>": { "<scheduled_service_id>": { demote, set_at, demoted_at? } } }
// — so several on-site contacts each keep their own entries, a second booking
// before the reply adds its own, and another contact's YES / NO never touches
// them. A visit entry is the durable obligation to send that booking's
// confirmation: it is cleared only once the send lands or is terminally
// refused (or the entry goes stale), and a sweep retries the rest. Every
// helper is best-effort and savepointed: a marker problem must never block or
// fail an opt-in transition.
const DEMOTE_MARKER_KEY = 'demote_primary_on_optin';
// A marker whose booked visit reached one of these is stale: the caller is not
// demoted for it.
// Same set as appointment-reminders' CONFIRMATION_REPLAY_DEAD_STATUSES: a
// visit that is over, called off or already under way.
const DEMOTE_STALE_VISIT_STATUSES = new Set(['cancelled', 'completed', 'skipped', 'no_show', 'en_route', 'on_site', 'in_progress', 'rescheduled']);
// Replay outcomes that end the obligation (anything else is retried by the sweep).
// template_unavailable is NOT terminal: the renderer returns null on a
// transient template-read / render error too, so it is retried.
const REPLAY_TERMINAL_REASONS = new Set(['missing_input', 'visit_not_live', 'visit_not_future', 'already_sent', 'sms_not_chosen', 'not_a_recipient', 'delivery_uncertain']);
// A replay claim older than this is a crashed attempt and may be retaken.
const REPLAY_CLAIM_STALE_MS = 10 * 60 * 1000;
// Unanswered or undeliverable entries stop being retried after this.
const MARKER_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const markerPath = (phoneKey, visitId) => (visitId ? ['demote_primary_on_optin', phoneKey, String(visitId)] : ['demote_primary_on_optin', phoneKey]);
// The customer's service_preferences object (jsonb, or a JSON string from a
// raw read), {} when absent.
function prefsOf(customer) {
  const raw = customer?.service_preferences;
  return (typeof raw === 'string' ? JSON.parse(raw || '{}') : raw) || {};
}
async function withSavepoint(dbh, fn) {
  try {
    // A root handle opens its own transaction (so the row lock holds and the
    // steps commit together); a transaction handle nests a savepoint.
    if (dbh && typeof dbh.transaction === 'function') return await dbh.transaction(fn);
    return await fn(dbh);
  } catch (err) {
    logger.warn(`[recipient-optin] demote marker step failed (${err.code || err.name || 'error'})`);
    return null;
  }
}
// Remove THIS phone's marker entry (the ask failed or was declined); other
// phones' entries stay.
async function clearDemoteMarker(customerId, phoneKey, { dbh = db } = {}) {
  if (!customerId || !phoneKey) return;
  await withSavepoint(dbh, (h) => h('customers')
    .where({ id: customerId })
    .whereRaw("jsonb_exists(COALESCE(service_preferences -> 'demote_primary_on_optin', '{}'::jsonb), ?)", [phoneKey])
    .update({ service_preferences: h.raw("COALESCE(service_preferences, '{}'::jsonb) #- ARRAY['demote_primary_on_optin', ?]::text[]", [phoneKey]) }));
}
// Stamp the account's service-contact consent artifact from a recipient's own
// YES (owner redesign 2026-10-01: the call pipeline infers no consent; the
// on-site person's YES to the opt-in text IS the consent). The artifact is
// ACCOUNT-WIDE ("every slot phone is consented"), so it is stamped only when
// the confirmed phone sits in one of the customer's slots AND every OTHER slot
// phone is already covered: the row is already stamped, or it has its own
// confirmed recipient_optin row. Otherwise it stays off and the review card
// says why. Returns { stamped, reason }.
async function stampConsentOnConfirm(h, customerId, phoneKey, customer) {
  if (customer.service_contacts_consent_at) return { stamped: true, reason: 'already_stamped' };
  const { SERVICE_CONTACT_SLOTS } = require('./customer-contact');
  const slotKeys = SERVICE_CONTACT_SLOTS.map((slot) => recipientPhoneKey(customer[slot.phone])).filter(Boolean);
  if (!slotKeys.includes(phoneKey)) return { stamped: false, reason: 'phone_not_in_a_slot' };
  const others = [...new Set(slotKeys.filter((k) => k !== phoneKey))];
  if (others.length) {
    const confirmed = await h('recipient_optin')
      .where({ customer_id: customerId, status: 'confirmed' })
      .whereIn('phone_key', others)
      .select('phone_key');
    const confirmedKeys = new Set((confirmed || []).map((r) => r.phone_key));
    // Phones the previous account stamp covered when an unconsented add
    // cleared it (call pipeline consent_covered_phone_keys) count as covered.
    const coveredKeys = new Set(prefsOf(customer).consent_covered_phone_keys || []);
    if (!others.every((k) => confirmedKeys.has(k) || coveredKeys.has(k))) return { stamped: false, reason: 'other_slot_phone_unconfirmed' };
  }
  // Bound to the slot phones just checked: a concurrent contact add/replace
  // changes a column and the stamp writes nothing (row_changed).
  let stampQuery = h('customers').where({ id: customerId }).whereNull('service_contacts_consent_at');
  for (const slot of SERVICE_CONTACT_SLOTS) {
    stampQuery = customer[slot.phone] ? stampQuery.where({ [slot.phone]: customer[slot.phone] }) : stampQuery.whereNull(slot.phone);
  }
  const wrote = await stampQuery
    .update({
      service_contacts_consent_at: new Date(),
      service_contacts_consent_source: 'recipient_optin_confirmed',
      service_contacts_consent_text_version: OPTIN_TEMPLATE_VERSION,
    });
  return wrote ? { stamped: true, reason: 'stamped' } : { stamped: false, reason: 'row_changed' };
}

// Breadcrumb on the open secondary_contact_captured review card for this
// recipient (matched by the contact phone in its payload): optin_result
// confirmed|declined, plus consent_stamp when the stamp was held. With a
// customerId, only that customer's calls' cards (each account's own outcome).
async function updateCaptureCard(h, phoneKey, patch, customerId = null) {
  let q = h('triage_items');
  if (customerId) q = q.whereIn('call_log_id', h('call_log').where({ customer_id: customerId }).select('id'));
  await q
    .where({ reason_code: 'secondary_contact_captured' })
    .whereIn('status', ['open', 'in_progress'])
    .whereRaw("right(regexp_replace(coalesce(payload #>> '{secondary_contact,phone}', ''), '\\D', '', 'g'), 10) = ?", [phoneKey])
    .update({
      payload: h.raw("(coalesce(payload, '{}'::jsonb)) || ?::jsonb", [JSON.stringify(patch)]),
      updated_at: new Date(),
    });
}

// A YES confirmed this phone. For each customer with a confirmed row for it:
// stamp the consent artifact (when the whole row is covered); and — only if the
// row now has consent, so somebody can actually be texted — act on THIS phone's
// visit entries (applyMarkerEntry). Updates each customer's review card.
// Returns { replays } — confirmation texts to send AFTER the caller's
// transaction commits (runConfirmationReplays clears each entry once final).
//
// Apply ONE confirmed phone's visit entries on a consented row. Revalidates
// before silencing the caller: the phone must STILL sit in a slot (a replaced
// contact's late YES demotes nobody) and each booked visit must still be live;
// a stale entry is dropped, never applied. demote entries switch the caller's
// appointment texts off once (demoted_at); every live entry queues the replay
// and stays until that replay is final.
async function applyMarkerEntry(h, customer, phoneKey, visits = {}, replays) {
  const customerId = customer.id;
  const { SERVICE_CONTACT_SLOTS } = require('./customer-contact');
  const slot = SERVICE_CONTACT_SLOTS.find((sl) => recipientPhoneKey(customer[sl.phone]) === phoneKey);
  const dropPath = (path) => h('customers').where({ id: customerId })
    .update({ service_preferences: h.raw("COALESCE(service_preferences, '{}'::jsonb) #- ?::text[]", [path]) });
  if (!slot) {
    await dropPath(markerPath(phoneKey));
    return;
  }
  // demote:false = another slot phone already gets the texts: replay only.
  // Re-judged on the CURRENT row too: a call that filed two on-site contacts
  // wrote demote:true for the first before the second landed — with another
  // slot phone now on the account, the caller is not stepped back.
  const otherSlotPhone = SERVICE_CONTACT_SLOTS.some((sl) => ![phoneKey, ''].includes(recipientPhoneKey(customer[sl.phone])));
  // demote_primary_applied[phone][visit] is the durable record that this
  // booking's demotion was applied: it outlives the replay entry, so a
  // reprocess after the holder re-enabled texts never switches them off again.
  const applied = prefsOf(customer).demote_primary_applied?.[phoneKey] || {};
  const { scheduledServiceApptTime } = require('./appointment-reminders');
  for (const [visitId, entry] of Object.entries(visits)) {
    // Same eligibility as the replay itself: a pre-visit status, no pulled
    // reminder, and the canonical customer-promised arrival still ahead (a
    // combined allocation's later member resolves to the group's arrival).
    const [visit, pulled, arrival] = await Promise.all([
      h('scheduled_services').where({ id: visitId, customer_id: customerId })
        .whereNotIn('status', [...DEMOTE_STALE_VISIT_STATUSES]).first('id'),
      h('appointment_reminders').where({ scheduled_service_id: visitId, cancelled: true }).first('id'),
      // A failed lookup throws (the savepoint rolls back and the YES / sweep
      // retries) — never read as "not in the future", which would drop the entry.
      scheduledServiceApptTime(visitId, { throwOnError: true }),
    ]);
    // An entry older than the cap is dropped too (NaN set_at never expires).
    if (!visit || pulled || !(arrival?.getTime() > Date.now()) || Date.now() - Date.parse(entry.set_at) > MARKER_MAX_AGE_MS) {
      await dropPath(markerPath(phoneKey, visitId));
      continue;
    }
    if (entry.demote !== false && !applied[visitId] && !otherSlotPhone) {
      await h('notification_prefs')
        .insert({ customer_id: customerId, appointment_notify_primary: false })
        .onConflict('customer_id')
        .merge({ appointment_notify_primary: false });
      await h('customers').where({ id: customerId })
        .update({ service_preferences: h.raw("jsonb_set(service_preferences, '{demote_primary_applied}', COALESCE(service_preferences -> 'demote_primary_applied', '{}'::jsonb) || jsonb_build_object(?::text, COALESCE(service_preferences #> ARRAY['demote_primary_applied', ?::text], '{}'::jsonb) || jsonb_build_object(?::text, to_jsonb(?::text))))", [phoneKey, phoneKey, String(visitId), new Date().toISOString()]) });
    }
    replays.push({
      customerId,
      scheduledServiceId: visitId,
      phoneKey,
      contact: { name: customer[slot.name], phone: customer[slot.phone], role: customer[slot.roleCol] },
    });
  }
}

async function applyDemoteMarkersOnConfirm(phoneKey, { dbh = db } = {}) {
  const replays = [];
  const committed = await withSavepoint(dbh, async (h) => {
    const rows = await h('recipient_optin').where({ phone_key: phoneKey, status: 'confirmed' }).whereNotNull('customer_id').select('customer_id');
    for (const { customer_id: customerId } of rows || []) {
      // Row lock: two slot recipients answering YES at once serialize here, so
      // the second reads the first's committed confirmation before deciding
      // whether the whole row is covered.
      const customer = await h('customers').where({ id: customerId }).forUpdate().first();
      if (!customer) continue;
      // This phone's own YES: it leaves the account's unconsented list.
      await h('customers').where({ id: customerId })
        .whereRaw("COALESCE(service_preferences -> 'unconsented_slot_phone_keys', '[]'::jsonb) @> to_jsonb(ARRAY[?::text])", [phoneKey])
        .update({ service_preferences: h.raw("jsonb_set(service_preferences, '{unconsented_slot_phone_keys}', COALESCE((SELECT jsonb_agg(k) FROM jsonb_array_elements(service_preferences -> 'unconsented_slot_phone_keys') k WHERE k <> to_jsonb(?::text)), '[]'::jsonb))", [phoneKey]) });
      const stamp = await stampConsentOnConfirm(h, customerId, phoneKey, customer);
      if (!stamp.stamped) {
        await updateCaptureCard(h, phoneKey, { optin_result: 'confirmed', consent_stamp: `held:${stamp.reason}` }, customerId);
        continue;
      }
      await updateCaptureCard(h, phoneKey, { optin_result: 'confirmed' }, customerId);
      const entries = prefsOf(customer)[DEMOTE_MARKER_KEY] || {};
      await applyMarkerEntry(h, customer, phoneKey, entries[phoneKey], replays);
      // This YES may be the one that completed the account's consent: entries
      // for OTHER confirmed phones held earlier (their YES came while this
      // phone was still unconfirmed) are applied now, not stranded.
      if (stamp.reason === 'stamped') {
        const otherKeys = Object.keys(entries).filter((k) => k !== phoneKey);
        if (otherKeys.length) {
          const confirmedOthers = await h('recipient_optin')
            .where({ customer_id: customerId, status: 'confirmed' })
            .whereIn('phone_key', otherKeys)
            .select('phone_key');
          for (const { phone_key: otherKey } of confirmedOthers || []) {
            await applyMarkerEntry(h, customer, otherKey, entries[otherKey], replays);
          }
        }
      }
    }
    return true;
  });
  // A rolled-back savepoint undid the stamp and the demotion: send nothing.
  return { replays: committed ? replays : [] };
}

// Send the booking confirmation to a recipient who just said YES, for the visit
// the call booked (still live and in the future; deduped on sms_log inside the
// helper). Runs AFTER the caller's transaction commits so the consent stamp is
// visible to the send's own checks. Best-effort: never throws.
function runConfirmationReplays(replays, dbh, { inReplyToYes = false } = {}) {
  if (!replays || !replays.length) return;
  const run = async () => {
    for (const replay of replays) {
      try {
        const path = replay.phoneKey ? markerPath(replay.phoneKey, replay.scheduledServiceId) : null;
        const claimPath = path ? [...path, 'replay_claimed_at'] : null;
        // Claim the phone+visit entry atomically: the YES handler and a
        // booking-time reconcile (or the sweep) can queue the same replay,
        // and the sms_log dedupe is read-only. Exactly one attempt sends; a
        // claim older than REPLAY_CLAIM_STALE_MS (crashed attempt) is retaken.
        if (claimPath) {
          const claimed = await db('customers')
            .where({ id: replay.customerId })
            .whereRaw('(service_preferences #> ?::text[]) IS NOT NULL', [path])
            .whereRaw('COALESCE((service_preferences #>> ?::text[])::timestamptz, \'epoch\'::timestamptz) < ?', [claimPath, new Date(Date.now() - REPLAY_CLAIM_STALE_MS)])
            .update({ service_preferences: db.raw('jsonb_set(service_preferences, ?::text[], to_jsonb(?::text))', [claimPath, new Date().toISOString()]) });
          if (!claimed) continue;
        }
        const AppointmentReminders = require('./appointment-reminders');
        const result = await AppointmentReminders.sendConfirmationToServiceContact({ ...replay, inReplyToYes });
        const final = result.sent || REPLAY_TERMINAL_REASONS.has(result.reason);
        if (path) {
          // Final: the obligation ends. Retryable: release the claim for the sweep.
          await db('customers').where({ id: replay.customerId })
            .update({ service_preferences: db.raw("COALESCE(service_preferences, '{}'::jsonb) #- ?::text[]", [final ? path : claimPath]) });
        }
        logger.info(`[recipient-optin] booking confirmation replay to ***${recipientPhoneKey(replay.contact.phone).slice(-4)}: ${result.sent ? 'sent' : `not sent (${result.reason}${final ? '' : ', will retry'})`}`);
      } catch (err) {
        logger.warn(`[recipient-optin] confirmation replay failed (${err.code || err.name || 'error'})`);
      }
    }
  };
  if (dbh && dbh.isTransaction && dbh.executionPromise && typeof dbh.executionPromise.then === 'function') {
    dbh.executionPromise.then(run, () => {});
  } else {
    setImmediate(run);
  }
}

// The booking site just wrote this phone's marker. The opt-in may already have
// resolved (the recipient was confirmed on an earlier call, so no new ask went
// out; or their YES / NO landed before the booking did): apply or drop the
// marker now instead of waiting for a reply that will never come. Writing the
// marker FIRST and reading the opt-in row second leaves no gap — a YES landing
// in between is applied by its own handler, and applying twice is idempotent
// (demoted_at gates the demotion; the replay dedupes on sms_log).
async function reconcileDemoteMarker(customerId, phoneKey, { dbh = db } = {}) {
  if (!customerId || !phoneKey) return 'skipped';
  try {
    const row = await dbh('recipient_optin').where({ customer_id: customerId, phone_key: phoneKey }).first('status');
    if (row && row.status === 'confirmed') {
      runConfirmationReplays((await applyDemoteMarkersOnConfirm(phoneKey, { dbh })).replays, dbh);
      return 'applied';
    }
    // ask_failed is retryable (a later save re-asks): its entries wait.
    if (row && row.status === 'declined') {
      await clearDemoteMarker(customerId, phoneKey, { dbh });
      return 'cleared';
    }
    return 'pending';
  } catch (err) {
    logger.warn(`[recipient-optin] demote marker reconcile failed (${err.code || err.name || 'error'})`);
    return 'error';
  }
}

// Retry sweep for unfinished booking-confirmation replays (a send that was
// held or failed leaves its visit entry in place): every customer still
// carrying entries is reconciled — confirmed phones retry the replay (the
// sms_log dedupe stops a double send), declined / failed asks drop theirs,
// pending ones wait; entries past MARKER_MAX_AGE_MS are dropped on apply.
async function sweepPendingConfirmationReplays({ limit = 25 } = {}) {
  if (!(await isDoubleOptinEnabled())) return 0;
  const rows = await db('customers')
    .whereRaw("jsonb_exists(COALESCE(service_preferences, '{}'::jsonb), 'demote_primary_on_optin')")
    .whereRaw("service_preferences -> 'demote_primary_on_optin' <> '{}'::jsonb")
    // Random rotation: long-pending entries never starve later customers.
    .orderByRaw('random()')
    .limit(limit)
    .select('id', 'service_preferences');
  let touched = 0;
  for (const row of rows || []) {
    for (const [phoneKey, visits] of Object.entries(prefsOf(row)[DEMOTE_MARKER_KEY] || {})) {
      const entries = Object.values(visits || {});
      const allExpired = entries.length > 0 && entries.every((e) => e && e.set_at && Date.now() - Date.parse(e.set_at) > MARKER_MAX_AGE_MS);
      if (!entries.length || allExpired) {
        await clearDemoteMarker(row.id, phoneKey);
        continue;
      }
      await reconcileDemoteMarker(row.id, phoneKey);
      touched += 1;
    }
  }
  return touched;
}

// A STOP declined this phone everywhere: drop every marker that names it.
async function clearDemoteMarkersForPhone(phoneKey, { dbh = db } = {}) {
  await withSavepoint(dbh, async (h) => {
    const rows = await h('recipient_optin').where({ phone_key: phoneKey }).whereNotNull('customer_id').select('customer_id');
    for (const { customer_id: customerId } of rows || []) await clearDemoteMarker(customerId, phoneKey, { dbh: h });
    await updateCaptureCard(h, phoneKey, { optin_result: 'declined' });
  });
}
// The ask for this (customer, phone) never reached the recipient: release the
// pending row to ask_failed (texts stay held) and drop the marker.
async function releaseAskFailed(phoneKey, customerId) {
  await db('recipient_optin')
    .where({ phone_key: phoneKey, customer_id: customerId, status: 'pending' })
    .update({ status: 'ask_failed', updated_at: new Date() })
    .catch(() => {});
  // The visit markers stay: ask_failed is reclaimable by a later save, and a
  // YES after that retry must still replay every still-live booking. Stale
  // entries are dropped on apply and by the sweep's 14-day cap.
}

// Same last-10 convention as the webhook's phoneLookupKey.
function recipientPhoneKey(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-10);
}

// True when appointment texts to this service contact must hold. `row` is
// the recipient_optin row (or null). Absence of a row = legacy allowed.
function optinBlocksSend(row, gateOn = isDoubleOptinEnabled()) {
  if (!gateOn || !row) return false;
  return row.status !== 'confirmed';
}

async function getRecipientOptin(phone, customerId = null) {
  const key = recipientPhoneKey(phone);
  if (!key) return null;
  try {
    const q = db('recipient_optin').where({ phone_key: key });
    if (customerId) q.where({ customer_id: customerId });
    return await q.first() || null;
  } catch (err) {
    // Split by failure type: a missing relation (42P01 — un-migrated env)
    // is the documented pre-opt-in state and fails OPEN to the #2955
    // row-level consent layer. Any OTHER error rethrows so
    // filterRecipientsByOptin's catch HOLDS the service contact — a live
    // DB blip must not text a possibly-declined recipient; held-and-
    // alerted (no-reachable-channel path) beats silently sent.
    if (err && err.code === '42P01') {
      logger.warn('[recipient-optin] table missing — failing open to row-level consent');
      return null;
    }
    logger.warn(`[recipient-optin] lookup failed (${err.message}) — holding via filter`);
    throw err;
  }
}

// Webhook hook: the sender replied YES (status 'confirmed') or STOP
// ('declined'). No-op when the phone has no row — a plain customer opt-in/
// opt-out is not recipient state.
async function markRecipientOptin(phone, status, { dbh = db } = {}) {
  const key = recipientPhoneKey(phone);
  if (!key) return false;
  try {
    const stamp = status === 'confirmed'
      ? { status, confirmed_at: new Date(), updated_at: new Date() }
      : { status, declined_at: new Date(), updated_at: new Date() };
    // Phone-wide by design: the reply comes from the person, and rows only
    // exist for properties that actually sent them an ask — a YES confirms
    // every DELIVERED ask to that person; a STOP declines them all.
    // ask_failed rows are excluded from confirmation (that property's ask
    // never reached them — the save-triggered retry must still run) but ARE
    // declined on STOP (they said stop; never re-ask).
    const q = dbh('recipient_optin').where({ phone_key: key });
    // A YES can only confirm rows whose ask actually went out: ask_failed
    // (delivery failed) and undispatched pending rows (claim committed,
    // dispatch not yet run/crashed) are excluded — the recovery sweep or
    // next save re-asks them. STOP still declines everything. DECLINED
    // rows confirm regardless of dispatched_at (codex #3495 r13): a
    // synchronous 21610 declines the row BEFORE dispatch stamps
    // dispatched_at, and no sweep re-asks a declined row — without this
    // carve-out the person's later explicit START+YES clears suppression
    // but can never unblock their appointment texts. An explicit inbound
    // YES from an already-declined person supersedes the carrier verdict,
    // exactly as it does for the callback path's dispatched declines.
    if (status === 'confirmed') {
      q.whereNot({ status: 'ask_failed' }).where(function confirmable() {
        this.whereNotNull('dispatched_at').orWhere({ status: 'declined' });
      });
    }
    let updated = await q.update(stamp);
    // Marker-recovery window: Twilio accepted the ask but the dispatched_at
    // write crashed, and the person replied YES before the sweep
    // reconciled. If sms_log shows an accepted ask to this phone, honor
    // the YES for the still-pending rows (ask_failed stays excluded).
    // Runs regardless of the first update's count: property A's confirmed
    // row must not skip reconciling property B's accepted-but-unmarked ask.
    if (status === 'confirmed') {
      // Per-row reconciliation: only a row whose OWN property's ask was
      // accepted (customer-scoped sms_log) confirms — property B's
      // undispatched pending row stays pending when only A's ask went out.
      const pendingRows = await dbh('recipient_optin').where({ phone_key: key, status: 'pending' });
      for (const row of pendingRows) {
        const priorAskRow = await dbh('sms_log')
          .whereRaw("right(regexp_replace(coalesce(to_phone, ''), '\\D', '', 'g'), 10) = ?", [key])
          .where({ customer_id: row.customer_id })
          .where(function optinAsk() {
            this.where({ message_type: 'recipient_optin_request' })
              .orWhereRaw("metadata::text like '%recipient_optin_request%'");
          })
          .orderBy('created_at', 'desc')
          .first('id', 'twilio_sid', 'status')
          .catch((err) => {
            // On a transactional dbh Postgres has already ABORTED on this
            // error; swallowing it here can let COMMIT silently resolve as a
            // rollback when no later query trips 25P02 (hook #3495) — the
            // caller would report success with nothing persisted. Rethrow so
            // the outer catch returns FALSE and the webhook's fail-loud
            // guard runs its locked fallback. Fire-and-forget callers keep
            // the best-effort null.
            if (dbh && dbh.isTransaction) throw err;
            return null;
          });
        const { isFailureStatus } = require('./twilio-failure-alerts');
        if (priorAskRow && !isFailureStatus(priorAskRow.status)) {
          updated += await dbh('recipient_optin')
            .where({ phone_key: key, customer_id: row.customer_id, status: 'pending' })
            .update({
              ...stamp,
              dispatched_at: new Date(),
              ...(priorAskRow.twilio_sid ? { provider_sid: String(priorAskRow.twilio_sid).slice(0, 64) } : {}),
            });
        }
      }
    }
    if (updated) {
      if (status === 'confirmed') runConfirmationReplays((await applyDemoteMarkersOnConfirm(key, { dbh })).replays, dbh, { inReplyToYes: true });
      else if (status === 'declined') await clearDemoteMarkersForPhone(key, { dbh });
      logger.info(`[recipient-optin] ${status} recorded for ***${key.slice(-4)}`);
    }
    // Returns the UPDATED COUNT (0 = no recipient rows — the normal case
    // for most phones), reserving FALSE for the swallowed-error path below
    // so transactional callers can distinguish "nothing to decline" from
    // "the write failed and aborted my transaction" (codex #3495). Both are
    // falsy, so fire-and-forget callers behave exactly as before.
    return updated;
  } catch (err) {
    logger.warn(`[recipient-optin] mark ${status} failed: ${err.message}`);
    return false;
  }
}

// Send-path filter shared by every fanout loop (appointment reminders +
// the twilio.js en-route/arrived sends): drops service-contact recipients
// whose recipient_optin row is not confirmed. Primary rows and phones with
// no row pass through untouched. Fail-CLOSED: while the gate is on, a
// lookup error holds the service contact's text.
async function filterRecipientsByOptin(contacts = [], customerId = null) {
  if (!isDoubleOptinEnabled()) return contacts;
  const { isServiceContactRole } = require('./customer-contact');
  const kept = [];
  for (const contact of contacts) {
    if (!isServiceContactRole(contact.role)) { kept.push(contact); continue; }
    try {
      const row = await getRecipientOptin(contact.phone, customerId);
      if (optinBlocksSend(row, true)) {
        logger.info(`[recipient-optin] holding send to unconfirmed recipient (${row.status})`);
        continue;
      }
    } catch (err) {
      // Fail closed: with the gate on, an error must hold this service
      // contact's text, never default to sending.
      logger.warn(`[recipient-optin] filter error (${err.message}) — holding send`);
      continue;
    }
    kept.push(contact);
  }
  return kept;
}

// Phase 1 — SYNCHRONOUS claim, called BEFORE the contact slots are written
// to the customers row: renders the template and inserts the pending rows
// (onConflict ignore = atomic one-ask-per-phone claim). Because the claim
// lands before the contact becomes visible to any fanout, there is no
// window where a brand-new phone reads as grandfathered (no row). Returns
// the claims for phase 2; template dark → no claims, nothing pends.
async function claimRecipientOptins({ customer, contacts = [], priorPhones = [], propertyAddress = '', trx = null }) {
  if (!isDoubleOptinEnabled()) return [];
  const dbc = trx || db;
  const accountKey = recipientPhoneKey(customer?.phone);
  const priorKeys = new Set(priorPhones.map(recipientPhoneKey).filter(Boolean));

  // Dark-vs-broken distinction (fail closed on broken): a missing or
  // deactivated template row is the INTENTIONAL dark state — skip quietly.
  // An ACTIVE row that then fails to render is infrastructure failure and
  // must throw (the save fails) rather than silently grandfather phones.
  let templateRow = null;
  try {
    templateRow = await dbc('sms_templates').where({ template_key: OPTIN_TEMPLATE_KEY }).first();
  } catch (err) {
    logger.error(`[recipient-optin] template lookup failed: ${err.message}`);
    throw err;
  }
  const templateDark = !templateRow || templateRow.is_active === false;

  const claims = [];
  for (const contact of contacts) {
    const key = recipientPhoneKey(contact.phone);
    if (!key || key === accountKey) continue;
    try {
      // Save-triggered retry: an ask_failed phone (ask never delivered)
      // re-claims on the next consented save even though the phone is
      // already stored — priorPhones only grandfathers phones that were
      // never routed through the ask flow.
      // Retryable states: ask_failed (delivery failed) and STALE pending
      // with no dispatch marker (claim committed but the process died or a
      // later step failed before the ask went out). dispatched_at is the
      // durable marker — an asked-but-unanswered recipient is never
      // re-texted.
      const reclaimed = templateDark ? 0 : await dbc('recipient_optin')
        .where({ phone_key: key, customer_id: customer?.id || null })
        .where(function retryable() {
          this.where({ status: 'ask_failed' })
            .orWhere(function stalePending() {
              this.where({ status: 'pending' })
                .whereNull('dispatched_at')
                .where('requested_at', '<', new Date(Date.now() - 10 * 60 * 1000));
            });
        })
        .update({ status: 'pending', requested_at: new Date(), dispatched_at: null, provider_sid: null, updated_at: new Date() });
      const retryClaim = reclaimed > 0;
      if (templateDark) continue;
      if (!retryClaim && priorKeys.has(key)) continue;
      const { renderSmsTemplate } = require('./sms-template-renderer');
      const body = await renderSmsTemplate(OPTIN_TEMPLATE_KEY, {
        recipient_first_name: String(contact.firstName || contact.name || '').trim().split(/\s+/)[0] || 'there',
        account_first_name: String(customer?.first_name || '').trim() || 'Your account holder',
        property_address: String(propertyAddress || '').trim() || 'your service property',
      });
      // Active template that fails to render = infrastructure failure.
      if (!body) throw new Error('active recipient_optin_request template failed to render');
      if (!retryClaim) {
        const claimed = await dbc('recipient_optin').insert({
          phone_key: key,
          phone_e164: String(contact.phone || '').trim(),
          status: 'pending',
          customer_id: customer?.id || null,
          requested_by: 'portal_contact_save',
          template_version: OPTIN_TEMPLATE_VERSION,
          requested_at: new Date(),
        }).onConflict(['customer_id', 'phone_key']).ignore().returning('phone_key');
        if (!claimed || !claimed.length) continue; // row already exists — never re-text
      }
      claims.push({ key, customerId: customer?.id || null, phone: contact.phone, body });
    } catch (err) {
      // Fail CLOSED: a claim error must fail the contact save — silently
      // proceeding would store a phone with no row (grandfathered) and
      // quietly disable the consent boundary.
      logger.error(`[recipient-optin] claim failed for ***${key.slice(-4)}: ${err.message}`);
      throw err;
    }
  }
  return claims;
}

// Phase 2 — ASYNC dispatch of the claimed confirmation texts (the save
// response never waits on Twilio). A blocked/failed send releases the
// claim so the recipient isn't stranded pending without ever being asked.
async function dispatchRecipientOptins(claims = [], customer = null) {
  let requested = 0;
  for (const claim of claims) {
    try {
      const { sendCustomerMessage } = require('./messaging/send-customer-message');
      const result = await sendCustomerMessage({
        to: claim.phone,
        body: claim.body,
        channel: 'sms',
        audience: 'customer',
        purpose: 'appointment',
        customerId: customer?.id || null,
        identityTrustLevel: 'service_contact_authorized',
        metadata: { original_message_type: 'recipient_optin_request' },
      });
      // Success-shaped sentinels (gate-blocked / template-disabled /
      // internal-redirect / suppressed) mean NO confirmation text reached
      // the recipient — no Twilio status callback will ever flip the row,
      // so treat them as failed asks and release to ask_failed for the
      // save-triggered retry (#2956 r4).
      const sentinelSid = /^(gate|template|internal|owner)-/.test(String(result?.sid || result?.providerMessageId || ''));
      // Send-window hold: ask_failed is only re-claimed by a LATER contact
      // save, so a night hold would leave this recipient blocked from all
      // texts indefinitely. Queue the ask on the scheduled-SMS rail for
      // 8:00 AM instead — the queued row owns the ask, the row stays
      // pending (dispatched), and the recipient's YES reply flips it
      // through the normal inbound path.
      if (result.blocked
        && result.code === 'QUIET_HOURS_HOLD'
        && result.deferred
        && result.nextAllowedAt) {
        try {
          const TWILIO_NUMBERS = require('../config/twilio-numbers');
          // Queue row + dispatch marker commit ATOMICALLY: a committed
          // queue row with a failed dispatched_at write leaves the ask
          // pending-undispatched, and the 10-minute stale-pending recovery
          // (sweep + save-time reclaim) would re-ask while the queued row
          // still delivers at 8:00 AM — duplicate asks. Exactly one marked
          // row or the whole enqueue rolls back to the ask_failed release.
          await db.transaction(async (trx) => {
            await trx('sms_log').insert({
              customer_id: customer?.id || null,
              direction: 'outbound',
              from_phone: TWILIO_NUMBERS.getOutboundNumber(),
              to_phone: claim.phone,
              message_body: claim.body,
              status: 'scheduled',
              scheduled_for: new Date(result.nextAllowedAt),
              message_type: 'recipient_optin_request',
              metadata: JSON.stringify({
                entry_point: 'recipient_optin_deferred',
                original_block_code: result.code,
                replay_purpose: 'appointment',
                // Replay-time staleness recheck keys (deferred-replay
                // registry): the ask only sends if this row is still pending.
                optin_phone_key: claim.key,
                optin_customer_id: claim.customerId || null,
                // from_phone above is the NOT NULL placeholder; replay on
                // the customer's location line like the immediate send.
                ...(customer?.id ? { resolve_from_by_customer: true } : {}),
              }),
            });
            const marked = await trx('recipient_optin')
              .where({ phone_key: claim.key, customer_id: claim.customerId, status: 'pending' })
              .update({ dispatched_at: new Date(), updated_at: new Date() });
            if (marked !== 1) {
              throw new Error(`dispatch marker update touched ${marked} rows (expected 1)`);
            }
          });
          requested += 1;
          logger.info(`[recipient-optin] ask for ***${claim.key.slice(-4)} held outside the 8AM-8PM ET send window — queued for ${result.nextAllowedAt}`);
          continue;
        } catch (queueErr) {
          logger.error(`[recipient-optin] held ask requeue failed for ***${claim.key.slice(-4)}: ${queueErr.message}`);
          // fall through to the ask_failed release below
        }
      }
      if (result.blocked || result.sent === false || result.suppressed === true || sentinelSid) {
        // They were never asked: keep a BLOCKING ask_failed row (texts
        // stay held) that the next consented save re-claims and retries —
        // deleting it would grandfather a phone that never got the ask.
        await releaseAskFailed(claim.key, claim.customerId);
        logger.warn(`[recipient-optin] request blocked for ***${claim.key.slice(-4)}: ${result.code || 'unknown'}`);
        continue;
      }
      await db('recipient_optin')
        .where({ phone_key: claim.key, customer_id: claim.customerId, status: 'pending' })
        .update({
          dispatched_at: new Date(),
          // Provider context ON the row: the /status failure hook can flip
          // this ask to ask_failed even when the sms_log insert failed.
          provider_sid: String(result?.sid || result?.providerMessageId || '').slice(0, 64) || null,
          updated_at: new Date(),
        })
        .catch(() => {});
      requested += 1;
    } catch (err) {
      await releaseAskFailed(claim.key, claim.customerId);
      logger.warn(`[recipient-optin] request failed for ***${claim.key.slice(-4)}: ${err.message}`);
    }
  }
  return { requested };
}

// Back-compat convenience for callers that can't split phases.
async function requestRecipientOptins(args) {
  const claims = await claimRecipientOptins(args);
  return dispatchRecipientOptins(claims, args.customer);
}

// Automatic recovery (cron): pending claims whose dispatch never happened
// (dispatched_at NULL, >10 min old — deploy/crash between claim commit and
// the fire-and-forget dispatch) get their ask sent now. Renders per row's
// customer; a dark template or send failure releases the row to ask_failed
// via the normal dispatch path. Bounded batch; no-op when the gate is off.
async function sweepUndispatchedOptins({ limit = 25 } = {}) {
  if (!isDoubleOptinEnabled()) return { swept: 0 };
  let rows = [];
  try {
    rows = await db('recipient_optin')
      .where({ status: 'pending' })
      .whereNull('dispatched_at')
      .where('requested_at', '<', new Date(Date.now() - 10 * 60 * 1000))
      .limit(limit);
  } catch { return { swept: 0 }; }
  let swept = 0;
  for (const row of rows) {
    try {
      const customer = row.customer_id
        ? await db('customers').where({ id: row.customer_id }).first()
        : null;
      if (!customer) continue;
      const slots = [customer.service_contact_name, customer.service_contact2_name, customer.service_contact3_name];
      const phones = [customer.service_contact_phone, customer.service_contact2_phone, customer.service_contact3_phone];
      const idx = phones.findIndex((ph) => recipientPhoneKey(ph) === row.phone_key);
      // Contact removed/replaced since the claim: they are no longer an
      // appointment recipient for this property — release to ask_failed
      // (re-adding them re-claims and asks) instead of texting a stranger.
      if (idx < 0) {
        await releaseAskFailed(row.phone_key, row.customer_id);
        continue;
      }
      // Reconcile before re-texting: if Twilio already accepted an ask to
      // this phone (crash landed between acceptance and the marker write),
      // just stamp dispatched_at — never send a duplicate confirmation.
      const priorSendRow = await db('sms_log')
        .whereRaw("right(regexp_replace(coalesce(to_phone, ''), '\\D', '', 'g'), 10) = ?", [row.phone_key])
        // Scoped to THIS property's customer: property A's delivered ask is
        // not proof property B's ask went out.
        .where({ customer_id: row.customer_id })
        .where(function optinAsk() {
          this.where({ message_type: 'recipient_optin_request' })
            // metadata is JSONB — cast before LIKE or the query errors and
            // the catch defeats reconciliation entirely.
            .orWhereRaw("metadata::text like '%recipient_optin_request%'");
        })
        .orderBy('created_at', 'desc')
        .first('id', 'twilio_sid', 'status')
        .catch(() => null);
      // Full failure set (mirrors the status webhook's isFailureStatus):
      // a busy/no-answer/canceled ask is NOT proof of delivery.
      const { isFailureStatus } = require('./twilio-failure-alerts');
      const priorSend = priorSendRow && !isFailureStatus(priorSendRow.status) ? priorSendRow : null;
      if (priorSend) {
        await db('recipient_optin')
          .where({ phone_key: row.phone_key, customer_id: row.customer_id, status: 'pending' })
          .update({
            dispatched_at: new Date(),
            // Copy the reconciled SID so a LATER failure callback can still
            // flip this row under the strict provider_sid match.
            ...(priorSend.twilio_sid ? { provider_sid: String(priorSend.twilio_sid).slice(0, 64) } : {}),
            updated_at: new Date(),
          }).catch(() => {});
        continue;
      }
      const { renderSmsTemplate } = require('./sms-template-renderer');
      const body = await renderSmsTemplate(OPTIN_TEMPLATE_KEY, {
        recipient_first_name: String(idx >= 0 ? slots[idx] || '' : '').trim().split(/\s+/)[0] || 'there',
        account_first_name: String(customer.first_name || '').trim() || 'Your account holder',
        property_address: [customer.address_line1, customer.city].filter(Boolean).join(', ') || 'your service property',
      });
      if (!body) continue; // template dark — leave pending-undispatched (held either way)
      const { requested } = await dispatchRecipientOptins(
        [{ key: row.phone_key, customerId: row.customer_id, phone: row.phone_e164 || row.phone_key, body }],
        customer
      );
      swept += requested;
    } catch (err) {
      logger.warn(`[recipient-optin] sweep failed for ***${String(row.phone_key || '').slice(-4)}: ${err.message}`);
    }
  }
  if (swept) logger.info(`[recipient-optin] sweep dispatched ${swept} stale ask(s)`);
  // Second pass — early-failure race: a failure callback that arrived
  // BEFORE the SID/marker stamp couldn't identify its row; that row now
  // sits pending+dispatched while its logged ask actually failed. Flip
  // such rows to ask_failed so the next consented save (or this sweep's
  // reclaim) re-asks.
  try {
    const { isFailureStatus } = require('./twilio-failure-alerts');
    const dispatched = await db('recipient_optin')
      .where({ status: 'pending' })
      .whereNotNull('dispatched_at')
      .where('dispatched_at', '<', new Date(Date.now() - 30 * 60 * 1000))
      .limit(limit);
    for (const row of dispatched) {
      const lastAsk = await db('sms_log')
        .whereRaw("right(regexp_replace(coalesce(to_phone, ''), '\\D', '', 'g'), 10) = ?", [row.phone_key])
        .where({ customer_id: row.customer_id })
        .where(function optinAsk() {
          this.where({ message_type: 'recipient_optin_request' })
            .orWhereRaw("metadata::text like '%recipient_optin_request%'");
        })
        .orderBy('created_at', 'desc')
        .first('status')
        .catch(() => null);
      if (lastAsk && isFailureStatus(lastAsk.status)) {
        await releaseAskFailed(row.phone_key, row.customer_id);
      }
    }
  } catch { /* best-effort */ }
  return { swept };
}

module.exports = {
  OPTIN_TEMPLATE_KEY,
  isOptinRailLive,
  clearDemoteMarker,
  applyDemoteMarkersOnConfirm,
  runConfirmationReplays,
  reconcileDemoteMarker,
  sweepPendingConfirmationReplays,
  clearDemoteMarkersForPhone,
  OPTIN_TEMPLATE_VERSION,
  isDoubleOptinEnabled,
  recipientPhoneKey,
  optinBlocksSend,
  getRecipientOptin,
  markRecipientOptin,
  filterRecipientsByOptin,
  claimRecipientOptins,
  dispatchRecipientOptins,
  requestRecipientOptins,
  sweepUndispatchedOptins,
};
