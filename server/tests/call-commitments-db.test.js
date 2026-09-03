// Commitments on a real Postgres: the fenced upsert, human-correction
// preservation across a reprocess, fulfillment from later records, and the
// CHECK constraints the migration promises. Runs only with DATABASE_URL
// (CI's DB-gated step); fixtures are fictitious (555-01xx, fake SIDs).
const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const SID = 'CA' + '8'.repeat(30) + 'd1';
const PHONE = '+15555550177';
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
    // A completed outbound call to the caller AFTER this call: association
    // only (the callback row is human-dismissed, so it must stay dismissed).
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
    // The outbound-call proof resolves as an association for an open callback.
    const proof = await cc.resolveFulfillment(db, { kind: 'callback' }, call);
    expect(proof).toMatchObject({ kind: 'outbound_call', record_id: outbound.id, strength: 'association' });
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

  test('an estimate on a REUSED lead that was sent before the call is not this call\'s proof; one sent after it is direct proof', async () => {
    const call = await db('call_log').where({ id: callId }).first();
    const [est] = await db('estimates').insert({ status: 'sent', sent_at: new Date(call.created_at.getTime() - 3 * 24 * 60 * 60 * 1000) }).returning('id');
    const [lead] = await db('leads').insert({ phone: PHONE, twilio_call_sid: SID, estimate_id: est.id, status: 'estimate_sent' }).returning('id');
    try {
      expect(await cc.resolveFulfillment(db, { kind: 'send_estimate' }, call)).toBeNull();
      // Sent after the call but CREATED before it (an earlier call's draft): still not this call's proof.
      await db('estimates').where({ id: est.id }).update({ sent_at: new Date(Date.now() - 60 * 1000), created_at: new Date(call.created_at.getTime() - 3 * 24 * 60 * 60 * 1000) });
      expect(await cc.resolveFulfillment(db, { kind: 'send_estimate' }, call)).toBeNull();
      // Created and sent after the call STARTED but before it ENDED (created_at
      // is ring time; this call ran 90 s): still not this call's proof (codex gh-r13 P1).
      await db('estimates').where({ id: est.id }).update({ created_at: new Date(call.created_at.getTime() + 10 * 1000), sent_at: new Date(call.created_at.getTime() + 30 * 1000) });
      expect(await cc.resolveFulfillment(db, { kind: 'send_estimate' }, call)).toBeNull();
      // Created and sent after the call ended: direct proof.
      await db('estimates').where({ id: est.id }).update({ created_at: new Date(Date.now() - 120 * 1000), sent_at: new Date(Date.now() - 60 * 1000) });
      // …unless it is a report/plan-restart mint whose sent_at is the
      // publish-without-delivery stamp: only a real handoff witness
      // (deliveryState.lastDeliveredAt after the call) counts (#3725 r13 P1 class).
      await db('estimates').where({ id: est.id }).update({ source: 'service_report_cta', estimate_data: JSON.stringify({}) });
      expect(await cc.resolveFulfillment(db, { kind: 'send_estimate' }, call)).toBeNull();
      await db('estimates').where({ id: est.id }).update({ estimate_data: JSON.stringify({ deliveryState: { lastDeliveredAt: new Date(Date.now() - 30 * 1000).toISOString() } }) });
      expect(await cc.resolveFulfillment(db, { kind: 'send_estimate' }, call)).toMatchObject({ kind: 'estimate_sent', record_id: est.id, strength: 'direct' });
      await db('estimates').where({ id: est.id }).update({ source: null, estimate_data: null });
      const proof = await cc.resolveFulfillment(db, { kind: 'send_estimate' }, call);
      expect(proof).toMatchObject({ kind: 'estimate_sent', record_id: est.id, strength: 'direct' });
      // The same lead reached only through the metadata.lead_id STAMP by a
      // call with a different SID is a REUSED lead: its estimate is a hint,
      // not direct proof (codex gh-r13 P1). The estimator's own callLogId
      // stamp on the estimate is explicit provenance and stays direct.
      const reusing = { ...call, twilio_call_sid: 'CA' + '9'.repeat(30) + 'd2', metadata: JSON.stringify({ lead_id: lead.id }) };
      expect(await cc.resolveFulfillment(db, { kind: 'send_estimate' }, reusing)).toMatchObject({ record_id: est.id, strength: 'association', basis: 'estimate_sent_on_a_lead_reused_from_an_earlier_call' });
      await db('estimates').where({ id: est.id }).update({ estimate_data: JSON.stringify({ estimatorEngine: { callLogId: call.id } }) });
      expect(await cc.resolveFulfillment(db, { kind: 'send_estimate' }, reusing)).toMatchObject({ record_id: est.id, strength: 'direct', basis: 'estimate_stamped_with_this_call' });
    } finally {
      await db('leads').where({ id: lead.id }).del();
      await db('estimates').where({ id: est.id }).del();
    }
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

  test('deleting the call cascades its commitments', async () => {
    const [scratch] = await db('call_log').insert({ twilio_call_sid: 'CA' + '8'.repeat(30) + 'd3', direction: 'inbound', from_phone: PHONE, to_phone: OUR_NUMBER, status: 'completed' }).returning('id');
    await cc.addHumanCommitment(db, scratch.id, { party: 'customer', kind: 'confirm_date', description: 'Confirm Friday' });
    await db('call_log').where({ id: scratch.id }).del();
    expect(await db('call_commitments').where({ call_log_id: scratch.id })).toHaveLength(0);
  });
});
