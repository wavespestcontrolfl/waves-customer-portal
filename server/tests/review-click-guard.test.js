/**
 * review-click-guard: a visit's date-only anchor is ET midnight, not UTC
 * midnight (Railway runs TZ=UTC), so a click the evening BEFORE the visit
 * never suppresses that visit's ask (pre-push P1 on the neutral-reviews PR).
 */
const guard = require('../services/review-click-guard');

function fakeDb({ serviceDate = null, scheduledDate = null, clicks = [] } = {}) {
  return (table) => {
    if (table === 'service_records') return { where: () => ({ first: async () => (serviceDate ? { service_date: serviceDate } : null) }) };
    if (table === 'scheduled_services') return { where: () => ({ first: async () => (scheduledDate ? { scheduled_date: scheduledDate } : null) }) };
    if (table === 'review_requests') {
      let since = null;
      const q = {
        where(arg) {
          if (typeof arg === 'function') {
            const b = { where: (_col, _op, value) => { since = value; return b; }, orWhere: () => b };
            arg(b);
          }
          return q;
        },
        whereNotNull: () => q,
        first: async () => (clicks.some((c) => new Date(c) >= new Date(since)) ? { id: 'rr-1' } : null),
      };
      return q;
    }
    throw new Error(`unexpected table ${table}`);
  };
}

describe('review-click-guard visit anchor', () => {
  test.each([
    ['a date string (EDT)', '2026-09-30', '2026-09-30T04:00:00.000Z'],
    ['a pg Date at UTC midnight (EDT)', new Date('2026-09-30T00:00:00Z'), '2026-09-30T04:00:00.000Z'],
    ['a date string (EST)', '2026-12-15', '2026-12-15T05:00:00.000Z'],
  ])('%s anchors at ET midnight', async (_label, serviceDate, expected) => {
    const anchor = await guard.visitAnchor({ serviceRecordId: 'sr-1' }, fakeDb({ serviceDate }));
    expect(anchor.toISOString()).toBe(expected);
  });

  test('the scheduled visit date anchors at ET midnight too', async () => {
    const anchor = await guard.visitAnchor({ scheduledServiceId: 'ss-1' }, fakeDb({ scheduledDate: '2026-09-30' }));
    expect(anchor.toISOString()).toBe('2026-09-30T04:00:00.000Z');
  });

  test('a 9 p.m. ET click the evening before the visit does NOT suppress the visit ask', async () => {
    // 2026-09-30T01:00Z = Sept 29, 9:00 p.m. EDT
    const db = fakeDb({ serviceDate: '2026-09-30', clicks: ['2026-09-30T01:00:00Z'] });
    expect(await guard.touchSuppressedByClick('cust-1', { serviceRecordId: 'sr-1' }, db)).toBe(false);
  });

  test('a cadence with no visit anchors at its own start (fallbackAnchor): only a click after it began counts', async () => {
    const started = '2026-09-20T15:00:00Z';
    const after = fakeDb({ clicks: ['2026-09-21T15:00:00Z'] });
    expect(await guard.touchSuppressedByClick('cust-1', { fallbackAnchor: started }, after)).toBe(true);
    const before = fakeDb({ clicks: ['2026-09-19T15:00:00Z'] });
    expect(await guard.touchSuppressedByClick('cust-1', { fallbackAnchor: started }, before)).toBe(false);
    // no visit and no fallback → no anchor → never suppressed
    expect(await guard.touchSuppressedByClick('cust-1', {}, after)).toBe(false);
  });

  test('a click just after ET midnight on the visit day DOES suppress it', async () => {
    // 2026-09-30T04:30Z = Sept 30, 12:30 a.m. EDT
    const db = fakeDb({ serviceDate: '2026-09-30', clicks: ['2026-09-30T04:30:00Z'] });
    expect(await guard.touchSuppressedByClick('cust-1', { serviceRecordId: 'sr-1' }, db)).toBe(true);
  });
});

describe('newestCompletedVisitAnchor ordering matches the anchor instant', () => {
  // The ORDER BY runs in Postgres (the unit fakes cannot evaluate it), so pin the
  // contract: same-day scheduled visits are ordered by the SAME instant
  // scheduledInstant() reads (actual end, then check-out, then completed_at).
  test('scheduled visits order same-day ties by COALESCE(actual_end_time, check_out_time, completed_at)', async () => {
    const raws = {};
    const fake = (table) => {
      const q = {
        where: () => q,
        orderBy: () => q,
        orderByRaw: (sql) => { raws[table] = sql; return q; },
        first: async () => (table === 'scheduled_services'
          ? { scheduled_date: '2026-09-25', actual_end_time: null, check_out_time: '2026-09-25T20:00:00Z', completed_at: '2026-09-25T13:00:00Z' }
          : null),
      };
      return q;
    };
    const anchor = await guard.newestCompletedVisitAnchor('cust-1', fake);
    expect(raws.scheduled_services).toMatch(/COALESCE\(\s*actual_end_time\s*,\s*check_out_time\s*,\s*completed_at\s*\)\s+DESC\s+NULLS\s+LAST/i);
    // ...and the anchor reads check_out_time before completed_at, like the ORDER BY.
    expect(anchor.toISOString()).toBe('2026-09-25T20:00:00.000Z');
  });
});

// GATE_REVIEW_PROBABLE_REVIEWER_GUARD (owner 2026-10-31, review matching plan PR 4): an ask also
// stops, whatever its visit, when an open review-matcher decision names the customer or they texted
// that they left a review. Synthetic names only.
describe('probable reviewer', () => {
  const OLD = process.env.GATE_REVIEW_PROBABLE_REVIEWER_GUARD;
  afterEach(() => {
    if (OLD === undefined) delete process.env.GATE_REVIEW_PROBABLE_REVIEWER_GUARD;
    else process.env.GATE_REVIEW_PROBABLE_REVIEWER_GUARD = OLD;
  });

  function fakeReviewDb({ reviews = [], texts = [] } = {}) {
    return (table) => {
      if (table === 'google_reviews') {
        const filters = [];
        const q = {
          where: (obj) => { filters.push((r) => Object.entries(obj).every(([k, v]) => r[k] === v)); return q; },
          whereIn: (col, values) => { filters.push((r) => values.includes(r[col])); return q; },
          whereNull: (col) => { filters.push((r) => r[col] == null); return q; },
          first: async () => reviews.find((r) => filters.every((f) => f(r))) || undefined,
        };
        return q;
      }
      if (table === 'sms_log') {
        const filters = [];
        const q = {
          where: (obj) => { filters.push((r) => Object.entries(obj).every(([k, v]) => r[k] === v)); return q; },
          whereILike: (_col, pattern) => { const needle = pattern.replace(/%/g, '').toLowerCase(); filters.push((r) => r.message_body.toLowerCase().includes(needle)); return q; },
          select: async () => texts.filter((r) => filters.every((f) => f(r))),
        };
        return q;
      }
      // No visit and no click rows: only the probable-reviewer arm can stop the ask.
      if (table === 'review_requests') return { where: () => ({ whereNotNull: () => ({ where: () => ({ first: async () => null }) }) }) };
      if (table === 'service_records' || table === 'scheduled_services') {
        const none = { where: () => none, orderBy: () => none, orderByRaw: () => none, first: async () => null };
        return none;
      }
      throw new Error(`unexpected table ${table}`);
    };
  }

  const openPause = { name_match_customer_id: 'cust-1', name_match_result: 'pause', customer_id: null, missing_since: null };

  test('gate off: an open matcher decision changes nothing', async () => {
    delete process.env.GATE_REVIEW_PROBABLE_REVIEWER_GUARD;
    expect(await guard.touchSuppressedByClick('cust-1', { fallbackAnchor: '2026-10-20T15:00:00Z' }, fakeReviewDb({ reviews: [openPause] }))).toBe(false);
  });

  test('gate on: an open matcher decision naming the customer stops every ask, with or without a visit anchor', async () => {
    process.env.GATE_REVIEW_PROBABLE_REVIEWER_GUARD = 'true';
    const db = fakeReviewDb({ reviews: [openPause] });
    expect(await guard.touchSuppressedByClick('cust-1', {}, db)).toBe(true);
    expect(await guard.askSuppressedByClick({ customer_id: 'cust-1', created_at: '2026-10-20T15:00:00Z' }, db)).toBe(true);
    expect(await guard.touchSuppressedByClick('cust-2', {}, db)).toBe(false);
  });

  test('gate on: a decision that is linked, removed, or only a queue entry does not stop the ask', async () => {
    process.env.GATE_REVIEW_PROBABLE_REVIEWER_GUARD = 'true';
    const db = fakeReviewDb({
      reviews: [
        { ...openPause, customer_id: 'cust-9' },
        { ...openPause, missing_since: '2026-10-01T00:00:00Z' },
        { ...openPause, name_match_result: 'queue' },
      ],
    });
    expect(await guard.probableReviewer('cust-1', db)).toBe(false);
  });

  test('gate on: a text saying they left a review stops the ask; a negated one does not', async () => {
    process.env.GATE_REVIEW_PROBABLE_REVIEWER_GUARD = 'true';
    const said = fakeReviewDb({ texts: [{ customer_id: 'cust-1', direction: 'inbound', message_body: 'Just left you a 5 star review!' }] });
    expect(await guard.probableReviewer('cust-1', said)).toBe(true);
    const notYet = fakeReviewDb({ texts: [{ customer_id: 'cust-1', direction: 'inbound', message_body: 'I have not left a review yet' }] });
    expect(await guard.probableReviewer('cust-1', notYet)).toBe(false);
    const ours = fakeReviewDb({ texts: [{ customer_id: 'cust-1', direction: 'outbound', message_body: 'Thanks, we saw you left a review!' }] });
    expect(await guard.probableReviewer('cust-1', ours)).toBe(false);
    // A question or a plan never stops asks for good.
    const asking = fakeReviewDb({ texts: [{ customer_id: 'cust-1', direction: 'inbound', message_body: 'Can you send me the link so I can get my review posted?' }] });
    expect(await guard.probableReviewer('cust-1', asking)).toBe(false);
    const planning = fakeReviewDb({ texts: [{ customer_id: 'cust-1', direction: 'inbound', message_body: 'I will let you know when I have left a review.' }] });
    expect(await guard.probableReviewer('cust-1', planning)).toBe(false);
  });
});
