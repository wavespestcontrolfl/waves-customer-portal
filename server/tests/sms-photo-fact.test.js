/**
 * PHOTO CHECK (owner 2026-11-26 "BUILD 1-6", texting AI gap 6): the photo checker's stored pest reading reaches the texting AI as ONE finished
 * sentence (sms-photo-fact.js), hedged, never a species for ant / termite / structural / stinging / venomous reads, never a safety, health or
 * price claim, and only with a visit booked. The drafter renders it in a PHOTO CHECK section (gate on only) and holds a reply that describes
 * a photo in its own words. Synthetic rows only.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const photoFact = require('../services/sms-photo-fact');
const { PEST_LIBRARY } = require('../services/pest-identification');

const ident = (slug, over = {}) => ({ identification: { slug, confidence: 'high', category: 'insect', ...over } });
const VISIT = { hasUpcomingVisit: true };

describe('photoCheckSentence - what a stored reading may say', () => {
  test('a named species above the checker bar, hedged, with the technician confirming at the visit', () => {
    expect(photoFact.photoCheckSentence(ident('german-roach'), VISIT))
      .toBe('From your photo, it looks like a German cockroach. Your technician will confirm at the visit.');
    expect(photoFact.photoCheckSentence(ident('german-roach', { confidence: 'moderate' }), VISIT)).toContain('a German cockroach');
  });

  test('below the checker bar, contested, unmatched, not a pest, or no visit booked: no sentence', () => {
    expect(photoFact.photoCheckSentence(ident('german-roach', { confidence: 'low' }), VISIT)).toBe('');
    expect(photoFact.photoCheckSentence(ident('german-roach', { contested: true }), VISIT)).toBe('');
    expect(photoFact.photoCheckSentence(ident('made-up-bug'), VISIT)).toBe('');
    expect(photoFact.photoCheckSentence(ident(null, { category: 'other' }), VISIT)).toBe('');
    expect(photoFact.photoCheckSentence(ident('lovebug', { category: 'not_a_pest' }), VISIT)).toBe('');
    expect(photoFact.photoCheckSentence(ident('beneficial'), VISIT)).toBe('');
    expect(photoFact.photoCheckSentence(ident('german-roach'), { hasUpcomingVisit: false })).toBe('');
    expect(photoFact.photoCheckSentence(null, VISIT)).toBe('');
  });

  test('ants, termites, structural, stinging and venomous reads never name a species, at any confidence', () => {
    for (const slug of ['subterranean-termite', 'drywood-termite', 'carpenter-ant', 'fire-ant', 'ghost-ant', 'bigheaded-ant', 'paper-wasp', 'yellow-jacket', 'honey-bee', 'black-widow']) {
      for (const confidence of ['low', 'high']) {
        expect(photoFact.photoCheckSentence(ident(slug, { confidence, contested: confidence === 'low' }), VISIT))
          .toBe('Your technician will check what is in your photo at the visit.');
      }
    }
  });

  test('every library species is handled on purpose: named, check-at-visit, or nothing', () => {
    for (const item of PEST_LIBRARY) {
      const verdict = photoFact.photoCheckKind(ident(item.slug, { category: item.category }));
      const expected = item.category === 'not_a_pest' ? null
        : (['ants', 'termites'].includes(item.group) || item.safety.structural_threat || item.safety.stinging || item.safety.venomous) ? 'check' : 'named';
      expect([item.slug, verdict?.kind ?? null]).toEqual([item.slug, expected]);
    }
  });

  test('no renderable sentence carries a safety, health, bite or price claim, a number, or a firm ID', () => {
    for (const sentence of photoFact.allRenderableSentences()) {
      expect(sentence).not.toMatch(/\b(?:safe|harmless|dangerous|venom\w*|poison\w*|bite|sting|health|sick|disease|worry|price|cost|free)\b|\$|\d/i);
      expect(sentence).toMatch(/^From your photo, it looks like .+\. Your technician will confirm at the visit\.$|^Your technician will check what is in your photo at the visit\.$/);
      expect(sentence).not.toMatch(/\btermite|\bants?\b/i);
    }
  });
});

describe('photoClaimInOwnWords - the model may not describe a photo itself', () => {
  const ROACH = 'From your photo, it looks like a German cockroach. Your technician will confirm at the visit.';
  test.each([
    'From the picture, those look like fire ants.',
    'That spider in your photo is harmless.',
    'The photo appears to be termite damage.',
    'In your pic it looks like bed bugs.',
  ])('held: %s', (text) => expect(photoFact.photoClaimInOwnWords(text)).toBe(true));
  test.each([
    'Thanks for the photo! Your technician will take a look.',
    'Can you send a picture of the bugs?',
    ROACH,
    'Your pest visit is on Friday.',
  ])('passes: %s', (text) => expect(photoFact.photoClaimInOwnWords(text, { allowed: [ROACH] })).toBe(false));
  test('a reply to a photo text that identifies a pest with no photo word is held too', () => {
    expect(photoFact.photoClaimInOwnWords('Those look like ghost ants.')).toBe(false);
    expect(photoFact.photoClaimInOwnWords('Those look like ghost ants.', { inboundHasPhoto: true })).toBe(true);
    expect(photoFact.photoClaimInOwnWords("Those are German roaches.", { inboundHasPhoto: true })).toBe(true);
    expect(photoFact.photoClaimInOwnWords("Your ant visit is set and it's on Friday.", { inboundHasPhoto: true })).toBe(false);
    expect(photoFact.photoClaimInOwnWords('They are covered by your pest plan.', { inboundHasPhoto: true })).toBe(false);
  });
});

// A chainable stand-in for the two reads loadPhotoChecks makes.
function fakeDb({ drafts = [], rows = [], fail = false } = {}) {
  const calls = [];
  const db = (table) => {
    const q = { table, wheres: [] };
    calls.push(q);
    const chain = {
      where: (...args) => { q.wheres.push(['where', ...args]); return chain; },
      whereNot: (...args) => { q.wheres.push(['whereNot', ...args]); return chain; },
      whereNotNull: (...args) => { q.wheres.push(['whereNotNull', ...args]); return chain; },
      whereIn: (...args) => { q.wheres.push(['whereIn', ...args]); return chain; },
      orderBy: () => chain,
      select: async () => {
        if (fail) throw new Error('db down');
        return table === 'message_drafts' ? drafts : rows;
      },
    };
    return chain;
  };
  db.calls = calls;
  return db;
}

describe('loadPhotoChecks - the stored triage result of a photo text', () => {
  const A1 = '11111111-1111-4111-8111-111111111111';
  const draft = (over = {}) => ({ sms_log_id: 'log-1', flags: { assessment_type: 'pest', assessment_id: A1 }, ...over });
  const row = (over = {}) => ({ id: A1, source: 'auto_triage', customer_id: 'c1', status: 'analyzed', archived_at: null, report_contract: JSON.stringify(ident('german-roach')), ...over });

  test('reads the pest assessment the photo_triage draft of this inbound row names, never a rejected draft', async () => {
    const db = fakeDb({ drafts: [draft()], rows: [row()] });
    const checks = await photoFact.loadPhotoChecks('c1', { db, smsLogId: 'log-1' });
    expect(checks).toEqual([{ smsLogId: 'log-1', assessmentId: A1, identification: ident('german-roach').identification }]);
    expect(db.calls[0].wheres).toEqual(expect.arrayContaining([
      ['where', { intent: 'photo_triage', customer_id: 'c1' }], ['whereNot', 'status', 'rejected'], ['where', 'sms_log_id', 'log-1'],
    ]));
  });

  test('the checker not finished (no draft yet), a lawn result, or an archived, relinked or staff-made row: nothing', async () => {
    await expect(photoFact.loadPhotoChecks('c1', { db: fakeDb(), smsLogId: 'log-1' })).resolves.toEqual([]);
    await expect(photoFact.loadPhotoChecks('c1', { db: fakeDb({ drafts: [draft({ flags: { assessment_type: 'lawn', assessment_id: A1 } })] }), smsLogId: 'log-1' })).resolves.toEqual([]);
    for (const over of [{ archived_at: new Date() }, { customer_id: 'c2' }, { source: 'admin' }, { status: 'draft' }]) {
      await expect(photoFact.loadPhotoChecks('c1', { db: fakeDb({ drafts: [draft()], rows: [row(over)] }), smsLogId: 'log-1' })).resolves.toEqual([]);
    }
  });

  test('a failed read is null, never a guess', async () => {
    await expect(photoFact.loadPhotoChecks('c1', { db: fakeDb({ fail: true }), smsLogId: 'log-1' })).resolves.toBeNull();
    await expect(photoFact.loadPhotoChecks(null, { db: fakeDb() })).resolves.toBeNull();
  });
});

describe('the drafter renders PHOTO CHECK only with real answers on', () => {
  const drafter = require('../services/sms-shadow-drafter');
  const ORIGINAL = process.env.GATE_SMS_REAL_ANSWERS;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.GATE_SMS_REAL_ANSWERS; else process.env.GATE_SMS_REAL_ANSWERS = ORIGINAL;
  });
  const context = () => ({
    customer: { id: 'c1', first_name: 'Pat' },
    upcomingServices: [{ type: 'Quarterly Pest Control', date: '2026-12-04' }],
    serviceHistory: [], billing: null, flags: [], propertyPrefs: {},
  });
  const now = new Date('2026-11-27T15:00:00Z');

  test('gate on: the sentence sits in its own section; gate off: the block is byte-identical to one with no reading', () => {
    process.env.GATE_SMS_REAL_ANSWERS = 'true';
    const withCheck = drafter.buildFactsBlock(context(), { now, photoCheck: ident('german-roach') });
    expect(withCheck).toContain('PHOTO CHECK (');
    expect(withCheck).toContain('- From your photo, it looks like a German cockroach. Your technician will confirm at the visit.\n');
    expect(drafter.buildFactsBlock(context(), { now, photoCheck: ident('german-roach', { confidence: 'low' }) })).not.toContain('PHOTO CHECK');
    process.env.GATE_SMS_REAL_ANSWERS = 'false';
    expect(drafter.buildFactsBlock(context(), { now, photoCheck: ident('german-roach') })).toBe(drafter.buildFactsBlock(context(), { now }));
  });

  test('the gate-on system prompt carries the PHOTOS rule; gate off does not', () => {
    process.env.GATE_SMS_REAL_ANSWERS = 'true';
    expect(drafter.buildSystemPromptWithProfile('').system).toContain('PHOTOS (a picture the customer sent)');
    process.env.GATE_SMS_REAL_ANSWERS = 'false';
    expect(drafter.buildSystemPromptWithProfile('').system).not.toContain('PHOTO');
  });
});
