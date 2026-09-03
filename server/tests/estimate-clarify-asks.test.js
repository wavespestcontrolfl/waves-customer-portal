/**
 * Ask-the-customer loop (GATE_ESTIMATE_CLARIFY_ASKS).
 *
 * Pins: the gate (fail-closed), the askable-missing filter ('phone' and
 * free-text uncertainties never ask), the usable-phone requirement, the
 * phone-scoped open/recent dedupe, the draft insert shape (intent
 * 'estimate_clarify', status pending, NO campaign_type so the campaign
 * guard skips, flags.toPhone for lead-only recipients), the deterministic
 * copy variants, and that a bell failure never unparks the draft.
 */

let mockState;
jest.mock('../models/db', () => {
  const makeBuilder = (table) => {
    const builder = {
      where() { return builder; },
      whereIn() { return builder; },
      whereNot() { return builder; },
      whereNull() { return builder; },
      whereNotNull() { return builder; },
      orWhere() { return builder; },
      orderBy() { return builder; },
      orderByRaw() { return builder; },
      whereRaw(sql, params) { mockState.raws.push({ sql: String(sql), params }); return builder; },
      forUpdate() { return builder; },
      modify(fn) { fn(builder); return builder; },
      first: async () => {
        mockState.firsts.push(table);
        const v = mockState.firstQueue.length ? mockState.firstQueue.shift() : mockState.existingDraft;
        if (v instanceof Error) throw v;
        return v;
      },
      select: async () => {
        mockState.selects.push(table);
        return mockState.selectQueue && mockState.selectQueue.length ? mockState.selectQueue.shift() : [];
      },
      update: async (payload) => {
        mockState.updates.push({ table, payload });
        return mockState.updateResults.length ? mockState.updateResults.shift() : 1;
      },
      insert: (payload) => ({
        returning: async () => {
          if (mockState.insertError) throw mockState.insertError;
          mockState.inserts.push(payload);
          return [{ id: 'draft-1' }];
        },
      }),
    };
    return builder;
  };
  const dbMock = jest.fn((table) => makeBuilder(table));
  // withClarifyLock: transaction executor doubles as the query builder; the
  // advisory-lock raw() is a no-op here.
  const trx = Object.assign((table) => makeBuilder(table), {
    raw: (sql, params) => {
      mockState.raws.push({ sql: String(sql), params });
      if (/pg_advisory_xact_lock/.test(String(sql))) { mockState.locks.push(params); return Promise.resolve({}); }
      return { __raw: String(sql), params };
    },
  });
  dbMock.transaction = async (callback) => callback(trx);
  dbMock.raw = (sql, params) => { mockState.raws.push({ sql: String(sql), params }); return { __raw: String(sql), params }; };
  return dbMock;
});
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const mockIsEnabled = jest.fn();
jest.mock('../config/feature-gates', () => ({
  isEnabled: (key) => mockIsEnabled(key),
}));


const mockNotifyAdmin = jest.fn();
jest.mock('../services/notification-service', () => ({
  notifyAdmin: (...args) => mockNotifyAdmin(...args),
}));

const mockStartSmsThreadDraft = jest.fn();
const mockSmsThreadDraftsEnabled = jest.fn();
const mockMaybeDraftEstimateForCall = jest.fn();
const mockEstimatorEngineEnabled = jest.fn(() => true);
jest.mock('../services/estimator-engine', () => ({
  estimatorEngineEnabled: (...a) => mockEstimatorEngineEnabled(...a),
  maybeDraftEstimateForCall: (...a) => mockMaybeDraftEstimateForCall(...a),
}));
jest.mock('../services/estimator-engine/sms-thread', () => ({
  smsThreadDraftsEnabled: () => mockSmsThreadDraftsEnabled(),
  startSmsThreadDraft: (...args) => mockStartSmsThreadDraft(...args),
}));

// Service replies are classifier-gated; the regex leg of the real
// classifier accepts obvious service words and rejects chit-chat.
jest.mock('../services/sms-service-intent', () => ({
  classifyServiceIntent: async (text) => (/pest|lawn|mosquito|termite/i.test(String(text))
    ? { interest: 'pest', confidence: 0.9, method: 'regex' }
    : null),
}));

// Keeps the dispatch-decision tests deterministic without loading the real
// lead-estimate-automation module graph.
jest.mock('../services/lead-estimate-automation', () => ({
  hasConcreteServiceInterest: (value) => ['pest', 'lawn', 'mosquito', 'termite'].includes(String(value || '')),
}));

// Write-back lane: the canonical property functions are exercised by their
// own suites; here we pin WHEN they are called and with what.
const mockRecordCallProperty = jest.fn();
const mockSyncPrimaryAddress = jest.fn();
const mockEnsurePrimaryProperty = jest.fn();
jest.mock('../services/customer-properties', () => ({
  recordCallProperty: (...a) => mockRecordCallProperty(...a),
  syncPrimaryAddress: (...a) => mockSyncPrimaryAddress(...a),
  ensurePrimaryProperty: (...a) => mockEnsurePrimaryProperty(...a),
}));
const mockEnqueueCallPropertyLookup = jest.fn();
jest.mock('../services/call-property-lookup', () => ({
  enqueueCallPropertyLookup: (...a) => mockEnqueueCallPropertyLookup(...a),
}));

const {
  parkClarifyAsk,
  handleClarifyReply,
  recordClarifyAnswer,
  claimClarifyDispatch,
  clarifyPreDispatchCheck,
  reopenClarifyAfterFailedSend,
  clarifyAsksEnabled,
  _private,
} = require('../services/estimate-clarify-asks');

beforeEach(() => {
  jest.clearAllMocks();
  mockState = { existingDraft: null, firstQueue: [], selectQueue: [], inserts: [], updates: [], updateResults: [], locks: [], raws: [], firsts: [], selects: [] };
  mockRecordCallProperty.mockReset().mockResolvedValue({ created: true, propertyId: 'prop-1' });
  mockSyncPrimaryAddress.mockReset().mockResolvedValue(undefined);
  mockEnsurePrimaryProperty.mockReset().mockResolvedValue({ created: false, propertyId: 'prop-primary' });
  mockIsEnabled.mockImplementation((key) => key === 'estimateClarifyAsks');
  mockNotifyAdmin.mockResolvedValue({ id: 'bell-1' });
});

describe('clarifyAsksEnabled', () => {
  test('reads the estimateClarifyAsks gate', () => {
    expect(clarifyAsksEnabled()).toBe(true);
    mockIsEnabled.mockReturnValue(false);
    expect(clarifyAsksEnabled()).toBe(false);
  });
});

describe('parkClarifyAsk', () => {
  const BASE = {
    missing: ['street_address'],
    phone: '(941) 555-0142',
    firstName: 'Pat',
    leadId: 'lead-1',
    source: 'estimator_engine_red',
  };

  test('gate off parks nothing', async () => {
    mockIsEnabled.mockReturnValue(false);
    const result = await parkClarifyAsk(BASE);
    expect(result).toEqual({ parked: false, skipped: 'gate_off' });
    expect(mockState.inserts).toHaveLength(0);
  });

  test('unaskable missing items park nothing — phone cannot be asked for by SMS', async () => {
    const result = await parkClarifyAsk({ ...BASE, missing: ['phone'] });
    expect(result.skipped).toBe('nothing_askable');
    expect(mockState.inserts).toHaveLength(0);
  });

  test('only real US destinations queue — 10 digits or 11 with leading 1, nothing else', async () => {
    // Shorter fragments, extension suffixes, and non-US lengths all fail at
    // Twilio AFTER the owner approved — reject at park time instead.
    for (const bad of ['555-01', '941555', '9415550142 ext 9', '+44 20 7946 0958', '', null]) {
      const result = await parkClarifyAsk({ ...BASE, phone: bad });
      expect(result.skipped).toBe('no_usable_phone');
    }
    expect(mockState.inserts).toHaveLength(0);

    const ok = await parkClarifyAsk({ ...BASE, phone: '+1 (941) 555-0142' });
    expect(ok.parked).toBe(true);
    expect(JSON.parse(mockState.inserts[0].flags).toPhone).toBe('+19415550142');
  });

  test('a unique-index conflict is a fail-soft anomaly, never a bell', async () => {
    // The clarify lock serializes every producer, so the partial unique
    // index can only fire for an out-of-band writer — the transaction
    // rolls back into the fail-soft catch and the standing draft covers
    // the phone.
    mockState.insertError = Object.assign(new Error('duplicate key'), { code: '23505' });
    const result = await parkClarifyAsk(BASE);
    expect(result.parked).toBe(false);
    expect(result.skipped).toMatch(/^error:/);
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  test('a recently sent clarify dedupes without touching the row', async () => {
    mockState.existingDraft = {
      id: 'draft-0',
      status: 'sent',
      flags: JSON.stringify({ missing: ['street_address'] }),
    };
    const result = await parkClarifyAsk(BASE);
    expect(result).toEqual({ parked: false, skipped: 'open_or_recent_clarify', draftId: 'draft-0', covers: ['street_address'] });
    expect(mockState.inserts).toHaveLength(0);
    expect(mockState.updates).toHaveLength(0);
  });

  test('the cooldown yields when a partially answered ask leaves this item unanswered', async () => {
    // Address answered, service still open: the resumed pipeline's re-ask
    // for the remainder must not be silenced for seven days.
    mockState.existingDraft = {
      id: 'draft-0',
      status: 'sent',
      flags: JSON.stringify({ missing: ['specific_service'], answer_recorded: ['street_address'] }),
    };
    const result = await parkClarifyAsk({ ...BASE, missing: ['specific_service'] });
    expect(result.parked).toBe(true);
    expect(mockState.inserts).toHaveLength(1);
  });

  test('a same-items pending dedupe still refreshes linkage to the newest request', async () => {
    // The old request's closed lead must not kill a question the NEW
    // request still needs — every pending dedupe hit rewrites linkage.
    mockState.existingDraft = {
      id: 'draft-0',
      status: 'pending',
      flags: JSON.stringify({ missing: ['street_address'], lead_id: 'old-lead' }),
    };
    const result = await parkClarifyAsk({ ...BASE, channelProvenance: 'sms' });
    expect(result).toEqual({ parked: false, skipped: 'merged_into_open_clarify', draftId: 'draft-0', covers: ['street_address'] });
    const flags = JSON.parse(mockState.updates[0].payload.flags);
    expect(flags.missing).toEqual(['street_address']);
    expect(flags.lead_id).toBe('lead-1');
    expect(flags.channel_provenance).toBe('sms');
  });


  test('a new missing item MERGES into the open pending draft instead of being discarded', async () => {
    // Service-only draft open, address-only request arrives: dropping it
    // would leave the address never asked once service resolves.
    mockState.existingDraft = {
      id: 'draft-0',
      status: 'pending',
      flags: JSON.stringify({ missing: ['specific_service'], toPhone: '+19415550142' }),
    };
    const result = await parkClarifyAsk({ ...BASE, channelProvenance: 'voice' });
    expect(result).toEqual({ parked: false, skipped: 'merged_into_open_clarify', draftId: 'draft-0', covers: ['specific_service', 'street_address'] });
    expect(mockState.inserts).toHaveLength(0);
    const update = mockState.updates[0].payload;
    const flags = JSON.parse(update.flags);
    expect(flags.missing.sort()).toEqual(['specific_service', 'street_address']);
    // The newest request owns the linkage the approval guard judges by.
    expect(flags.lead_id).toBe('lead-1');
    expect(flags.source).toBe('estimator_engine_red');
    expect(flags.channel_provenance).toBe('voice');
    expect(update.draft_response).toContain('service address');
    expect(update.draft_response).toContain('which service');
  });

  test('claimed (approved) drafts are never rewritten by a merge', async () => {
    mockState.existingDraft = {
      id: 'draft-0',
      status: 'approved',
      flags: JSON.stringify({ missing: ['specific_service'] }),
    };
    const result = await parkClarifyAsk(BASE);
    expect(result.skipped).toBe('open_or_recent_clarify');
    expect(mockState.updates).toHaveLength(0);
  });

  test('parks a pending estimate_clarify draft with lead-only recipient in flags', async () => {
    const result = await parkClarifyAsk({ ...BASE, missing: ['street_address', 'specific_service', 'phone'] });
    expect(result.parked).toBe(true);
    expect(mockNotifyAdmin).toHaveBeenCalledWith(
      'lead',
      expect.stringContaining('Clarifying question drafted'),
      expect.any(String),
      expect.objectContaining({ link: '/admin/communications' }),
    );
    const insert = mockState.inserts[0];
    expect(insert.intent).toBe('estimate_clarify');
    expect(insert.status).toBe('pending');
    expect(insert.source_ref).toBe('clarify:9415550142');
    // NO campaign_type: guardCampaignSend must skip these drafts entirely.
    expect(insert.campaign_type).toBeUndefined();
    expect(insert.customer_id).toBeNull();
    const flags = JSON.parse(insert.flags);
    expect(flags.toPhone).toBe('+19415550142');
    expect(flags.missing).toEqual(['street_address', 'specific_service']);
    expect(flags.lead_id).toBe('lead-1');
    expect(insert.draft_response).toContain('Waves Pest Control');
    expect(insert.draft_response).toContain('service address');
    expect(insert.draft_response).toContain('which service');
  });

  test('a bell failure never unparks the draft', async () => {
    mockNotifyAdmin.mockRejectedValueOnce(new Error('notifications down'));
    const result = await parkClarifyAsk(BASE);
    expect(result.parked).toBe(true);
    expect(mockState.inserts).toHaveLength(1);
  });
});

describe('handleClarifyReply', () => {
  const AWAITING = (missing, extra = {}) => ({
    id: 'sent-1',
    customer_id: null,
    sent_at: '2026-07-18T12:00:00Z',
    flags: JSON.stringify({ missing, lead_id: 'lead-1', ...extra }),
  });

  beforeEach(() => {
    mockSmsThreadDraftsEnabled.mockReturnValue(true);
    mockStartSmsThreadDraft.mockResolvedValue({ started: true });
  });

  test('no awaiting clarify — not handled, nothing touched', async () => {
    const result = await handleClarifyReply({ phone: '+19415550142', body: '123 Main St' });
    expect(result.handled).toBe(false);
    expect(mockState.updates).toHaveLength(0);
    expect(mockStartSmsThreadDraft).not.toHaveBeenCalled();
  });

  test('an address-only reply records onto the lead and resumes with gate + cooldown bypassed', async () => {
    mockState.existingDraft = AWAITING(['street_address']);
    const result = await handleClarifyReply({ phone: '+19415550142', body: "It's 123 Main St, Sarasota" });
    expect(result.handled).toBe(true);
    const leadUpdate = mockState.updates.find((u) => u.table === 'leads');
    expect(leadUpdate.payload.address).toBe('123 Main St, Sarasota');
    const bookkeeping = mockState.updates.find((u) => u.table === 'message_drafts');
    expect(JSON.parse(bookkeeping.payload.flags).answer_recorded).toEqual(['street_address']);
    expect(mockStartSmsThreadDraft).toHaveBeenCalledWith(expect.objectContaining({
      skipIntentGate: true,
      skipCooldown: true,
    }));
  });

  test('a combined reply to a both-items ask records address AND service', async () => {
    mockState.existingDraft = AWAITING(['street_address', 'specific_service']);
    const result = await handleClarifyReply({ phone: '9415550142', body: 'Quarterly pest control, 123 Main St, Sarasota' });
    expect(result.handled).toBe(true);
    const leadUpdates = mockState.updates.filter((u) => u.table === 'leads');
    expect(leadUpdates.some((u) => u.payload.address === '123 Main St, Sarasota')).toBe(true);
    expect(leadUpdates.some((u) => u.payload.service_interest === 'Quarterly pest control')).toBe(true);
  });

  test('an unrecognizable reply is not handled — the normal inbox flow owns it', async () => {
    mockState.existingDraft = AWAITING(['street_address']);
    const result = await handleClarifyReply({ phone: '9415550142', body: 'ok thanks' });
    expect(result.handled).toBe(false);
    expect(mockState.updates).toHaveLength(0);
  });

  test('a partial answer keeps the ask alive for the remaining item', async () => {
    mockState.existingDraft = AWAITING(['street_address', 'specific_service']);
    const result = await handleClarifyReply({ phone: '9415550142', body: '123 Main St, Sarasota' });
    expect(result.handled).toBe(true);
    const bookkeeping = mockState.updates.find((u) => u.table === 'message_drafts');
    const flags = JSON.parse(bookkeeping.payload.flags);
    expect(flags.missing).toEqual(['specific_service']);
    expect(flags.answer_recorded).toEqual(['street_address']);
    expect(flags.answered_at).toBeUndefined();
  });

  test('an admin claim winning mid-transaction never loses the reply — stamp-only fallback', async () => {
    // Locked read saw 'pending'; the UNLOCKED route claim flipped it to
    // 'approved' before the status-conditional retire — the fallback must
    // stamp the flags so the dispatch decision (same lock) sees the answer.
    // Lead-less on purpose: with no CRM row updated, the flags stamp is the
    // ONLY record of the answer.
    mockState.existingDraft = {
      id: 'pending-1',
      customer_id: null,
      status: 'pending',
      sent_at: null,
      flags: JSON.stringify({ missing: ['specific_service'] }),
    };
    mockState.updateResults = [0]; // conditional pending-branch write loses
    const result = await handleClarifyReply({ phone: '9415550142', body: 'mosquito treatment please' });
    expect(result.handled).toBe(true);
    const draftWrites = mockState.updates.filter((u) => u.table === 'message_drafts');
    expect(draftWrites).toHaveLength(2);
    const fallback = draftWrites[1].payload;
    expect(fallback.status).toBeUndefined();
    expect(fallback.draft_response).toBeUndefined();
    const flags = JSON.parse(fallback.flags);
    expect(flags.answer_recorded).toEqual(['specific_service']);
    expect(flags.answered_at).toBeTruthy();
    // Copy untouched on a claimed row → the mismatch must be marked so the
    // dispatch decision recomposes instead of sending the old text.
    expect(flags.copy_stale).toBe(true);
  });

  test('chit-chat never records as the service — the classifier is the bar', async () => {
    mockState.existingDraft = AWAITING(['specific_service']);
    const result = await handleClarifyReply({ phone: '9415550142', body: 'thanks, sounds good' });
    expect(result.handled).toBe(false);
    expect(mockState.updates).toHaveLength(0);
  });

  test('a fully answered ask is stamped consumed', async () => {
    mockState.existingDraft = AWAITING(['street_address']);
    await handleClarifyReply({ phone: '9415550142', body: '123 Main St, Sarasota' });
    const bookkeeping = mockState.updates.find((u) => u.table === 'message_drafts');
    const flags = JSON.parse(bookkeeping.payload.flags);
    expect(flags.missing).toEqual([]);
    expect(flags.answered_at).toBeTruthy();
  });

  test('SMS engine lane off: the answer is still recorded, no resume fires', async () => {
    mockSmsThreadDraftsEnabled.mockReturnValue(false);
    mockState.existingDraft = AWAITING(['street_address']);
    const result = await handleClarifyReply({ phone: '9415550142', body: '123 Main St, Sarasota' });
    expect(result.handled).toBe(true);
    expect(mockState.updates.find((u) => u.table === 'leads')).toBeTruthy();
    expect(mockStartSmsThreadDraft).not.toHaveBeenCalled();
  });

  test('clarify gate off — replies flow through untouched', async () => {
    mockIsEnabled.mockReturnValue(false);
    mockState.existingDraft = AWAITING(['street_address']);
    const result = await handleClarifyReply({ phone: '9415550142', body: '123 Main St' });
    expect(result.handled).toBe(false);
  });
});

describe('recordClarifyAnswer', () => {
  test('stamps a sent ask when another flow captured the item', async () => {
    mockState.existingDraft = {
      id: 'sent-1',
      sent_at: '2026-07-18T12:00:00Z',
      flags: JSON.stringify({ missing: ['street_address', 'specific_service'] }),
    };
    const result = await recordClarifyAnswer({ phone: '9415550142', items: ['street_address'] });
    expect(result.recorded).toBe(true);
    const flags = JSON.parse(mockState.updates[0].payload.flags);
    expect(flags.missing).toEqual(['specific_service']);
    expect(flags.answer_recorded).toEqual(['street_address']);
    expect(flags.answered_at).toBeUndefined();
  });

  test('a PENDING ask fully answered through another flow is retired, never sent', async () => {
    mockState.existingDraft = {
      id: 'pending-1',
      status: 'pending',
      sent_at: null,
      flags: JSON.stringify({ missing: ['specific_service'] }),
    };
    const result = await recordClarifyAnswer({ phone: '9415550142', items: ['specific_service'] });
    expect(result.recorded).toBe(true);
    const update = mockState.updates[0].payload;
    expect(update.status).toBe('rejected');
    expect(JSON.parse(update.flags).answered_at).toBeTruthy();
  });

  test('a PENDING both-items ask partially answered rewrites down to the remainder', async () => {
    mockState.existingDraft = {
      id: 'pending-1',
      status: 'pending',
      sent_at: null,
      flags: JSON.stringify({ missing: ['street_address', 'specific_service'] }),
    };
    const result = await recordClarifyAnswer({ phone: '9415550142', items: ['specific_service'] });
    expect(result.recorded).toBe(true);
    const update = mockState.updates[0].payload;
    expect(update.status).toBeUndefined();
    expect(update.draft_response).toContain('service address');
    expect(update.draft_response).not.toContain('which service');
    expect(JSON.parse(update.flags).missing).toEqual(['street_address']);
  });

  test('an admin claim winning mid-transaction never loses the answer — stamp-only fallback', async () => {
    // The reply's locked read saw 'pending', but the UNLOCKED route claim
    // flipped it to 'approved' first: the status-conditional rewrite matches
    // zero rows and MUST fall back to a flags-only stamp so the dispatch
    // decision (under the same lock) still sees the answer.
    mockState.existingDraft = {
      id: 'pending-1',
      status: 'pending',
      sent_at: null,
      flags: JSON.stringify({ missing: ['specific_service'] }),
    };
    mockState.updateResults = [0]; // conditional pending-branch write loses
    const result = await recordClarifyAnswer({ phone: '9415550142', items: ['specific_service'] });
    expect(result.recorded).toBe(true);
    expect(mockState.updates).toHaveLength(2);
    const fallback = mockState.updates[1].payload;
    expect(fallback.status).toBeUndefined();
    expect(fallback.draft_response).toBeUndefined();
    const fallbackFlags = JSON.parse(fallback.flags);
    expect(fallbackFlags.answered_at).toBeTruthy();
    expect(fallbackFlags.copy_stale).toBe(true);
  });

  test('a CLAIMED-unsent ask (mid-approval) records stamp-only — copy and status untouched', async () => {
    // Lead intake captures the item after the route claim but before the
    // dispatch decision: the bookkeeping must land so the decision's locked
    // re-read (which runs after this commit) rewrites or retires the
    // question instead of sending it stale.
    mockState.existingDraft = {
      id: 'claimed-1',
      status: 'approved',
      sent_at: null,
      flags: JSON.stringify({ missing: ['street_address', 'specific_service'] }),
    };
    const result = await recordClarifyAnswer({ phone: '9415550142', items: ['street_address'] });
    expect(result.recorded).toBe(true);
    const update = mockState.updates[0].payload;
    expect(update.status).toBeUndefined();
    expect(update.draft_response).toBeUndefined();
    const flags = JSON.parse(update.flags);
    expect(flags.missing).toEqual(['specific_service']);
    expect(flags.answer_recorded).toEqual(['street_address']);
    expect(flags.copy_stale).toBe(true);
  });

  test('irrelevant items or no awaiting ask record nothing', async () => {
    expect((await recordClarifyAnswer({ phone: '9415550142', items: ['street_address'] })).recorded).toBe(false);
    mockState.existingDraft = {
      id: 'sent-1',
      sent_at: '2026-07-18T12:00:00Z',
      flags: JSON.stringify({ missing: ['specific_service'] }),
    };
    expect((await recordClarifyAnswer({ phone: '9415550142', items: ['street_address'] })).recorded).toBe(false);
    expect(mockState.updates).toHaveLength(0);
  });
});

describe('claimClarifyDispatch', () => {
  const DRAFT = { id: 'draft-1', source_ref: 'clarify:9415550142' };
  const freshRow = (overrides = {}, flags = {}) => ({
    id: 'draft-1',
    source_ref: 'clarify:9415550142',
    customer_id: null,
    status: 'approved',
    sent_at: null,
    draft_response: 'Original question?',
    final_response: null,
    flags: JSON.stringify({ missing: ['street_address'], toPhone: '+19415550142', ...flags }),
    ...overrides,
  });

  test('sendable as-is: atomically re-verifies the claim and returns the stored copy — sent_at stays provider-confirmed', async () => {
    mockState.firstQueue = [freshRow()];
    const verdict = await claimClarifyDispatch({ draft: DRAFT });
    expect(verdict.outcome).toBe('send');
    expect(verdict.body).toBe('Original question?');
    expect(verdict.flags.missing).toEqual(['street_address']);
    expect(mockState.updates).toHaveLength(1);
    expect(mockState.updates[0].table).toBe('message_drafts');
    // The claim-conditional write must never pre-stamp sent_at — a crash
    // before the provider call would otherwise read as delivered.
    expect(mockState.updates[0].payload).toEqual({ approved_at: expect.any(Date) });
  });

  test('an ask consumed mid-claim (reply stamped answered_at) retires instead of sending', async () => {
    mockState.firstQueue = [freshRow({}, { missing: [], answered_at: '2026-07-19T00:00:00Z' })];
    const verdict = await claimClarifyDispatch({ draft: DRAFT });
    expect(verdict.outcome).toBe('retired');
    expect(verdict.message).toContain('already provided');
    expect(mockState.updates).toEqual([
      { table: 'message_drafts', payload: { status: 'rejected' } },
    ]);
  });

  test('a provider-confirmed sent row never dispatches twice — and is never relabeled rejected', async () => {
    mockState.firstQueue = [freshRow({ sent_at: new Date() })];
    const verdict = await claimClarifyDispatch({ draft: DRAFT });
    expect(verdict.outcome).toBe('retired');
    expect(verdict.message).toContain('already dispatched');
    expect(mockState.updates).toHaveLength(0);
  });

  test('partial answer in CRM state rewrites the copy to the remainder before dispatch', async () => {
    mockState.firstQueue = [
      freshRow({}, { missing: ['street_address', 'specific_service'], lead_id: 'lead-1' }),
      { id: 'lead-1', status: 'new', address: '123 Main St', service_interest: null, first_name: 'Pat' },
    ];
    const verdict = await claimClarifyDispatch({ draft: DRAFT });
    expect(verdict.outcome).toBe('send');
    const expected = _private.composeClarifyBody({ missing: ['specific_service'], firstName: 'Pat' });
    expect(verdict.body).toBe(expected);
    expect(verdict.flags.missing).toEqual(['specific_service']);
    const payload = mockState.updates[0].payload;
    expect(payload.draft_response).toBe(expected);
    expect(payload.sent_at).toBeUndefined();
    expect(JSON.parse(payload.flags).missing).toEqual(['specific_service']);
  });

  test('partial answer on a REVISION rewrites, releases the claim in the same conditional write, and never dispatches', async () => {
    mockState.firstQueue = [
      freshRow({}, { missing: ['street_address', 'specific_service'], lead_id: 'lead-1' }),
      { id: 'lead-1', status: 'new', address: '123 Main St', service_interest: null, first_name: 'Pat' },
    ];
    const verdict = await claimClarifyDispatch({
      draft: DRAFT,
      isRevision: true,
      releaseFields: { revised_response: null, final_response: null },
    });
    expect(verdict.outcome).toBe('rewritten');
    expect(mockState.updates).toHaveLength(1);
    const payload = mockState.updates[0].payload;
    expect(payload.sent_at).toBeUndefined();
    expect(payload.draft_response)
      .toBe(_private.composeClarifyBody({ missing: ['specific_service'], firstName: 'Pat' }));
    // The claim release rides the SAME status-conditional write — a separate
    // unconditional release could resurrect a concurrent reject.
    expect(payload.status).toBe('pending');
    expect(payload.approved_by).toBeNull();
    expect(payload.revised_response).toBeNull();
    expect(payload.final_response).toBeNull();
  });

  test('a closed lead retires the draft', async () => {
    mockState.firstQueue = [
      freshRow({}, { lead_id: 'lead-1' }),
      { id: 'lead-1', status: 'unresponsive', address: null, service_interest: null },
    ];
    const verdict = await claimClarifyDispatch({ draft: DRAFT });
    expect(verdict.outcome).toBe('retired');
    expect(verdict.message).toContain('lead is closed');
  });

  test('a linked estimate that moved past draft retires the draft', async () => {
    mockState.firstQueue = [
      freshRow({}, { estimate_id: 'est-1' }),
      { id: 'est-1', status: 'sent', sent_at: '2026-07-18T00:00:00Z', address: null },
    ];
    const verdict = await claimClarifyDispatch({ draft: DRAFT });
    expect(verdict.outcome).toBe('retired');
    expect(verdict.message).toContain('moved past draft');
  });

  test('an unparseable source_ref fails closed without writing anything', async () => {
    const verdict = await claimClarifyDispatch({ draft: { id: 'draft-1', source_ref: 'not-a-clarify-ref' } });
    expect(verdict.outcome).toBe('error');
    expect(mockState.updates).toHaveLength(0);
  });

  test('copy_stale (stamp-only writer shrank the ask) forces a recompose even when CRM shows nothing new', async () => {
    // A reply answered street_address while the row was claimed: missing is
    // already shrunk, the stored copy still asks both questions, and the
    // customer-only linkage means no lead row exists for the CRM recheck.
    mockState.firstQueue = [
      freshRow(
        { draft_response: 'Old two-question copy?' },
        { missing: ['specific_service'], answer_recorded: ['street_address'], copy_stale: true },
      ),
    ];
    const verdict = await claimClarifyDispatch({ draft: DRAFT });
    expect(verdict.outcome).toBe('send');
    const expected = _private.composeClarifyBody({ missing: ['specific_service'], firstName: null });
    expect(verdict.body).toBe(expected);
    expect(verdict.flags.copy_stale).toBeUndefined();
    const payload = mockState.updates[0].payload;
    expect(payload.draft_response).toBe(expected);
    expect(JSON.parse(payload.flags).copy_stale).toBeUndefined();
  });

  test('copy_stale on a REVISION bounces to re-review — the owner typed against the old copy', async () => {
    mockState.firstQueue = [
      freshRow({}, { missing: ['specific_service'], answer_recorded: ['street_address'], copy_stale: true }),
    ];
    const verdict = await claimClarifyDispatch({ draft: DRAFT, isRevision: true });
    expect(verdict.outcome).toBe('rewritten');
    expect(mockState.updates[0].payload.status).toBe('pending');
  });

  test('a draft the unlocked reject route already resolved is respected — no write, no send', async () => {
    mockState.firstQueue = [freshRow({ status: 'rejected' })];
    const verdict = await claimClarifyDispatch({ draft: DRAFT });
    expect(verdict.outcome).toBe('retired');
    expect(verdict.message).toContain('no longer claimed');
    expect(mockState.updates).toHaveLength(0);
  });

  test('a reject interleaving between the fresh read and the claim re-verification aborts the dispatch', async () => {
    mockState.firstQueue = [freshRow()];
    mockState.updateResults = [0]; // conditional claim write matches zero rows
    const verdict = await claimClarifyDispatch({ draft: DRAFT });
    expect(verdict.outcome).toBe('retired');
    expect(verdict.message).toContain('no longer claimed');
  });
});

describe('clarifyPreDispatchCheck', () => {
  const PARAMS = {
    draftId: 'draft-1',
    sourceRef: 'clarify:9415550142',
    dispatchedMissing: ['street_address'],
  };
  const claimedRow = (flags = {}, overrides = {}) => ({
    id: 'draft-1',
    status: 'approved',
    sent_at: null,
    flags: JSON.stringify({ missing: ['street_address'], ...flags }),
    ...overrides,
  });

  test('claim standing and ask unchanged → ok', async () => {
    mockState.firstQueue = [claimedRow()];
    expect(await clarifyPreDispatchCheck(PARAMS)()).toEqual({ ok: true });
  });

  test('a unit-number card closed while validators ran aborts the send; an open one lets it through', async () => {
    const unitParams = { ...PARAMS, dispatchedMissing: ['unit_number'] };
    mockState.firstQueue = [claimedRow({ missing: ['unit_number'], unit_call_log_id: 'call-1' }), null];
    const verdict = await clarifyPreDispatchCheck(unitParams)();
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/card was closed/);
    mockState.firstQueue = [claimedRow({ missing: ['unit_number'], unit_call_log_id: 'call-1' }), { id: 'card-1' }];
    expect(await clarifyPreDispatchCheck(unitParams)()).toEqual({ ok: true });
  });

  test('an answer recorded while validators ran aborts the send', async () => {
    mockState.firstQueue = [claimedRow({ missing: [], answered_at: '2026-07-19T00:00:00Z' })];
    const verdict = await clarifyPreDispatchCheck(PARAMS)();
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe('CLARIFY_SUPERSEDED');
  });

  test('a partial answer (missing set changed since dispatch) aborts the send', async () => {
    const check = clarifyPreDispatchCheck({ ...PARAMS, dispatchedMissing: ['street_address', 'specific_service'] });
    mockState.firstQueue = [claimedRow({ missing: ['specific_service'], answer_recorded: ['street_address'] })];
    const verdict = await check();
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe('CLARIFY_SUPERSEDED');
  });

  test('a concurrent reject aborts the send', async () => {
    mockState.firstQueue = [claimedRow({}, { status: 'rejected' })];
    const verdict = await clarifyPreDispatchCheck(PARAMS)();
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe('CLARIFY_SUPERSEDED');
  });

  test('copy_stale set after the decision aborts the send', async () => {
    mockState.firstQueue = [claimedRow({ copy_stale: true })];
    const verdict = await clarifyPreDispatchCheck(PARAMS)();
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe('CLARIFY_SUPERSEDED');
  });

  test('an unparseable ref fails closed without a db read', async () => {
    const verdict = await clarifyPreDispatchCheck({ ...PARAMS, sourceRef: 'nope' })();
    expect(verdict.ok).toBe(false);
    expect(mockState.updates).toHaveLength(0);
  });
});

describe('reopenClarifyAfterFailedSend', () => {
  const stampedRow = (flags = {}) => ({
    id: 'draft-1',
    source_ref: 'clarify:9415550142',
    status: 'approved',
    sent_at: new Date(),
    draft_response: 'Original question?',
    flags: JSON.stringify({ missing: ['street_address'], toPhone: '+19415550142', ...flags }),
  });

  test('reopens to pending with the stamp cleared; unchanged copy is preserved', async () => {
    // first() order: row (pre-lock), fresh (locked), rival probe (none).
    mockState.firstQueue = [stampedRow(), stampedRow(), null];
    const result = await reopenClarifyAfterFailedSend({
      draftId: 'draft-1',
      dispatchedMissing: ['street_address'],
    });
    expect(result).toEqual({ reopened: true, retired: false });
    const payload = mockState.updates[0].payload;
    expect(payload.status).toBe('pending');
    expect(payload.sent_at).toBeNull();
    expect(payload.approved_by).toBeNull();
    expect(payload.approved_at).toBeNull();
    // Missing set unchanged since dispatch — the parked copy (greeting and
    // all) must survive the round trip.
    expect(payload.draft_response).toBeUndefined();
  });

  test('a reply that shrank the ask mid-flight recomposes the reopened copy', async () => {
    const shrunk = stampedRow({ missing: ['specific_service'], answer_recorded: ['street_address'] });
    mockState.firstQueue = [shrunk, shrunk, null];
    const result = await reopenClarifyAfterFailedSend({
      draftId: 'draft-1',
      dispatchedMissing: ['street_address', 'specific_service'],
    });
    expect(result.reopened).toBe(true);
    expect(mockState.updates[0].payload.draft_response)
      .toBe(_private.composeClarifyBody({ missing: ['specific_service'], firstName: null }));
  });

  test('copy_stale reopens with a recomposed copy and the marker cleared', async () => {
    const stale = stampedRow({ missing: ['specific_service'], answer_recorded: ['street_address'], copy_stale: true });
    mockState.firstQueue = [stale, stale, null];
    const result = await reopenClarifyAfterFailedSend({
      draftId: 'draft-1',
      dispatchedMissing: ['specific_service'], // same set — the MARKER drives the recompose
    });
    expect(result.reopened).toBe(true);
    const payload = mockState.updates[0].payload;
    expect(payload.draft_response)
      .toBe(_private.composeClarifyBody({ missing: ['specific_service'], firstName: null }));
    expect(JSON.parse(payload.flags).copy_stale).toBeUndefined();
  });

  test('an ask fully consumed while the row read as sent retires with the stamp cleared', async () => {
    const consumed = stampedRow({ missing: [], answered_at: '2026-07-19T00:00:00Z' });
    mockState.firstQueue = [consumed, consumed];
    const result = await reopenClarifyAfterFailedSend({ draftId: 'draft-1', dispatchedMissing: ['street_address'] });
    expect(result).toEqual({ reopened: false, retired: true });
    expect(mockState.updates[0].payload).toEqual({ status: 'rejected', sent_at: null });
  });

  test('a rival open clarify (cooldown-exception park) supersedes — ours retires, index intact', async () => {
    mockState.firstQueue = [stampedRow(), stampedRow(), { id: 'draft-2', status: 'pending', sent_at: null }];
    const result = await reopenClarifyAfterFailedSend({ draftId: 'draft-1', dispatchedMissing: ['street_address'] });
    expect(result).toEqual({ reopened: false, retired: true });
    expect(mockState.updates[0].payload.status).toBe('rejected');
    expect(mockState.updates[0].payload.sent_at).toBeNull();
  });

  test('a draft rejected during the send window keeps its status — only the false stamp clears', async () => {
    const rejected = stampedRow();
    rejected.status = 'rejected';
    mockState.firstQueue = [rejected, rejected];
    const result = await reopenClarifyAfterFailedSend({ draftId: 'draft-1', dispatchedMissing: ['street_address'] });
    expect(result).toEqual({ reopened: false, retired: true });
    expect(mockState.updates).toHaveLength(1);
    expect(mockState.updates[0].payload).toEqual({ sent_at: null });
  });

  test('a reject interleaving after the fresh read wins — reopen falls back to clearing the stamp', async () => {
    mockState.firstQueue = [stampedRow(), stampedRow(), null];
    mockState.updateResults = [0]; // conditional reopen matches zero rows
    const result = await reopenClarifyAfterFailedSend({ draftId: 'draft-1', dispatchedMissing: ['street_address'] });
    expect(result).toEqual({ reopened: false, retired: true });
    expect(mockState.updates).toHaveLength(2);
    expect(mockState.updates[1].payload).toEqual({ sent_at: null });
  });

  test('revision releaseFields ride along on reopen', async () => {
    mockState.firstQueue = [stampedRow(), stampedRow(), null];
    await reopenClarifyAfterFailedSend({
      draftId: 'draft-1',
      dispatchedMissing: ['street_address'],
      releaseFields: { revised_response: null, final_response: null },
    });
    expect(mockState.updates[0].payload.revised_response).toBeNull();
    expect(mockState.updates[0].payload.final_response).toBeNull();
  });
});

describe('_private.composeClarifyBody', () => {
  test('address-only, service-only, and combined variants', () => {
    const address = _private.composeClarifyBody({ missing: ['street_address'], firstName: 'Pat' });
    expect(address).toMatch(/^Hi Pat, /);
    expect(address).toContain('service address');
    expect(address).not.toContain('which service');

    const service = _private.composeClarifyBody({ missing: ['specific_service'], firstName: null });
    expect(service).toMatch(/^Hi, /);
    expect(service).toContain('Which service');

    const both = _private.composeClarifyBody({ missing: ['street_address', 'specific_service'], firstName: 'Unknown' });
    expect(both).toMatch(/^Hi, /);
    expect(both).toContain('service address');
    expect(both).toContain('which service');
    // SMS-sized: the longest variant stays well under two segments.
    expect(both.length).toBeLessThan(300);
  });

  test('company name is always the full legal marketing name', () => {
    for (const missing of [['street_address'], ['specific_service'], ['street_address', 'specific_service']]) {
      expect(_private.composeClarifyBody({ missing, firstName: 'A' })).toContain('Waves Pest Control');
    }
  });
});

// ── bedroom_count (GATE_UNIT_BAND_PRICING lane) ─────────────────
// The attempt token the guard stamp wrote (second jsonb_build_object param).
function guardStampAttempt(state) {
  const stamp = state.updates.find((u) => u.table === 'estimates' && /reprice_attempt/.test(String(u.payload.estimate_data?.__raw || '')));
  return stamp ? stamp.payload.estimate_data.params[1] : null;
}

describe('bedroom_count ask (unit-band lane)', () => {
  test('is askable, with its own one-question copy and a trailing question when combined', () => {
    expect(_private.ASKABLE_MISSING.has('bedroom_count')).toBe(true);
    const alone = _private.composeClarifyBody({ missing: ['bedroom_count'], firstName: 'Pat' });
    expect(alone.startsWith('Hi Pat, ')).toBe(true);
    expect(alone).toMatch(/how many bedrooms is the unit \(studio, 1, 2, 3, or 4\+\)\?/);
    const combined = _private.composeClarifyBody({ missing: ['street_address', 'bedroom_count'], firstName: null });
    expect(combined).toBe(`${_private.composeClarifyBody({ missing: ['street_address'], firstName: null })} Also, how many bedrooms is the unit (studio, 1, 2, 3, or 4+)? That sets the price for your apartment or condo.`);
  });

  test('extractBedroomReply reads counts as spoken; studio = 0; a bare number is not an answer', () => {
    const { extractBedroomReply } = _private;
    expect(extractBedroomReply("It's a 2 bedroom")).toBe(2);
    expect(extractBedroomReply('one-bedroom apartment')).toBe(1);
    expect(extractBedroomReply('3br 2ba')).toBe(3);
    expect(extractBedroomReply('2 bed 2 bath')).toBe(2);
    expect(extractBedroomReply('studio')).toBe(0);
    expect(extractBedroomReply('Efficiency unit')).toBe(0);
    // An explicit count beats the studio word; a negated studio is not zero.
    expect(extractBedroomReply("not a studio, it's a 2 bedroom")).toBe(2);
    expect(extractBedroomReply("It isn't a studio")).toBeNull();
    expect(extractBedroomReply('no studio here')).toBeNull();
    expect(extractBedroomReply('2')).toBeNull();
    // A bedroom-ONLY ask accepts the natural bare answer, bounded.
    expect(extractBedroomReply('2', { bareNumberOk: true })).toBe(2);
    // Lower-bound replies below 4 straddle two bands ($99 vs $109) — not an answer;
    // "4+" collapses into the four_plus band exactly.
    expect(extractBedroomReply(' 3+ ', { bareNumberOk: true })).toBeNull();
    expect(extractBedroomReply('3 or more', { bareNumberOk: true })).toBeNull();
    expect(extractBedroomReply('4+', { bareNumberOk: true })).toBe(4);
    expect(extractBedroomReply('3+ bedrooms')).toBeNull();
    expect(extractBedroomReply('4 plus bedrooms')).toBe(4);
    expect(extractBedroomReply('One.', { bareNumberOk: true })).toBe(1);
    expect(extractBedroomReply('0', { bareNumberOk: true })).toBe(0);
    expect(extractBedroomReply('99', { bareNumberOk: true })).toBeNull();
    expect(extractBedroomReply('2 people', { bareNumberOk: true })).toBeNull();
    expect(extractBedroomReply('ok thanks')).toBeNull();
    expect(extractBedroomReply('')).toBeNull();
  });

  test('a bedroom reply records onto the draft flags only (no CRM column exists) and resumes the thread draft', async () => {
    mockSmsThreadDraftsEnabled.mockReturnValue(true);
    mockStartSmsThreadDraft.mockResolvedValue({ started: true });
    mockState.existingDraft = {
      id: 'sent-1', customer_id: null, sent_at: '2026-07-18T12:00:00Z',
      flags: JSON.stringify({ missing: ['bedroom_count'], lead_id: 'lead-1', estimate_id: 'est-1', bedroom_estimate_id: 'est-1' }),
    };
    const result = await handleClarifyReply({ phone: '+19415550142', body: "It's a 2 bedroom, thanks" });
    expect(result.handled).toBe(true);
    await result.repricePromise;
    expect(mockState.updates.some((u) => u.table === 'leads' || u.table === 'customers')).toBe(false);
    const bookkeeping = mockState.updates.find((u) => u.table === 'message_drafts');
    const flags = JSON.parse(bookkeeping.payload.flags);
    expect(flags.answer_recorded).toEqual(['bedroom_count']);
    expect(flags.bedroom_count_answer).toBe(2);
    expect(flags.missing).toEqual([]);
    expect(flags.answered_at).toBeDefined();
    // The re-draft names the fallback-priced draft it replaces, so the
    // dedupe transaction retires it and the replacement passes the guard.
    expect(mockStartSmsThreadDraft).toHaveBeenCalledWith(expect.objectContaining({
      skipIntentGate: true, skipCooldown: true, supersedeEstimateId: 'est-1', supersedeReason: 'clarify_bedroom_reply', bedroomCountOverride: 2,
    }));
    expect(mockMaybeDraftEstimateForCall).not.toHaveBeenCalled();
  });

  test('flag patches take the phone-scoped clarify lock (advisory xact lock) — never an unlocked read-modify-write; the webhook returns before the re-draft', async () => {
    mockSmsThreadDraftsEnabled.mockReturnValue(true);
    let releaseDraft;
    mockStartSmsThreadDraft.mockResolvedValue({ started: true, draftPromise: new Promise((resolve) => { releaseDraft = resolve; }) });
    mockState.existingDraft = {
      id: 'sent-1', customer_id: null, sent_at: '2026-07-18T12:00:00Z',
      flags: JSON.stringify({ missing: ['bedroom_count'], lead_id: 'lead-1', estimate_id: 'est-1', bedroom_estimate_id: 'est-1' }),
    };
    const result = await handleClarifyReply({ phone: '+19415550142', body: '1 bedroom' });
    // Returned while the re-draft is still running (detached from the webhook).
    expect(result.handled).toBe(true);
    releaseDraft({ created: true, estimateId: 'x' });
    await result.repricePromise;
    // one lock for the reply record + one per flag stamp (pending, then cleared)
    expect(mockState.locks.filter((l) => l[1] === '9415550142')).toHaveLength(3);
  });

  test('a VOICE-origin draft re-runs from its original call with the answer applied (the SMS thread has no quote evidence)', async () => {
    mockSmsThreadDraftsEnabled.mockReturnValue(true);
    mockMaybeDraftEstimateForCall.mockResolvedValue({ created: true });
    const awaiting = {
      id: 'sent-1', customer_id: null, sent_at: '2026-07-18T12:00:00Z',
      flags: JSON.stringify({ missing: ['bedroom_count'], lead_id: 'lead-1', estimate_id: 'est-1', bedroom_estimate_id: 'est-1' }),
    };
    // first() order: awaiting (unlocked), fresh (locked), ask (reprice_pending
    // stamp), estimate (origin), ask (cleared). The estimate guard is an
    // atomic UPDATE with no read.
    const estimateRow = { id: 'est-1', estimate_data: JSON.stringify({ estimatorEngine: { callLogId: 'call-9', lane: 'yellow' } }) };
    mockState.firstQueue = [awaiting, awaiting, awaiting, estimateRow, awaiting];
    mockMaybeDraftEstimateForCall.mockResolvedValue({ created: true, estimateId: 'est-new' });
    const result = await handleClarifyReply({ phone: '+19415550142', body: 'one bedroom' });
    expect(result.handled).toBe(true);
    await result.repricePromise;
    expect(mockMaybeDraftEstimateForCall).toHaveBeenCalledWith({
      callLogId: 'call-9', quotePromised: true, supersedeEstimateId: 'est-1', supersedeReason: 'clarify_bedroom_reply',
      supersedeAttempt: expect.stringMatching(/^[0-9a-f-]{36}$/), bedroomCountOverride: 1,
    });
    // The same attempt token is what the guard stamp wrote on the estimate.
    const guardStamp = mockState.updates.find((u) => u.table === 'estimates').payload.estimate_data;
    expect(guardStamp.__raw).toMatch(/'reprice_attempt', \?::text/);
    expect(guardStamp.params[1]).toBe(mockMaybeDraftEstimateForCall.mock.calls[0][0].supersedeAttempt);
    expect(mockStartSmsThreadDraft).not.toHaveBeenCalled();
    // Durable reprice state: pending BEFORE the attempt, cleared with the replacement id AFTER.
    const stamps = mockState.updates.filter((u) => u.table === 'message_drafts').map((u) => JSON.parse(u.payload.flags));
    expect(stamps.some((f) => f.reprice_pending?.estimate_id === 'est-1' && f.reprice_pending?.bedroom_count === 1)).toBe(true);
    const last = stamps[stamps.length - 1];
    expect(last.reprice_pending).toBeUndefined();
    expect(last.repriced_estimate_id).toBe('est-new');
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  test('a re-draft that produces NO replacement keeps reprice_pending on the ask row and bells the operator (never silently consumed)', async () => {
    mockSmsThreadDraftsEnabled.mockReturnValue(true);
    mockNotifyAdmin.mockResolvedValue({ id: 'bell-2' });
    const awaiting = {
      id: 'sent-1', customer_id: null, sent_at: '2026-07-18T12:00:00Z',
      flags: JSON.stringify({ missing: ['bedroom_count'], lead_id: 'lead-1', estimate_id: 'est-1', bedroom_estimate_id: 'est-1' }),
    };
    const estimateRow = { id: 'est-1', estimate_data: JSON.stringify({ estimatorEngine: { callLogId: 'call-9' } }) };
    mockState.firstQueue = [awaiting, awaiting, awaiting, estimateRow];
    mockMaybeDraftEstimateForCall.mockResolvedValue({ created: false, lane: 'red', reasons: ['composer skipped'] });
    const failed = await handleClarifyReply({ phone: '+19415550142', body: '2 bedroom' });
    await failed.repricePromise;
    const stamps = mockState.updates.filter((u) => u.table === 'message_drafts').map((u) => JSON.parse(u.payload.flags));
    expect(stamps[stamps.length - 1].reprice_pending).toMatchObject({ estimate_id: 'est-1', bedroom_count: 2 });
    expect(stamps.some((f) => f.repriced_estimate_id)).toBe(false);
    expect(mockNotifyAdmin).toHaveBeenCalledWith(
      'lead',
      expect.stringMatching(/re-price the unit draft/i),
      expect.stringMatching(/2 bedrooms/),
      expect.objectContaining({ link: '/admin/estimates/est-1', metadata: expect.objectContaining({ reprice_pending: true, estimateId: 'est-1' }) }),
    );
  });

  test('an SMS-origin draft (estimator_engine.origin = sms_thread) re-drafts from the thread, not the call', async () => {
    mockSmsThreadDraftsEnabled.mockReturnValue(true);
    mockStartSmsThreadDraft.mockResolvedValue({ started: true });
    const awaiting = {
      id: 'sent-1', customer_id: null, sent_at: '2026-07-18T12:00:00Z',
      flags: JSON.stringify({ missing: ['bedroom_count'], lead_id: 'lead-1', estimate_id: 'est-2', bedroom_estimate_id: 'est-2' }),
    };
    const estimateRow = { id: 'est-2', estimate_data: JSON.stringify({ estimatorEngine: { origin: 'sms_thread', callLogId: null } }) };
    mockState.firstQueue = [awaiting, awaiting, awaiting, estimateRow, awaiting];
    // Detached thread draft: the re-price waits on its outcome.
    mockStartSmsThreadDraft.mockResolvedValue({ started: true, draftPromise: Promise.resolve({ created: true, estimateId: 'est-2b' }) });
    const smsResult = await handleClarifyReply({ phone: '+19415550142', body: 'studio' });
    await smsResult.repricePromise;
    expect(mockMaybeDraftEstimateForCall).not.toHaveBeenCalled();
    expect(mockStartSmsThreadDraft).toHaveBeenCalledWith(expect.objectContaining({ supersedeEstimateId: 'est-2', bedroomCountOverride: 0 }));
    const stamps = mockState.updates.filter((u) => u.table === 'message_drafts').map((u) => JSON.parse(u.payload.flags));
    expect(stamps[stamps.length - 1].repriced_estimate_id).toBe('est-2b');
  });

  test('an address reply (red-path ask, no linked draft) never asks the re-draft to supersede anything', async () => {
    mockSmsThreadDraftsEnabled.mockReturnValue(true);
    mockStartSmsThreadDraft.mockResolvedValue({ started: true });
    mockState.existingDraft = {
      id: 'sent-1', customer_id: null, sent_at: '2026-07-18T12:00:00Z',
      flags: JSON.stringify({ missing: ['street_address'], lead_id: 'lead-1' }),
    };
    await handleClarifyReply({ phone: '+19415550142', body: '123 Main St, Sarasota' });
    const args = mockStartSmsThreadDraft.mock.calls[0][0];
    expect(args.supersedeEstimateId).toBeUndefined();
  });

  test('repricePendingActive never lapses on its own — only a replacement or an operator revision (inside its own locked write) clears it', async () => {
    const { repricePendingActive } = require('../services/estimate-clarify-asks');
    expect(repricePendingActive({ reprice_pending_at: '2026-08-28T11:50:00Z' })).toBe(true);
    expect(repricePendingActive({ reprice_pending_at: '2020-01-01T00:00:00Z' })).toBe(true);
    expect(repricePendingActive({})).toBe(false);
    expect(repricePendingActive(null)).toBe(false);
    expect(require('../services/estimate-clarify-asks').clearEstimateRepricePending).toBeUndefined();
  });

  test('the linked ESTIMATE carries reprice_pending_at from the locked phase; a failed re-draft lifts it (bell stands)', async () => {
    mockSmsThreadDraftsEnabled.mockReturnValue(true);
    mockNotifyAdmin.mockResolvedValue({ id: 'bell-3' });
    mockMaybeDraftEstimateForCall.mockResolvedValue({ created: false, lane: 'red' });
    const awaiting = {
      id: 'sent-1', customer_id: null, sent_at: '2026-07-18T12:00:00Z',
      flags: JSON.stringify({ missing: ['bedroom_count'], lead_id: 'lead-1', estimate_id: 'est-1', bedroom_estimate_id: 'est-1' }),
    };
    const estimateRow = { id: 'est-1', estimate_data: JSON.stringify({ estimatorEngine: { callLogId: 'call-9', lane: 'yellow' } }) };
    // first() order: awaiting, fresh(locked), ask (pending stamp), estimate (origin)
    mockState.firstQueue = [awaiting, awaiting, awaiting, estimateRow];
    const result = await handleClarifyReply({ phone: '+19415550142', body: '1 bedroom' });
    await result.repricePromise;
    // ATOMIC JSONB path updates only — never a whole-blob rewrite that
    // could erase a concurrent linkage marker.
    // guard stamp → (failure) unschedule only — the guard STAYS (known-stale dollars)
    const estimateUpdates = mockState.updates.filter((u) => u.table === 'estimates');
    expect(estimateUpdates).toHaveLength(2);
    expect(estimateUpdates[0].payload.estimate_data.__raw).toMatch(/jsonb_set\(estimate_data, '\{estimatorEngine\}'.*jsonb_build_object\('reprice_pending_at'/);
    expect(estimateUpdates[0].payload.estimate_data.params[0]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(estimateUpdates[1].payload).toMatchObject({ status: 'draft', scheduled_at: null });
    // …and the unschedule is attempt-scoped (an operator revision that deleted the token makes it a no-op).
    expect(mockState.raws.some((r) => /reprice_attempt' = \?/.test(r.sql) && r.params?.[0] === guardStampAttempt(mockState))).toBe(true);
    expect(estimateUpdates.some((u) => /- 'reprice_pending_at'/.test(String(u.payload.estimate_data?.__raw || '')))).toBe(false);
    expect(mockNotifyAdmin).toHaveBeenCalled();
  });

  test('the bedroom re-price binds to bedroom_estimate_id — a merged ask that re-pointed the generic estimate_id never archives the wrong draft', async () => {
    mockSmsThreadDraftsEnabled.mockReturnValue(true);
    mockMaybeDraftEstimateForCall.mockResolvedValue({ created: true, estimateId: 'est-new' });
    const awaiting = {
      id: 'sent-1', customer_id: null, sent_at: '2026-07-18T12:00:00Z',
      // generic linkage moved to an unrelated lawn draft by a later merged ask
      flags: JSON.stringify({ missing: ['bedroom_count', 'specific_service'], lead_id: 'lead-1', estimate_id: 'est-LAWN', bedroom_estimate_id: 'est-UNIT' }),
    };
    const unitRow = { id: 'est-UNIT', estimate_data: JSON.stringify({ estimatorEngine: { callLogId: 'call-1' } }) };
    mockState.firstQueue = [awaiting, awaiting, awaiting, unitRow, awaiting];
    const result = await handleClarifyReply({ phone: '+19415550142', body: '2 bedroom' });
    await result.repricePromise;
    expect(mockMaybeDraftEstimateForCall).toHaveBeenCalledWith(expect.objectContaining({ supersedeEstimateId: 'est-UNIT' }));
    expect(mockMaybeDraftEstimateForCall).not.toHaveBeenCalledWith(expect.objectContaining({ supersedeEstimateId: 'est-LAWN' }));
  });

  test('parking and merging a bedroom ask record bedroom_estimate_id; a merge for another item keeps it', async () => {
    mockState.existingDraft = null;
    await parkClarifyAsk({ missing: ['bedroom_count'], phone: '+19415550142', estimateId: 'est-UNIT', source: 'estimator_engine_unit_band', channelProvenance: 'voice' });
    const parked = JSON.parse(mockState.inserts[0].flags);
    expect(parked.bedroom_estimate_id).toBe('est-UNIT');
    expect(parked.estimate_id).toBe('est-UNIT');
    // A later street_address ask for the same phone merges in with ITS linkage…
    mockState.existingDraft = { id: 'draft-1', status: 'pending', flags: mockState.inserts[0].flags };
    await parkClarifyAsk({ missing: ['street_address'], phone: '+19415550142', estimateId: 'est-LAWN', leadId: 'lead-2', source: 'estimator_engine_red', channelProvenance: 'voice' });
    const merged = JSON.parse(mockState.updates.find((u) => u.table === 'message_drafts').payload.flags);
    expect(merged.missing).toEqual(['bedroom_count', 'street_address']);
    expect(merged.estimate_id).toBe('est-LAWN');
    // …but the bedroom item stays bound to the unit draft.
    expect(merged.bedroom_estimate_id).toBe('est-UNIT');
  });

  test('a failed re-price on a SCHEDULED draft cancels the schedule (inert draft, no due time) before lifting the guard', async () => {
    mockSmsThreadDraftsEnabled.mockReturnValue(true);
    mockNotifyAdmin.mockResolvedValue({ id: 'bell-5' });
    mockMaybeDraftEstimateForCall.mockResolvedValue({ created: false, lane: 'red' });
    const awaiting = {
      id: 'sent-1', customer_id: null, sent_at: '2026-07-18T12:00:00Z',
      flags: JSON.stringify({ missing: ['bedroom_count'], lead_id: 'lead-1', estimate_id: 'est-1', bedroom_estimate_id: 'est-1' }),
    };
    const estimateRow = { id: 'est-1', estimate_data: JSON.stringify({ estimatorEngine: { callLogId: 'call-9' } }) };
    mockState.firstQueue = [awaiting, awaiting, awaiting, estimateRow];
    const result = await handleClarifyReply({ phone: '+19415550142', body: '1 bedroom' });
    await result.repricePromise;
    const estimateUpdates = mockState.updates.filter((u) => u.table === 'estimates').map((u) => u.payload);
    // guard stamp, then (failure) unschedule — never a guard release
    expect(estimateUpdates.some((p) => p.status === 'draft' && p.scheduled_at === null)).toBe(true);
    expect(estimateUpdates.some((p) => /- 'reprice_pending_at'\)/.test(String(p.estimate_data?.__raw || '')))).toBe(false);
  });

  test('a guard that stamps ZERO rows (draft already sent/moved on) fails closed: answer recorded, no re-draft, operator bell', async () => {
    mockSmsThreadDraftsEnabled.mockReturnValue(true);
    mockNotifyAdmin.mockResolvedValue({ id: 'bell-4' });
    const awaiting = {
      id: 'sent-1', customer_id: null, sent_at: '2026-07-18T12:00:00Z',
      flags: JSON.stringify({ missing: ['bedroom_count'], lead_id: 'lead-1', estimate_id: 'est-1', bedroom_estimate_id: 'est-1' }),
    };
    mockState.firstQueue = [awaiting, awaiting, awaiting];
    // update results: ask row bookkeeping (1), estimate guard (0 rows), pending stamp (1)…
    mockState.updateResults = [0, 1];
    const result = await handleClarifyReply({ phone: '+19415550142', body: '1 bedroom' });
    await result.repricePromise;
    expect(mockMaybeDraftEstimateForCall).not.toHaveBeenCalled();
    expect(mockStartSmsThreadDraft).not.toHaveBeenCalled();
    expect(mockNotifyAdmin).toHaveBeenCalledWith('lead', expect.stringMatching(/re-price the unit draft/i), expect.any(String), expect.objectContaining({ link: '/admin/estimates/est-1' }));
  });

  test('a bare number answers only a DELIVERED bedroom-only prompt — an unsent draft leaves an unrelated "2" alone', async () => {
    mockSmsThreadDraftsEnabled.mockReturnValue(true);
    mockState.existingDraft = {
      id: 'pend-1', customer_id: null, sent_at: null, status: 'pending',
      flags: JSON.stringify({ missing: ['bedroom_count'], lead_id: 'lead-1' }),
    };
    const result = await handleClarifyReply({ phone: '9415550142', body: '2' });
    expect(result.handled).toBe(false);
    expect(mockState.updates).toHaveLength(0);
  });

  test('a bare "2" answers a bedroom-ONLY ask but not a combined ask', async () => {
    mockSmsThreadDraftsEnabled.mockReturnValue(true);
    mockStartSmsThreadDraft.mockResolvedValue({ started: true, draftPromise: Promise.resolve({ created: true, estimateId: 'x' }) });
    mockState.existingDraft = {
      id: 'sent-1', customer_id: null, sent_at: '2026-07-18T12:00:00Z',
      flags: JSON.stringify({ missing: ['bedroom_count'], lead_id: 'lead-1' }),
    };
    const only = await handleClarifyReply({ phone: '9415550142', body: '2' });
    expect(only.handled).toBe(true);
    await only.repricePromise;
    mockState.updates.length = 0;
    mockState.existingDraft = {
      id: 'sent-2', customer_id: null, sent_at: '2026-07-18T12:00:00Z',
      flags: JSON.stringify({ missing: ['street_address', 'bedroom_count'], lead_id: 'lead-1' }),
    };
    const combined = await handleClarifyReply({ phone: '9415550142', body: '2' });
    expect(combined.handled).toBe(false);
    expect(mockState.updates).toHaveLength(0);
  });

  test('the re-price target is the LOCKED row\'s estimate_id, not the pre-lock snapshot (a concurrent merge may have re-pointed it)', async () => {
    mockSmsThreadDraftsEnabled.mockReturnValue(true);
    mockMaybeDraftEstimateForCall.mockResolvedValue({ created: true, estimateId: 'est-new' });
    const unlocked = {
      id: 'sent-1', customer_id: null, sent_at: '2026-07-18T12:00:00Z',
      flags: JSON.stringify({ missing: ['bedroom_count'], lead_id: 'lead-1', estimate_id: 'est-OLD', bedroom_estimate_id: 'est-OLD' }),
    };
    const lockedRow = { ...unlocked, flags: JSON.stringify({ missing: ['bedroom_count'], lead_id: 'lead-1', estimate_id: 'est-FRESH', bedroom_estimate_id: 'est-FRESH' }) };
    const estimateRow = { id: 'est-FRESH', estimate_data: JSON.stringify({ estimatorEngine: { callLogId: 'call-1' } }) };
    mockState.firstQueue = [unlocked, lockedRow, lockedRow, estimateRow, lockedRow];
    const result = await handleClarifyReply({ phone: '+19415550142', body: '1 bedroom' });
    await result.repricePromise;
    expect(mockMaybeDraftEstimateForCall).toHaveBeenCalledWith(expect.objectContaining({ supersedeEstimateId: 'est-FRESH' }));
    const stamps = mockState.updates.filter((u) => u.table === 'message_drafts').map((u) => JSON.parse(u.payload.flags));
    expect(stamps.some((f) => f.reprice_pending?.estimate_id === 'est-FRESH')).toBe(true);
    expect(stamps.some((f) => f.reprice_pending?.estimate_id === 'est-OLD')).toBe(false);
  });

  test('a reply without a bedroom count leaves the ask open', async () => {
    mockState.existingDraft = {
      id: 'sent-1', customer_id: null, sent_at: '2026-07-18T12:00:00Z',
      flags: JSON.stringify({ missing: ['bedroom_count'], lead_id: 'lead-1' }),
    };
    const result = await handleClarifyReply({ phone: '9415550142', body: 'ok thanks' });
    expect(result.handled).toBe(false);
    expect(mockState.updates).toHaveLength(0);
  });

  test('approval-time staleness never treats bedroom_count as answered by CRM state (an address on the lead is not a bedroom count)', async () => {
    mockState.firstQueue = [
      {
        id: 'draft-1', source_ref: 'clarify:9415550142', customer_id: null, status: 'approved', sent_at: null,
        draft_response: 'Original question?', final_response: null,
        flags: JSON.stringify({ missing: ['bedroom_count'], toPhone: '+19415550142', lead_id: 'lead-1' }),
      },
      { id: 'lead-1', status: 'new', address: '123 Main St Apt 4', service_interest: 'quarterly pest', first_name: 'Pat' },
    ];
    const verdict = await claimClarifyDispatch({ draft: { id: 'draft-1', source_ref: 'clarify:9415550142' } });
    expect(verdict.outcome).toBe('send');
    expect(verdict.flags.missing).toEqual(['bedroom_count']);
  });
});

describe('unit_number ask (call pipeline lane)', () => {
  const BUILDING = { street_line_1: '1048 Example Lakes Cir', city: 'Sarasota', postal_code: '34232' };

  test('copy: the one-question unit ask names the building; combined asks append it', () => {
    const solo = _private.composeClarifyBody({ missing: ['unit_number'], firstName: 'Anna', unitAskBuilding: BUILDING });
    expect(solo).toBe("Hi Anna, it's Waves Pest Control — one quick thing to finish your quote: what's the apartment or unit number at 1048 Example Lakes Cir?");
    const noBuilding = _private.composeClarifyBody({ missing: ['unit_number'], firstName: null });
    expect(noBuilding).toMatch(/what's the apartment or unit number\?$/);
    const combined = _private.composeClarifyBody({ missing: ['specific_service', 'unit_number'], firstName: null, unitAskBuilding: BUILDING });
    expect(combined).toMatch(/^Hi, it's Waves Pest Control — glad to get you a quote\. Which service/);
    expect(combined).toMatch(/ Also, what's the apartment or unit number at 1048 Example Lakes Cir\?$/);
  });

  test('parks the unit ask bound to its call card and building, marked call-origin', async () => {
    const result = await parkClarifyAsk({
      missing: ['unit_number'], phone: '+17735550142', firstName: 'Anna', customerId: 'cust-1', leadId: 'lead-1',
      callLogId: 'call-1', source: 'call_missing_unit_number', channelProvenance: 'voice', unitAskBuilding: BUILDING,
    });
    expect(result).toEqual({ parked: true, draftId: 'draft-1', covers: ['unit_number'] });
    const row = mockState.inserts[0];
    expect(row.intent).toBe('estimate_clarify');
    expect(row.draft_response).toMatch(/unit number at 1048 Example Lakes Cir\?$/);
    const flags = JSON.parse(row.flags);
    expect(flags).toEqual(expect.objectContaining({
      missing: ['unit_number'], toPhone: '+17735550142', lead_id: 'lead-1', call_origin: true,
      unit_call_log_id: 'call-1', unit_ask_building: BUILDING, channel_provenance: 'voice',
    }));
    expect(flags.unit_lead_id).toBe('lead-1');
    expect(flags.unit_customer_id).toBe('cust-1');
    expect(flags.unit_quote_promised).toBeUndefined();
  });

  test('a later merged ask for ANOTHER lead on the same phone keeps the unit item bound to its card; a non-call producer clears call origin', async () => {
    mockState.existingDraft = {
      id: 'draft-1', status: 'pending', sent_at: null,
      flags: JSON.stringify({ missing: ['unit_number'], lead_id: 'lead-A', call_origin: true, unit_call_log_id: 'call-A', unit_ask_building: BUILDING }),
    };
    const result = await parkClarifyAsk({ missing: ['specific_service'], phone: '+17735550142', leadId: 'lead-B', source: 'lead_intake' });
    expect(result.skipped).toBe('merged_into_open_clarify');
    const merged = mockState.updates.find((u) => u.table === 'message_drafts');
    const flags = JSON.parse(merged.payload.flags);
    expect(flags.missing).toEqual(['unit_number', 'specific_service']);
    expect(flags.lead_id).toBe('lead-B');
    expect(flags.unit_call_log_id).toBe('call-A');
    expect(flags.call_origin).toBe(false);
    expect(merged.payload.draft_response).toMatch(/unit number at 1048 Example Lakes Cir\?$/);
  });

  test('a NEWER unit ask with a deliberately-null customer (ambiguous shared phone) CLEARS the prior ask\'s customer target', async () => {
    mockState.existingDraft = {
      id: 'draft-1', status: 'pending', sent_at: null,
      flags: JSON.stringify({ missing: ['unit_number'], lead_id: 'lead-A', call_origin: true, unit_call_log_id: 'call-A', unit_lead_id: 'lead-A', unit_customer_id: 'cust-A', unit_ask_building: BUILDING }),
    };
    const result = await parkClarifyAsk({ missing: ['unit_number'], phone: '+17735550142', leadId: 'lead-B', customerId: null, callLogId: 'call-B', source: 'call_missing_unit_number', channelProvenance: 'voice', unitAskBuilding: { street_line_1: '5 Other Rd', city: 'Venice', postal_code: '34285' } });
    expect(result.skipped).toBe('merged_into_open_clarify');
    const flags = JSON.parse(mockState.updates.find((u) => u.table === 'message_drafts').payload.flags);
    expect(flags.unit_customer_id).toBeNull();
    expect(flags.unit_lead_id).toBe('lead-B');
    expect(flags.unit_call_log_id).toBe('call-B');
  });

  test('extractUnitReply: designated forms always (incl. PH1 / TH12 / A-204 / ABC12 / PH-1); a bare token only when allowed; never a bare word', () => {
    const { extractUnitReply } = _private;
    expect(extractUnitReply('Apt 204')).toBe('Apt 204');
    // Exactly one unambiguous candidate: a correction or a two-unit reply is not an answer.
    expect(extractUnitReply("Not Apt 204, it's Apt 205")).toBeNull();
    expect(extractUnitReply('Unit 204 and unit 205')).toBeNull();
    expect(extractUnitReply('not unit 204')).toBeNull();
    expect(extractUnitReply("Apt 204 is wrong, it's 205")).toBeNull();
    expect(extractUnitReply('Unit 204 or 205')).toBeNull();
    expect(extractUnitReply('Apt 204, actually 206')).toBeNull();
    expect(extractUnitReply('Apt 204 and 205')).toBeNull();
    expect(extractUnitReply('Apt 204, should be 205')).toBeNull();
    expect(extractUnitReply('Apt 204/205')).toBeNull();
    expect(extractUnitReply('Apt 204 205')).toBeNull();
    expect(extractUnitReply('Apt 204, 3 br')).toBe('Apt 204');
    expect(extractUnitReply("It's Apt 204")).toBe('Apt 204');
    expect(extractUnitReply('Apt 204, 2 bedrooms')).toBe('Apt 204');
    expect(extractUnitReply('Apt 204, apt 204')).toBe('Apt 204');
    // Every dwelling designator, KEPT (codex r16 P1 on #3804): a park lot/space or an office suite is its own key.
    expect(extractUnitReply('Lot 12')).toBe('Lot 12');
    expect(extractUnitReply('Space 7')).toBe('Space 7');
    expect(extractUnitReply('Spc 7')).toBe('Spc 7');
    expect(extractUnitReply('Suite 210')).toBe('Suite 210');
    expect(extractUnitReply('Lot 12, 2 bedrooms')).toBe('Lot 12');
    expect(extractUnitReply('Lot 12 or lot 13')).toBeNull();
    // Two DIFFERENT designators on the same value name two premises — ambiguous (codex r17 P1 on #3804).
    expect(extractUnitReply('Lot 12 or Apt 12')).toBeNull();
    expect(extractUnitReply('Space 7, apt 7')).toBeNull();
    // The same interchangeable designator twice is still one answer.
    expect(extractUnitReply('Unit 204, apt 204')).toBe('Apt 204');
    expect(extractUnitReply('#204')).toBe('Apt 204');
    // A hash owned by the worded designator ("Lot #12") is decoration, not a second (apartment) designator (codex r18 P1 on #3804).
    expect(extractUnitReply('Lot #12')).toBe('Lot 12');
    expect(extractUnitReply('Space #7')).toBe('Space 7');
    expect(extractUnitReply('Suite #210')).toBe('Suite 210');
    expect(extractUnitReply("It's lot # 12")).toBe('Lot 12');
    expect(extractUnitReply('Apt #204')).toBe('Apt 204');
    // …while a hash the worded matcher did not consume still names a second premise or value.
    expect(extractUnitReply('Lot #12 or apt 12')).toBeNull();
    expect(extractUnitReply('Lot #12 or #12')).toBeNull();
    expect(extractUnitReply('Lot #12, #13')).toBeNull();
    // Structural designators are not a unit answer.
    expect(extractUnitReply('Bldg 9')).toBeNull();
    expect(extractUnitReply('Yes, Apt 204 please')).toBe('Apt 204');
    expect(extractUnitReply("it's apt. 12B, thanks!")).toBe('Apt 12B');
    expect(extractUnitReply('Unit 7')).toBe('Apt 7');
    expect(extractUnitReply('#7')).toBe('Apt 7');
    expect(extractUnitReply('Unit PH1')).toBe('Apt PH1');
    expect(extractUnitReply('apt TH12 please')).toBe('Apt TH12');
    expect(extractUnitReply('Unit A-204')).toBe('Apt A-204');
    expect(extractUnitReply('Unit ABC12')).toBe('Apt ABC12');
    expect(extractUnitReply('Unit PH-1')).toBe('Apt Ph-1');
    expect(extractUnitReply('apt on the 3rd floor')).toBeNull();
    expect(extractUnitReply('unit the')).toBeNull();
    expect(extractUnitReply('204')).toBeNull();
    expect(extractUnitReply('204', { bareOk: true })).toBe('Apt 204');
    expect(extractUnitReply('its 12B.', { bareOk: true })).toBe('Apt 12B');
    expect(extractUnitReply('ok thanks', { bareOk: true })).toBeNull();
    expect(extractUnitReply('2 dogs and a cat', { bareOk: true })).toBeNull();
  });

  describe('reply', () => {
    const AWAITING = (overrides = {}) => ({
      id: 'sent-1',
      customer_id: 'cust-1',
      status: 'approved',
      sent_at: '2026-09-03T12:00:00Z',
      flags: JSON.stringify({ missing: ['unit_number'], lead_id: 'lead-1', call_origin: true, unit_call_log_id: 'call-1', unit_ask_building: BUILDING }),
      ...overrides,
    });
    beforeEach(() => {
      mockSmsThreadDraftsEnabled.mockReturnValue(true);
      mockStartSmsThreadDraft.mockResolvedValue({ started: true });
    });

    test('"Apt 204" is stamped on the open card (never resolving it) and consumed on the draft — no CRM address writes, no automatic re-draft', async () => {
      const result = await handleClarifyReply({ phone: '+17735550142', body: 'Apt 204' });
      expect(result.handled).toBe(true);
      await result.repricePromise;
      const cardUpdate = mockState.updates.find((u) => u.table === 'triage_items');
      expect(cardUpdate.payload.payload.__raw).toMatch(/customer_reply_unit/);
      expect(cardUpdate.payload.payload.params[0]).toBe('Apt 204');
      expect(cardUpdate.payload.status).toBeUndefined();
      expect(mockState.updates.find((u) => u.table === 'leads')).toBeUndefined();
      expect(mockState.updates.find((u) => u.table === 'customers')).toBeUndefined();
      const bookkeeping = mockState.updates.find((u) => u.table === 'message_drafts');
      const flags = JSON.parse(bookkeeping.payload.flags);
      expect(flags.answer_recorded).toEqual(['unit_number']);
      expect(flags.unit_number_answer).toBe('Apt 204');
      expect(flags.answered_at).toBeTruthy();
      expect(mockMaybeDraftEstimateForCall).not.toHaveBeenCalled();
      expect(mockStartSmsThreadDraft).not.toHaveBeenCalled();
    });

    test('a bare "204" answers a DELIVERED one-question ask, never an unsent one', async () => {
      mockState.existingDraft = AWAITING();
      expect((await handleClarifyReply({ phone: '+17735550142', body: '204' })).handled).toBe(true);
      mockState.updates = [];
      mockState.existingDraft = AWAITING({ status: 'pending', sent_at: null });
      expect((await handleClarifyReply({ phone: '+17735550142', body: '204' })).handled).toBe(false);
      expect(mockState.updates).toHaveLength(0);
    });

    beforeEach(() => { mockState.existingDraft = AWAITING(); });
  });

  describe('dispatch', () => {
    const DRAFT = { id: 'draft-1', source_ref: 'clarify:7735550142' };
    const freshRow = (flags = {}, overrides = {}) => ({
      id: 'draft-1', source_ref: 'clarify:7735550142', customer_id: null, status: 'approved', sent_at: null,
      draft_response: 'Unit?', final_response: null,
      flags: JSON.stringify({ missing: ['unit_number'], toPhone: '+17735550142', lead_id: 'lead-1', call_origin: true, unit_call_log_id: 'call-1', unit_ask_building: BUILDING, ...flags }),
      ...overrides,
    });

    test('a lead with a street but no unit still needs the ask while its card is open (the street-address rule must not retire it)', async () => {
      mockState.firstQueue = [freshRow(), { id: 'lead-1', status: 'new', address: '1048 Example Lakes Cir, Apt 9, Sarasota, FL 34232', first_name: 'Anna' }, { id: 'card-1' }];
      const verdict = await claimClarifyDispatch({ draft: DRAFT });
      expect(verdict.outcome).toBe('send');
      expect(verdict.body).toBe('Unit?');
    });

    test('the closed triage card is the human verdict: a resolved/dismissed missing_unit_number card retires the ask', async () => {
      mockState.firstQueue = [freshRow(), { id: 'lead-1', status: 'new', address: '1048 Example Lakes Cir', first_name: 'Anna' }, null];
      const verdict = await claimClarifyDispatch({ draft: DRAFT });
      expect(verdict.outcome).toBe('retired');
      expect(verdict.message).toContain('already provided');
    });
  });
});

describe('unit write-back (GATE_CLARIFY_UNIT_WRITEBACK)', () => {
  const BUILDING = { street_line_1: '1048 Example Lakes Cir', city: 'Sarasota', postal_code: '34232' };
  const gateOn = () => mockIsEnabled.mockImplementation((key) => key === 'estimateClarifyAsks' || key === 'clarifyUnitWriteback');
  const AWAITING = (flags = {}, overrides = {}) => ({
    id: 'sent-1', customer_id: 'cust-1', status: 'approved', sent_at: '2026-09-03T12:00:00Z',
    flags: JSON.stringify({
      missing: ['unit_number'], lead_id: 'lead-1', call_origin: true,
      unit_call_log_id: 'call-1', unit_ask_building: BUILDING, unit_lead_id: 'lead-1', unit_customer_id: 'cust-1', ...flags,
    }),
    ...overrides,
  });
  const reply = async (leadRow, customerRow, flags = {}, body = 'Apt 204') => {
    const a = AWAITING(flags);
    // first() order in the locked phase: fresh draft, the unit call's row (its CURRENT customer
    // linkage is the target), customer (locked first), lead; later flag stamps re-read the draft
    // row (existingDraft) once the queue drains.
    mockState.existingDraft = a;
    // The call row is read twice: unlocked for the target, then FOR UPDATE (after the customer
    // lock when there is a customer; ALWAYS, a null linkage included) as the recheck.
    const callRow = { id: 'call-1', customer_id: customerRow?.id || null };
    mockState.firstQueue = [a, a, callRow, ...(customerRow ? [customerRow] : []), callRow, leadRow];
    const result = await handleClarifyReply({ phone: '+17735550142', body });
    await result.repricePromise;
    return result;
  };
  const writeback = () => JSON.parse(mockState.updates.find((u) => u.table === 'message_drafts').payload.flags).unit_writeback;
  beforeEach(() => {
    gateOn();
    mockSmsThreadDraftsEnabled.mockReturnValue(true);
    mockStartSmsThreadDraft.mockResolvedValue({ started: true });
  });

  test('new prospect: blank lead line is filled with building + unit; the customer (no address) gets the building as their primary property; the new row is enqueued for enrichment; nothing re-drafts', async () => {
    const result = await reply({ id: 'lead-1', address: null }, { id: 'cust-1', address_line1: null, address_line2: null });
    expect(result.handled).toBe(true);
    expect(mockState.updates.find((u) => u.table === 'leads').payload.address).toBe('1048 Example Lakes Cir, Apt 204, Sarasota, FL 34232');
    expect(mockState.updates.find((u) => u.table === 'customers')).toBeUndefined();
    expect(mockRecordCallProperty).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'cust-1', address_line1: '1048 Example Lakes Cir', address_line2: 'Apt 204', city: 'Sarasota', zip: '34232', source: 'clarify_unit_reply',
    }));
    expect(mockSyncPrimaryAddress).not.toHaveBeenCalled();
    expect(writeback()).toEqual(expect.objectContaining({ lead: 'filled', customer: 'primary_property', propertyId: 'prop-1' }));
    // The card stamp still happens; the NEW row is enriched like a call-pipeline insert.
    expect(mockState.updates.find((u) => u.table === 'triage_items')).toBeDefined();
    expect(mockEnqueueCallPropertyLookup).toHaveBeenCalledWith({ propertyId: 'prop-1' });
    // The call's estimate is NOT re-drafted by this lane (PR C2).
    expect(mockMaybeDraftEstimateForCall).not.toHaveBeenCalled();
    expect(mockStartSmsThreadDraft).not.toHaveBeenCalled();
    expect(mockState.updates.find((u) => u.table === 'estimates')).toBeUndefined();
  });

  test('an operator relink of the call after the ask parked wins over the cached customer target; an unlink means no customer write', async () => {
    const a = AWAITING();
    mockState.existingDraft = a;
    mockState.firstQueue = [a, a, { id: 'call-1', customer_id: 'cust-Z' }, { id: 'cust-Z', address_line1: null }, { id: 'call-1', customer_id: 'cust-Z' }, { id: 'lead-1', address: null }];
    let r = await handleClarifyReply({ phone: '+17735550142', body: 'Apt 204' }); await r.repricePromise;
    expect(mockRecordCallProperty).toHaveBeenCalledWith(expect.objectContaining({ customerId: 'cust-Z' }));
    expect(mockRecordCallProperty).not.toHaveBeenCalledWith(expect.objectContaining({ customerId: 'cust-1' }));
    // A relink landing BETWEEN the unlocked read and the customer lock: the locked recheck sees it and the former customer is skipped.
    jest.clearAllMocks(); mockState.updates = [];
    mockState.firstQueue = [a, a, { id: 'call-1', customer_id: 'cust-1' }, { id: 'cust-1', address_line1: null }, { id: 'call-1', customer_id: 'cust-Q' }, { id: 'lead-1', address: null }];
    r = await handleClarifyReply({ phone: '+17735550142', body: 'Apt 204' }); await r.repricePromise;
    expect(mockRecordCallProperty).not.toHaveBeenCalled();
    expect(mockState.updates.find((u) => u.table === 'customers')).toBeUndefined();
    expect(writeback().customer).toBe('call_relinked');
    expect(mockState.firsts.filter((t) => ['customers', 'call_log'].includes(t)).slice(-2)).toEqual(['customers', 'call_log']);
    expect(writeback().relinkedTo).toBe('cust-Q');
    // Unlinked (null) before the reply: no customer lock, the call row is STILL taken FOR UPDATE, no customer write.
    jest.clearAllMocks(); mockState.updates = []; mockState.firsts = [];
    mockState.firstQueue = [a, a, { id: 'call-1', customer_id: null }, { id: 'call-1', customer_id: null }, { id: 'lead-1', address: null }];
    r = await handleClarifyReply({ phone: '+17735550142', body: 'Apt 204' }); await r.repricePromise;
    expect(mockRecordCallProperty).not.toHaveBeenCalled();
    expect(mockState.updates.find((u) => u.table === 'customers')).toBeUndefined();
    expect(writeback()).toEqual(expect.objectContaining({ lead: 'filled', customer: 'skipped' }));
    expect(mockState.firsts.filter((t) => t === 'call_log')).toHaveLength(2);
    expect(mockState.firsts).not.toContain('customers');
    // A relink landing between the null read and the call lock (the relink committed first): the
    // locked read sees the new customer; that customer is NOT locked after the call (reverse order)
    // — the write is skipped and the audit names them.
    jest.clearAllMocks(); mockState.updates = []; mockState.firsts = [];
    mockState.firstQueue = [a, a, { id: 'call-1', customer_id: null }, { id: 'call-1', customer_id: 'cust-Q' }, { id: 'lead-1', address: null }];
    r = await handleClarifyReply({ phone: '+17735550142', body: 'Apt 204' }); await r.repricePromise;
    expect(mockRecordCallProperty).not.toHaveBeenCalled();
    expect(mockState.updates.find((u) => u.table === 'customers')).toBeUndefined();
    expect(writeback()).toEqual(expect.objectContaining({ lead: 'filled', customer: 'call_relinked', relinkedTo: 'cust-Q' }));
    expect(mockState.firsts).not.toContain('customers');
  });

  test('an operator UNLINK after the ask parked detaches the lead too: the cached unit_lead_id is not written; a relink that keeps the stamp still is', async () => {
    const a = AWAITING();
    mockState.existingDraft = a;
    // Unlink: customer null, lead stamp keys dropped, the lead's twilio_call_sid cleared.
    const unlinked = { id: 'call-1', customer_id: null, twilio_call_sid: 'CA-1', metadata: { customer_link_override: { customer_id: null } } };
    mockState.firstQueue = [a, a, unlinked, unlinked, { id: 'lead-1', address: null, twilio_call_sid: null }];
    let r = await handleClarifyReply({ phone: '+17735550142', body: 'Apt 204' }); await r.repricePromise;
    expect(r.handled).toBe(true);
    expect(mockState.updates.find((u) => u.table === 'leads')).toBeUndefined();
    expect(mockRecordCallProperty).not.toHaveBeenCalled();
    expect(writeback()).toEqual(expect.objectContaining({ lead: 'call_unlinked', customer: 'skipped' }));
    // Unlinked, then re-linked to a person: the lead stays detached (the stamp is not restored).
    jest.clearAllMocks(); mockState.updates = [];
    const relinkedLater = { id: 'call-1', customer_id: 'cust-Z', twilio_call_sid: 'CA-1', metadata: { customer_link_override: { customer_id: 'cust-Z' } } };
    mockState.firstQueue = [a, a, relinkedLater, { id: 'cust-Z', address_line1: null }, relinkedLater, { id: 'lead-1', address: null, twilio_call_sid: null }];
    r = await handleClarifyReply({ phone: '+17735550142', body: 'Apt 204' }); await r.repricePromise;
    expect(mockState.updates.find((u) => u.table === 'leads')).toBeUndefined();
    expect(mockRecordCallProperty).toHaveBeenCalledWith(expect.objectContaining({ customerId: 'cust-Z' }));
    expect(writeback().lead).toBe('call_unlinked');
    // A relink BETWEEN customers keeps the lead stamp: the lead is still the call's and gets the unit.
    jest.clearAllMocks(); mockState.updates = [];
    const moved = { id: 'call-1', customer_id: 'cust-Z', twilio_call_sid: 'CA-1', metadata: { lead_id: 'lead-1', customer_link_override: { customer_id: 'cust-Z' } } };
    mockState.firstQueue = [a, a, moved, { id: 'cust-Z', address_line1: null }, moved, { id: 'lead-1', address: null, twilio_call_sid: 'CA-1' }];
    r = await handleClarifyReply({ phone: '+17735550142', body: 'Apt 204' }); await r.repricePromise;
    expect(mockState.updates.find((u) => u.table === 'leads').payload.address).toMatch(/Apt 204/);
    expect(writeback().lead).toBe('filled');
  });

  test('a primary property CREATED from the mirror during write-back carries the clarify source and is enqueued for enrichment', async () => {
    mockEnsurePrimaryProperty.mockResolvedValue({ created: true, propertyId: 'prop-new-primary' });
    mockState.selectQueue = [[], [], []];
    await reply({ id: 'lead-1', address: null }, { id: 'cust-1', address_line1: '1048 Example Lakes Cir', address_line2: null, city: 'Sarasota', zip: '34232' });
    expect(mockEnsurePrimaryProperty).toHaveBeenCalledWith(expect.objectContaining({ id: 'cust-1', address_line2: 'Apt 204' }), { conn: expect.anything(), source: 'clarify_unit_reply' });
    expect(writeback()).toEqual(expect.objectContaining({ customer: 'line2_filled', propertyId: 'prop-new-primary', propertyCreated: true }));
    expect(mockEnqueueCallPropertyLookup).toHaveBeenCalledWith({ propertyId: 'prop-new-primary' });
  });

  test('lock order: the customer row is locked before the lead row (customer-address-fanout order)', async () => {
    await reply({ id: 'lead-1', address: null }, { id: 'cust-1', address_line1: null });
    const locked = mockState.firsts.filter((t) => ['customers', 'leads'].includes(t));
    expect(locked.slice(0, 2)).toEqual(['customers', 'leads']);
  });

  test('the card is the human verdict: a unit texted after staff closed the missing_unit_number card is kept on the ask only — no CRM writes', async () => {
    mockState.updateResults = [0]; // the triage_items stamp hits zero open/in_progress rows
    const result = await reply({ id: 'lead-1', address: null }, { id: 'cust-1', address_line1: null });
    expect(result.handled).toBe(true);
    expect(mockState.updates.find((u) => u.table === 'leads')).toBeUndefined();
    expect(mockState.updates.find((u) => u.table === 'customers')).toBeUndefined();
    expect(mockRecordCallProperty).not.toHaveBeenCalled();
    const flags = JSON.parse(mockState.updates.find((u) => u.table === 'message_drafts').payload.flags);
    expect(flags.unit_number_answer).toBe('Apt 204');
    expect(flags.unit_writeback).toEqual(expect.objectContaining({ lead: 'skipped', customer: 'skipped', reason: 'card_closed' }));
  });

  test('existing customer whose OWN address is the building: line 2 filled + primary synced; lead gets the unit as line 2', async () => {
    mockState.selectQueue = [[], [], []];
    const result = await reply(
      { id: 'lead-1', address: '1048 Example Lakes Cir, Sarasota, FL 34232' },
      { id: 'cust-1', address_line1: '1048 Example Lakes Circle', address_line2: null, city: 'Sarasota', zip: '34232' },
    );
    expect(result.handled).toBe(true);
    expect(mockState.updates.find((u) => u.table === 'leads').payload.address).toBe('1048 Example Lakes Cir, Apt 204, Sarasota, FL 34232');
    expect(mockState.updates.find((u) => u.table === 'customers').payload).toEqual({ address_line2: 'Apt 204' });
    expect(mockSyncPrimaryAddress).toHaveBeenCalledWith(expect.objectContaining({ id: 'cust-1', address_line2: 'Apt 204' }), expect.anything(), { explicitLine2: true, preserveCoords: true });
    // A customer with no primary property row yet gets one from the mirror, WITH the unit, before the sync.
    expect(mockEnsurePrimaryProperty).toHaveBeenCalledWith(expect.objectContaining({ id: 'cust-1', address_line2: 'Apt 204' }), { conn: expect.anything(), source: 'clarify_unit_reply' });
    expect(mockEnsurePrimaryProperty.mock.invocationCallOrder[0]).toBeLessThan(mockSyncPrimaryAddress.mock.invocationCallOrder[0]);
    expect(mockRecordCallProperty).not.toHaveBeenCalled();
    expect(writeback()).toEqual(expect.objectContaining({ lead: 'unit_added', customer: 'line2_filled' }));
  });

  test('a structural-only line 2 ("Bldg 9") is kept beside the replied unit on the mirror and the synced primary — never replaced by it (codex r18 P1 on #3804)', async () => {
    mockState.selectQueue = [[], [], []];
    await reply(
      { id: 'lead-1', address: null },
      { id: 'cust-1', address_line1: '1048 Example Lakes Cir', address_line2: 'Bldg 9', city: 'Sarasota', zip: '34232' },
    );
    expect(mockState.updates.find((u) => u.table === 'customers').payload).toEqual({ address_line2: 'Bldg 9 Apt 204' });
    expect(mockEnsurePrimaryProperty).toHaveBeenCalledWith(expect.objectContaining({ id: 'cust-1', address_line2: 'Bldg 9 Apt 204' }), { conn: expect.anything(), source: 'clarify_unit_reply' });
    expect(mockSyncPrimaryAddress).toHaveBeenCalledWith(expect.objectContaining({ id: 'cust-1', address_line2: 'Bldg 9 Apt 204' }), expect.anything(), { explicitLine2: true, preserveCoords: true });
    expect(mockRecordCallProperty).not.toHaveBeenCalled();
    expect(writeback().customer).toBe('line2_filled');
  });

  test('a customer whose line 2 is blank but whose PRIMARY property row at the building carries Apt 9: the primary is kept, Apt 204 becomes a secondary', async () => {
    mockState.selectQueue = [[], [], [{ id: 'prop-primary', is_primary: true, address_line1: '1048 Example Lakes Cir', address_line2: 'Apt 9', city: 'Sarasota', zip: '34232' }]];
    await reply({ id: 'lead-1', address: null }, { id: 'cust-1', address_line1: '1048 Example Lakes Cir', address_line2: null, city: 'Sarasota', zip: '34232' });
    expect(mockState.updates.find((u) => u.table === 'customers')).toBeUndefined();
    expect(mockSyncPrimaryAddress).not.toHaveBeenCalled();
    expect(mockRecordCallProperty).toHaveBeenCalledWith(expect.objectContaining({ customerId: 'cust-1', address_line2: 'Apt 204' }));
    expect(writeback().customer).toBe('second_property');
  });

  test('existing customer whose address is ELSEWHERE: the building + unit becomes a second property; their home is untouched; a drifted lead line is left alone', async () => {
    await reply(
      { id: 'lead-1', address: '5 Other Rd, Venice, FL 34285' },
      { id: 'cust-1', address_line1: '9 Home St', address_line2: null, city: 'Venice', zip: '34285' },
    );
    expect(mockState.updates.find((u) => u.table === 'leads')).toBeUndefined();
    expect(mockState.updates.find((u) => u.table === 'customers')).toBeUndefined();
    expect(mockRecordCallProperty).toHaveBeenCalledWith(expect.objectContaining({ customerId: 'cust-1', address_line2: 'Apt 204' }));
    expect(writeback()).toEqual(expect.objectContaining({ lead: 'different_building', customer: 'second_property' }));
    // The customer's OWN (mirror) address gets its primary row first, so the unit lands as the secondary.
    expect(mockEnsurePrimaryProperty).toHaveBeenCalledWith(expect.objectContaining({ id: 'cust-1', address_line1: '9 Home St' }), { conn: expect.anything(), source: 'clarify_unit_reply' });
    expect(mockEnsurePrimaryProperty.mock.invocationCallOrder[0]).toBeLessThan(mockRecordCallProperty.mock.invocationCallOrder[0]);
  });

  test('existing customer elsewhere with NO primary row yet: the mirror\'s primary is created first and enqueued, the unit is the secondary', async () => {
    mockEnsurePrimaryProperty.mockResolvedValue({ created: true, propertyId: 'prop-home' });
    await reply({ id: 'lead-1', address: null }, { id: 'cust-1', address_line1: '9 Home St', address_line2: null, city: 'Venice', zip: '34285' });
    expect(writeback()).toEqual(expect.objectContaining({ customer: 'second_property', propertyId: 'prop-1', primaryEnsuredId: 'prop-home' }));
    expect(mockEnqueueCallPropertyLookup).toHaveBeenCalledWith({ propertyId: 'prop-1' });
    expect(mockEnqueueCallPropertyLookup).toHaveBeenCalledWith({ propertyId: 'prop-home' });
  });

  test('an existing BUILDING-LEVEL property row at the address (a manager\'s common-area property, or the call\'s own unitless insert) is preserved — the unit becomes its own row, the old row is never rewritten', async () => {
    mockState.selectQueue = [[], [], [{ id: 'prop-bldg', is_primary: false, address_line1: '1048 Example Lakes Cir', address_line2: null, city: 'Sarasota', zip: '34232' }]];
    await reply(
      { id: 'lead-1', address: '5 Other Rd, Venice, FL 34285' },
      { id: 'cust-1', address_line1: '9 Home St', address_line2: null, city: 'Venice', zip: '34285' },
    );
    expect(mockState.updates.find((u) => u.table === 'customer_properties')).toBeUndefined();
    expect(mockRecordCallProperty).toHaveBeenCalledWith(expect.objectContaining({ customerId: 'cust-1', address_line1: '1048 Example Lakes Cir', address_line2: 'Apt 204' }));
    expect(writeback()).toEqual(expect.objectContaining({ customer: 'second_property', propertyId: 'prop-1' }));
    expect(mockEnqueueCallPropertyLookup).toHaveBeenCalledWith({ propertyId: 'prop-1' });
  });

  test('existing customer elsewhere with the exact unit already on file at the building: nothing is inserted or upgraded', async () => {
    mockState.selectQueue = [[], [], [{ id: 'prop-unit', address_line1: '1048 Example Lakes Cir', address_line2: 'Apt 204', city: 'Sarasota', zip: '34232' }]];
    await reply({ id: 'lead-1', address: null }, { id: 'cust-1', address_line1: '9 Home St', city: 'Venice', zip: '34285' });
    expect(mockRecordCallProperty).not.toHaveBeenCalled();
    expect(mockState.updates.find((u) => u.table === 'customer_properties')).toBeUndefined();
    expect(writeback().customer).toBe('property_exists');
  });

  test('a lead line that already carries a unit, and a customer whose own unit at the building IS the replied unit, are never overwritten', async () => {
    await reply(
      { id: 'lead-1', address: '1048 Example Lakes Cir Apt 204, Sarasota, FL 34232' },
      { id: 'cust-1', address_line1: '1048 Example Lakes Cir', address_line2: 'Apt 204', city: 'Sarasota', zip: '34232' },
    );
    expect(mockState.updates.find((u) => u.table === 'leads')).toBeUndefined();
    expect(mockState.updates.find((u) => u.table === 'customers')).toBeUndefined();
    expect(mockRecordCallProperty).not.toHaveBeenCalled();
    expect(writeback()).toEqual(expect.objectContaining({ lead: 'already_has_unit', customer: 'already_has_unit' }));
  });

  test('a customer whose own unit at the building is a DIFFERENT one keeps their primary; the replied unit is recorded as a secondary property', async () => {
    await reply(
      { id: 'lead-1', address: null },
      { id: 'cust-1', address_line1: '1048 Example Lakes Cir', address_line2: 'Apt 9', city: 'Sarasota', zip: '34232' },
    );
    expect(mockState.updates.find((u) => u.table === 'customers')).toBeUndefined();
    expect(mockSyncPrimaryAddress).not.toHaveBeenCalled();
    expect(mockRecordCallProperty).toHaveBeenCalledWith(expect.objectContaining({ customerId: 'cust-1', address_line1: '1048 Example Lakes Cir', address_line2: 'Apt 204' }));
    expect(writeback().customer).toBe('second_property');
  });

  test('a customer whose own unit differs but who ALREADY has the replied unit as a property row: nothing moves', async () => {
    mockState.selectQueue = [[], [], [{ id: 'prop-204', address_line1: '1048 Example Lakes Cir', address_line2: 'Apt 204', city: 'Sarasota', zip: '34232' }]];
    await reply({ id: 'lead-1', address: null }, { id: 'cust-1', address_line1: '1048 Example Lakes Cir', address_line2: 'Apt 9', city: 'Sarasota', zip: '34232' });
    expect(mockRecordCallProperty).not.toHaveBeenCalled();
    expect(mockState.updates.find((u) => u.table === 'customers')).toBeUndefined();
    expect(writeback().customer).toBe('property_exists');
  });

  test('unitless primary at the building + an existing property row for THIS unit: nothing moves (the unique address_key would collide)', async () => {
    mockState.selectQueue = [[], [], [{ address_line1: '1048 Example Lakes Cir', address_line2: 'Apt 204', city: 'Sarasota', zip: '34232' }]];
    await reply({ id: 'lead-1', address: null }, { id: 'cust-1', address_line1: '1048 Example Lakes Cir', address_line2: null, city: 'Sarasota', zip: '34232' });
    expect(mockState.updates.find((u) => u.table === 'customers')).toBeUndefined();
    expect(mockSyncPrimaryAddress).not.toHaveBeenCalled();
    expect(writeback().customer).toBe('property_exists');
  });

  test('a customer row with the unit INLINE on line 1 (the replied unit) is never given a second unit', async () => {
    await reply({ id: 'lead-1', address: null }, { id: 'cust-1', address_line1: '1048 Example Lakes Cir Apt 204', address_line2: null, city: 'Sarasota', zip: '34232' });
    expect(mockState.updates.find((u) => u.table === 'customers')).toBeUndefined();
    expect(mockSyncPrimaryAddress).not.toHaveBeenCalled();
    expect(mockRecordCallProperty).not.toHaveBeenCalled();
  });

  test('locality: a stored line on the same street with NO city/ZIP is not written to (the duplicate guard\'s conservative match is not a write match); a stored city that agrees is', async () => {
    // Lead + customer both "1048 Example Lakes Cir" with no locality: the
    // lead line is left alone, and the customer is treated as living
    // ELSEWHERE — the localized building + unit becomes a property row.
    await reply({ id: 'lead-1', address: '1048 Example Lakes Cir' }, { id: 'cust-1', address_line1: '1048 Example Lakes Cir', address_line2: null, city: null, zip: null });
    expect(mockState.updates.find((u) => u.table === 'leads')).toBeUndefined();
    expect(mockState.updates.find((u) => u.table === 'customers')).toBeUndefined();
    expect(mockRecordCallProperty).toHaveBeenCalledWith(expect.objectContaining({ address_line1: '1048 Example Lakes Cir', address_line2: 'Apt 204', city: 'Sarasota', zip: '34232' }));
    expect(writeback()).toEqual(expect.objectContaining({ lead: 'different_building', customer: 'second_property' }));
    jest.clearAllMocks(); mockState.updates = []; mockState.firsts = [];
    mockRecordCallProperty.mockResolvedValue({ created: true, propertyId: 'prop-1' });
    // City agrees, ZIP absent: a positive locality match → written.
    await reply({ id: 'lead-1', address: '1048 Example Lakes Cir, Sarasota' }, { id: 'cust-1', address_line1: '1048 Example Lakes Cir', address_line2: null, city: 'Sarasota', zip: null });
    expect(mockState.updates.find((u) => u.table === 'leads').payload.address).toMatch(/Apt 204/);
    expect(mockState.updates.find((u) => u.table === 'customers').payload).toEqual({ address_line2: 'Apt 204' });
  });

  test('locality: a property row on the same street carrying Apt 204 but NO locality is not the building — the localized unit row is still recorded', async () => {
    mockState.selectQueue = [[], [], [{ id: 'prop-nowhere', address_line1: '1048 Example Lakes Cir', address_line2: 'Apt 204', city: null, zip: null }]];
    await reply({ id: 'lead-1', address: null }, { id: 'cust-1', address_line1: '9 Home St', city: 'Venice', zip: '34285' });
    expect(mockRecordCallProperty).toHaveBeenCalled();
    expect(writeback().customer).toBe('second_property');
  });

  test('locality: a city name inside the STREET ("123 Venice Ave", no locality) does not pass as Venice — nothing is written to that line', async () => {
    const VENICE = { street_line_1: '123 Venice Ave', city: 'Venice', postal_code: '34285' };
    await reply({ id: 'lead-1', address: '123 Venice Ave' }, { id: 'cust-1', address_line1: '123 Venice Ave', address_line2: null, city: null, zip: null }, { unit_ask_building: VENICE });
    expect(mockState.updates.find((u) => u.table === 'leads')).toBeUndefined();
    expect(mockState.updates.find((u) => u.table === 'customers')).toBeUndefined();
    expect(mockRecordCallProperty).toHaveBeenCalledWith(expect.objectContaining({ address_line1: '123 Venice Ave', city: 'Venice' }));
    jest.clearAllMocks(); mockState.updates = []; mockState.firsts = [];
    mockRecordCallProperty.mockResolvedValue({ created: true, propertyId: 'prop-1' });
    await reply({ id: 'lead-1', address: '123 Venice Ave, Venice, FL' }, { id: 'cust-1', address_line1: '123 Venice Ave', address_line2: null, city: 'Venice', zip: null }, { unit_ask_building: VENICE });
    expect(mockState.updates.find((u) => u.table === 'leads').payload.address).toMatch(/Apt 204/);
    expect(mockState.updates.find((u) => u.table === 'customers').payload).toEqual({ address_line2: 'Apt 204' });
  });

  test('a correcting or two-unit reply ("Not Apt 204, it\'s Apt 205") is not an answer: nothing is written, the reply stays with the humans', async () => {
    const result = await reply({ id: 'lead-1', address: null }, { id: 'cust-1', address_line1: null }, {}, "Not Apt 204, it's Apt 205");
    expect(result.handled).toBe(false);
    expect(mockState.updates).toHaveLength(0);
    expect(mockRecordCallProperty).not.toHaveBeenCalled();
  });

  test('legacy in-flight ask (no unit_* targets): targets come from the unit\'s OWN call row (metadata lead stamp first), never the merged generic linkage — even after a non-call merge flipped call_origin to false', async () => {
    const a = AWAITING({ lead_id: 'lead-B', call_origin: false, unit_lead_id: undefined, unit_customer_id: undefined }, { customer_id: 'cust-B' });
    mockState.existingDraft = a;
    // first() order: fresh, call_log (A), lead by A's metadata stamp, customer (locked), lead.
    mockState.firstQueue = [a, a,
      { id: 'call-1', customer_id: 'cust-A', twilio_call_sid: 'CA-A', metadata: { lead_id: 'lead-A' } },
      { id: 'lead-A' },
      { id: 'cust-A', address_line1: null },
      { id: 'call-1', customer_id: 'cust-A' },
      { id: 'lead-A', address: null },
    ];
    const result = await handleClarifyReply({ phone: '+17735550142', body: 'Apt 204' });
    await result.repricePromise;
    expect(mockState.updates.find((u) => u.table === 'leads').payload.address).toMatch(/Apt 204/);
    expect(mockRecordCallProperty).toHaveBeenCalledWith(expect.objectContaining({ customerId: 'cust-A' }));
    expect(mockRecordCallProperty).not.toHaveBeenCalledWith(expect.objectContaining({ customerId: 'cust-B' }));
  });

  test('gate OFF: card stamp only — no CRM writes', async () => {
    mockIsEnabled.mockImplementation((key) => key === 'estimateClarifyAsks');
    const a = AWAITING();
    mockState.firstQueue = [a, a];
    const result = await handleClarifyReply({ phone: '+17735550142', body: 'Apt 204' });
    await result.repricePromise;
    expect(mockState.updates.find((u) => u.table === 'triage_items')).toBeDefined();
    expect(mockState.updates.find((u) => u.table === 'leads')).toBeUndefined();
    expect(mockRecordCallProperty).not.toHaveBeenCalled();
    expect(mockMaybeDraftEstimateForCall).not.toHaveBeenCalled();
    // No fence on the call row either — gate off reads and writes nothing.
    expect(mockState.updates.find((u) => u.table === 'call_log')).toBeUndefined();
  });

  describe('approval-time evidence (gate ON)', () => {
    const DRAFT = { id: 'draft-1', source_ref: 'clarify:7735550142' };
    const freshRow = (flags = {}) => ({
      id: 'draft-1', source_ref: 'clarify:7735550142', customer_id: 'cust-1', status: 'approved', sent_at: null,
      draft_response: 'Unit?', final_response: null,
      flags: JSON.stringify({ missing: ['unit_number'], toPhone: '+17735550142', lead_id: 'lead-1', call_origin: true, unit_call_log_id: 'call-1', unit_ask_building: BUILDING, unit_lead_id: 'lead-1', unit_customer_id: 'cust-1', ...flags }),
    });
    // first() order: fresh, lead(lead_id), customer(customer_id), card, lead(unit_lead_id), customer(unit_customer_id); then select() for properties.
    test('a unit on the lead line AT the building retires the ask', async () => {
      const lead = { id: 'lead-1', status: 'new', address: '1048 Example Lakes Cir, Apt 204, Sarasota, FL 34232', first_name: 'Anna' };
      const cust = { id: 'cust-1', first_name: 'Anna', address_line1: '9 Home St', address_line2: null };
      mockState.firstQueue = [freshRow(), lead, cust, { id: 'card-1' }, { id: 'call-1', customer_id: 'cust-1' }, lead, cust];
      mockState.selectQueue = [[]];
      expect((await claimClarifyDispatch({ draft: DRAFT })).outcome).toBe('retired');
    });

    test('the unit item\'s OWN lead carrying a unit at the building retires the ask even when the account has other units there', async () => {
      const lead = { id: 'lead-1', status: 'new', address: '1048 Example Lakes Cir, Apt 204, Sarasota, FL 34232', first_name: 'Pat' };
      const cust = { id: 'cust-1', first_name: 'Pat', address_line1: '9 Home St', address_line2: null };
      mockState.firstQueue = [freshRow(), lead, cust, { id: 'card-1' }, { id: 'call-1', customer_id: 'cust-1' }, lead, cust];
      mockState.selectQueue = [[{ address_line1: '1048 Example Lakes Cir', address_line2: 'Apt 101', city: 'Sarasota', zip: '34232' }]];
      expect((await claimClarifyDispatch({ draft: DRAFT })).outcome).toBe('retired');
    });

    test('a unit-first lead line with a city but no ZIP ("Apt 204, 1048 …, Sarasota") is evidence at the building — locality parsed after the peel (codex r3 P2 on #3804)', async () => {
      const lead = { id: 'lead-1', status: 'new', address: 'Apt 204, 1048 Example Lakes Cir, Sarasota', first_name: 'Anna' };
      const cust = { id: 'cust-1', first_name: 'Anna', address_line1: '9 Home St', address_line2: null };
      mockState.firstQueue = [freshRow(), lead, cust, { id: 'card-1' }, { id: 'call-1', customer_id: 'cust-1' }, lead, cust];
      mockState.selectQueue = [[]];
      expect((await claimClarifyDispatch({ draft: DRAFT })).outcome).toBe('retired');
    });

    test('SEVERAL units on file at the building (a property manager) do not answer WHICH one — the ask stands', async () => {
      const lead = { id: 'lead-1', status: 'new', address: '1048 Example Lakes Cir', first_name: 'Pat' };
      const cust = { id: 'cust-1', first_name: 'Pat', address_line1: '9 Home St', address_line2: null };
      mockState.firstQueue = [freshRow(), lead, cust, { id: 'card-1' }, { id: 'call-1', customer_id: 'cust-1' }, lead, cust];
      mockState.selectQueue = [[
        { address_line1: '1048 Example Lakes Cir', address_line2: 'Apt 101', city: 'Sarasota', zip: '34232' },
        { address_line1: '1048 Example Lakes Cir Apt 202', address_line2: null, city: 'Sarasota', zip: '34232' },
      ]];
      expect((await claimClarifyDispatch({ draft: DRAFT })).outcome).toBe('send');
    });
    test('a unit on a DIFFERENT building, or the customer\'s home unit, is not evidence; a property row at the building is', async () => {
      const lead = { id: 'lead-1', status: 'new', address: '5 Other Rd, Apt 3, Venice, FL 34285', first_name: 'Anna' };
      const cust = { id: 'cust-1', first_name: 'Anna', address_line1: '9 Home St', address_line2: 'Apt 7', city: 'Venice', zip: '34285' };
      mockState.firstQueue = [freshRow(), lead, cust, { id: 'card-1' }, { id: 'call-1', customer_id: 'cust-1' }, lead, cust];
      mockState.selectQueue = [[]];
      expect((await claimClarifyDispatch({ draft: DRAFT })).outcome).toBe('send');
      mockState.updates = [];
      mockState.firstQueue = [freshRow(), lead, cust, { id: 'card-1' }, { id: 'call-1', customer_id: 'cust-1' }, lead, cust];
      mockState.selectQueue = [[{ address_line1: '1048 Example Lakes Circle', address_line2: 'Apt 204', city: 'Sarasota', zip: '34232' }]];
      expect((await claimClarifyDispatch({ draft: DRAFT })).outcome).toBe('retired');
    });
    test('a lone "same street" row with NO locality is not evidence that THIS building\'s unit is on file — the ask stands', async () => {
      const lead = { id: 'lead-1', status: 'new', address: '1048 Example Lakes Cir Apt 204', first_name: 'Pat' };
      const cust = { id: 'cust-1', first_name: 'Pat', address_line1: '1048 Example Lakes Cir', address_line2: 'Apt 204', city: null, zip: null };
      mockState.firstQueue = [freshRow(), lead, cust, { id: 'card-1' }, { id: 'call-1', customer_id: 'cust-1' }, lead, cust];
      mockState.selectQueue = [[{ address_line1: '1048 Example Lakes Cir', address_line2: 'Apt 204', city: null, zip: null }]];
      expect((await claimClarifyDispatch({ draft: DRAFT })).outcome).toBe('send');
    });

    test('a STRUCTURAL-only line 2 ("Bldg 9", "Floor 2") on the customer or a property row is not unit evidence — the ask stands; a bare "204" line 2 still is (codex r17 P1 on #3804)', async () => {
      const lead = { id: 'lead-1', status: 'new', address: '1048 Example Lakes Cir', first_name: 'Pat' };
      const cust = { id: 'cust-1', first_name: 'Pat', address_line1: '1048 Example Lakes Cir', address_line2: 'Bldg 9', city: 'Sarasota', zip: '34232' };
      mockState.firstQueue = [freshRow(), lead, cust, { id: 'card-1' }, { id: 'call-1', customer_id: 'cust-1' }, lead, cust];
      mockState.selectQueue = [[{ address_line1: '1048 Example Lakes Cir', address_line2: 'Floor 2', city: 'Sarasota', zip: '34232' }]];
      expect((await claimClarifyDispatch({ draft: DRAFT })).outcome).toBe('send');
      mockState.updates = [];
      const bare = { ...cust, address_line2: '204' };
      mockState.firstQueue = [freshRow(), lead, bare, { id: 'card-1' }, { id: 'call-1', customer_id: 'cust-1' }, lead, bare];
      mockState.selectQueue = [[]];
      expect((await claimClarifyDispatch({ draft: DRAFT })).outcome).toBe('retired');
    });

    test('a lead the operator detached from the call (unlink) is not evidence for this ask — the ask stands', async () => {
      const lead = { id: 'lead-1', status: 'new', address: '1048 Example Lakes Cir, Apt 204, Sarasota, FL 34232', first_name: 'Anna', twilio_call_sid: null };
      const cust = { id: 'cust-1', first_name: 'Anna', address_line1: '9 Home St', address_line2: null };
      const unlinked = { id: 'call-1', customer_id: null, twilio_call_sid: 'CA-1', metadata: { customer_link_override: { customer_id: null } } };
      mockState.firstQueue = [freshRow(), lead, cust, { id: 'card-1' }, unlinked, lead];
      mockState.selectQueue = [[]];
      expect((await claimClarifyDispatch({ draft: DRAFT })).outcome).toBe('send');
    });

    test('gate OFF: CRM state is not read — only the card decides', async () => {
      mockIsEnabled.mockImplementation((key) => key === 'estimateClarifyAsks');
      const lead = { id: 'lead-1', status: 'new', address: '1048 Example Lakes Cir, Apt 204, Sarasota, FL 34232', first_name: 'Anna' };
      mockState.firstQueue = [freshRow(), lead, { id: 'cust-1', first_name: 'Anna' }, { id: 'card-1' }];
      expect((await claimClarifyDispatch({ draft: DRAFT })).outcome).toBe('send');
    });
  });
});

describe('unit hold (GATE_CLARIFY_UNIT_WRITEBACK — PR C2a: call-row fence + every-live-draft hold + one operator bell, no re-run)', () => {
  const BUILDING = { street_line_1: '1048 Example Lakes Cir', city: 'Sarasota', postal_code: '34232' };
  const gateOn = () => mockIsEnabled.mockImplementation((key) => key === 'estimateClarifyAsks' || key === 'clarifyUnitWriteback');
  const AWAITING = (flags = {}) => ({
    id: 'sent-1', customer_id: 'cust-1', status: 'approved', sent_at: '2026-09-03T12:00:00Z',
    flags: JSON.stringify({
      missing: ['unit_number'], lead_id: 'lead-1', call_origin: true,
      unit_call_log_id: 'call-1', unit_ask_building: BUILDING, unit_lead_id: 'lead-1', unit_customer_id: 'cust-1', ...flags,
    }),
  });
  // first() order in the locked phase: fresh draft, the unit call's row (unlocked target),
  // customer (locked first), the call row FOR UPDATE, lead. select() order: pass-1 live drafts,
  // pass-2 live drafts (under the call-row lock), customer_properties.
  const reply = async ({ leadRow = { id: 'lead-1', address: null }, customerRow = { id: 'cust-1', address_line1: null }, drafts = [], drafts2 = null, props = [], flags = {}, body = 'Apt 204' } = {}) => {
    const a = AWAITING(flags);
    mockState.existingDraft = a;
    const callRow = { id: 'call-1', customer_id: customerRow?.id || null };
    mockState.firstQueue = [a, a, callRow, ...(customerRow ? [customerRow] : []), callRow, leadRow];
    mockState.selectQueue = [drafts, drafts2 ?? drafts, props];
    const result = await handleClarifyReply({ phone: '+17735550142', body });
    await result.repricePromise;
    return result;
  };
  const stamps = () => mockState.updates.filter((u) => u.table === 'message_drafts').map((u) => { try { return JSON.parse(u.payload.flags); } catch { return {}; } });
  const fenceRaw = () => mockState.raws.find((r) => /jsonb_set\(COALESCE\(metadata/.test(r.sql) && Array.isArray(r.params) && r.params[0] === '{unit_answer}');
  const guardUpdates = () => mockState.updates.filter((u) => u.table === 'estimates' && u.payload.estimate_data && /reprice_pending_at/.test(u.payload.estimate_data.__raw || ''));
  const unscheduleUpdates = () => mockState.updates.filter((u) => u.table === 'estimates' && u.payload.status === 'draft' && u.payload.scheduled_at === null);
  beforeEach(() => {
    gateOn();
    mockSmsThreadDraftsEnabled.mockReturnValue(true);
    mockStartSmsThreadDraft.mockResolvedValue({ started: true });
  });

  test('no draft yet: the unit + building are stamped on the call row as the creators\' fence; nothing is held, nothing bells, nothing re-drafts', async () => {
    const result = await reply();
    expect(result.handled).toBe(true);
    const fence = fenceRaw();
    expect(fence).toBeDefined();
    expect(JSON.parse(fence.params[1])).toEqual(expect.objectContaining({ unit: 'Apt 204', building: BUILDING, ask_draft_id: 'sent-1' }));
    expect(mockState.updates.find((u) => u.table === 'call_log')).toBeDefined();
    expect(stamps().at(-1).unit_writeback.fence).toBe('stamped');
    expect(guardUpdates()).toHaveLength(0);
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
    expect(mockMaybeDraftEstimateForCall).not.toHaveBeenCalled();
    expect(mockStartSmsThreadDraft).not.toHaveBeenCalled();
    expect(mockRecordCallProperty).toHaveBeenCalled();
  });

  test('lock order: the call\'s live drafts are enumerated FOR UPDATE before the customer and lead rows; the second pass runs under the call-row lock', async () => {
    await reply({ drafts: [{ id: 'est-1', status: 'draft' }] });
    expect(mockState.selects.indexOf('estimates')).toBeGreaterThan(-1);
    expect(mockState.selects.filter((t) => t === 'estimates')).toHaveLength(2);
    expect(mockState.firsts.filter((t) => ['customers', 'leads'].includes(t)).slice(0, 2)).toEqual(['customers', 'leads']);
  });

  test('the card is the human verdict: a unit texted after the card closed writes no fence and holds nothing', async () => {
    mockState.updateResults = [0];
    await reply({ drafts: [{ id: 'est-1', status: 'draft' }] });
    expect(fenceRaw()).toBeUndefined();
    expect(mockState.updates.find((u) => u.table === 'estimates')).toBeUndefined();
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
    expect(stamps().at(-1).unit_writeback).toEqual(expect.objectContaining({ reason: 'card_closed' }));
  });

  test('a live building-level draft is HELD: guarded under one attempt token in the locked phase, unscheduled after commit, recorded on the ask, ONE bell naming it; no re-run', async () => {
    await reply({ drafts: [{ id: 'est-1', status: 'scheduled' }] });
    expect(guardUpdates()).toHaveLength(1);
    expect(unscheduleUpdates()).toHaveLength(1);
    const hold = stamps().find((f) => f.unit_hold)?.unit_hold;
    expect(hold).toEqual(expect.objectContaining({ estimate_id: 'est-1', estimate_ids: ['est-1'], unit: 'Apt 204' }));
    expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
    expect(mockNotifyAdmin).toHaveBeenCalledWith('lead', 'Unit number received — re-draft the estimate', expect.stringMatching(/whole building/), expect.objectContaining({
      link: '/admin/estimates?estimateId=est-1', metadata: expect.objectContaining({ unit: 'Apt 204', estimateIds: ['est-1'] }),
    }));
    expect(mockMaybeDraftEstimateForCall).not.toHaveBeenCalled();
  });

  test('EVERY live unsent draft at the building is held (legacy composer races), newest first; a same-call draft for ANOTHER property and one that ALREADY names the unit are left alone; an addressless row is held', async () => {
    await reply({ drafts: [
      { id: 'est-newer', status: 'scheduled', address: '1048 Example Lakes Circle, Sarasota, FL 34232' },
      { id: 'est-elsewhere', status: 'scheduled', address: '5 Other Rd, Venice, FL 34285' },
      { id: 'est-correct', status: 'draft', address: 'Unit 204, 1048 Example Lakes Cir, Sarasota, FL 34232' },
      { id: 'est-bldg', status: 'draft', address: 'Bldg 9, 1048 Example Lakes Cir, Sarasota, FL 34232' },
      { id: 'est-noaddr', status: 'draft', address: null },
    ] });
    expect(guardUpdates()).toHaveLength(3);
    expect(stamps().find((f) => f.unit_hold).unit_hold.estimate_ids).toEqual(['est-newer', 'est-bldg', 'est-noaddr']);
    expect(unscheduleUpdates()).toHaveLength(3);
    expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
    expect(mockNotifyAdmin).toHaveBeenCalledWith('lead', expect.any(String), expect.stringMatching(/3 unsent estimates/), expect.objectContaining({ link: '/admin/estimates?estimateId=est-newer' }));
  });

  test('a draft that appeared between the first lookup and the call-row lock is caught by the second pass and held', async () => {
    await reply({ drafts: [], drafts2: [{ id: 'est-late', status: 'draft' }] });
    expect(guardUpdates()).toHaveLength(1);
    expect(stamps().find((f) => f.unit_hold).unit_hold.estimate_id).toBe('est-late');
  });

  test('a draft that already names the answered unit and nothing stale: recorded, no hold, no bell', async () => {
    await reply({ drafts: [{ id: 'est-correct', status: 'draft', address: '1048 Example Lakes Cir Apt 204, Sarasota, FL 34232' }] });
    expect(guardUpdates()).toHaveLength(0);
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
    expect(stamps().some((f) => f.unit_draft_already_correct === 'est-correct')).toBe(true);
  });

  test('a SENDING row is still held (the send path re-checks the marker before the provider call)', async () => {
    await reply({ drafts: [{ id: 'est-sending', status: 'sending' }] });
    expect(guardUpdates()).toHaveLength(1);
    expect(stamps().find((f) => f.unit_hold).unit_hold.estimate_ids).toEqual(['est-sending']);
  });

  test('a lead line with only a STRUCTURAL component ("Bldg 9, 1048 …") still lacks the apartment: the dwelling unit is added, the building part kept', async () => {
    await reply({ leadRow: { id: 'lead-1', address: 'Bldg 9, 1048 Example Lakes Cir, Sarasota, FL 34232' } });
    const lead = mockState.updates.find((u) => u.table === 'leads');
    expect(lead).toBeDefined();
    // Rebuilt from the PEELED street: the unpeeled parse read "Bldg 9" as the
    // street and dropped Sarasota (codex r4 P1 on #3804).
    expect(lead.payload.address).toBe('1048 Example Lakes Cir, Bldg 9 Apt 204, Sarasota, FL 34232');
    expect(stamps().at(-1).unit_writeback.lead).toBe('unit_added');
  });

  test('a STREET-FIRST structural lead line ("1048 …, Bldg 9, Sarasota") gets the apartment beside the building part — never a silent unitless write reported as unit_added (codex r8 P1)', async () => {
    await reply({ leadRow: { id: 'lead-1', address: '1048 Example Lakes Cir, Bldg 9, Sarasota, FL 34232' } });
    const lead = mockState.updates.find((u) => u.table === 'leads');
    expect(lead).toBeDefined();
    expect(lead.payload.address).toBe('1048 Example Lakes Cir, Bldg 9 Apt 204, Sarasota, FL 34232');
    expect(stamps().at(-1).unit_writeback.lead).toBe('unit_added');
  });

  test('write-back with a unit-first CRM line ("Apt 9, 1048 …") never adds a second unit to the lead or the customer', async () => {
    await reply({
      leadRow: { id: 'lead-1', address: 'Apt 9, 1048 Example Lakes Cir, Sarasota, FL 34232' },
      customerRow: { id: 'cust-1', address_line1: 'Apt 9, 1048 Example Lakes Cir', address_line2: null, city: 'Sarasota', zip: '34232' },
    });
    expect(mockState.updates.find((u) => u.table === 'leads')).toBeUndefined();
    expect(mockState.updates.find((u) => u.table === 'customers')).toBeUndefined();
    expect(stamps().at(-1).unit_writeback.lead).toBe('already_has_unit');
    // The customer's own unit differs → the replied unit is a secondary property, never a contradictory line 2.
    expect(mockRecordCallProperty).toHaveBeenCalledWith(expect.objectContaining({ customerId: 'cust-1', address_line2: 'Apt 204' }));
  });

  test('a bedroom answer on the same ask keeps main\'s bedroom re-price path (the unit hold never touches it); the re-run adopts the fence on its own', async () => {
    const uuid = jest.spyOn(require('crypto'), 'randomUUID');
    mockMaybeDraftEstimateForCall.mockResolvedValue({ lane: 'green', created: true, estimateId: 'est-new' });
    const a = AWAITING({ missing: ['unit_number', 'bedroom_count'], bedroom_estimate_id: 'est-1' });
    mockState.existingDraft = a;
    const callRow = { id: 'call-1', customer_id: 'cust-1' };
    // …then estimateComposedFromCall reads the bedroom draft row (same call ⇒ the hold's token), the hold +
    // bedroom flag stamps re-read the ask row, and voiceOriginCallLogId reads the bedroom draft row again.
    const bedroomDraft = { estimate_data: { estimatorEngine: { callLogId: 'call-1' } } };
    mockState.firstQueue = [a, a, callRow, { id: 'cust-1', address_line1: null }, callRow, { id: 'lead-1', address: null }, bedroomDraft, a, a, bedroomDraft];
    mockState.selectQueue = [[{ id: 'est-1', status: 'draft' }], [{ id: 'est-1', status: 'draft' }], []];
    const result = await handleClarifyReply({ phone: '+17735550142', body: 'Apt 204, 2 bedrooms' });
    await result.repricePromise;
    expect(mockMaybeDraftEstimateForCall).toHaveBeenCalledWith(expect.objectContaining({ callLogId: 'call-1', supersedeEstimateId: 'est-1', supersedeReason: 'clarify_bedroom_reply', bedroomCountOverride: 2 }));
    // The unit hold still fired on the same row (the bedroom attempt is the newer marker).
    expect(fenceRaw()).toBeDefined();
    // Same call ⇒ the re-run carries the unit hold's attempt token — the first UUID minted — so the
    // call's other held rows pass the replacement instead of reading as duplicate_call_draft (codex r4 P2).
    const holdAttempt = uuid.mock.results[0].value;
    expect(mockMaybeDraftEstimateForCall).toHaveBeenCalledWith(expect.objectContaining({ supersedeAttempt: holdAttempt }));
    expect(guardStampAttempt(mockState)).toBe(holdAttempt);
    uuid.mockRestore();
  });

  test('a bedroom draft composed from ANOTHER call (phone-scoped merge) gets its OWN re-price token, never the unit hold\'s (codex r14 P2 on #3804)', async () => {
    const uuid = jest.spyOn(require('crypto'), 'randomUUID');
    mockMaybeDraftEstimateForCall.mockResolvedValue({ lane: 'green', created: true, estimateId: 'est-new' });
    const a = AWAITING({ missing: ['unit_number', 'bedroom_count'], bedroom_estimate_id: 'est-1' });
    mockState.existingDraft = a;
    const callRow = { id: 'call-1', customer_id: 'cust-1' };
    // call B's draft is not among call A's unsent drafts, so the hold guards nothing.
    const otherCallDraft = { estimate_data: { estimatorEngine: { callLogId: 'call-2' } } };
    // Nothing held ⇒ no hold re-read of the ask row: one fewer `a` than the same-call case.
    mockState.firstQueue = [a, a, callRow, { id: 'cust-1', address_line1: null }, callRow, { id: 'lead-1', address: null }, otherCallDraft, a, otherCallDraft];
    mockState.selectQueue = [[], [], []];
    const result = await handleClarifyReply({ phone: '+17735550142', body: 'Apt 204, 2 bedrooms' });
    await result.repricePromise;
    const holdAttempt = uuid.mock.results[0].value;
    const bedroomAttempt = guardStampAttempt(mockState);
    expect(bedroomAttempt).toBeTruthy();
    expect(bedroomAttempt).not.toBe(holdAttempt);
    expect(mockMaybeDraftEstimateForCall).toHaveBeenCalledWith(expect.objectContaining({ supersedeEstimateId: 'est-1', supersedeAttempt: bedroomAttempt }));
    uuid.mockRestore();
  });});

describe('clarifyPreDispatchCheck — write-back evidence (gate ON)', () => {
  test('a unit recorded at the building while validators ran aborts the send', async () => {
    mockIsEnabled.mockImplementation((key) => key === 'estimateClarifyAsks' || key === 'clarifyUnitWriteback');
    const BUILDING = { street_line_1: '1048 Example Lakes Cir', city: 'Sarasota', postal_code: '34232' };
    const row = { id: 'draft-1', status: 'approved', sent_at: null, customer_id: 'cust-1',
      flags: JSON.stringify({ missing: ['unit_number'], unit_call_log_id: 'call-1', unit_ask_building: BUILDING, unit_lead_id: 'lead-1', unit_customer_id: 'cust-1' }) };
    // first(): fresh, card (open), lead, customer; select(): properties.
    mockState.firstQueue = [row, { id: 'card-1' }, { id: 'call-1', customer_id: 'cust-1' }, { id: 'lead-1', address: '1048 Example Lakes Cir, Apt 204, Sarasota, FL 34232' }, { id: 'cust-1', address_line1: '9 Home St' }];
    mockState.selectQueue = [[]];
    const verdict = await clarifyPreDispatchCheck({ draftId: 'draft-1', sourceRef: 'clarify:7735550142', dispatchedMissing: ['unit_number'] })();
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/unit was recorded/);
  });
});
