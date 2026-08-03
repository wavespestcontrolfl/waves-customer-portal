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
const { signAssessmentPin, verifyAssessmentPin, PIN_TTL_SECONDS } = require('../services/service-report/assessment-pin');

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
  LAWN_RENDER_STRATEGY,
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
  const OLD_SECRET = process.env.REPORT_PIN_SECRET;
  beforeAll(() => {
    process.env.CLIENT_URL = 'https://portal.example';
    // A pin only reaches the URL when it can be signed.
    process.env.REPORT_PIN_SECRET = 'test-pin-secret';
  });
  afterAll(() => {
    process.env.CLIENT_URL = OLD_CLIENT_URL;
    process.env.REPORT_PIN_SECRET = OLD_SECRET;
  });

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
    const signed = signAssessmentPin('tok-1', 'assess-A');
    expect(typeof signed.signature).toBe('string');
    expect(verifyAssessmentPin('tok-1', 'assess-A', signed.signature, signed.expiresAt)).toBe(true);
  });

  test('an absent or guessed signature is refused', () => {
    const { expiresAt } = signAssessmentPin('tok-1', 'assess-A');
    expect(verifyAssessmentPin('tok-1', 'assess-A', undefined, expiresAt)).toBe(false);
    expect(verifyAssessmentPin('tok-1', 'assess-A', '', expiresAt)).toBe(false);
    expect(verifyAssessmentPin('tok-1', 'assess-A', 'deadbeef', expiresAt)).toBe(false);
  });

  // The abuse this closes: a customer opening their own report with
  // ?assessment=none to hide an unfavourable assessment.
  test('the sentinel cannot be pinned without a signature either', () => {
    expect(verifyAssessmentPin('tok-1', PIN_NO_ASSESSMENT, undefined, 9e9)).toBe(false);
    const signed = signAssessmentPin('tok-1', PIN_NO_ASSESSMENT);
    expect(verifyAssessmentPin('tok-1', PIN_NO_ASSESSMENT, signed.signature, signed.expiresAt)).toBe(true);
  });

  test('a signature is bound to its report token — no replay onto another', () => {
    const signed = signAssessmentPin('tok-1', 'assess-A');
    expect(verifyAssessmentPin('tok-2', 'assess-A', signed.signature, signed.expiresAt)).toBe(false);
  });

  test('a signature is bound to its assessment — no swapping the id', () => {
    const signed = signAssessmentPin('tok-1', 'assess-A');
    expect(verifyAssessmentPin('tok-1', 'assess-B', signed.signature, signed.expiresAt)).toBe(false);
  });

  test('a signature is bound to its expiry — no extending it', () => {
    const signed = signAssessmentPin('tok-1', 'assess-A');
    // Pushing the expiry out invalidates the signature: exp is signed, not
    // merely carried alongside.
    expect(verifyAssessmentPin('tok-1', 'assess-A', signed.signature, signed.expiresAt + 3600)).toBe(false);
  });

  test('an EXPIRED signature is refused — a leaked URL stops working', () => {
    // The signed URL is handed to an external browser-rendering service, so it
    // must not stay valid forever.
    const past = Math.floor(Date.now() / 1000) - 10;
    const signed = signAssessmentPin('tok-1', 'assess-A', { nowSeconds: past - PIN_TTL_SECONDS });
    expect(verifyAssessmentPin('tok-1', 'assess-A', signed.signature, signed.expiresAt)).toBe(false);
  });

  test('the render URL carries signature and expiry alongside the pin', () => {
    const url = serviceReportViewerUrl('tok-1', null, 'pdf', { pinnedLawnAssessmentId: 'assess-A' });
    expect(url).toContain('assessment=assess-A');
    expect(url).toMatch(/asig=[0-9a-f]{64}/);
    expect(url).toMatch(/aexp=\d+/);
  });

  test('NO secret configured ⇒ the render FAILS, never falls back to unpinned', () => {
    // Fail CLOSED. Degrading to an unpinned render was my first instinct — it
    // keeps mail flowing when the secret is missing — but the post-render
    // fence compares the separately built data, not what the browser fetched,
    // so an unpinned render can still mail an attachment nothing verified.
    // A stopped queue is visible and recoverable; a wrong attachment is
    // silent and unrecallable.
    const saved = process.env.REPORT_PIN_SECRET;
    const savedJwt = process.env.JWT_SECRET;
    delete process.env.REPORT_PIN_SECRET;
    delete process.env.JWT_SECRET;
    try {
      expect(signAssessmentPin('tok-1', 'assess-A')).toBeNull();
      expect(() => serviceReportViewerUrl('tok-1', null, 'pdf', { pinnedLawnAssessmentId: 'assess-A' }))
        .toThrow(/cannot be signed/i);
      // An UNPINNED render is unaffected — only a requested pin fails closed.
      expect(serviceReportViewerUrl('tok-1', null, 'pdf')).toContain('/report/tok-1?mode=pdf');
    } finally {
      process.env.REPORT_PIN_SECRET = saved;
      if (savedJwt !== undefined) process.env.JWT_SECRET = savedJwt;
    }
  });
});

describe('#3168 — assessment identity is part of the PDF storage key', () => {
  // Nulling pdf_storage_key is not a durable invalidation: a render already in
  // flight with the OLD assessment finishes afterward and writes the
  // deterministic key back, so a pinned delivery could email assessment A while
  // Download PDF served a raced render of B. Folding assessment identity into
  // the key fences it — the stale renderer's key no longer matches what the
  // next view expects, so that view re-renders. Same fix the time-on-site
  // correction uses (pdf-storage.js).
  const fs = require('fs');
  const path = require('path');
  const pdfQueueSource = fs.readFileSync(path.join(__dirname, '../services/service-report/pdf-queue.js'), 'utf8');
  const reportsPublicSource = fs.readFileSync(path.join(__dirname, '../routes/reports-public.js'), 'utf8');

  test('every storage-key composition site carries the component', () => {
    // A missing site desynchronizes written vs expected keys: lawn records
    // would either serve stale PDFs (the race this fences) or re-render on
    // every view. Two sites per module — renderAndStore + getOrRender in
    // pdf-queue, expected + store in reports-public.
    // Every key composition carries the component, whether via the single
    // canonical snapshot (laSignature) or the signature-only lookup.
    for (const source of [pdfQueueSource, reportsPublicSource]) {
      const keyLines = source.split('\n').filter((l) => l.includes('visibilitySignature:'));
      expect(keyLines.length).toBeGreaterThanOrEqual(2);
      for (const line of keyLines) {
        expect(line).toMatch(/laSignature|lawnAssessmentPdfSignature\(/);
      }
    }
  });

  test('the component is awaited everywhere it is composed', () => {
    // It is async (it resolves the assessment). A forgotten await composes
    // "[object Promise]" into the key — every render would miss cache silently.
    for (const source of [pdfQueueSource, reportsPublicSource]) {
      const composed = source.match(/[^\s(]*lawnAssessmentPdfSignature\(/g) || [];
      for (const hit of composed) {
        if (hit.startsWith('await') || hit === 'lawnAssessmentPdfSignature(') continue;
        expect(hit).toContain('await');
      }
      // Explicitly: no bare composition without await in a signature string.
      expect(source).not.toMatch(/\+ lawnAssessmentPdfSignature\(/);
    }
  });
});

describe('#3172 — ordinary renders are pinned to CANONICAL and stay cacheable', () => {
  const fs = require('fs');
  const path = require('path');
  const pdfQueueSource = fs.readFileSync(path.join(__dirname, '../services/service-report/pdf-queue.js'), 'utf8');
  const reportsPublicSource = fs.readFileSync(path.join(__dirname, '../routes/reports-public.js'), 'utf8');

  // An UNPINNED render lets the browser resolve its own assessment, so a
  // selection moving away and back defeats any pre/post check the server makes
  // — the A-to-B-to-A limitation that created #3168, one level down. Pinning
  // ordinary renders to the canonical answer removes that freedom.
  test('renderAndStore falls back to the canonical pin when no delivery pin is given', () => {
    expect(pdfQueueSource).toMatch(/effectivePin\s*=\s*pinnedLawnAssessmentId\s*\|\|\s*canonical\.pin/);
    // …and the render uses it, not the raw delivery pin.
    expect(pdfQueueSource).toMatch(/pinnedLawnAssessmentId:\s*effectivePin/);
  });

  test('the public PDF route pins its render to canonical too', () => {
    expect(reportsPublicSource).toMatch(/canonicalPin\s*=\s*canonical\.pin/);
    expect((reportsPublicSource.match(/pinnedLawnAssessmentId:\s*canonicalPin/g) || []).length)
      .toBeGreaterThanOrEqual(2);
  });

  // The load-bearing distinction: gating cache-bypass on the DELIVERY pin, not
  // on "is pinned at all". Every render carries a pin now, so gating on the
  // latter would make every render fresh and unstored — silently destroying
  // PDF caching for the whole fleet.
  test('cache bypass and unstored-return key on the DELIVERY pin only', () => {
    expect(pdfQueueSource).toMatch(/mustRenderFresh\s*=\s*forceFresh\s*\|\|\s*correctionPending\s*\|\|\s*!!pinnedLawnAssessmentId/);
    expect(pdfQueueSource).toMatch(/if \(isDeliveryPin\) \{/);
    // effectivePin must NOT be what decides caching.
    expect(pdfQueueSource).not.toMatch(/mustRenderFresh[^\n]*effectivePin/);
    expect(pdfQueueSource).not.toMatch(/if \(effectivePin\) \{/);
  });

  // The pin and the storage-key component MUST come from one lookup. Two can
  // straddle a selection change: the render pins B while the object is cached
  // under A's key — the race this closes, reintroduced by resolving twice.
  test('pin and signature come from a SINGLE canonical lookup', () => {
    for (const source of [pdfQueueSource, reportsPublicSource]) {
      expect(source).toMatch(/const canonical = await resolveCanonicalLawnRender\(/);
      expect(source).toMatch(/laSignature = canonical\.signature/);
    }
    // No render site may resolve the pin independently of the signature.
    expect(pdfQueueSource).not.toMatch(/await canonicalLawnPin\(/);
    expect(reportsPublicSource).not.toMatch(/await canonicalLawnPin\(/);
  });

  test('resolveCanonicalLawnRender: non-lawn pins nothing, lawn absence pins the sentinel', async () => {
    const { resolveCanonicalLawnRender } = require('../services/service-report/report-data');
    const knex = makeKnex([]);
    // Non-lawn: nothing to pin, so ordinary caching is untouched.
    expect(await resolveCanonicalLawnRender({ ...SERVICE, service_line: 'pest' }, knex))
      .toEqual({ pin: null, signature: '' });
    // Lawn with no assessment: absence is an answer and must be pinned, with
    // its own key marker distinct from the legacy empty one.
    expect(await resolveCanonicalLawnRender({ ...SERVICE, service_line: 'lawn' }, knex))
      .toEqual({ pin: PIN_NO_ASSESSMENT, signature: `-la${LAWN_RENDER_STRATEGY}0` });
  });

  // Objects cached by the previous UNPINNED path carry the same assessment
  // hash, so without a strategy marker they would keep being served after
  // deploy — including a PDF produced during the exact race this closes.
  test('the key carries a render-strategy marker so pre-pinning PDFs regenerate', async () => {
    const { resolveCanonicalLawnRender } = require('../services/service-report/report-data');
    const knex = makeKnex([
      { id: 'assess-A', customer_id: 'cust-1', confirmed_by_tech: true, service_record_id: 'svc-1' },
    ]);
    const { signature } = await resolveCanonicalLawnRender({ ...SERVICE, service_line: 'lawn' }, knex);
    expect(signature.startsWith(`-la${LAWN_RENDER_STRATEGY}`)).toBe(true);
    // The marker must sit BEFORE the content hash, so an unpinned-era key
    // (-la<hash>) can never collide with a pinned-era one.
    expect(signature).not.toMatch(/^-la[0-9a-f]{12}$/);
    // Non-lawn stays empty — no fleet-wide cache bust.
    expect((await resolveCanonicalLawnRender({ ...SERVICE, service_line: 'pest' }, knex)).signature).toBe('');
  });

  test('resolveCanonicalLawnRender: pin and signature describe the SAME row', async () => {
    const { resolveCanonicalLawnRender } = require('../services/service-report/report-data');
    const knex = makeKnex([
      { id: 'assess-A', customer_id: 'cust-1', confirmed_by_tech: true, service_record_id: 'svc-1', ai_summary: 'x' },
    ]);
    const got = await resolveCanonicalLawnRender({ ...SERVICE, service_line: 'lawn' }, knex);
    expect(got.pin).toBe('assess-A');
    expect(got.signature).toMatch(new RegExp(`^-la${LAWN_RENDER_STRATEGY}[0-9a-f]{12}$`));
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
  const OLD_SECRET = process.env.REPORT_PIN_SECRET;
  beforeAll(() => {
    process.env.CLIENT_URL = 'https://portal.example';
    process.env.REPORT_PIN_SECRET = 'test-pin-secret';
  });
  afterAll(() => {
    process.env.CLIENT_URL = OLD_CLIENT_URL;
    process.env.REPORT_PIN_SECRET = OLD_SECRET;
  });

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
