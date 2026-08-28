/**
 * Estimate acceptance terms (GATE_ESTIMATE_ACCEPTANCE_TERMS) — the copy
 * contract and the gate contract.
 *
 * - The version is PINNED: editing any line without bumping the version
 *   would let a new text be recorded under an old version string.
 * - The snapshot recorded on estimate_acceptances is the line + every
 *   drawer line, in order — what the customer could read above Accept.
 * - The gate is OFF by default in every env (fail closed).
 */

const serverText = require('../services/acceptance-terms-text');

describe('acceptance terms text', () => {
  test('version is pinned', () => {
    expect(serverText.ACCEPTANCE_TERMS_VERSION).toBe('v2026-09');
  });

  test('copy is short: one line above Accept, five drawer lines', () => {
    expect(serverText.ACCEPTANCE_LINE.split(/\s+/).length).toBeLessThanOrEqual(20);
    expect(serverText.ACCEPTANCE_TERMS).toHaveLength(5);
    for (const t of serverText.ACCEPTANCE_TERMS) {
      expect(typeof t.label).toBe('string');
      expect(typeof t.text).toBe('string');
    }
  });

  test('never carries a fee, interest or collection-cost clause (prospective-only rule)', () => {
    const all = serverText.acceptanceTermsSnapshot().toLowerCase();
    for (const banned of ['late fee', 'interest', 'collection cost', 'attorney', 'lien', 'credit bureau']) {
      expect(all).not.toContain(banned);
    }
  });

  test('snapshot = line + every drawer line, in order', () => {
    const snap = serverText.acceptanceTermsSnapshot();
    const lines = snap.split('\n');
    expect(lines[0]).toBe(serverText.ACCEPTANCE_LINE);
    expect(lines).toHaveLength(1 + serverText.ACCEPTANCE_TERMS.length);
    serverText.ACCEPTANCE_TERMS.forEach((t, i) => {
      expect(lines[i + 1]).toBe(`${t.label} — ${t.text}`);
    });
  });

  test('payload shape served to the estimate page', () => {
    const p = serverText.acceptanceTermsPayload();
    expect(p).toEqual({
      version: serverText.ACCEPTANCE_TERMS_VERSION,
      line: serverText.ACCEPTANCE_LINE,
      terms: serverText.ACCEPTANCE_TERMS.map((t) => ({ label: t.label, text: t.text })),
    });
  });
});

describe('GATE_ESTIMATE_ACCEPTANCE_TERMS', () => {
  const ORIGINAL = process.env.GATE_ESTIMATE_ACCEPTANCE_TERMS;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.GATE_ESTIMATE_ACCEPTANCE_TERMS;
    else process.env.GATE_ESTIMATE_ACCEPTANCE_TERMS = ORIGINAL;
    jest.resetModules();
  });

  test('off unless exactly "true"', () => {
    delete process.env.GATE_ESTIMATE_ACCEPTANCE_TERMS;
    jest.resetModules();
    expect(require('../config/feature-gates').isEnabled('estimateAcceptanceTerms')).toBe(false);
    process.env.GATE_ESTIMATE_ACCEPTANCE_TERMS = '1';
    jest.resetModules();
    expect(require('../config/feature-gates').isEnabled('estimateAcceptanceTerms')).toBe(false);
    process.env.GATE_ESTIMATE_ACCEPTANCE_TERMS = 'true';
    jest.resetModules();
    expect(require('../config/feature-gates').isEnabled('estimateAcceptanceTerms')).toBe(true);
  });
});

describe('accepted-onboarding email acceptance_note', () => {
  // The terms promise "email you a copy" — the note is that copy: verbatim
  // recorded line (never the live constant), the instant, the estimate URL.
  const rows = { acceptance: null, estimate: { token: 'tok-note-1' } };
  let gateOn = true;
  beforeEach(() => {
    jest.resetModules();
    jest.doMock('../config/feature-gates', () => ({ isEnabled: () => gateOn }));
    jest.doMock('../models/db', () => {
      const builder = (table) => {
        const b = {};
        b.where = () => b;
        b.orderBy = () => b;
        b.first = async () => (table === 'estimate_acceptances' ? rows.acceptance : rows.estimate);
        return b;
      };
      return builder;
    });
  });
  afterEach(() => { gateOn = true; });

  test('records → verbatim recorded line + ET instant + estimate link', async () => {
    rows.acceptance = {
      terms_version: 'v2000-01',
      terms_text: 'OLD LINE the customer actually saw.\nServices — old.',
      accepted_at: '2026-08-28T19:04:00Z',
    };
    const { _private } = require('../services/estimate-accepted-email');
    const note = await _private.acceptanceNoteFor('est-1');
    expect(note).toContain('“OLD LINE the customer actually saw.”');
    expect(note).toContain('(terms v2000-01)');
    expect(note).toContain('Friday, August 28, 2026 at 3:04 PM ET');
    expect(note).toMatch(/\/estimate\/tok-note-1$/);
  });

  test('no record, or gate off → empty string (block dropped, email unchanged)', async () => {
    rows.acceptance = null;
    let { _private } = require('../services/estimate-accepted-email');
    expect(await _private.acceptanceNoteFor('est-1')).toBe('');

    gateOn = false;
    rows.acceptance = { terms_version: 'v2026-09', terms_text: 'x', accepted_at: '2026-08-28T19:04:00Z' };
    jest.resetModules();
    jest.doMock('../config/feature-gates', () => ({ isEnabled: () => false }));
    ({ _private } = require('../services/estimate-accepted-email'));
    expect(await _private.acceptanceNoteFor('est-1')).toBe('');
  });
});
