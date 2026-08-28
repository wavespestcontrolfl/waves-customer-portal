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

const crypto = require('crypto');
const serverText = require('../services/acceptance-terms-text');

// The EXACT text pinned together with its version (GH Codex r3 P1): a
// copy-only edit that forgets the version bump would let an already-open tab
// attest 'v2026-09' for text the customer never saw. Bump BOTH when editing.
const PINNED_VERSION = 'v2026-09';
const PINNED_SNAPSHOT_SHA256 = '517ff8fc3cad1153efc1e440ebed5ba1b5f83f9f96fb2946baf8a5b499e6f495';

describe('acceptance terms text', () => {
  test('version AND text are pinned together — edit the copy ⇒ bump the version and this hash', () => {
    expect(serverText.ACCEPTANCE_TERMS_VERSION).toBe(PINNED_VERSION);
    const hash = crypto.createHash('sha256').update(serverText.acceptanceTermsSnapshot(), 'utf8').digest('hex');
    expect(hash).toBe(PINNED_SNAPSHOT_SHA256);
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

describe('acceptance record customer-facing shape', () => {
  test('IP is masked to two octets, including IPv4-mapped IPv6', () => {
    expect(serverText.maskIpForCustomer('203.0.113.9')).toBe('203.0.x.x');
    expect(serverText.maskIpForCustomer('::ffff:203.0.113.9')).toBe('203.0.x.x');
    expect(serverText.maskIpForCustomer('2001:db8:85a3::8a2e:370:7334')).toBe('2001:db8:…');
    expect(serverText.maskIpForCustomer('::1')).toBeNull();
    expect(serverText.maskIpForCustomer('')).toBeNull();
    expect(serverText.maskIpForCustomer('not-an-ip')).toBeNull();
  });

  test('user agent reduces to a device · browser family', () => {
    expect(serverText.deviceLabelFromUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1')).toBe('iPhone · Safari');
    expect(serverText.deviceLabelFromUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 Edg/120.0')).toBe('Windows · Edge');
    expect(serverText.deviceLabelFromUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0 Mobile/15E148 Safari/604.1')).toBe('iPhone · Chrome');
    expect(serverText.deviceLabelFromUserAgent('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/120.0 Mobile/15E148 Safari/605.1.15')).toBe('iPad · Firefox');
    expect(serverText.deviceLabelFromUserAgent(null)).toBeNull();
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
    expect(require('../config/feature-gates').isEnabled('estimateAcceptanceTermsRequired')).toBe(false);
  });

  test('`required` = on + attestation required', () => {
    process.env.GATE_ESTIMATE_ACCEPTANCE_TERMS = 'required';
    jest.resetModules();
    expect(require('../config/feature-gates').isEnabled('estimateAcceptanceTerms')).toBe(true);
    expect(require('../config/feature-gates').isEnabled('estimateAcceptanceTermsRequired')).toBe(true);
  });
});

describe('accepted-onboarding email recipient', () => {
  test('a customer-less accept emails the estimate contact with the acceptance note', async () => {
    jest.resetModules();
    const sendTemplate = jest.fn(async () => ({ ok: true }));
    jest.doMock('../services/email-template-library', () => ({ sendTemplate, redactEmailAddresses: (s) => s }));
    jest.doMock('../models/db', () => (table) => {
      const b = {};
      b.where = () => b;
      b.whereNull = () => b;
      b.orderBy = () => b;
      b.update = async () => 1;
      b.first = async () => {
        if (table === 'customers') return undefined;
        if (table === 'estimates') return { token: 'tok-cl', customer_name: 'Pat Q. Tester', customer_email: 'pat@example.com' };
        if (table === 'estimate_acceptances') return { terms_version: 'v2026-09', terms_text: 'Line.\nMore.', accepted_at: '2026-08-28T19:04:00Z' };
        return undefined;
      };
      return b;
    });
    const { sendEstimateAcceptedOnboarding } = require('../services/estimate-accepted-email');
    await sendEstimateAcceptedOnboarding({ customerId: null, estimateId: 'est-cl', acceptanceId: 'acc-9', serviceLabel: 'Pest Control', appointment: null });
    expect(sendTemplate).toHaveBeenCalledTimes(1);
    const call = sendTemplate.mock.calls[0][0];
    expect(call.to).toBe('pat@example.com');
    expect(call.recipientId).toBeNull();
    // One copy per acceptance EVENT: keyed on the record, not just the estimate.
    expect(call.idempotencyKey).toBe('estimate.accepted_onboarding:est-cl:acc:acc-9');
    expect(call.payload.first_name).toBe('Pat');
    expect(call.payload.acceptance_note).toContain('“Line.”');
  });
});

describe('accepted-onboarding email recipient — linked customer without a usable email', () => {
  test('falls back to the estimate contact', async () => {
    jest.resetModules();
    const sendTemplate = jest.fn(async () => ({ ok: true }));
    jest.doMock('../services/email-template-library', () => ({ sendTemplate, redactEmailAddresses: (s) => s }));
    jest.doMock('../models/db', () => (table) => {
      const b = {};
      b.where = () => b;
      b.whereNull = () => b;
      b.orderBy = () => b;
      b.update = async () => 1;
      b.first = async () => {
        if (table === 'customers') return { id: 'cust-1', first_name: 'Pat', email: '' };
        if (table === 'estimates') return { token: 'tok-cl', customer_name: 'Pat Tester', customer_email: 'pat@example.com' };
        return undefined;
      };
      return b;
    });
    const { sendEstimateAcceptedOnboarding } = require('../services/estimate-accepted-email');
    await sendEstimateAcceptedOnboarding({ customerId: 'cust-1', estimateId: 'est-cl', serviceLabel: 'Pest Control', appointment: null });
    expect(sendTemplate).toHaveBeenCalledTimes(1);
    expect(sendTemplate.mock.calls[0][0].to).toBe('pat@example.com');
    expect(sendTemplate.mock.calls[0][0].recipientId).toBe('cust-1');
  });

  test('outcomes: no address anywhere → no_address; a thrown send → failed (never null)', async () => {
    jest.resetModules();
    const sendTemplate = jest.fn(async () => { throw new Error('SendGrid 503'); });
    jest.doMock('../services/email-template-library', () => ({ sendTemplate, redactEmailAddresses: (s) => s }));
    let contactEmail = '';
    jest.doMock('../models/db', () => (table) => {
      const b = {};
      b.where = () => b; b.whereNull = () => b; b.orderBy = () => b; b.update = async () => 1;
      b.first = async () => {
        if (table === 'customers') return undefined;
        if (table === 'estimates') return { token: 't', customer_name: 'Pat', customer_email: contactEmail };
        return undefined;
      };
      return b;
    });
    const { sendEstimateAcceptedOnboarding } = require('../services/estimate-accepted-email');
    expect(await sendEstimateAcceptedOnboarding({ customerId: null, estimateId: 'e', serviceLabel: 'x' })).toEqual({ sent: false, outcome: 'no_address' });
    contactEmail = 'pat@example.com';
    expect(await sendEstimateAcceptedOnboarding({ customerId: null, estimateId: 'e', serviceLabel: 'x' })).toMatchObject({ sent: false, outcome: 'failed' });
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

  test('records → verbatim recorded text + ET instant, self-contained', async () => {
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
    // The email is the complete copy: every recorded line, and no link that
    // can 404 once staff archives the estimate.
    expect(note).toContain('Services — old.');
    expect(note).not.toContain('/estimate/');
  });

  test('no record → empty string (block dropped, email unchanged)', async () => {
    rows.acceptance = null;
    const { _private } = require('../services/estimate-accepted-email');
    expect(await _private.acceptanceNoteFor('est-1')).toBe('');
  });

  test('a recorded acceptance is still emailed with the gate OFF (kill switch never hides evidence)', async () => {
    gateOn = false;
    rows.acceptance = { terms_version: 'v2026-09', terms_text: 'Line.\nMore.', accepted_at: '2026-08-28T19:04:00Z' };
    const { _private } = require('../services/estimate-accepted-email');
    expect(await _private.acceptanceNoteFor('est-1')).toContain('“Line.”');
  });
});
