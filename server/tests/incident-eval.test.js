/**
 * Locks the incident-regression eval runner's semantics (the corpus replays
 * live models weekly — see server/fixtures/incident-eval/README.md):
 *   - the corpus files load, validate, and keep their incident anchor cases
 *   - fail-open gate results (checked=false) count INCONCLUSIVE, never pass
 *   - a failing LLM case is retried once; pass-on-retry = flaky, not failing
 *   - the inbox suite derives destructive-action verdicts through the REAL
 *     shouldSkipAutoAction guard
 *   - exactly one admin notification on regression; a "could not run"
 *     notification when every case is inconclusive; silence when green
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const {
  runIncidentEval,
  _internals: { loadSuite, runCase },
} = require('../services/eval/incident-regression');
const { shouldSkipAutoAction } = require('../services/email/email-actions');

// Real guard, fake LLMs. Notifications captured, never inserted.
function harness({ evaluate, classify }) {
  const notifications = [];
  return {
    notifications,
    opts: {
      evaluate,
      classify,
      shouldSkip: shouldSkipAutoAction,
      notify: async (row) => { notifications.push(row); },
    },
  };
}

// Classifier double keyed by fixture sender so each corpus case gets the
// category a healthy model returns.
function classifyBySender(overrides = {}) {
  return async (email) => {
    const bySender = {
      'events@wavespestcontrol.com': 'marketing_newsletter',
      'deals@mail.shopsavvy-deals.com': 'marketing_newsletter',
      'maria.gonzalez.test@example.com': 'lead_inquiry',
      'john.smith.test@example.com': 'complaint',
      'billing@swflchemsupply.com': 'vendor_invoice',
      'outreach@rankboosterpro.com': 'spam',
      ...overrides,
    };
    const category = bySender[email.from_address];
    if (!category) throw new Error(`unexpected fixture sender ${email.from_address}`);
    return { category, confidence: 0.95 };
  };
}

// Gate double honoring each fact-check case's expectation (a healthy model).
const healthyEvaluate = async (draft) => {
  const reversed = draft.body.includes('*Clarireedia jacksonii* — its cool-season cousin *C. monteithiana*');
  const repealedBlackout = draft.body.includes('repealed back in 2024');
  const block = reversed || repealedBlackout;
  return {
    pass: !block,
    checked: true,
    findings: block ? [{ severity: 'P0', code: 'FACTUAL_ERROR' }] : [],
  };
};

describe('incident-eval corpus integrity', () => {
  test('both suites load and validate', () => {
    expect(loadSuite('fact-check').cases.length).toBeGreaterThanOrEqual(4);
    expect(loadSuite('inbox').cases.length).toBeGreaterThanOrEqual(6);
  });

  test('the incident anchor cases are present with their expectations intact', () => {
    const fc = loadSuite('fact-check');
    const byId = Object.fromEntries(fc.cases.map((c) => [c.id, c]));
    // PR #1561 recalibration: the corrected Venice post must PASS the gate
    expect(byId['venice-corrected-post-must-pass'].expect.pass).toBe(true);
    // PR #212's reversed-species error class must BLOCK
    expect(byId['venice-reversed-pathogen-must-block'].expect.pass).toBe(false);
    // The mutated body differs from the corrected body only by the swap
    expect(byId['venice-reversed-pathogen-must-block'].draft.body)
      .not.toEqual(byId['venice-corrected-post-must-pass'].draft.body);

    const inbox = loadSuite('inbox');
    const contact = inbox.cases.find((c) => c.id === 'waves-own-newsletter-no-destructive-action');
    // PR #1654: our own newsletter must never draw a destructive action
    expect(contact.expect.no_destructive_action).toBe(true);
    expect(contact.email.from_address.endsWith('@wavespestcontrol.com')).toBe(true);
  });

  test('inbox fixtures contain no real-looking PII (synthetic markers only)', () => {
    const inbox = loadSuite('inbox');
    for (const c of inbox.cases) {
      const blob = JSON.stringify(c.email);
      // 941-555-xxxx is the reserved fictional exchange; any other 941 number is a leak
      const realPhones = (blob.match(/941[-.) ]?\d{3}[-. ]?\d{4}/g) || [])
        .filter((m) => !m.includes('555'));
      expect(realPhones).toEqual([]);
    }
  });
});

describe('runIncidentEval semantics', () => {
  test('healthy model: everything passes, no notification', async () => {
    const h = harness({ evaluate: healthyEvaluate, classify: classifyBySender() });
    const result = await runIncidentEval(h.opts);
    expect(result.failed).toBe(0);
    expect(result.inconclusive).toBe(0);
    expect(result.passed).toBe(result.total);
    expect(h.notifications).toEqual([]);
  });

  test('fail-open gate (checked=false) is inconclusive, never a pass — and a fully-inconclusive suite alerts even when the other suite is green', async () => {
    const h = harness({
      evaluate: async () => ({ pass: true, checked: false, findings: [], skipped: 'api_error' }),
      classify: classifyBySender(),
    });
    const result = await runIncidentEval(h.opts);
    const fc = result.results.filter((r) => r.suite === 'fact-check');
    expect(fc.every((r) => r.status === 'inconclusive')).toBe(true);
    expect(result.unverifiedSuites).toEqual(['fact-check']);
    // Not a regression, but the fact-check component verified NOTHING this
    // run — that gets its own could-not-verify notification.
    expect(h.notifications).toHaveLength(1);
    expect(h.notifications[0].title).toMatch(/could not verify: fact-check/);
  });

  test('a lone inconclusive case does not alert (suite still partially verified)', async () => {
    const healthyClassify = classifyBySender();
    const h = harness({
      evaluate: healthyEvaluate,
      classify: async (email) => {
        if (email.from_address === 'billing@swflchemsupply.com') throw new Error('one-off blip');
        return healthyClassify(email);
      },
    });
    const result = await runIncidentEval(h.opts);
    expect(result.inconclusive).toBe(1);
    expect(result.unverifiedSuites).toEqual([]);
    expect(h.notifications).toEqual([]);
  });

  test('gate drift (over-blocking the corrected post) is a regression + one notification', async () => {
    const h = harness({
      // Model now P0-flags everything — the pre-#1561 failure mode
      evaluate: async () => ({ pass: false, checked: true, findings: [{ severity: 'P0' }] }),
      classify: classifyBySender(),
    });
    const result = await runIncidentEval(h.opts);
    const failedIds = result.results.filter((r) => r.status === 'fail').map((r) => r.id);
    expect(failedIds).toContain('venice-corrected-post-must-pass');
    expect(failedIds).toContain('judgment-call-nuance-must-pass');
    expect(h.notifications).toHaveLength(1);
    expect(h.notifications[0].category).toBe('eval_regression');
    expect(h.notifications[0].recipient_type).toBe('admin');
    expect(h.notifications[0].title).toMatch(/regression/);
  });

  test('gate gone blind (passing the reversed pathogen) is a regression', async () => {
    const h = harness({
      evaluate: async () => ({ pass: true, checked: true, findings: [] }),
      classify: classifyBySender(),
    });
    const result = await runIncidentEval(h.opts);
    const failedIds = result.results.filter((r) => r.status === 'fail').map((r) => r.id);
    expect(failedIds).toContain('venice-reversed-pathogen-must-block');
    expect(failedIds).toContain('sarasota-blackout-repealed-must-block');
  });

  test('classifier drift on the contact@ incident case relies on the REAL guard: marketing_newsletter from a Waves sender stays non-destructive', async () => {
    const h = harness({ evaluate: healthyEvaluate, classify: classifyBySender() });
    const result = await runIncidentEval(h.opts);
    const contact = result.results.find((r) => r.id === 'waves-own-newsletter-no-destructive-action');
    expect(contact.status).toBe('pass');
  });

  test('classifier drift to "other" on an external newsletter is a regression (inbox stops cleaning itself)', async () => {
    const h = harness({
      evaluate: healthyEvaluate,
      classify: classifyBySender({ 'deals@mail.shopsavvy-deals.com': 'other' }),
    });
    const result = await runIncidentEval(h.opts);
    const ext = result.results.find((r) => r.id === 'external-newsletter-destructive-action-must-fire');
    expect(ext.status).toBe('fail');
    expect(h.notifications).toHaveLength(1);
  });

  test('classifier API errors are inconclusive; all suites down raises ONE could-not-verify notification naming both', async () => {
    const h = harness({
      evaluate: async () => { throw new Error('api down'); },
      classify: async () => { throw new Error('api down'); },
    });
    const result = await runIncidentEval(h.opts);
    expect(result.inconclusive).toBe(result.total);
    expect(result.unverifiedSuites).toEqual(['fact-check', 'inbox']);
    expect(h.notifications).toHaveLength(1);
    expect(h.notifications[0].title).toMatch(/could not verify: fact-check, inbox/);
  });

  test('suites filter narrows the run', async () => {
    const h = harness({ evaluate: healthyEvaluate, classify: classifyBySender() });
    const result = await runIncidentEval({ ...h.opts, suites: ['fact-check'] });
    expect(result.results.every((r) => r.suite === 'fact-check')).toBe(true);
    await expect(runIncidentEval({ ...h.opts, suites: ['nope'] })).rejects.toThrow(/no suites match/);
  });
});

describe('runCase retry-once', () => {
  test('fail then pass = flaky pass', async () => {
    let n = 0;
    const r = await runCase(async () => (n++ === 0
      ? { status: 'fail', detail: 'first miss' }
      : { status: 'pass' }));
    expect(r.status).toBe('pass');
    expect(r.flaky).toBe(true);
  });

  test('fail twice = fail', async () => {
    const r = await runCase(async () => ({ status: 'fail', detail: 'consistent' }));
    expect(r.status).toBe('fail');
    expect(r.flaky).toBe(false);
  });

  test('inconclusive is not retried', async () => {
    let calls = 0;
    const r = await runCase(async () => { calls++; return { status: 'inconclusive', detail: 'skipped' }; });
    expect(r.status).toBe('inconclusive');
    expect(calls).toBe(1);
  });
});
