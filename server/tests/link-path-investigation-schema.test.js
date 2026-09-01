/**
 * Step-3 investigator output contract (plan §5, §3.2): required literal
 * booleans, bounded confidence, enums pinned to link-registry.js, paid paths
 * must answer fee_scope, and — the money rule — NO cents field is accepted:
 * the model never emits an amount.
 */
const { INVESTIGATION_SCHEMA, VERDICTS, validateInvestigation } = require('../services/seo/link-path-investigation-schema');
const R = require('../services/seo/link-registry');

const goodPath = (over = {}) => ({
  acquisition_type: 'self_service_account',
  submission_url: 'https://example.com/add-listing',
  account_required: true,
  email_verification: true,
  payment_required: false,
  legal_attestation: false,
  agent_completable: true,
  terms_accepted_by_send: false,
  execution_after_send: true,
  link_type: 'directory',
  expected_rel: 'dofollow',
  expected_indexability: 'indexable',
  expected_persistence: 'durable',
  confidence: 0.8,
  fee_scope: null,
  renewal_period: null,
  price_text: null,
  price_page_url: null,
  renewal_price_text: null,
  renewal_price_page_url: null,
  currency_evidence: null,
  merchant_binding: null,
  legal_terms_url: null,
  replaces_path_id: null,
  reasons: 'signup form observed',
  quotes: ['Add your business'],
  ...over,
});
const good = (over = {}) => ({ verdict: 'qualified', watch_reason: null, paths: [goodPath()], ...over });

describe('investigator output schema', () => {
  test('a complete answer validates', () => {
    expect(validateInvestigation(good())).toEqual({ valid: true, errors: [] });
  });

  test('the model can NEVER emit an amount: any *_cost_cents field is rejected', () => {
    for (const key of ['estimated_cost_cents', 'renewal_cost_cents']) {
      const r = validateInvestigation(good({ paths: [goodPath({ [key]: 9500 })] }));
      expect({ key, valid: r.valid }).toEqual({ key, valid: false });
    }
    expect(JSON.stringify(INVESTIGATION_SCHEMA)).not.toMatch(/cost_cents/);
  });

  test('every authority-relevant flag is required and must be a literal boolean', () => {
    const flags = ['account_required', 'email_verification', 'payment_required', 'legal_attestation', 'agent_completable', 'terms_accepted_by_send', 'execution_after_send'];
    for (const flag of flags) {
      const missing = goodPath();
      delete missing[flag];
      expect({ flag, valid: validateInvestigation(good({ paths: [missing] })).valid }).toEqual({ flag, valid: false });
      expect({ flag, valid: validateInvestigation(good({ paths: [goodPath({ [flag]: 'true' })] })).valid }).toEqual({ flag, valid: false });
    }
  });

  test('confidence is bounded [0,1] in the schema itself', () => {
    expect(validateInvestigation(good({ paths: [goodPath({ confidence: 1.2 })] })).valid).toBe(false);
    expect(validateInvestigation(good({ paths: [goodPath({ confidence: -0.1 })] })).valid).toBe(false);
    // 0 is inside the bounds (though a qualified verdict needs one >0 path, so bound-check under not_reproducible)
    expect(validateInvestigation(good({ verdict: 'not_reproducible', paths: [goodPath({ confidence: 0 })] })).valid).toBe(true);
    expect(validateInvestigation(good({ paths: [goodPath({ confidence: 1 })] })).valid).toBe(true);
  });

  test('enums are the link-registry sets (a foreign lane or type never validates)', () => {
    expect(validateInvestigation(good({ paths: [goodPath({ acquisition_type: 'bribery' })] })).valid).toBe(false);
    expect(validateInvestigation(good({ paths: [goodPath({ link_type: 'forum' })] })).valid).toBe(false); // not in CLAIMABLE_LINK_TYPES
    for (const t of R.ACQUISITION_TYPES) {
      const paid = R.PAID_ACQUISITION_TYPES.includes(t);
      const p = goodPath({ acquisition_type: t, payment_required: paid, fee_scope: paid ? 'per_location' : null });
      // dead-end types are valid path OBJECTS but cannot alone back a qualified verdict
      const verdict = ['unknown', 'not_reproducible'].includes(t) ? 'not_reproducible' : 'qualified';
      expect({ t, valid: validateInvestigation(good({ verdict, paths: [p] })).valid }).toEqual({ t, valid: true });
    }
  });

  test('paid paths must answer fee_scope; free paths must not invent one', () => {
    const paid = goodPath({ acquisition_type: 'paid_listing', payment_required: true, fee_scope: null });
    expect(validateInvestigation(good({ paths: [paid] })).valid).toBe(false);
    expect(validateInvestigation(good({ paths: [{ ...paid, fee_scope: 'account_wide' }] })).valid).toBe(true);
    expect(validateInvestigation(good({ paths: [goodPath({ fee_scope: 'per_location' })] })).valid).toBe(false);
  });

  test('§3.2 type consistency: paid types require payment_required; self_service_free forbids it', () => {
    expect(validateInvestigation(good({ paths: [goodPath({ acquisition_type: 'membership', payment_required: false })] })).valid).toBe(false);
    expect(validateInvestigation(good({ paths: [goodPath({ acquisition_type: 'self_service_free', payment_required: true, fee_scope: 'per_location' })] })).valid).toBe(false);
  });

  test('qualified requires at least one EXECUTABLE, positive-confidence path (Codex r5 P1)', () => {
    // only a dead-end type ⇒ invalid
    expect(validateInvestigation(good({ paths: [goodPath({ acquisition_type: 'unknown' })] })).valid).toBe(false);
    expect(validateInvestigation(good({ paths: [goodPath({ acquisition_type: 'not_reproducible' })] })).valid).toBe(false);
    // only zero confidence ⇒ invalid
    expect(validateInvestigation(good({ paths: [goodPath({ confidence: 0 })] })).valid).toBe(false);
    // one real path beside a dead-end one ⇒ valid
    expect(validateInvestigation(good({ paths: [goodPath({ acquisition_type: 'unknown' }), goodPath()] })).valid).toBe(true);
    // the same paths under a NON-qualified verdict stay valid (evidence-only answers are fine there)
    expect(validateInvestigation(good({ verdict: 'not_reproducible', paths: [goodPath({ acquisition_type: 'unknown' })] })).valid).toBe(true);
  });

  test('site-executed types REQUIRE a submission URL; outreach types may go without (Codex r11 P1)', () => {
    const S = require('../services/seo/link-path-investigation-schema');
    for (const t of S.URL_REQUIRED_ACQUISITION_TYPES) {
      const paid = R.PAID_ACQUISITION_TYPES.includes(t);
      const p = goodPath({ acquisition_type: t, payment_required: paid, fee_scope: paid ? 'per_location' : null, submission_url: null });
      expect({ t, valid: validateInvestigation(good({ paths: [p] })).valid }).toEqual({ t, valid: false });
    }
    const outreach = goodPath({ acquisition_type: 'resource_outreach', link_type: 'resource', submission_url: null });
    expect(validateInvestigation(good({ paths: [outreach] })).valid).toBe(true);
  });

  test('send-accepted terms force send-first ordering — the deadlock combination is rejected (plan L788, Codex PR r1 P1)', () => {
    const deadlock = goodPath({ terms_accepted_by_send: true, execution_after_send: false, legal_attestation: true, legal_terms_url: 'https://example.com/terms' });
    expect(validateInvestigation(good({ paths: [deadlock] })).valid).toBe(false);
    const sendFirst = goodPath({ terms_accepted_by_send: true, execution_after_send: true, legal_attestation: true, legal_terms_url: 'https://example.com/terms' });
    expect(validateInvestigation(good({ paths: [sendFirst] })).valid).toBe(true);
  });

  test('a not_reproducible verdict may carry evidence entries but never a positive-confidence executable path (Codex PR r1 P1)', () => {
    const executable = goodPath();
    expect(validateInvestigation(good({ verdict: 'not_reproducible', paths: [executable] })).valid).toBe(false);
    const deadEnd = goodPath({ acquisition_type: 'unknown' });
    const zeroConf = goodPath({ confidence: 0 });
    expect(validateInvestigation(good({ verdict: 'not_reproducible', paths: [deadEnd, zeroConf] })).valid).toBe(true);
    expect(validateInvestigation(good({ verdict: 'not_reproducible', paths: [] })).valid).toBe(true);
  });

  test('verdicts: watching requires a reason; qualified requires ≥1 path; not_reproducible may have none', () => {
    expect([...VERDICTS]).toEqual(['qualified', 'not_reproducible', 'watching']);
    expect(validateInvestigation(good({ verdict: 'watching', watch_reason: null })).valid).toBe(false);
    expect(validateInvestigation(good({ verdict: 'watching', watch_reason: 'applications closed until fall' })).valid).toBe(true);
    expect(validateInvestigation(good({ verdict: 'qualified', paths: [] })).valid).toBe(false);
    expect(validateInvestigation(good({ verdict: 'not_reproducible', paths: [] })).valid).toBe(true);
  });

  test('replaces_path_id must be a uuid when present', () => {
    expect(validateInvestigation(good({ paths: [goodPath({ replaces_path_id: 'nonsense' })] })).valid).toBe(false);
    expect(validateInvestigation(good({ paths: [goodPath({ replaces_path_id: '5f0b6c1e-1111-4222-8333-444455556666' })] })).valid).toBe(true);
  });

  test('unknown top-level or path fields are rejected (additionalProperties: false)', () => {
    expect(validateInvestigation({ ...good(), extra: 1 }).valid).toBe(false);
    expect(validateInvestigation(good({ paths: [goodPath({ price_cents: 100 })] })).valid).toBe(false);
  });
});
