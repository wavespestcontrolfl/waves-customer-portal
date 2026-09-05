// Commitments on a real Postgres: the fenced upsert, human-correction
// preservation across a reprocess, fulfillment from later records, and the
// CHECK constraints the migration promises. Runs only with DATABASE_URL
// (CI's DB-gated step); fixtures are fictitious (555-01xx, fake SIDs).
const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const SID = 'CA' + '8'.repeat(30) + 'd1';
const PHONE = '+15555550177';
// The send_estimate handoff witness: a REAL delivery (deliveryState.lastDeliveredAt)
// `agoSec` seconds ago — sent_at alone proves nothing for any source.
const handedOff = (agoSec = 30, extra = {}) => JSON.stringify({ deliveryState: { lastDeliveredAt: new Date(Date.now() - agoSec * 1000).toISOString() }, ...extra });
const OUR_NUMBER = '+15555550100';

maybeDescribe('call_commitments (live Postgres)', () => {
  let db;
  let cc;
  let callId;
  const cleanup = { callIds: [], smsIds: [], visitIds: [], customerIds: [] };

  beforeAll(async () => {
    db = require('../models/db');
    cc = require('../services/call-commitments');
    await db('call_log').where({ twilio_call_sid: SID }).del();
    const [row] = await db('call_log').insert({
      twilio_call_sid: SID,
      direction: 'inbound',
      from_phone: PHONE,
      to_phone: OUR_NUMBER,
      status: 'completed',
      duration_seconds: 90,
      processing_status: 'processing',
      processing_token: 'tok-' + 'a'.repeat(28),
      processing_generation: 1,
      metadata: JSON.stringify({ fixture: 'commitments-db' }),
      created_at: new Date(Date.now() - 60 * 60 * 1000),
    }).returning('id');
    callId = row.id;
    cleanup.callIds.push(callId);
  });

  afterAll(async () => {
    if (cleanup.smsIds.length) await db('sms_log').whereIn('id', cleanup.smsIds).del();
    if (cleanup.visitIds.length) await db('scheduled_services').whereIn('id', cleanup.visitIds).del();
    if (cleanup.callIds.length) await db('call_log').whereIn('id', cleanup.callIds).del();
    if (cleanup.paymentIds && cleanup.paymentIds.length) await db('payments').whereIn('id', cleanup.paymentIds).del();
    if (cleanup.customerIds.length) await db('customers').whereIn('id', cleanup.customerIds).del();
    await db.destroy();
  });

  const seed = () => [
    { party: 'waves', kind: 'send_estimate', description: 'Send the caller an estimate', channel: 'email', confidence: 0.8, evidence: [{ quote: 'I will email you an estimate', speaker: 'agent', matched: true }] },
    { party: 'waves', kind: 'callback', description: 'Call the customer back', channel: 'call', confidence: 0.7, evidence: [] },
    { party: 'customer', kind: 'send_photos', description: 'Text photos of the ant trail', channel: 'sms', confidence: 0.9, evidence: [{ quote: 'I will text you photos', speaker: 'caller', matched: true }] },
  ];

  test('the upsert refuses to write when the pass no longer holds the claim', async () => {
    const result = await cc.upsertCommitments(db, callId, seed(), { generation: 1, procToken: 'not-the-token' });
    expect(result).toEqual({ written: 0, ownershipLost: true });
    expect(await db('call_commitments').where({ call_log_id: callId })).toHaveLength(0);
  });

  test('after finalization the upsert is fenced on the pass generation: a newer pass or a live token refuses it', async () => {
    const [done] = await db('call_log').insert({
      twilio_call_sid: 'CA' + '8'.repeat(30) + 'd4', direction: 'inbound', from_phone: PHONE, to_phone: OUR_NUMBER, status: 'completed',
      processing_status: 'processed', processing_token: null, processing_generation: 2,
    }).returning('id');
    cleanup.callIds.push(done.id);
    // Wrong generation (a newer pass ran since) → nothing written.
    expect(await cc.upsertCommitments(db, done.id, seed(), { generation: 1, procGeneration: 1 })).toEqual({ written: 0, ownershipLost: true });
    // Right generation, token cleared by finalization → written.
    const ok = await cc.upsertCommitments(db, done.id, seed(), { generation: 2, procGeneration: 2 });
    expect(ok.written).toBe(3);
    // Same generation but a LIVE token (a reclaim in flight) → refused.
    await db('call_log').where({ id: done.id }).update({ processing_token: 'live' });
    expect(await cc.upsertCommitments(db, done.id, seed(), { generation: 2, procGeneration: 2 })).toEqual({ written: 0, ownershipLost: true });
  });

  test('first pass inserts one row per identity; the same pass again changes nothing', async () => {
    const first = await cc.upsertCommitments(db, callId, seed(), { generation: 1, procToken: 'tok-' + 'a'.repeat(28) });
    expect(first.written).toBe(3);
    const again = await cc.upsertCommitments(db, callId, seed(), { generation: 1, procToken: 'tok-' + 'a'.repeat(28) });
    expect(again.written).toBe(3);
    const rows = await db('call_commitments').where({ call_log_id: callId }).orderBy('commitment_key');
    expect(rows.map((r) => r.commitment_key)).toEqual(['customer:send_photos', 'waves:callback', 'waves:send_estimate']);
    expect(rows.every((r) => r.status === 'open' && r.source === 'ai' && r.human_state === null)).toBe(true);
  });

  test('a human verdict survives a reprocess; untouched AI rows take the new pass\'s wording', async () => {
    const rows = await cc.listForCall(db, callId);
    const estimate = rows.find((r) => r.kind === 'send_estimate');
    const callback = rows.find((r) => r.kind === 'callback');
    const edited = await cc.applyHumanUpdate(db, estimate.id, { action: 'edit', description: 'Email the ant treatment estimate to the caller', due_at: '2026-09-05T13:00:00Z', reviewedBy: 'tech-fixture' });
    expect(edited).toMatchObject({ human_state: 'edited', description: 'Email the ant treatment estimate to the caller', reviewed_by: 'tech-fixture', due_basis: 'stated' });
    const dismissed = await cc.applyHumanUpdate(db, callback.id, { action: 'dismiss', note: 'They said not to bother', reviewedBy: 'tech-fixture' });
    expect(dismissed).toMatchObject({ human_state: 'dismissed', status: 'dismissed', human_note: 'They said not to bother' });

    // Reprocess (generation 2) with different AI wording for every row.
    const reprocessed = seed().map((s) => ({ ...s, description: `${s.description} (pass 2)`, confidence: 0.95 }));
    const second = await cc.upsertCommitments(db, callId, reprocessed, { generation: 2, procToken: 'tok-' + 'a'.repeat(28) });
    expect(second.written).toBe(3);

    const after = await cc.listForCall(db, callId);
    const est2 = after.find((r) => r.kind === 'send_estimate');
    const cb2 = after.find((r) => r.kind === 'callback');
    const photos2 = after.find((r) => r.kind === 'send_photos');
    // Human rows: wording, verdict and status untouched; still marked seen.
    expect(est2.description).toBe('Email the ant treatment estimate to the caller');
    expect(est2.human_state).toBe('edited');
    expect(est2.last_seen_generation).toBe(2);
    expect(est2.processing_generation).toBe(1);
    expect(cb2.status).toBe('dismissed');
    expect(cb2.description).toBe('Call the customer back');
    // Untouched AI row: rewritten by the new pass.
    expect(photos2.description).toBe('Text photos of the ant trail (pass 2)');
    expect(Number(photos2.confidence)).toBe(0.95);
    expect(photos2.processing_generation).toBe(2);
  });

  test('a commitment the new pass no longer detects is kept and reads as not seen on the latest pass', async () => {
    const third = await cc.upsertCommitments(db, callId, [seed()[2]], { generation: 3, procToken: 'tok-' + 'a'.repeat(28) });
    expect(third.written).toBe(1);
    const rows = await cc.listForCall(db, callId);
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.kind === 'send_photos').last_seen_generation).toBe(3);
    expect(rows.find((r) => r.kind === 'send_estimate').last_seen_generation).toBe(2);
  });

  test('a pass from a DIFFERENT recording resets the AI fulfillment it cannot vouch for; the same recording keeps it; a human row is untouched (codex gh-r12 P2)', async () => {
    const token = 'tok-' + 'a'.repeat(28);
    const oldSid = 'RE' + '1'.repeat(32);
    const newSid = 'RE' + '2'.repeat(32);
    await db('call_commitments').where({ call_log_id: callId, kind: 'send_photos' })
      .update({ status: 'fulfilled', fulfillment: JSON.stringify({ kind: 'inbound_media', strength: 'direct' }), fulfilled_at: new Date() });
    await db('call_log').where({ id: callId }).update({ recording_sid: oldSid });
    // Same audio, reprocessed: the proof stands (a row with no SID on record is stamped, never reset).
    await cc.upsertCommitments(db, callId, [seed()[2]], { generation: 4, procToken: token, recordingSid: oldSid });
    let photos = await db('call_commitments').where({ call_log_id: callId, kind: 'send_photos' }).first();
    expect(photos.status).toBe('fulfilled');
    expect(photos.recording_sid).toBe(oldSid);
    await cc.upsertCommitments(db, callId, [seed()[2]], { generation: 5, procToken: token, recordingSid: oldSid });
    photos = await db('call_commitments').where({ call_log_id: callId, kind: 'send_photos' }).first();
    expect(photos.status).toBe('fulfilled');
    // Adopted/replaced audio: the old audio's proof is not proof for this promise.
    await db('call_log').where({ id: callId }).update({ recording_sid: newSid });
    await cc.upsertCommitments(db, callId, [seed()[2]], { generation: 6, procToken: token, recordingSid: newSid });
    photos = await db('call_commitments').where({ call_log_id: callId, kind: 'send_photos' }).first();
    expect(photos.status).toBe('open');
    expect(photos.fulfillment).toBeNull();
    expect(photos.fulfilled_at).toBeNull();
    expect(photos.recording_sid).toBe(newSid);
    // A pass still enriching the SUPERSEDED audio is fenced out even though it holds the claim (codex gh-r16 P2).
    expect(await cc.upsertCommitments(db, callId, [seed()[2]], { generation: 7, procToken: token, recordingSid: oldSid })).toEqual({ written: 0, ownershipLost: true });
    photos = await db('call_commitments').where({ call_log_id: callId, kind: 'send_photos' }).first();
    expect(photos.recording_sid).toBe(newSid);
    expect(photos.last_seen_generation).toBe(6);
    // The human-edited row keeps its state and is never stamped by the AI pass.
    const est = await db('call_commitments').where({ call_log_id: callId, kind: 'send_estimate' }).first();
    expect(est.human_state).toBe('edited');
    expect(est.recording_sid).toBeNull();
  });

  test('editing a KEPT commitment reopens it and clears the old proof; editing an open one just edits (codex gh-r13 P2)', async () => {
    const photos = await db('call_commitments').where({ call_log_id: callId, kind: 'send_photos' }).first();
    const kept = await cc.applyHumanUpdate(db, photos.id, { action: 'fulfill', reviewedBy: 'tech-fixture' });
    expect(kept.status).toBe('fulfilled');
    const edited = await cc.applyHumanUpdate(db, photos.id, { action: 'edit', description: 'Text photos of the ant trail AND the kitchen', reviewedBy: 'tech-fixture' });
    expect(edited).toMatchObject({ status: 'open', fulfillment: null, fulfilled_at: null, human_state: 'edited', description: 'Text photos of the ant trail AND the kitchen' });
    const again = await cc.applyHumanUpdate(db, photos.id, { action: 'edit', due_at: '2026-09-06T13:00:00Z', reviewedBy: 'tech-fixture' });
    expect(again.status).toBe('open');
    expect(new Date(again.due_at).toISOString()).toBe('2026-09-06T13:00:00.000Z');
  });

  test('a human-added commitment is its own row, confirmed, with no AI provenance', async () => {
    const row = await cc.addHumanCommitment(db, callId, { party: 'waves', kind: 'send_paperwork', description: 'Mail the WDO paperwork', reviewedBy: 'tech-fixture' });
    expect(row).toMatchObject({ source: 'human', human_state: 'confirmed', status: 'open', kind: 'send_paperwork', confidence: null });
    expect(row.commitment_key).toMatch(/^waves:send_paperwork:[a-z0-9-]+:h[0-9a-f]{6}$/);
    // Strict pairing: a caller promise cannot be filed as a Waves one, and vice versa.
    await expect(cc.addHumanCommitment(db, callId, { party: 'customer', kind: 'send_paperwork', description: 'x' })).rejects.toMatchObject({ status: 400 });
    await expect(cc.addHumanCommitment(db, callId, { party: 'martian', kind: 'other', description: 'x' })).rejects.toMatchObject({ status: 400 });
    await expect(cc.addHumanCommitment(db, callId, { party: 'waves', kind: 'teleport', description: 'x' })).rejects.toMatchObject({ status: 400 });
    // A retried or double-submitted request returns the same row, never a
    // uniqueness error.
    const again = await cc.addHumanCommitment(db, callId, { party: 'waves', kind: 'send_paperwork', description: 'Mail the WDO paperwork', reviewedBy: 'tech-fixture' });
    expect(again.id).toBe(row.id);
    expect(await db('call_commitments').where({ call_log_id: callId, kind: 'send_paperwork' })).toHaveLength(1);
  });

  test('the CHECK constraints reject a writer with a bad enum value', async () => {
    await expect(db('call_commitments').insert({
      call_log_id: callId, commitment_key: 'x:bad', party: 'waves', kind: 'teleport', description: 'nope',
    })).rejects.toThrow(/call_commitments_kind_check/);
    await expect(db('call_commitments').insert({
      call_log_id: callId, commitment_key: 'x:bad2', party: 'martian', kind: 'other', description: 'nope',
    })).rejects.toThrow(/call_commitments_party_check/);
  });

  test('fulfillment: a DIRECTLY linked record marks a promise kept; a same-customer record is only a hint; nothing touches a human verdict', async () => {
    const call = await db('call_log').where({ id: callId }).first();
    // A short (abandoned) outbound call to the caller AFTER this call: not
    // a returned callback (the callback row is human-dismissed anyway, so
    // it must stay dismissed).
    const [outbound] = await db('call_log').insert({
      twilio_call_sid: 'CA' + '8'.repeat(30) + 'd2', direction: 'outbound', from_phone: OUR_NUMBER, to_phone: PHONE,
      status: 'completed', duration_seconds: 45, created_at: new Date(Date.now() - 10 * 60 * 1000),
    }).returning('id');
    cleanup.callIds.push(outbound.id);
    // A FAILED confirmation earlier is no witness; the earliest surviving row is the hint (codex gh-r16 P2).
    const [failedSms] = await db('sms_log').insert({
      direction: 'outbound', from_phone: OUR_NUMBER, to_phone: PHONE, message_type: 'confirmation', status: 'failed',
      created_at: new Date(Date.now() - 7 * 60 * 1000),
    }).returning('id');
    cleanup.smsIds.push(failedSms.id);
    // A confirmation text to the caller after the call: association only.
    const [sms] = await db('sms_log').insert({
      direction: 'outbound', from_phone: OUR_NUMBER, to_phone: PHONE, message_type: 'confirmation', status: 'sent',
      created_at: new Date(Date.now() - 5 * 60 * 1000),
    }).returning('id');
    cleanup.smsIds.push(sms.id);
    // A visit booked FROM this call: direct linkage.
    const [visit] = await db('scheduled_services').insert({
      scheduled_date: '2026-09-10', service_type: 'General Pest Control', status: 'pending', source_call_log_id: callId,
    }).returning('id');
    cleanup.visitIds.push(visit.id);

    await cc.upsertCommitments(db, callId, [
      { party: 'waves', kind: 'send_appointment_confirmation', description: 'Send the confirmation', evidence: [] },
      { party: 'waves', kind: 'schedule_visit', description: 'Book the visit', evidence: [] },
    ], { generation: 4, procToken: 'tok-' + 'a'.repeat(28) });

    const refreshed = await cc.refreshFulfillment(db, callId, call);
    expect(refreshed).toMatchObject({ fulfilled: 1, hinted: 1 });
    const rows = await cc.listForCall(db, callId);
    const booked = rows.find((r) => r.kind === 'schedule_visit');
    expect(booked.status).toBe('fulfilled');
    expect(booked.fulfillment).toMatchObject({ kind: 'appointment_booked', record_id: visit.id, strength: 'direct', basis: 'visit_booked_from_this_call' });
    // The confirmation text is not linked to this call: status stays open,
    // the match is a hint the office confirms.
    const conf = rows.find((r) => r.kind === 'send_appointment_confirmation');
    expect(conf.status).toBe('open');
    expect(conf.fulfillment).toMatchObject({ kind: 'sms_sent', record_id: sms.id, strength: 'association' });
    // The dismissed callback stays dismissed even though an outbound call exists.
    expect(rows.find((r) => r.kind === 'callback').status).toBe('dismissed');
    // The caller's photo promise has no inbound media → open, no hint.
    const photos = rows.find((r) => r.kind === 'send_photos');
    expect(photos.status).toBe('open');
    expect(photos.fulfillment).toBeNull();
    // A 45 s pickup-and-abandon is not a returned callback (digest parity: >= 60 s).
    expect(await cc.resolveFulfillment(db, { kind: 'callback' }, call)).toBeNull();
    // A CONNECTED outbound call to the caller after the call IS the returned callback: direct proof.
    await db('call_log').where({ id: outbound.id }).update({ duration_seconds: 75 });
    expect(await cc.resolveFulfillment(db, { kind: 'callback' }, call)).toMatchObject({ kind: 'outbound_call', record_id: outbound.id, strength: 'direct' });
    // A LINKED call is returned only by an outbound call linked to the same customer.
    expect(await cc.resolveFulfillment(db, { kind: 'callback' }, { ...call, customer_id: '00000000-0000-4000-8000-000000000001' })).toBeNull();
    await db('call_log').where({ id: outbound.id }).update({ duration_seconds: 45 });
  });

  test('a human-typed text to the caller after the call returns a callback; the assistant\'s automatic reply does not', async () => {
    const call = await db('call_log').where({ id: callId }).first();
    const [auto] = await db('sms_log').insert({
      direction: 'outbound', from_phone: OUR_NUMBER, to_phone: PHONE, message_type: 'ai_assistant_reply', status: 'sent', created_at: new Date(Date.now() - 4 * 60 * 1000),
    }).returning('id');
    cleanup.smsIds.push(auto.id);
    expect(await cc.resolveFulfillment(db, { kind: 'callback' }, call)).toBeNull();
    const [manual] = await db('sms_log').insert({
      direction: 'outbound', from_phone: OUR_NUMBER, to_phone: PHONE, message_type: 'manual', status: 'sent', created_at: new Date(Date.now() - 3 * 60 * 1000),
    }).returning('id');
    cleanup.smsIds.push(manual.id);
    expect(await cc.resolveFulfillment(db, { kind: 'callback' }, call)).toMatchObject({ kind: 'sms_sent', record_id: manual.id, strength: 'direct' });
    // …and the customer's own call_back promise matches a later completed
    // INBOUND call from their number (codex gh-r8 P2) — the outbound call
    // above is not that.
    expect(await cc.resolveFulfillment(db, { kind: 'call_back' }, call)).toBeNull();
    const [inboundLater] = await db('call_log').insert({
      twilio_call_sid: 'CA' + '9'.repeat(30) + 'cb', direction: 'inbound', from_phone: PHONE, to_phone: OUR_NUMBER, status: 'completed',
      duration_seconds: 45, created_at: new Date(Date.now() + 2 * 60 * 60 * 1000),
    }).returning('id');
    cleanup.callIds.push(inboundLater.id);
    expect(await cc.resolveFulfillment(db, { kind: 'call_back' }, call)).toMatchObject({ kind: 'inbound_call', record_id: inboundLater.id, strength: 'association' });
  });

  test('a delivery inside the window keeps counting after a resend outside it — firstDeliveredAt is the retained witness (codex #3811 r29 P2)', async () => {
    const call = await db('call_log').where({ id: callId }).first();
    const inWindow = new Date(call.created_at.getTime() + 2 * 24 * 60 * 60 * 1000);
    const resent = new Date(call.created_at.getTime() + (cc.ASSOCIATION_WINDOW_DAYS + 5) * 24 * 60 * 60 * 1000);
    const [est] = await db('estimates').insert({
      status: 'sent', customer_phone: PHONE, sent_at: resent, created_at: inWindow,
      estimate_data: JSON.stringify({ deliveryState: { firstDeliveredAt: inWindow.toISOString(), lastDeliveredAt: resent.toISOString() } }),
    }).returning('id');
    try {
      expect(await cc.resolveFulfillment(db, { kind: 'send_estimate' }, call)).toMatchObject({ kind: 'estimate_sent', record_id: est.id, strength: 'association', matched_at: inWindow });
      // A resend-only row (first and last both outside the window) is not a hint.
      await db('estimates').where({ id: est.id }).update({ estimate_data: JSON.stringify({ deliveryState: { firstDeliveredAt: resent.toISOString(), lastDeliveredAt: resent.toISOString() } }) });
      expect(await cc.resolveFulfillment(db, { kind: 'send_estimate' }, call)).toBeNull();
      // Delivered BEFORE the call, resent inside the window, resent again
      // after it: first and last are both outside, the send history
      // (deliveryState.deliveredAt) carries the in-window handoff (codex
      // #3811 r30 P2). A malformed history element is skipped.
      const before = new Date(call.created_at.getTime() - 3 * 24 * 60 * 60 * 1000);
      await db('estimates').where({ id: est.id }).update({ estimate_data: JSON.stringify({ deliveryState: { firstDeliveredAt: before.toISOString(), lastDeliveredAt: resent.toISOString(), deliveredAt: [before.toISOString(), 'yesterday afternoon', inWindow.toISOString(), resent.toISOString()] } }) });
      expect(await cc.resolveFulfillment(db, { kind: 'send_estimate' }, call)).toMatchObject({ kind: 'estimate_sent', record_id: est.id, strength: 'association', matched_at: inWindow });
    } finally {
      await db('estimates').where({ id: est.id }).del();
    }
  });

  test('an association outside the window is not a hint at all', async () => {
    const call = await db('call_log').where({ id: callId }).first();
    const [late] = await db('sms_log').insert({
      direction: 'outbound', from_phone: OUR_NUMBER, to_phone: '+15555550178', message_type: 'confirmation', status: 'sent',
      created_at: new Date(Date.now() + (cc.ASSOCIATION_WINDOW_DAYS + 5) * 24 * 60 * 60 * 1000),
    }).returning('id');
    cleanup.smsIds.push(late.id);
    const proof = await cc.resolveFulfillment(db, { kind: 'send_appointment_confirmation' }, { ...call, from_phone: '+15555550178' });
    expect(proof).toBeNull();
  });

  test('an invoice on the visit booked from this call counts only when paid AFTER the call', async () => {
    const call = await db('call_log').where({ id: callId }).first();
    const [visit] = await db('scheduled_services').insert({ scheduled_date: '2026-09-11', service_type: 'General Pest Control', status: 'completed', source_call_log_id: callId }).returning('id');
    cleanup.visitIds.push(visit.id);
    const [payer] = await db('customers').insert({ first_name: 'Payer', phone: '+15555550199' }).returning('id');
    cleanup.customerIds.push(payer.id);
    const [inv] = await db('invoices').insert({ customer_id: payer.id, scheduled_service_id: visit.id, token: 'pay-' + callId.slice(0, 8), invoice_number: 'PAY-' + callId.slice(0, 6), total: 99, status: 'paid', paid_at: new Date(call.created_at.getTime() - 24 * 60 * 60 * 1000) }).returning('id');
    try {
      // A visit linked to the call but CREATED before it (a reprocess relinked
      // an existing appointment) is not this call's proof either.
      await db('scheduled_services').where({ source_call_log_id: callId }).update({ created_at: new Date(call.created_at.getTime() - 24 * 60 * 60 * 1000) });
      expect(await cc.resolveFulfillment(db, { kind: 'schedule_visit' }, { ...call, customer_id: null })).toBeNull();
      await db('scheduled_services').where({ id: visit.id }).update({ created_at: new Date(Date.now() - 30 * 1000) });
      expect(await cc.resolveFulfillment(db, { kind: 'schedule_visit' }, { ...call, customer_id: null })).toMatchObject({ kind: 'appointment_booked', record_id: visit.id, strength: 'direct' });
      // Paid before the call: neither the direct path nor the same-customer hint.
      expect(await cc.resolveFulfillment(db, { kind: 'make_payment' }, { ...call, customer_id: payer.id })).toBeNull();
      await db('invoices').where({ id: inv.id }).update({ paid_at: new Date(Date.now() - 60 * 1000) });
      // paid_at alone is not a payment (credit-closed invoices stamp it with
      // no payment row): no paid payments row after the call → no proof (codex gh-r11 P2).
      expect(await cc.resolveFulfillment(db, { kind: 'make_payment' }, { ...call, customer_id: payer.id })).toBeNull();
      // A same-day payment on some OTHER invoice is not this invoice's witness
      // either: the payment must be linked to the invoice it vouches for (codex gh-r12 P2).
      cleanup.paymentIds = cleanup.paymentIds || [];
      const [stray] = await db('payments').insert({ customer_id: payer.id, amount: 45, status: 'paid', payment_date: new Date(Date.now() - 45 * 1000), created_at: new Date(Date.now() - 45 * 1000), metadata: JSON.stringify({ invoice_id: '00000000-0000-4000-8000-000000000000' }) }).returning('id');
      cleanup.paymentIds.push(stray.id);
      expect(await cc.resolveFulfillment(db, { kind: 'make_payment' }, { ...call, customer_id: payer.id })).toBeNull();
      const [pay] = await db('payments').insert({ customer_id: payer.id, amount: 99, status: 'paid', payment_date: new Date(Date.now() - 45 * 1000), created_at: new Date(Date.now() - 45 * 1000), metadata: JSON.stringify({ invoice_id: inv.id }) }).returning('id');
      cleanup.paymentIds.push(pay.id);
      expect(await cc.resolveFulfillment(db, { kind: 'make_payment' }, { ...call, customer_id: payer.id })).toMatchObject({ kind: 'invoice_paid', record_id: inv.id, strength: 'direct' });
    } finally {
      await db('invoices').where({ id: inv.id }).del();
    }
  });

  test('an estimate on a REUSED lead that was sent before the call is not this call\'s proof; one handed off after it is direct proof', async () => {
    const call = await db('call_log').where({ id: callId }).first();
    const [est] = await db('estimates').insert({ status: 'sent', sent_at: new Date(call.created_at.getTime() - 3 * 24 * 60 * 60 * 1000), estimate_data: handedOff(3 * 24 * 60 * 60) }).returning('id');
    const [lead] = await db('leads').insert({ phone: PHONE, twilio_call_sid: SID, estimate_id: est.id, status: 'estimate_sent' }).returning('id');
    try {
      expect(await cc.resolveFulfillment(db, { kind: 'send_estimate' }, call)).toBeNull();
      // …but ACCEPTED after the call: the promise was kept at acceptance,
      // whatever sent_at says (pre-push hook P1 on 3b5b2cb27).
      await db('estimates').where({ id: est.id }).update({ accepted_at: new Date(Date.now() - 30 * 1000) });
      expect(await cc.resolveFulfillment(db, { kind: 'send_estimate' }, call)).toMatchObject({ kind: 'estimate_sent', record_id: est.id, strength: 'direct' });
      await db('estimates').where({ id: est.id }).update({ accepted_at: null });
      // Sent after the call ended even though CREATED before it (an existing
      // estimate re-sent on request — the watcher's rule, r14): direct proof.
      await db('estimates').where({ id: est.id }).update({ sent_at: new Date(Date.now() - 60 * 1000), created_at: new Date(call.created_at.getTime() - 3 * 24 * 60 * 60 * 1000), estimate_data: handedOff() });
      expect(await cc.resolveFulfillment(db, { kind: 'send_estimate' }, call)).toMatchObject({ kind: 'estimate_sent', record_id: est.id, strength: 'direct' });
      // Sent after the call STARTED but before it ENDED (created_at is ring
      // time; this call ran 90 s): not this call's proof (codex #3738 gh-r13 P1).
      const midCall = new Date(call.created_at.getTime() + 30 * 1000);
      await db('estimates').where({ id: est.id }).update({ sent_at: midCall, estimate_data: JSON.stringify({ deliveryState: { lastDeliveredAt: midCall.toISOString() } }) });
      expect(await cc.resolveFulfillment(db, { kind: 'send_estimate' }, call)).toBeNull();
      // Created and sent after the call ended: direct proof.
      await db('estimates').where({ id: est.id }).update({ created_at: new Date(Date.now() - 120 * 1000), sent_at: new Date(Date.now() - 60 * 1000), estimate_data: handedOff() });
      expect(await cc.resolveFulfillment(db, { kind: 'send_estimate' }, call)).toMatchObject({ kind: 'estimate_sent', record_id: est.id, strength: 'direct' });
      // The ONE handoff witness, every source: sent_at alone is the
      // publish-without-delivery stamp of a report/plan-restart mint AND the
      // suppression-only stamp of an ordinary send (#3725 r13 P1 class,
      // #3811 r5). Only a real handoff (deliveryState.lastDeliveredAt after
      // the call) or an acceptance after the call counts.
      await db('estimates').where({ id: est.id }).update({ source: 'service_report_cta', estimate_data: JSON.stringify({}) });
      expect(await cc.resolveFulfillment(db, { kind: 'send_estimate' }, call)).toBeNull();
      await db('estimates').where({ id: est.id }).update({ source: null });
      expect(await cc.resolveFulfillment(db, { kind: 'send_estimate' }, call)).toBeNull();
      await db('estimates').where({ id: est.id }).update({ accepted_at: new Date(Date.now() - 30 * 1000) });
      expect(await cc.resolveFulfillment(db, { kind: 'send_estimate' }, call)).toMatchObject({ kind: 'estimate_sent', record_id: est.id, strength: 'direct' });
      // A MANUAL accept (an admin recording a verbal yes — price locked by
      // 'manual_accept') delivered nothing; the customer's own accept did
      // (codex r18 P1).
      await db('estimates').where({ id: est.id }).update({ price_locked_by: 'manual_accept' });
      expect(await cc.resolveFulfillment(db, { kind: 'send_estimate' }, call)).toBeNull();
      await db('estimates').where({ id: est.id }).update({ price_locked_by: 'customer_accept' });
      expect(await cc.resolveFulfillment(db, { kind: 'send_estimate' }, call)).toMatchObject({ kind: 'estimate_sent', record_id: est.id, strength: 'direct' });
      await db('estimates').where({ id: est.id }).update({ price_locked_by: null });
      // An acceptance BEFORE the call is not this call's handoff either.
      await db('estimates').where({ id: est.id }).update({ accepted_at: new Date(call.created_at.getTime() - 60 * 1000) });
      expect(await cc.resolveFulfillment(db, { kind: 'send_estimate' }, call)).toBeNull();
      await db('estimates').where({ id: est.id }).update({ accepted_at: null, estimate_data: handedOff() });
      expect(await cc.resolveFulfillment(db, { kind: 'send_estimate' }, call)).toMatchObject({ kind: 'estimate_sent', record_id: est.id, strength: 'direct' });
      // A group-send SIBLING carries no deliveryState of its own — it
      // inherits the anchor's handoff through groupPublishedByEstimateId.
      const [anchor] = await db('estimates').insert({ status: 'sent', sent_at: new Date(Date.now() - 60 * 1000), estimate_data: handedOff() }).returning('id');
      try {
        await db('estimates').where({ id: est.id }).update({ estimate_data: JSON.stringify({ groupPublishedByEstimateId: anchor.id }) });
        expect(await cc.resolveFulfillment(db, { kind: 'send_estimate' }, call)).toMatchObject({ kind: 'estimate_sent', record_id: est.id, strength: 'direct' });
        // A sibling sent on its own BEFORE joining the group keeps its stale
        // stamp; the anchor's later handoff still counts (Codex r6 P2).
        await db('estimates').where({ id: est.id }).update({ estimate_data: JSON.stringify({ deliveryState: { lastDeliveredAt: new Date(call.created_at.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString() }, groupPublishedByEstimateId: anchor.id }) });
        expect(await cc.resolveFulfillment(db, { kind: 'send_estimate' }, call)).toMatchObject({ kind: 'estimate_sent', record_id: est.id, strength: 'direct' });
        await db('estimates').where({ id: est.id }).update({ estimate_data: JSON.stringify({ groupPublishedByEstimateId: anchor.id }) });
        await db('estimates').where({ id: anchor.id }).update({ estimate_data: JSON.stringify({}) });
        expect(await cc.resolveFulfillment(db, { kind: 'send_estimate' }, call)).toBeNull();
      } finally {
        await db('estimates').where({ id: anchor.id }).del();
      }
      await db('estimates').where({ id: est.id }).update({ estimate_data: handedOff() });
      // The same lead reached only through the metadata.lead_id STAMP by a
      // call with a different SID is a REUSED lead: its estimate is a hint,
      // not direct proof (codex gh-r13 P1). The estimator's own callLogId
      // stamp on the estimate is explicit provenance and stays direct.
      const reusing = { ...call, twilio_call_sid: 'CA' + '9'.repeat(30) + 'd2', metadata: JSON.stringify({ lead_id: lead.id }) };
      expect(await cc.resolveFulfillment(db, { kind: 'send_estimate' }, reusing)).toMatchObject({ record_id: est.id, strength: 'association', basis: 'estimate_sent_on_a_lead_reused_from_an_earlier_call' });
      await db('estimates').where({ id: est.id }).update({ estimate_data: handedOff(30, { estimatorEngine: { callLogId: call.id } }) });
      expect(await cc.resolveFulfillment(db, { kind: 'send_estimate' }, reusing)).toMatchObject({ record_id: est.id, strength: 'direct', basis: 'estimate_stamped_with_this_call' });
      await db('estimates').where({ id: est.id }).update({ estimate_data: handedOff() });
      // A lead OLDER than the call that carries its SID only because
      // attribution re-stamped it on reuse is a reused lead: association,
      // not direct (Codex #3811 r9 P1). Created at/after the call: minted.
      await db('leads').where({ id: lead.id }).update({ created_at: new Date(call.created_at.getTime() - 24 * 60 * 60 * 1000) });
      expect(await cc.resolveFulfillment(db, { kind: 'send_estimate' }, call)).toMatchObject({ record_id: est.id, strength: 'association', basis: 'estimate_sent_on_a_lead_reused_from_an_earlier_call' });
      await db('leads').where({ id: lead.id }).update({ created_at: new Date(call.created_at.getTime() + 30 * 1000) });
      expect(await cc.resolveFulfillment(db, { kind: 'send_estimate' }, call)).toMatchObject({ record_id: est.id, strength: 'direct' });
      // The same-customer association path: an estimate created before the
      // call but sent after it is a hint like any other (r14).
      await db('leads').where({ id: lead.id }).update({ estimate_id: null });
      const [cust] = await db('customers').insert({ first_name: 'Assoc', phone: PHONE }).returning('id');
      cleanup.customerIds.push(cust.id);
      await db('estimates').where({ id: est.id }).update({ customer_id: cust.id, created_at: new Date(call.created_at.getTime() - 3 * 24 * 60 * 60 * 1000) });
      expect(await cc.resolveFulfillment(db, { kind: 'send_estimate' }, { ...call, customer_id: cust.id })).toMatchObject({ record_id: est.id, strength: 'association' });
      await db('estimates').where({ id: est.id }).update({ created_at: new Date(Date.now() - 120 * 1000) });
      expect(await cc.resolveFulfillment(db, { kind: 'send_estimate' }, { ...call, customer_id: cust.id })).toMatchObject({ record_id: est.id, strength: 'association' });
      // The association arm applies the same handoff witness: a same-customer
      // report-tap mint with no delivery is not even a hint.
      await db('estimates').where({ id: est.id }).update({ source: 'plan_restart', estimate_data: JSON.stringify({}) });
      expect(await cc.resolveFulfillment(db, { kind: 'send_estimate' }, { ...call, customer_id: cust.id })).toBeNull();
      await db('estimates').where({ id: est.id }).update({ estimate_data: handedOff() });
      expect(await cc.resolveFulfillment(db, { kind: 'send_estimate' }, { ...call, customer_id: cust.id })).toMatchObject({ record_id: est.id, strength: 'association' });
      // Sibling and anchor witnesses are tested against the window on their
      // own: an anchor resent past the association window does not hide the
      // sibling's own qualifying handoff (Codex r8 P2).
      const [lateAnchor] = await db('estimates').insert({ status: 'sent', sent_at: new Date(Date.now() - 60 * 1000), estimate_data: JSON.stringify({ deliveryState: { lastDeliveredAt: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString() } }) }).returning('id');
      try {
        await db('estimates').where({ id: est.id }).update({ estimate_data: handedOff(30, { groupPublishedByEstimateId: lateAnchor.id }) });
        expect(await cc.resolveFulfillment(db, { kind: 'send_estimate' }, { ...call, customer_id: cust.id })).toMatchObject({ record_id: est.id, strength: 'association' });
      } finally {
        await db('estimates').where({ id: lateAnchor.id }).del();
      }
      // The hint is the estimate handed off EARLIEST after the call: a
      // sibling row carrying a stale pre-call handoff plus a later post-call
      // acceptance is admitted, but its qualifying witness (the acceptance)
      // is later than est's own handoff, so it must not sort ahead of est
      // (codex r15 P2).
      const [stale] = await db('estimates').insert({
        status: 'accepted', customer_id: cust.id, sent_at: new Date(call.created_at.getTime() - 3 * 24 * 60 * 60 * 1000),
        accepted_at: new Date(Date.now() - 5 * 1000), estimate_data: handedOff(3 * 24 * 60 * 60),
      }).returning('id');
      try {
        expect(await cc.resolveFulfillment(db, { kind: 'send_estimate' }, { ...call, customer_id: cust.id })).toMatchObject({ record_id: est.id, strength: 'association' });
      } finally {
        await db('estimates').where({ id: stale.id }).del();
      }
    } finally {
      await db('leads').where({ id: lead.id }).del();
      await db('estimates').where({ id: est.id }).del();
    }
  });

  test('an estimate linked only by customer_phone fulfills an UNLINKED caller\'s promise; a linked estimate on a shared number does not (codex #3738 P1)', async () => {
    const call = await db('call_log').where({ id: callId }).first(); // unlinked (customer_id NULL), from_phone = PHONE
    const [est] = await db('estimates').insert({ status: 'sent', sent_at: new Date(Date.now() - 60 * 1000), created_at: new Date(Date.now() - 120 * 1000), customer_phone: PHONE, estimate_data: handedOff() }).returning('id');
    let otherId = null;
    try {
      // An UNLINKED estimate whose phone matches the caller keeps the promise
      // (commercial proposals store the phone with a NULL customer_id).
      expect(await cc.resolveFulfillment(db, { kind: 'send_estimate' }, call)).toMatchObject({ kind: 'estimate_sent', record_id: est.id, strength: 'association', basis: expect.stringContaining('caller_phone') });
      // A LINKED estimate on the same (shared) number must NOT clear an
      // unlinked caller's promise — mirrors the watcher's shared-number rule.
      const [other] = await db('customers').insert({ first_name: 'Housemate', phone: PHONE }).returning('id');
      otherId = other.id;
      await db('estimates').where({ id: est.id }).update({ customer_id: otherId });
      expect(await cc.resolveFulfillment(db, { kind: 'send_estimate' }, call)).toBeNull();
    } finally {
      await db('estimates').where({ id: est.id }).del();
      if (otherId) await db('customers').where({ id: otherId }).del();
    }
  });

  test.each([
    ['FK', { link: 'fk', match: true }],
    ['lead mirror', { link: 'mirror', match: true }],
    ['agreeing FK and mirror', { link: 'both', match: true }],
    ['explicit foreign estimate owner', { link: 'fk', foreignEstimate: true }],
    ['foreign FK alongside own FK', { link: 'fk', foreignLink: 'fk' }],
    ['foreign mirror alongside own FK', { link: 'fk', foreignLink: 'mirror' }],
    ['foreign FK alongside own mirror', { link: 'mirror', foreignLink: 'fk' }],
    ['unknown owner FK alongside own mirror', { link: 'mirror', foreignLink: 'fk', unknownOwner: true }],
    ['unknown owner mirror alongside own FK', { link: 'fk', foreignLink: 'mirror', unknownOwner: true }],
    ['only a deleted customer lead', { link: 'both', deleted: true }],
    ['only a matching phone', { link: 'none' }],
    ['sent status without handoff', { link: 'fk', noHandoff: true }],
    ['handoff before call ended', { link: 'fk', beforeCallEnd: true }],
    ['handoff outside association window', { link: 'mirror', outsideWindow: true }],
    ['deleted foreign lead does not override live owner', { link: 'fk', foreignLink: 'mirror', deletedForeign: true, match: true }],
  ])('lead-linked estimate association: %s', async (_label, scenario) => {
    // Every trial rolls back all fixtures and refresh writes, including failures.
    const trx = await db.transaction();
    try {
      const sourceCall = await trx('call_log').where({ id: callId }).first();
      const [customer, foreignCustomer] = await trx('customers').insert([
        { first_name: 'SyntheticPrimary', phone: PHONE },
        { first_name: 'SyntheticOther', phone: '+15555550199' },
      ]).returning('id');
      // No call SID or metadata lead provenance: only customer -> lead -> quote.
      const call = { ...sourceCall, customer_id: customer.id, twilio_call_sid: null, metadata: {} };
      const [lead] = await trx('leads').insert({
        customer_id: customer.id, phone: PHONE, status: 'estimate_sent',
        deleted_at: scenario.deleted ? new Date() : null,
      }).returning('id');
      const [foreignLead] = await trx('leads').insert({
        customer_id: scenario.unknownOwner ? null : foreignCustomer.id,
        phone: PHONE, status: 'estimate_sent',
        deleted_at: scenario.deletedForeign ? new Date() : null,
      }).returning('id');
      const endedAt = cc.callEndedAt(call);
      const handedOffAt = new Date(endedAt.getTime() + (
        scenario.beforeCallEnd ? -1000 : scenario.outsideWindow
          ? (cc.ASSOCIATION_WINDOW_DAYS + 1) * 24 * 60 * 60 * 1000 : 60000
      ));
      const data = scenario.noHandoff ? {} : { deliveryState: { lastDeliveredAt: handedOffAt.toISOString() } };
      if (['mirror', 'both'].includes(scenario.link)) data.lead_id = lead.id;
      if (scenario.foreignLink === 'mirror') data.lead_id = foreignLead.id;
      const [estimate] = await trx('estimates').insert({
        status: 'sent', sent_at: handedOffAt, created_at: call.created_at,
        customer_id: scenario.foreignEstimate ? foreignCustomer.id : null,
        customer_phone: PHONE, estimate_data: JSON.stringify(data),
      }).returning('id');
      if (['fk', 'both'].includes(scenario.link)) await trx('leads').where({ id: lead.id }).update({ estimate_id: estimate.id });
      if (scenario.foreignLink === 'fk') await trx('leads').where({ id: foreignLead.id }).update({ estimate_id: estimate.id });
      const proof = await cc.resolveFulfillment(trx, { kind: 'send_estimate' }, call);
      if (scenario.match) {
        expect(proof).toMatchObject({ record_id: estimate.id, strength: 'association', matched_at: handedOffAt });
        const [commitment] = await trx('call_commitments').insert({
          call_log_id: call.id, commitment_key: 'waves:send_estimate:lead-hint',
          party: 'waves', kind: 'send_estimate', description: 'Send synthetic quote',
          status: 'open',
        }).returning('id');
        await cc.refreshFulfillment(trx, call.id, call);
        const refreshed = await trx('call_commitments').where({ id: commitment.id }).first();
        expect(refreshed.status).toBe('open');
        expect(refreshed.fulfilled_at).toBeNull();
        expect(refreshed.fulfillment).toMatchObject({ record_id: estimate.id, strength: 'association' });
        // The read-based association must not repair ownership as a side effect.
        expect((await trx('estimates').where({ id: estimate.id }).first('customer_id')).customer_id).toBeNull();
      } else {
        expect(proof).toBeNull();
      }
    } finally {
      await trx.rollback();
    }
  });

  test('fulfillment is measured from the END of the call: an estimate sent while the caller was still on the line is not proof of a promise made in that call', async () => {
    const call = await db('call_log').where({ id: callId }).first(); // inbound, 90 s long
    const midCall = new Date(call.created_at.getTime() + 30 * 1000);
    const [est] = await db('estimates').insert({ status: 'sent', sent_at: midCall, created_at: midCall, estimate_data: JSON.stringify({ deliveryState: { lastDeliveredAt: midCall.toISOString() } }) }).returning('id');
    const [lead] = await db('leads').insert({ phone: PHONE, twilio_call_sid: SID, estimate_id: est.id, status: 'estimate_sent' }).returning('id');
    try {
      expect(await cc.resolveFulfillment(db, { kind: 'send_estimate' }, call)).toBeNull();
      // Created mid-call (capture_lead's shape) but SENT after the call ended: direct proof.
      const afterEnd = new Date(call.created_at.getTime() + 120 * 1000);
      await db('estimates').where({ id: est.id }).update({ sent_at: afterEnd, estimate_data: JSON.stringify({ deliveryState: { lastDeliveredAt: afterEnd.toISOString() } }) });
      expect(await cc.resolveFulfillment(db, { kind: 'send_estimate' }, call)).toMatchObject({ kind: 'estimate_sent', record_id: est.id, strength: 'direct', matched_at: afterEnd });
    } finally {
      await db('leads').where({ id: lead.id }).del();
      await db('estimates').where({ id: est.id }).del();
    }
  });

  test('a relay call that REUSED a prospect lead (stamped relay_lead_id, the lead keeps its original SID) finds that lead\'s later estimate as a HINT, not direct proof (codex #3738 gh-r13 P1)', async () => {
    const call = await db('call_log').where({ id: callId }).first();
    const [est] = await db('estimates').insert({ status: 'sent', sent_at: new Date(Date.now() - 60 * 1000), created_at: new Date(Date.now() - 120 * 1000), estimate_data: handedOff() }).returning('id');
    const [lead] = await db('leads').insert({ phone: PHONE, twilio_call_sid: 'CA' + '8'.repeat(30) + 'x0', estimate_id: est.id, status: 'estimate_sent' }).returning('id');
    try {
      const relayCall = { ...call, twilio_call_sid: 'CA' + '8'.repeat(30) + 'x1', customer_id: null, metadata: JSON.stringify({ relay_lead_id: lead.id }) };
      expect(await cc.resolveFulfillment(db, { kind: 'send_estimate' }, relayCall)).toMatchObject({ kind: 'estimate_sent', record_id: est.id, strength: 'association', basis: 'estimate_sent_on_a_lead_reused_from_an_earlier_call' });
      expect(await cc.resolveFulfillment(db, { kind: 'send_estimate' }, { ...relayCall, metadata: JSON.stringify({}) })).toBeNull();
    } finally {
      await db('leads').where({ id: lead.id }).del();
      await db('estimates').where({ id: est.id }).del();
    }
  });

  test('the estimator provenance stamp is direct proof on its own; the public-quote mirror on a stamped lead that carries another call\'s SID is a reused-lead hint (codex #3738 gh-r13 P1)', async () => {
    const call = await db('call_log').where({ id: callId }).first();
    const sentAfter = { status: 'sent', sent_at: new Date(Date.now() - 60 * 1000), created_at: new Date(Date.now() - 120 * 1000) };
    const [stamped] = await db('estimates').insert({ ...sentAfter, estimate_data: handedOff(30, { estimatorEngine: { callLogId: call.id } }) }).returning('id');
    const [lead] = await db('leads').insert({ phone: PHONE, twilio_call_sid: 'CA' + '8'.repeat(30) + 'x2', status: 'new' }).returning('id');
    const [mirror] = await db('estimates').insert({ ...sentAfter, estimate_data: handedOff(30, { lead_id: lead.id }) }).returning('id');
    try {
      // Unlinked prospect: no customer, no lead stamp, no SID match — only the provenance stamp ties the estimate to this call.
      const unlinked = { ...call, customer_id: null, twilio_call_sid: 'CA' + '8'.repeat(30) + 'x3', metadata: JSON.stringify({}) };
      expect(await cc.resolveFulfillment(db, { kind: 'send_estimate' }, unlinked)).toMatchObject({ record_id: stamped.id, strength: 'direct' });
      await db('estimates').where({ id: stamped.id }).del();
      expect(await cc.resolveFulfillment(db, { kind: 'send_estimate' }, unlinked)).toBeNull();
      // The lead this call is stamped with never got leads.estimate_id; the estimate carries the lead in estimate_data.lead_id.
      // That lead carries ANOTHER call's SID (a reused lead): the mirror is a hint, not direct proof.
      expect(await cc.resolveFulfillment(db, { kind: 'send_estimate' }, { ...unlinked, metadata: JSON.stringify({ lead_id: lead.id }) })).toMatchObject({ record_id: mirror.id, strength: 'association', basis: 'estimate_sent_on_a_lead_reused_from_an_earlier_call' });
      // The same mirror on a lead THIS call minted (its SID) is direct.
      await db('leads').where({ id: lead.id }).update({ twilio_call_sid: unlinked.twilio_call_sid });
      expect(await cc.resolveFulfillment(db, { kind: 'send_estimate' }, { ...unlinked, metadata: JSON.stringify({ lead_id: lead.id }) })).toMatchObject({ record_id: mirror.id, strength: 'direct' });
    } finally {
      await db('estimates').whereIn('id', [stamped.id, mirror.id]).del();
      await db('leads').where({ id: lead.id }).del();
    }
  });

  test('directEstimatesSentAfter: every call behind leads that share one estimate gets the direct proof (Codex r8 P2)', async () => {
    const call = await db('call_log').where({ id: callId }).first();
    const sid2 = 'CA' + '8'.repeat(30) + 'z2';
    const [call2] = await db('call_log').insert({ twilio_call_sid: sid2, direction: 'inbound', from_phone: PHONE, to_phone: OUR_NUMBER, status: 'completed', duration_seconds: 90, created_at: call.created_at }).returning('id');
    cleanup.callIds.push(call2.id);
    const [est] = await db('estimates').insert({ status: 'sent', sent_at: new Date(Date.now() - 60 * 1000), created_at: new Date(Date.now() - 120 * 1000), estimate_data: handedOff() }).returning('id');
    const [leadA] = await db('leads').insert({ phone: PHONE, twilio_call_sid: SID, estimate_id: est.id, status: 'estimate_sent' }).returning('id');
    const [leadB] = await db('leads').insert({ phone: PHONE, twilio_call_sid: sid2, estimate_id: est.id, status: 'estimate_sent' }).returning('id');
    try {
      const after = new Date(call.created_at.getTime() + 90 * 1000);
      const out = await cc.directEstimatesSentAfter(db, [
        { key: 'a', callId: call.id, twilioCallSid: SID, callStartedAt: call.created_at, after },
        { key: 'b', callId: call2.id, twilioCallSid: sid2, callStartedAt: call.created_at, after },
      ]);
      expect(out.get('a')).toMatchObject({ record_id: est.id, strength: 'direct' });
      expect(out.get('b')).toMatchObject({ record_id: est.id, strength: 'direct' });
      // Owned by a customer neither (unlinked) call is linked to — the shape
      // a relink leaves behind — it is no longer either call's proof; the
      // call's own customer keeps it.
      const [stranger] = await db('customers').insert({ first_name: 'Stranger', phone: '+15555550199' }).returning('id');
      cleanup.customerIds.push(stranger.id);
      await db('estimates').where({ id: est.id }).update({ customer_id: stranger.id });
      const probes = [
        { key: 'a', callId: call.id, twilioCallSid: SID, callStartedAt: call.created_at, after },
        { key: 'b', callId: call2.id, twilioCallSid: sid2, callStartedAt: call.created_at, customerId: stranger.id, after },
      ];
      const owned = await cc.directEstimatesSentAfter(db, probes);
      expect(owned.get('a')).toBeUndefined();
      expect(owned.get('b')).toMatchObject({ record_id: est.id, strength: 'direct' });
    } finally {
      await db('leads').whereIn('id', [leadA.id, leadB.id]).del();
      await db('estimates').where({ id: est.id }).del();
    }
  });

  test('listOpenCommitments: overdue first, then soonest due, then oldest call; filters by customer and lead; hints optional', async () => {
    const call = await db('call_log').where({ id: callId }).first();
    const [cust] = await db('customers').insert({ first_name: 'Owed', phone: '+15555550188' }).returning('id');
    cleanup.customerIds.push(cust.id);
    const mk = async (sid, extra) => {
      const [c] = await db('call_log').insert({
        twilio_call_sid: sid, direction: 'inbound', from_phone: '+15555550188', to_phone: OUR_NUMBER, status: 'completed',
        customer_id: cust.id, ...extra,
      }).returning('id');
      cleanup.callIds.push(c.id);
      return c.id;
    };
    const oldCall = await mk('CA' + '8'.repeat(30) + 'q1', { created_at: new Date(Date.now() - 10 * 24 * 3600 * 1000), metadata: JSON.stringify({ lead_id: '11111111-2222-4333-8444-555555555555' }) });
    const newCall = await mk('CA' + '8'.repeat(30) + 'q2', { created_at: new Date(Date.now() - 1 * 24 * 3600 * 1000) });
    await cc.upsertCommitments(db, oldCall, [
      { party: 'waves', kind: 'send_report', description: 'implicit overdue (old call, no due)', evidence: [] },
    ], { generation: 1 });
    await cc.upsertCommitments(db, newCall, [
      { party: 'waves', kind: 'callback', description: 'due tomorrow', due_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(), evidence: [] },
      { party: 'waves', kind: 'send_estimate', description: 'stated overdue', due_at: new Date(Date.now() - 3600 * 1000).toISOString(), evidence: [] },
      { party: 'customer', kind: 'send_photos', description: 'customer side', evidence: [] },
    ], { generation: 1 });

    const waves = await cc.listOpenCommitments(db, { party: 'waves', customerId: cust.id });
    // Both overdue rows lead; between them the EARLIER effective deadline
    // (the report owed 3 days after a 10-day-old call) precedes the
    // estimate that fell due an hour ago.
    expect(waves.map((r) => r.description)).toEqual(['implicit overdue (old call, no due)', 'stated overdue', 'due tomorrow']);
    expect(waves.map((r) => r.overdue)).toEqual([true, true, false]);
    expect(waves[0]).toMatchObject({ customer_first_name: 'Owed', call_started_at: expect.any(Date) });
    const all = await cc.listOpenCommitments(db, { customerId: cust.id });
    expect(all).toHaveLength(4);
    const byLead = await cc.listOpenCommitments(db, { leadId: '11111111-2222-4333-8444-555555555555' });
    expect(byLead.map((r) => r.description)).toEqual(['implicit overdue (old call, no due)']);
    // A relay call that reused the lead is stamped relay_lead_id, not lead_id.
    const relayReuse = await mk('CA' + '8'.repeat(30) + 'q3', { metadata: JSON.stringify({ relay_lead_id: '11111111-2222-4333-8444-555555555555' }) });
    await cc.upsertCommitments(db, relayReuse, [{ party: 'waves', kind: 'callback', description: 'relay reuse', evidence: [] }], { generation: 1 });
    const byLeadWithRelay = await cc.listOpenCommitments(db, { leadId: '11111111-2222-4333-8444-555555555555' });
    expect(byLeadWithRelay.map((r) => r.description).sort()).toEqual(['implicit overdue (old call, no due)', 'relay reuse']);
    // The fixture call from the earlier tests is not this customer's.
    expect(all.some((r) => r.call_log_id === call.id)).toBe(false);
  });

  test('buildCallOutcomes: the paid total covers every later paid invoice, not just the capped list', async () => {
    const [cust] = await db('customers').insert({ first_name: 'Revenue', phone: '+15555550166' }).returning('id');
    cleanup.customerIds.push(cust.id);
    const [c] = await db('call_log').insert({ twilio_call_sid: 'CA' + '8'.repeat(30) + 'r1', direction: 'inbound', from_phone: '+15555550166', to_phone: OUR_NUMBER, status: 'completed', customer_id: cust.id, created_at: new Date(Date.now() - 3600 * 1000) }).returning('*');
    cleanup.callIds.push(c.id);
    const invoiceIds = [];
    try {
      for (let i = 0; i < 7; i += 1) {
        const [inv] = await db('invoices').insert({ customer_id: cust.id, token: 'fx-' + i + '-' + c.id.slice(0, 8), invoice_number: 'FX-' + c.id.slice(0, 6) + '-' + i, total: 10.5, status: 'paid', paid_at: new Date(), created_at: new Date(Date.now() - (60 - i) * 1000) }).returning('id');
        invoiceIds.push(inv.id);
      }
      // A booking that EXISTED before the call and was attached to it is labelled as such; one created after it was booked from it (codex gh-r16 P2).
      const [attached] = await db('scheduled_services').insert({ scheduled_date: '2026-09-12', service_type: 'General Pest Control', status: 'pending', source_call_log_id: c.id, customer_id: cust.id, created_at: new Date(Date.now() - 2 * 24 * 3600 * 1000) }).returning('id');
      const [booked] = await db('scheduled_services').insert({ scheduled_date: '2026-09-13', service_type: 'General Pest Control', status: 'pending', source_call_log_id: c.id, customer_id: cust.id, created_at: new Date(Date.now() - 60 * 1000) }).returning('id');
      cleanup.visitIds.push(attached.id, booked.id);
      const outcomes = await cc.buildCallOutcomes(db, c);
      expect(outcomes.invoices).toHaveLength(5);
      expect(outcomes.revenue_cents).toBe(7 * 1050);
      expect(outcomes.appointments.find((a) => a.id === attached.id).basis).toBe('existing_booking_attached_to_this_call');
      expect(outcomes.appointments.find((a) => a.id === booked.id).basis).toBe('booked_from_this_call');
    } finally {
      await db('invoices').whereIn('id', invoiceIds).del();
    }
  });

  test('relay commitments are owner-fenced in the write: a foreign claim owner refuses, the owning or unclaimed session records', async () => {
    const [relay] = await db('call_log').insert({
      twilio_call_sid: 'CA' + '8'.repeat(30) + 'd7', direction: 'inbound', from_phone: PHONE, to_phone: OUR_NUMBER, status: 'completed',
      processing_status: null, metadata: JSON.stringify({ relay_session_claim_owner: 'nonce-replacement' }),
    }).returning('id');
    cleanup.callIds.push(relay.id);
    const args = { callSid: 'CA' + '8'.repeat(30) + 'd7', transcript: 'Agent: Someone from the office will call you back tomorrow.\nCaller: Thanks.', estimateQueued: true };
    // The superseded session (its nonce is no longer the owner) writes nothing.
    expect(await cc.recordRelayCommitments(db, { ...args, sessionKey: 'nonce-old' })).toEqual({ found: 0, written: 0, superseded: true });
    expect(await db('call_commitments').where({ call_log_id: relay.id })).toHaveLength(0);
    // The owning session records.
    const owned = await cc.recordRelayCommitments(db, { ...args, sessionKey: 'nonce-replacement' });
    expect(owned.written).toBeGreaterThan(0);
    expect(owned.superseded).toBeUndefined();
    // An unclaimed row (no owner stamped) accepts an unverified session's own record.
    await db('call_commitments').where({ call_log_id: relay.id }).del();
    await db('call_log').where({ id: relay.id }).update({ metadata: JSON.stringify({}) });
    expect((await cc.recordRelayCommitments(db, { ...args, sessionKey: 'nonce-unverified' })).written).toBeGreaterThan(0);
  });

  test('a voice-agent SANDBOX call never records commitments — a test promise is not office work', async () => {
    const sid = 'CA' + '9'.repeat(30) + 'sb';
    const [sandbox] = await db('call_log').insert({
      twilio_call_sid: sid, direction: 'inbound', from_phone: PHONE, to_phone: OUR_NUMBER, status: 'completed',
      processing_status: null, source: 'voice_relay_sandbox', metadata: JSON.stringify({ relay_sandbox: true }),
    }).returning('id');
    cleanup.callIds.push(sandbox.id);
    const out = await cc.recordRelayCommitments(db, {
      callSid: sid, transcript: 'Agent: Someone from the office will call you back tomorrow.\nCaller: Thanks.', estimateQueued: true,
    });
    expect(out).toEqual({ found: 0, written: 0, sandbox: true });
    expect(await db('call_commitments').where({ call_log_id: sandbox.id })).toHaveLength(0);
  });

  test('an untouched AI row the latest pass withdrew leaves the queue; a human-confirmed one stays', async () => {
    const [c] = await db('call_log').insert({
      twilio_call_sid: 'CA' + '8'.repeat(30) + 'q9', direction: 'inbound', from_phone: PHONE, to_phone: OUR_NUMBER, status: 'completed',
      processing_status: 'processed', processing_token: null, processing_generation: 1,
    }).returning('id');
    cleanup.callIds.push(c.id);
    await cc.upsertCommitments(db, c.id, [
      { party: 'waves', kind: 'send_report', description: 'stale after reprocess', evidence: [] },
      { party: 'waves', kind: 'callback', description: 'confirmed by the office', evidence: [] },
    ], { generation: 1, procGeneration: 1 });
    const rows = await db('call_commitments').where({ call_log_id: c.id });
    await cc.applyHumanUpdate(db, rows.find((r) => r.kind === 'callback').id, { action: 'confirm', reviewedBy: 'office' });
    // A reprocess CLAIMS the row (processing_generation advances) and then
    // fails before recording commitments: nothing is stale — the last good
    // pass's promises stay live (r15).
    await db('call_log').where({ id: c.id }).update({ processing_generation: 2 });
    const afterClaim = await cc.listOpenCommitments(db, { party: 'waves', limit: 200 });
    expect(afterClaim.filter((r) => r.call_log_id === c.id).map((r) => r.description).sort()).toEqual(['confirmed by the office', 'stale after reprocess']);
    // The next pass COMPLETES and detects only a new promise: the untouched
    // send_report row is now stale; the human-confirmed callback stays.
    await db('call_log').where({ id: c.id }).update({ processing_generation: 3 });
    await cc.upsertCommitments(db, c.id, [
      { party: 'waves', kind: 'send_estimate', description: 'found on pass 3', evidence: [] },
    ], { generation: 3, procGeneration: 3 });
    const open = await cc.listOpenCommitments(db, { party: 'waves', limit: 200 });
    const mine = open.filter((r) => r.call_log_id === c.id).map((r) => r.description).sort();
    expect(mine).toEqual(['confirmed by the office', 'found on pass 3']);
  });

  test('an association hint the facts no longer support is cleared on refresh; a lookup error leaves it', async () => {
    const [c] = await db('call_log').insert({
      twilio_call_sid: 'CA' + '8'.repeat(30) + 'q8', direction: 'inbound', from_phone: '+15555550166', to_phone: OUR_NUMBER, status: 'completed',
      processing_status: 'processed', processing_token: null, processing_generation: 1, customer_id: null,
    }).returning('id');
    cleanup.callIds.push(c.id);
    await cc.upsertCommitments(db, c.id, [{ party: 'waves', kind: 'send_estimate', description: 'hinted', evidence: [] }], { generation: 1, procGeneration: 1 });
    const [row] = await db('call_commitments').where({ call_log_id: c.id });
    await db('call_commitments').where({ id: row.id }).update({ fulfillment: JSON.stringify({ kind: 'estimate_sent', strength: 'association', basis: 'estimate_sent_to_same_customer_within_14_days', record_id: '00000000-0000-4000-8000-000000000000' }) });
    // No customer on the call any more (relinked away): nothing resolves → the hint is cleared.
    const out = await cc.refreshFulfillment(db, c.id);
    expect(out).toMatchObject({ fulfilled: 0, hinted: 0, cleared: 1, failed: 0 });
    expect((await db('call_commitments').where({ id: row.id }).first()).fulfillment).toBeNull();
  });

  test('deleting the call cascades its commitments', async () => {
    const [scratch] = await db('call_log').insert({ twilio_call_sid: 'CA' + '8'.repeat(30) + 'd3', direction: 'inbound', from_phone: PHONE, to_phone: OUR_NUMBER, status: 'completed' }).returning('id');
    await cc.addHumanCommitment(db, scratch.id, { party: 'customer', kind: 'confirm_date', description: 'Confirm Friday' });
    await db('call_log').where({ id: scratch.id }).del();
    expect(await db('call_commitments').where({ call_log_id: scratch.id })).toHaveLength(0);
  });
});
