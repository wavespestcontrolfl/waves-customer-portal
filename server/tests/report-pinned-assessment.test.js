// #3168 — pinning which lawn assessment a render shows.
//
// The renderer navigates a headless browser to /report/:token and that page
// fetches its own data, so the server cannot read what ended up in the PDF. The
// pin removes the page's freedom to choose instead: the send fence pins the
// assessment it sealed, and the attachment provably carries it.
//
// Two properties matter and both are asserted here:
//   1. AUTHORIZATION — a pin may only select among assessments the token
//      already exposes (same customer, confirmed, linked to this visit). It
//      must never widen what a report token can see.
//   2. FAIL-CLOSED — an unusable pin THROWS. Falling back to normal resolution
//      would answer a pinned request with a different assessment, which is the
//      exact divergence the pin exists to prevent, and the caller could not
//      tell it happened.
jest.mock('../models/db', () => jest.fn());

const { PinnedAssessmentUnavailable } = require('../services/service-report/report-data');
const { serviceReportViewerUrl } = require('../services/service-report/pdf-puppeteer');
const { signAssessmentPin, verifyAssessmentPin } = require('../services/service-report/assessment-pin');

const SERVICE = {
  id: 'svc-1',
  customer_id: 'cust-1',
  scheduled_service_id: 'sched-1',
};

// knex stub over lawn_assessments. `rows` is the full table; the stub applies
// the same equality filters the resolver builds.
function makeKnex(rows) {
  return (table) => {
    expect(table).toBe('lawn_assessments');
    const chain = {
      __where: {},
      where(criteria) { chain.__where = { ...chain.__where, ...criteria }; return chain; },
      orderBy() { return chain; },
      async first() {
        return rows.find((r) => Object.entries(chain.__where)
          .every(([k, v]) => r[k] === v)) || null;
      },
    };
    return chain;
  };
}

const {
  loadLinkedLawnAssessment,
  loadPinnedLawnAssessment,
  PIN_NO_ASSESSMENT,
} = require('../services/service-report/report-data');

describe('#3168 pinned assessment — authorization boundary', () => {
  const CONFIRMED_THIS_VISIT = {
    id: 'assess-A', customer_id: 'cust-1', confirmed_by_tech: true, service_record_id: 'svc-1',
  };
  const CONFIRMED_BY_SCHEDULED_SERVICE = {
    id: 'assess-B', customer_id: 'cust-1', confirmed_by_tech: true, service_id: 'sched-1',
  };
  const OTHER_CUSTOMER = {
    id: 'assess-EVIL', customer_id: 'cust-2', confirmed_by_tech: true, service_record_id: 'svc-1',
  };
  const UNCONFIRMED = {
    id: 'assess-UNCONFIRMED', customer_id: 'cust-1', confirmed_by_tech: false, service_record_id: 'svc-1',
  };

  // The candidate set a pin may draw from is deliberately the SAME one
  // loadLinkedLawnAssessment picks from, so a pin can never widen a token.
  test('the unpinned resolver only sees confirmed rows for this customer + visit', async () => {
    const knex = makeKnex([OTHER_CUSTOMER, UNCONFIRMED, CONFIRMED_THIS_VISIT]);
    const found = await loadLinkedLawnAssessment(SERVICE, knex);
    expect(found.id).toBe('assess-A');
  });

  test('a row belonging to another customer is not reachable', async () => {
    const knex = makeKnex([OTHER_CUSTOMER]);
    const found = await loadLinkedLawnAssessment(SERVICE, knex);
    expect(found).toBeNull();
  });

  test('an unconfirmed row is not reachable', async () => {
    const knex = makeKnex([UNCONFIRMED]);
    const found = await loadLinkedLawnAssessment(SERVICE, knex);
    expect(found).toBeNull();
  });

  test('a scheduled-service-linked row is reachable (the by-service fallback)', async () => {
    const knex = makeKnex([CONFIRMED_BY_SCHEDULED_SERVICE]);
    const found = await loadLinkedLawnAssessment(SERVICE, knex);
    expect(found.id).toBe('assess-B');
  });
});

describe('#3168 pinned assessment — the pin itself', () => {
  const A = { id: 'assess-A', customer_id: 'cust-1', confirmed_by_tech: true, service_record_id: 'svc-1' };
  const B = { id: 'assess-B', customer_id: 'cust-1', confirmed_by_tech: true, service_id: 'sched-1' };
  const OTHER_CUSTOMER = { id: 'assess-EVIL', customer_id: 'cust-2', confirmed_by_tech: true, service_record_id: 'svc-1' };
  const OTHER_VISIT = { id: 'assess-OTHER', customer_id: 'cust-1', confirmed_by_tech: true, service_record_id: 'svc-99' };
  const UNCONFIRMED = { id: 'assess-UNCONFIRMED', customer_id: 'cust-1', confirmed_by_tech: false, service_record_id: 'svc-1' };

  test('returns EXACTLY the pinned row when this report may show it', async () => {
    const knex = makeKnex([A, B]);
    const got = await loadPinnedLawnAssessment(SERVICE, 'assess-A', knex);
    expect(got.id).toBe('assess-A');
  });

  test('honours the by-scheduled-service link too', async () => {
    const knex = makeKnex([B]);
    const got = await loadPinnedLawnAssessment(SERVICE, 'assess-B', knex);
    expect(got.id).toBe('assess-B');
  });

  // The four refusals. Each would otherwise be a way to widen what a report
  // token exposes, or to render copy nothing verified.
  test.each([
    ['another customer', OTHER_CUSTOMER, 'assess-EVIL'],
    ['another visit', OTHER_VISIT, 'assess-OTHER'],
    ['an unconfirmed row', UNCONFIRMED, 'assess-UNCONFIRMED'],
    ['a row that does not exist', A, 'assess-NOPE'],
  ])('refuses %s', async (_label, row, pin) => {
    const knex = makeKnex([row]);
    await expect(loadPinnedLawnAssessment(SERVICE, pin, knex))
      .rejects.toMatchObject({ code: 'pinned_assessment_unavailable' });
  });

  test('refuses rather than resolving when the service has no customer', async () => {
    const knex = makeKnex([A]);
    await expect(loadPinnedLawnAssessment({ id: 'svc-1' }, 'assess-A', knex))
      .rejects.toMatchObject({ code: 'pinned_assessment_unavailable' });
  });

  // The load-bearing property: a refused pin must NEVER degrade into the
  // unpinned answer. If it did, a pinned render would quietly return a
  // different assessment and the fence would have proved nothing.
  test('never falls back to normal resolution on a bad pin', async () => {
    const knex = makeKnex([A]); // A *would* resolve if we fell back
    await expect(loadPinnedLawnAssessment(SERVICE, 'assess-NOPE', knex)).rejects.toThrow();
    // Sanity: the fallback really would have succeeded.
    await expect(loadLinkedLawnAssessment(SERVICE, knex)).resolves.toMatchObject({ id: 'assess-A' });
  });
});

describe('#3168 pinned assessment — pinning ABSENCE', () => {
  const OLD_CLIENT_URL = process.env.CLIENT_URL;
  beforeAll(() => { process.env.CLIENT_URL = 'https://portal.example'; });
  afterAll(() => { process.env.CLIENT_URL = OLD_CLIENT_URL; });

  // An absent pin is not a pin of absence. A fence that sealed "no assessment"
  // has to say so, or the render is simply unpinned and a row that becomes
  // eligible during the browser's fetch and ineligible again before the
  // post-render check slips past both checks into the attachment.
  test('the sentinel is a value the URL can carry', () => {
    expect(typeof PIN_NO_ASSESSMENT).toBe('string');
    expect(PIN_NO_ASSESSMENT.length).toBeGreaterThan(0);
    expect(serviceReportViewerUrl('tok-1', null, 'pdf', { pinnedLawnAssessmentId: PIN_NO_ASSESSMENT }))
      .toContain(`assessment=${PIN_NO_ASSESSMENT}`);
  });

  test('the sentinel is not a uuid, so the route guard must special-case it', () => {
    // The route rejects any non-uuid pin before it reaches a query (the id
    // column is a Postgres uuid). The sentinel therefore has to be allowed
    // explicitly — this asserts the two rules cannot silently diverge.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    expect(UUID_RE.test(PIN_NO_ASSESSMENT)).toBe(false);
  });

  test('the sentinel can never collide with a real assessment id', () => {
    // Ids are uuids; the sentinel deliberately is not one, so a row could
    // never be named 'none' and be resolved by accident.
    expect(PIN_NO_ASSESSMENT).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/i);
  });
});

describe('#3168 pinned assessment — the pin must be SIGNED', () => {
  // Pinning narrows what a report says: `assessment=none` suppresses the lawn
  // section outright. An unsigned pin would therefore let anyone holding a
  // report token produce an official, share-able portal report with an
  // unfavourable assessment removed — forgery by omission, even though a pin
  // can never widen what the token can see. Only this server may sign.
  const OLD_SECRET = process.env.REPORT_PIN_SECRET;
  beforeAll(() => { process.env.REPORT_PIN_SECRET = 'test-pin-secret'; });
  afterAll(() => { process.env.REPORT_PIN_SECRET = OLD_SECRET; });

  test('a signature this server produced verifies', () => {
    const sig = signAssessmentPin('tok-1', 'assess-A');
    expect(typeof sig).toBe('string');
    expect(verifyAssessmentPin('tok-1', 'assess-A', sig)).toBe(true);
  });

  test('an absent or guessed signature is refused', () => {
    expect(verifyAssessmentPin('tok-1', 'assess-A', undefined)).toBe(false);
    expect(verifyAssessmentPin('tok-1', 'assess-A', '')).toBe(false);
    expect(verifyAssessmentPin('tok-1', 'assess-A', 'deadbeef')).toBe(false);
  });

  // The abuse this closes: a customer opening their own report with
  // ?assessment=none to hide an unfavourable assessment.
  test('the sentinel cannot be pinned without a signature either', () => {
    expect(verifyAssessmentPin('tok-1', PIN_NO_ASSESSMENT, undefined)).toBe(false);
    const sig = signAssessmentPin('tok-1', PIN_NO_ASSESSMENT);
    expect(verifyAssessmentPin('tok-1', PIN_NO_ASSESSMENT, sig)).toBe(true);
  });

  test('a signature is bound to its report token — no replay onto another', () => {
    const sig = signAssessmentPin('tok-1', 'assess-A');
    expect(verifyAssessmentPin('tok-2', 'assess-A', sig)).toBe(false);
  });

  test('a signature is bound to its assessment — no swapping the id', () => {
    const sig = signAssessmentPin('tok-1', 'assess-A');
    expect(verifyAssessmentPin('tok-1', 'assess-B', sig)).toBe(false);
  });

  test('the render URL carries the signature alongside the pin', () => {
    const url = serviceReportViewerUrl('tok-1', null, 'pdf', { pinnedLawnAssessmentId: 'assess-A' });
    expect(url).toContain('assessment=assess-A');
    expect(url).toContain(`asig=${signAssessmentPin('tok-1', 'assess-A')}`);
  });
});

describe('#3168 pinned assessment — fail-closed contract', () => {
  test('PinnedAssessmentUnavailable carries the code the route maps to 409', () => {
    const err = new PinnedAssessmentUnavailable('assess-X');
    expect(err.code).toBe('pinned_assessment_unavailable');
    expect(err.assessmentId).toBe('assess-X');
    expect(err).toBeInstanceOf(Error);
    // The message must not be handed to a customer verbatim; the route answers
    // with fixed copy. It only needs to identify the id for the server log.
    expect(err.message).toContain('assess-X');
  });
});

describe('#3168 pinned assessment — the render URL carries the pin', () => {
  const OLD_CLIENT_URL = process.env.CLIENT_URL;
  beforeAll(() => { process.env.CLIENT_URL = 'https://portal.example'; });
  afterAll(() => { process.env.CLIENT_URL = OLD_CLIENT_URL; });

  test('no pin renders the URL unchanged', () => {
    expect(serviceReportViewerUrl('tok-1')).toBe('https://portal.example/report/tok-1?mode=pdf');
  });

  test('a pin is appended and URL-encoded', () => {
    const url = serviceReportViewerUrl('tok-1', null, 'pdf', { pinnedLawnAssessmentId: 'assess-A' });
    expect(url).toContain('https://portal.example/report/tok-1?mode=pdf&assessment=assess-A');
  });

  test('a hostile pin value cannot break out of the query string', () => {
    const url = serviceReportViewerUrl('tok-1', null, 'pdf', {
      pinnedLawnAssessmentId: 'a&mode=live#x',
    });
    expect(url).toContain('assessment=a%26mode%3Dlive%23x');
    // One mode param only — the injected one is encoded into the value.
    expect(url.match(/mode=/g)).toHaveLength(1);
  });
});
