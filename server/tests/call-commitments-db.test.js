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

  test('a human-added commitment is its own row, confirmed, with no AI provenance', async () => {
    const row = await cc.addHumanCommitment(db, callId, { party: 'waves', kind: 'send_paperwork', description: 'Mail the WDO paperwork', reviewedBy: 'tech-fixture' });
    expect(row).toMatchObject({ source: 'human', human_state: 'confirmed', status: 'open', kind: 'send_paperwork', confidence: null });
    expect(row.commitment_key).toMatch(/^waves:send_paperwork:[a-z0-9-]+:h[0-9a-f]{6}$/);
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

  test('an estimate on a REUSED lead that was sent before the call is not this call\'s proof; one sent after it is direct proof', async () => {
    const call = await db('call_log').where({ id: callId }).first();
    const [est] = await db('estimates').insert({ status: 'sent', sent_at: new Date(call.created_at.getTime() - 3 * 24 * 60 * 60 * 1000) }).returning('id');
    const [lead] = await db('leads').insert({ phone: PHONE, twilio_call_sid: SID, estimate_id: est.id, status: 'estimate_sent' }).returning('id');
    try {
      expect(await cc.resolveFulfillment(db, { kind: 'send_estimate' }, call)).toBeNull();
      // Sent after the call but CREATED before it (an earlier call's draft): still not this call's proof.
      await db('estimates').where({ id: est.id }).update({ sent_at: new Date(Date.now() - 60 * 1000), created_at: new Date(call.created_at.getTime() - 3 * 24 * 60 * 60 * 1000) });
      expect(await cc.resolveFulfillment(db, { kind: 'send_estimate' }, call)).toBeNull();
      // Created and sent after the call: direct proof.
      await db('estimates').where({ id: est.id }).update({ created_at: new Date(Date.now() - 120 * 1000) });
      const proof = await cc.resolveFulfillment(db, { kind: 'send_estimate' }, call);
      expect(proof).toMatchObject({ kind: 'estimate_sent', record_id: est.id, strength: 'direct' });
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
      const outcomes = await cc.buildCallOutcomes(db, c);
      expect(outcomes.invoices).toHaveLength(5);
      expect(outcomes.revenue_cents).toBe(7 * 1050);
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
