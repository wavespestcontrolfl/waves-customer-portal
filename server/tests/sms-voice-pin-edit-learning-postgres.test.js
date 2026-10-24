// GATE_SMS_VOICE_PROFILE_PIN + GATE_SMS_EDIT_LEARNING against Postgres. Synthetic fixtures only; each test runs in a
// transaction that is rolled back. Discovered by CI's serial DB-gated step; skipped without DATABASE_URL.
const SKIP = !process.env.DATABASE_URL;
const suite = SKIP ? describe.skip : describe;
const { randomUUID } = require('node:crypto');
const knex = require('knex');

let mockDb;
jest.mock('../models/db', () => new Proxy((...args) => mockDb(...args), {
  get: (_, key) => typeof mockDb[key] === 'function' ? mockDb[key].bind(mockDb) : mockDb[key],
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const logger = require('../services/logger');
const drafter = require('../services/sms-shadow-drafter');
const { getApprovedVoiceProfile } = require('../services/voice-profile-distiller');
const { _test: { mineSmsPairs } } = require('../services/sms-voice-corpus-miner');

jest.setTimeout(30000);

const HOUR = 3600 * 1000;
const GATES = ['GATE_SMS_VOICE_PROFILE_PIN', 'GATE_SMS_EDIT_LEARNING'];

suite('voice profile pin and edit learning (PostgreSQL)', () => {
  let database;
  let saved;
  let phoneSeq = 0;

  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL);
    const ci = process.env.CI === 'true' && url.hostname === 'localhost' && url.pathname === '/waves_test';
    if (!ci && !(process.env.WAVES_DATABASE_ENVIRONMENT === 'test' && /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname))) {
      throw new Error('Select the task-owned synthetic development database');
    }
    database = knex({ client: 'pg', connection: url.href, pool: { min: 0, max: 1 } });
  });
  beforeEach(async () => {
    saved = GATES.map((k) => [k, process.env[k]]);
    GATES.forEach((k) => delete process.env[k]);
    logger.warn.mockClear();
    mockDb = await database.transaction();
  });
  afterEach(async () => {
    await mockDb?.rollback();
    saved.forEach(([k, v]) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  });
  afterAll(async () => { await database?.destroy(); });

  async function addCustomer() {
    phoneSeq += 1;
    const [row] = await mockDb('customers').insert({ first_name: 'Synthetic', phone: `+1555555${String(1000 + phoneSeq).slice(-4)}`, active: true }).returning('id');
    return row.id;
  }
  async function addSms({ customerId, direction = 'outbound', body, type = 'manual', metadata = null, at, status = 'delivered' }) {
    const [row] = await mockDb('sms_log').insert({
      customer_id: customerId, direction, message_body: body, message_type: type, status,
      from_phone: direction === 'outbound' ? '+15555550100' : '+15555550111',
      to_phone: direction === 'outbound' ? '+15555550111' : '+15555550100',
      metadata: metadata ? JSON.stringify(metadata) : null, created_at: at,
    }).returning('id');
    return row.id;
  }
  async function addDecision(verdict) {
    const [row] = await mockDb('agent_decisions').insert({
      workflow: 'sms_house_voice_suggest', agent_name: 'House Voice Drafter', decision_version: 'test', status: verdict, human_verdict: verdict,
    }).returning('id');
    return row.id;
  }

  describe('GATE_SMS_VOICE_PROFILE_PIN', () => {
    async function seedProfiles() {
      await mockDb('voice_profiles').del();
      await mockDb('voice_profiles').insert([
        { version: 1, profile_text: 'profile one', status: 'superseded' },
        { version: 2, profile_text: 'profile two', status: 'approved' },
        { version: 3, profile_text: 'profile three', status: 'pending' },
        { version: 4, profile_text: 'profile four', status: 'rejected' },
      ]);
    }

    test('unset: the newest approved profile, exactly as before', async () => {
      await seedProfiles();
      expect((await drafter.resolveEffectiveVoiceProfile({ dbi: mockDb })).version).toBe(2);
      expect((await drafter.fetchVoiceProfileForDrafter({ dbi: mockDb })).version).toBe(2);
      expect(logger.warn).not.toHaveBeenCalled();
    });

    test('pinned to a once-approved version: the drafter reads THAT profile, even a superseded one', async () => {
      await seedProfiles();
      process.env.GATE_SMS_VOICE_PROFILE_PIN = '1';
      const pinned = await drafter.resolveEffectiveVoiceProfile({ dbi: mockDb });
      expect(pinned).toMatchObject({ version: 1, profile_text: 'profile one' });
      expect((await drafter.fetchVoiceProfileForDrafter({ dbi: mockDb })).version).toBe(1);
      process.env.GATE_SMS_VOICE_PROFILE_PIN = '2';
      expect((await drafter.resolveEffectiveVoiceProfile({ dbi: mockDb })).version).toBe(2);
    });

    test('the distiller side is untouched: the newest approved profile still reads as v2 while the drafter is pinned to v1', async () => {
      await seedProfiles();
      process.env.GATE_SMS_VOICE_PROFILE_PIN = '1';
      expect((await getApprovedVoiceProfile({ dbi: mockDb })).version).toBe(2);
    });

    test('a pin that stays valid after a newer profile is approved (superseded keeps working)', async () => {
      await seedProfiles();
      process.env.GATE_SMS_VOICE_PROFILE_PIN = '2';
      await mockDb('voice_profiles').where({ version: 2 }).update({ status: 'superseded' });
      await mockDb('voice_profiles').where({ version: 3 }).update({ status: 'approved' });
      expect((await drafter.resolveEffectiveVoiceProfile({ dbi: mockDb })).version).toBe(2);
      delete process.env.GATE_SMS_VOICE_PROFILE_PIN;
      expect((await drafter.resolveEffectiveVoiceProfile({ dbi: mockDb })).version).toBe(3);
    });

    test.each([[99, 'does not exist'], [3, 'is pending'], [4, 'is rejected or revoked']])('pin v%i (%s) falls back to the newest approved profile and logs once', async (pin) => {
      await seedProfiles();
      process.env.GATE_SMS_VOICE_PROFILE_PIN = String(pin);
      expect((await drafter.resolveEffectiveVoiceProfile({ dbi: mockDb })).version).toBe(2);
      expect((await drafter.resolveEffectiveVoiceProfile({ dbi: mockDb })).version).toBe(2);
      const pinWarnings = logger.warn.mock.calls.filter(([m]) => String(m).includes(`pin v${pin} `));
      expect(pinWarnings).toHaveLength(1);
      expect(pinWarnings[0][0]).not.toMatch(/profile (one|two|three|four)/);
    });

    test('a value that is not a version number is no pin: newest approved, one warning', async () => {
      await seedProfiles();
      process.env.GATE_SMS_VOICE_PROFILE_PIN = 'true';
      expect((await drafter.resolveEffectiveVoiceProfile({ dbi: mockDb })).version).toBe(2);
      expect((await drafter.resolveEffectiveVoiceProfile({ dbi: mockDb })).version).toBe(2);
      expect(logger.warn.mock.calls.filter(([m]) => String(m).includes('not a whole version number'))).toHaveLength(1);
    });

    test('no approved profile at all and no usable pin: null, as before', async () => {
      await mockDb('voice_profiles').del();
      await mockDb('voice_profiles').insert({ version: 7, profile_text: 'only pending', status: 'pending' });
      process.env.GATE_SMS_VOICE_PROFILE_PIN = '7';
      expect(await drafter.resolveEffectiveVoiceProfile({ dbi: mockDb })).toBeNull();
    });
  });

  describe('GATE_SMS_EDIT_LEARNING: the miner', () => {
    async function seedReplies() {
      const now = Date.now();
      const out = {};
      const reply = async (key, type, metadata) => {
        const customerId = await addCustomer();
        await addSms({ customerId, direction: 'inbound', type: 'sms', body: `Question number ${key} about my service`, at: new Date(now - 8 * 24 * HOUR - HOUR) });
        out[key] = await addSms({ customerId, type, metadata, body: `Reply text for ${key} goes here`, at: new Date(now - 8 * 24 * HOUR) });
      };
      await reply('plain', 'manual', null);
      await reply('accepted', 'manual', { agent_decision_id: await addDecision('accepted') });
      await reply('corrected', 'manual', { agent_decision_id: await addDecision('corrected') });
      await reply('revised', 'ai_revised', null);
      await reply('approved', 'ai_approved', null);
      return out;
    }
    const mine = async () => {
      const rows = await mineSmsPairs({ since: new Date(Date.now() - 30 * 24 * HOUR), until: new Date(Date.now() - 2 * 24 * HOUR), skipped: {} });
      return new Set(rows.map((r) => r.source_id));
    };

    test('gate off: only message_type manual, accepted-unchanged sends included, exactly as before', async () => {
      const ids = await seedReplies();
      expect(await mine()).toEqual(new Set([ids.plain, ids.accepted, ids.corrected]));
    });

    test('gate on: edited suggestions are mined (corrected manual, ai_revised); unchanged ones and ai_approved are not', async () => {
      const ids = await seedReplies();
      process.env.GATE_SMS_EDIT_LEARNING = 'true';
      expect(await mine()).toEqual(new Set([ids.plain, ids.corrected, ids.revised]));
    });
  });

  describe('GATE_SMS_EDIT_LEARNING: exemplar ranking', () => {
    const INTENT = 'edit_learning_test_intent';
    const texts = (rows) => rows.map((r) => r.reply_text);

    async function corpusRow({ key, ageHours, outcome = {}, smsId = null, customerId = null }) {
      const sourceId = smsId || randomUUID();
      await mockDb('voice_corpus_examples').insert({
        source: 'sms_human_reply', source_id: sourceId, customer_id: customerId, intent: INTENT,
        inbound_text: `inbound ${key}`, reply_text: `reply ${key}`, outcome: JSON.stringify(outcome),
        occurred_at: new Date(Date.now() - ageHours * HOUR),
      });
      return sourceId;
    }
    async function seed() {
      await mockDb('voice_corpus_examples').del();
      const customerId = await addCustomer();
      const smsFor = (extra) => addSms({ customerId, body: 'reply body', at: new Date(), ...extra });
      // newest first: accepted (own text), plain-new, edited (corrected), revised (legacy), human_better, plain-old
      await corpusRow({ key: 'accepted', ageHours: 1, smsId: await smsFor({ metadata: { agent_decision_id: await addDecision('accepted') } }) });
      await corpusRow({ key: 'plain-new', ageHours: 2, smsId: await smsFor({}) });
      await corpusRow({ key: 'corrected', ageHours: 3, smsId: await smsFor({ metadata: { agent_decision_id: await addDecision('corrected') } }) });
      await corpusRow({ key: 'revised', ageHours: 4, smsId: await smsFor({ type: 'ai_revised' }) });
      const hbSms = await smsFor({});
      await corpusRow({ key: 'human-better', ageHours: 5, smsId: hbSms });
      const [draft] = await mockDb('message_drafts').insert({ customer_id: customerId, drafter: 'house_voice', status: 'shadow' }).returning('id');
      await mockDb('shadow_draft_judgments').insert({ draft_id: draft.id, customer_id: customerId, human_reply_sms_id: hbSms, verdict: 'human_better' });
      // a judged draft_better reply does NOT rank up
      const dbSms = await smsFor({});
      await corpusRow({ key: 'draft-better', ageHours: 6, smsId: dbSms });
      const [draft2] = await mockDb('message_drafts').insert({ customer_id: customerId, drafter: 'house_voice', status: 'shadow' }).returning('id');
      await mockDb('shadow_draft_judgments').insert({ draft_id: draft2.id, customer_id: customerId, human_reply_sms_id: dbSms, verdict: 'draft_better' });
      await corpusRow({ key: 'plain-old', ageHours: 7, smsId: await smsFor({}) });
      // exclusions that must survive ranking: opt-out, complaint, sealed-exam answer key
      const optSms = await smsFor({ metadata: { agent_decision_id: await addDecision('corrected') } });
      await corpusRow({ key: 'opted-out', ageHours: 8, outcome: { optedOut: true }, smsId: optSms });
      await corpusRow({ key: 'complaint', ageHours: 9, outcome: { complaintWithin7d: true }, smsId: await smsFor({ type: 'ai_revised' }) });
      const sealedSms = await smsFor({ type: 'ai_revised' });
      await corpusRow({ key: 'sealed', ageHours: 10, smsId: sealedSms });
      const [sealedDraft] = await mockDb('message_drafts').insert({ customer_id: customerId, drafter: 'house_voice', status: 'shadow' }).returning('id');
      await mockDb('sms_sealed_eval_items').insert({
        source_draft_id: sealedDraft.id, inbound_message: 'x', facts_block: 'y', human_reply_text: 'z', human_reply_sms_id: sealedSms,
      });
    }

    test('off (default call): newest first, byte for byte as before (the accepted-unchanged reply still shows)', async () => {
      await seed();
      const rows = await drafter.fetchVoiceExemplars({ intent: INTENT, limit: 5, dbi: mockDb, throwOnError: true });
      expect(texts(rows)).toEqual(['reply accepted', 'reply plain-new', 'reply corrected', 'reply revised', 'reply human-better']);
    });

    test('on: edited and human_better first (newest within the tier), then the rest newest first; unchanged replies dropped', async () => {
      await seed();
      const rows = await drafter.fetchVoiceExemplars({ intent: INTENT, limit: 5, dbi: mockDb, throwOnError: true, outcomeRanked: true });
      expect(texts(rows)).toEqual(['reply corrected', 'reply revised', 'reply human-better', 'reply plain-new', 'reply draft-better']);
      const all = await drafter.fetchVoiceExemplars({ intent: INTENT, limit: 5, dbi: mockDb, throwOnError: true, outcomeRanked: true });
      expect(texts(all)).not.toContain('reply accepted');
    });

    test('on, with room for every row: opt-out, complaint and sealed-exam exclusions stay', async () => {
      await seed();
      const rows = await drafter.fetchVoiceExemplars({ intent: INTENT, limit: 50, dbi: mockDb, throwOnError: true, outcomeRanked: true });
      expect(texts(rows)).toEqual(['reply corrected', 'reply revised', 'reply human-better', 'reply plain-new', 'reply draft-better', 'reply plain-old']);
    });

    test('a malformed agent_decision_id in a send never fails the query', async () => {
      await seed();
      const customerId = await addCustomer();
      const smsId = await addSms({ customerId, body: 'reply body', at: new Date(), metadata: { agent_decision_id: 'not-a-uuid' } });
      await corpusRow({ key: 'malformed', ageHours: 0.5, smsId });
      const rows = await drafter.fetchVoiceExemplars({ intent: INTENT, limit: 50, dbi: mockDb, throwOnError: true, outcomeRanked: true });
      expect(texts(rows)).toContain('reply malformed');
    });
  });
});
