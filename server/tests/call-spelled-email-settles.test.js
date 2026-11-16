/**
 * GATE_CALL_SPELLED_EMAIL_SETTLES (owner 2026-11-04, "A", call-agent audit).
 *
 * When the two call extraction passes write different emails, the 2026-09-25
 * hold saves no email and files one read-back card. In 60 days 11 of 13 such
 * cards were never worked, so those leads got no email. With the gate on, the
 * letters the caller spelled settle it when the spelling decoder heard ONE
 * spelling at full confidence, adopted it, and it is exactly one pass value,
 * and neither spelling is on the do-not-email list. The 2026-10-05
 * spelled-email trust then drops the card and the first-touch hold.
 *
 * The rule itself is unit-tested in call-email-hygiene.test.js. This file
 * pins how the processor uses it: the settled shape satisfies the 2026-10-05
 * rule while the hold shape does not, the do-not-email check fails closed and
 * keeps addresses out of the log, the wiring order inside processRecording,
 * and the gate's dark default.
 */
const fs = require('fs');
const path = require('path');

const mockSuppressed = new Set();
const mockQuery = { fail: false, tables: [] };
jest.mock('../models/db', () => jest.fn((table) => {
  const addresses = [];
  mockQuery.tables.push(table);
  const q = {
    where(arg) {
      // suppressionCoversEmail(email) is a knex grouping callback: record the
      // address it binds, the way the real builder would.
      if (typeof arg === 'function') {
        const rec = {
          whereRaw: (_sql, bindings) => { addresses.push(bindings[0]); return rec; },
          orWhereRaw: () => rec,
        };
        arg.call(rec);
      }
      return q;
    },
    async first() {
      if (mockQuery.fail) {
        throw Object.assign(new Error('select "id" from "email_suppressions" where LOWER(email) = jondoh@gmail.com'), { code: 'ECONNRESET' });
      }
      return addresses.some((a) => mockSuppressed.has(a)) ? { id: 7 } : undefined;
    },
  };
  return q;
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const logger = require('../services/logger');
const { applyEmailDisagreementHold, spelledEmailSettled, spelledLettersSettleEmailDisagreement } = require('../services/call-triage-flags');
const { eitherSpellingSuppressed } = require('../services/call-recording-processor')._test;

const src = fs.readFileSync(path.join(__dirname, '../services/call-recording-processor.js'), 'utf8');

const passes = ['jondoe@gmail.com', 'jondoh@gmail.com'];
const decoderPayload = () => ({ email_candidates: [{ value: 'jondoh@gmail.com', confidence: 1 }] });

beforeEach(() => {
  mockSuppressed.clear();
  mockQuery.fail = false;
  mockQuery.tables.length = 0;
  logger.warn.mockClear();
});

describe('the settled shape is what the 2026-10-05 spelled-email trust accepts', () => {
  test('settled: one spelling, no disagreement, saved = spelled → no read-back card', () => {
    const extracted = { email: 'jondoh@gmail.com', email_candidates: passes.slice() };
    const payload = decoderPayload();
    const settled = spelledLettersSettleEmailDisagreement(extracted, payload);
    expect(settled).toEqual({ email: 'jondoh@gmail.com', otherSpelling: 'jondoe@gmail.com' });
    // The processor leaves the decoder payload as it is and keeps extracted.email.
    expect(spelledEmailSettled(payload, extracted.email)).toBe(true);
  });

  test('held: the 2026-09-25 hold nulls the email and stamps the disagreement → card stays', () => {
    const held = applyEmailDisagreementHold({ email: 'jondoh@gmail.com', email_candidates: passes.slice() }, decoderPayload());
    expect(held.extracted.email).toBeNull();
    expect(spelledEmailSettled(held.dictationEmailPayload, held.extracted.email)).toBe(false);
  });
});

describe('eitherSpellingSuppressed (do-not-email check on both spellings)', () => {
  const settled = { email: 'jondoh@gmail.com', otherSpelling: 'jondoe@gmail.com' };

  test('neither spelling suppressed → the settle may stand', async () => {
    await expect(eitherSpellingSuppressed(settled)).resolves.toBe(false);
    expect(mockQuery.tables).toEqual(['email_suppressions', 'email_suppressions']);
  });

  test('the saved spelling suppressed → keep the hold', async () => {
    mockSuppressed.add('jondoh@gmail.com');
    await expect(eitherSpellingSuppressed(settled)).resolves.toBe(true);
  });

  test('the OTHER spelling suppressed → keep the hold', async () => {
    mockSuppressed.add('jondoe@gmail.com');
    await expect(eitherSpellingSuppressed(settled)).resolves.toBe(true);
  });

  test('a failed lookup fails closed and logs no address', async () => {
    mockQuery.fail = true;
    await expect(eitherSpellingSuppressed(settled)).resolves.toBe(true);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const line = String(logger.warn.mock.calls[0][0]);
    expect(line).toContain('ECONNRESET');
    expect(line).not.toMatch(/@/);
  });
});

describe('processRecording wiring', () => {
  const holdStart = src.indexOf('if (Array.isArray(extracted.email_candidates) && extracted.email_candidates.length >= 2) {');
  const block = src.slice(holdStart, src.indexOf('\n    }\n', holdStart));

  test('the settle check runs inside the disagreement block, gated, before the hold', () => {
    expect(holdStart).toBeGreaterThan(-1);
    const order = [
      "isEnabled('callSpelledEmailSettles')",
      'spelledLettersSettleEmailDisagreement(extracted, dictationEmailPayload)',
      'await eitherSpellingSuppressed(settled)',
      'email_spelling_settled: { email: settled.email, other_spelling: settled.otherSpelling }',
      'delete next.email_candidates;',
      '} else {',
      'applyEmailDisagreementHold(extracted, dictationEmailPayload)',
    ].map((needle) => block.indexOf(needle));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test('the block sits after the decoder and arbiter, and before the DNS check and the card decision', () => {
    expect(src.indexOf('[quarantine-arbiter] review verdict')).toBeLessThan(holdStart);
    expect(holdStart).toBeLessThan(src.indexOf('callEmailCheck = await screenCallEmail(extracted);'));
    expect(holdStart).toBeLessThan(src.indexOf('if (await spelledEmailTrusted({ extracted, dictationEmailPayload, correctedEmail: normalizedEmail })) {'));
  });
});

describe('GATE_CALL_SPELLED_EMAIL_SETTLES', () => {
  const load = (value) => {
    const prior = process.env.GATE_CALL_SPELLED_EMAIL_SETTLES;
    if (value === undefined) delete process.env.GATE_CALL_SPELLED_EMAIL_SETTLES;
    else process.env.GATE_CALL_SPELLED_EMAIL_SETTLES = value;
    let on;
    jest.isolateModules(() => { on = require('../config/feature-gates').isEnabled('callSpelledEmailSettles'); });
    if (prior === undefined) delete process.env.GATE_CALL_SPELLED_EMAIL_SETTLES;
    else process.env.GATE_CALL_SPELLED_EMAIL_SETTLES = prior;
    return on;
  };

  test('ships dark: only exactly "true" turns it on', () => {
    expect(load(undefined)).toBe(false);
    expect(load('1')).toBe(false);
    expect(load('TRUE')).toBe(false);
    expect(load('true')).toBe(true);
  });
});
