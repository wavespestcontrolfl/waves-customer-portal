/**
 * Out-of-area waitlist signups keep their ZIP/city. The astro waitlist card
 * posts source 'out_of_area_waitlist' with tags ['out_of_area_waitlist',
 * 'zip:NNNNN', 'city:slug']; the portal persists the two location tags into
 * newsletter_subscribers.tags (jsonb) for the signup's own pending row, and
 * every other source is untouched.
 */
let mockNsUpdates = [];
let mockSubscribeResult;
let mockUpdateImpl;

jest.mock('../models/db', () => {
  const handler = (table) => {
    const wheres = [];
    const chain = {
      where: jest.fn((arg) => { wheres.push(arg); return chain; }),
      update: jest.fn(async (patch) => {
        mockNsUpdates.push({ table, wheres: [...wheres], patch });
        return mockUpdateImpl ? mockUpdateImpl() : 1;
      }),
    };
    return chain;
  };
  const fn = jest.fn(handler);
  // applyWaitlistTags is one atomic UPDATE (Codex #5454 r1): bindings are
  // [WAITLIST_SOURCE, freshTagsJson, id]. Recorded in the same shape as the
  // chain updates so the assertions read { wheres, patch.tags }.
  fn.raw = jest.fn(async (sql, bindings) => {
    mockNsUpdates.push({
      table: 'newsletter_subscribers', sql,
      wheres: [{ id: bindings[2], status: 'pending' }],
      patch: { tags: bindings[1] },
    });
    const n = mockUpdateImpl ? await mockUpdateImpl() : 1;
    return { rowCount: n };
  });
  return fn;
});
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../services/newsletter-confirm', () => ({ sendConfirmationEmail: jest.fn(async () => {}) }));
jest.mock('../services/newsletter-subscribers', () => ({
  ...jest.requireActual('../services/newsletter-subscribers'),
  subscribeOrResubscribe: jest.fn(async () => mockSubscribeResult),
}));

const logger = require('../services/logger');
const { subscribeOrResubscribe, sanitizeWaitlistTags, applyWaitlistTags } = require('../services/newsletter-subscribers');
const router = require('../routes/public-newsletter');

function subscribeHandler() {
  const layer = router.stack.find((l) => l.route && l.route.path === '/subscribe' && l.route.methods.post);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
function post(body) {
  return new Promise((resolve, reject) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); } };
    subscribeHandler()({ body }, res, reject);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockNsUpdates = [];
  mockUpdateImpl = null;
  mockSubscribeResult = {
    action: 'confirmation_sent',
    subscriber: { id: 7, email: 'waitlister@example.com', status: 'pending', tags: [] },
  };
});

describe('sanitizeWaitlistTags', () => {
  test('keeps a 5-digit zip and a slugged city, plus the source tag', () => {
    expect(sanitizeWaitlistTags(['out_of_area_waitlist', 'zip:34205', 'city:ruskin']))
      .toEqual(['out_of_area_waitlist', 'zip:34205', 'city:ruskin']);
  });

  test('normalizes city to a capped lowercase slug', () => {
    expect(sanitizeWaitlistTags(['city:  Sun City  Center! ']))
      .toEqual(['out_of_area_waitlist', 'city:sun-city-center']);
    const long = sanitizeWaitlistTags([`city:${'a'.repeat(200)}`]);
    expect(long[1]).toBe(`city:${'a'.repeat(40)}`);
  });

  test.each([
    ['zip:1234'], ['zip:123456'], ['zip:34a05'], ['zip: 34205 x'], ['zip:'],
  ])('rejects malformed zip %j', (bad) => {
    expect(sanitizeWaitlistTags([bad])).toEqual(['out_of_area_waitlist']);
  });

  test('drops empty/garbage cities, unknown tags, and non-arrays', () => {
    expect(sanitizeWaitlistTags(['city:', 'city:!!!', 'admin', { a: 1 }, 5, null]))
      .toEqual(['out_of_area_waitlist']);
    expect(sanitizeWaitlistTags(undefined)).toEqual(['out_of_area_waitlist']);
    expect(sanitizeWaitlistTags('zip:34205')).toEqual(['out_of_area_waitlist']);
  });

  test('takes at most one zip and one city', () => {
    expect(sanitizeWaitlistTags(['zip:34205', 'zip:33570', 'city:ruskin', 'city:wimauma']))
      .toEqual(['out_of_area_waitlist', 'zip:34205', 'city:ruskin']);
  });
});

describe('sanitizeWaitlistTags top-level zip/city', () => {
  test('top-level fields win over tags; tags are the fallback', () => {
    expect(sanitizeWaitlistTags(['zip:33570', 'city:ruskin'], { zip: '34266', city: 'Arcadia' }))
      .toEqual(['out_of_area_waitlist', 'zip:34266', 'city:arcadia']);
    expect(sanitizeWaitlistTags(['zip:33570', 'city:ruskin'], {}))
      .toEqual(['out_of_area_waitlist', 'zip:33570', 'city:ruskin']);
    expect(sanitizeWaitlistTags(undefined, { zip: '34266' }))
      .toEqual(['out_of_area_waitlist', 'zip:34266']);
  });

  test('a bad top-level value falls back to the tag, never stored raw', () => {
    expect(sanitizeWaitlistTags(['zip:33570', 'city:ruskin'], { zip: '3426', city: '***' }))
      .toEqual(['out_of_area_waitlist', 'zip:33570', 'city:ruskin']);
    expect(sanitizeWaitlistTags([], { zip: 34266, city: { a: 1 } })).toEqual(['out_of_area_waitlist']);
    expect(sanitizeWaitlistTags([], { city: `Sun City ${'x'.repeat(100)}` })[1].length).toBeLessThanOrEqual(5 + 40);
  });
});

describe('applyWaitlistTags', () => {
  test('one atomic UPDATE against the current tags, CASed on pending (Codex r1 P2)', async () => {
    await applyWaitlistTags(
      { id: 7, tags: ['vip', 'zip:33570', 'city:old-town', 'out_of_area_waitlist'] },
      ['zip:33573', 'city:ruskin'],
    );
    expect(mockNsUpdates).toHaveLength(1);
    const { sql, wheres, patch } = mockNsUpdates[0];
    expect(wheres).toEqual([{ id: 7, status: 'pending' }]);
    // Only the fresh tags are bound — the stale in-memory snapshot is never written.
    expect(JSON.parse(patch.tags)).toEqual(['out_of_area_waitlist', 'zip:33573', 'city:ruskin']);
    expect(sql).toMatch(/jsonb_array_elements\(/);
    expect(sql).toMatch(/WHERE id = \? AND status = 'pending'/);
    expect(sql).toMatch(/\^\(zip\|city\):/);
  });

  test('is a no-op without a subscriber row', async () => {
    expect(await applyWaitlistTags(null, ['zip:33573'])).toBe(0);
    expect(mockNsUpdates).toHaveLength(0);
  });
});

describe('POST /subscribe', () => {
  test('out_of_area_waitlist persists zip + city tags', async () => {
    const out = await post({
      email: 'waitlister@example.com',
      source: 'out_of_area_waitlist',
      tags: ['out_of_area_waitlist', 'zip:33570', 'city:ruskin'],
    });
    expect(out).toEqual({ status: 200, body: { success: true, pending: true } });
    expect(mockNsUpdates).toHaveLength(1);
    expect(JSON.parse(mockNsUpdates[0].patch.tags))
      .toEqual(['out_of_area_waitlist', 'zip:33570', 'city:ruskin']);
  });

  test('top-level zip/city body fields are persisted as tags', async () => {
    await post({
      email: 'waitlister@example.com',
      source: 'out_of_area_waitlist',
      tags: ['out_of_area_waitlist', 'zip:34266', 'city:arcadia'],
      zip: '34266',
      city: 'Arcadia',
    });
    expect(JSON.parse(mockNsUpdates[0].patch.tags))
      .toEqual(['out_of_area_waitlist', 'zip:34266', 'city:arcadia']);
  });

  test('other sources ignore top-level zip/city too', async () => {
    await post({ email: 'a@example.com', source: 'public_form', zip: '34266', city: 'Arcadia' });
    expect(mockNsUpdates).toHaveLength(0);
  });

  test('a re-submit on a pending row also records the tags', async () => {
    mockSubscribeResult = { ...mockSubscribeResult, action: 'confirmation_resent' };
    await post({ email: 'waitlister@example.com', source: 'out_of_area_waitlist', tags: ['zip:33570'] });
    expect(JSON.parse(mockNsUpdates[0].patch.tags)).toEqual(['out_of_area_waitlist', 'zip:33570']);
  });

  test('bad zip/city is dropped, signup still succeeds', async () => {
    const out = await post({
      email: 'waitlister@example.com',
      source: 'out_of_area_waitlist',
      tags: ['zip:3357', 'city:!!!'],
    });
    expect(out.status).toBe(200);
    expect(JSON.parse(mockNsUpdates[0].patch.tags)).toEqual(['out_of_area_waitlist']);
  });

  test('an already-active subscriber is not retagged by an anonymous post', async () => {
    mockSubscribeResult = {
      action: 'already_active',
      subscriber: { id: 7, email: 'waitlister@example.com', status: 'active', tags: [] },
    };
    const out = await post({ email: 'waitlister@example.com', source: 'out_of_area_waitlist', tags: ['zip:33570'] });
    expect(out.status).toBe(200);
    expect(mockNsUpdates).toHaveLength(0);
  });

  test('every other source ignores tags entirely', async () => {
    await post({ email: 'a@example.com', source: 'public_form', tags: ['zip:33570', 'city:ruskin'] });
    await post({ email: 'a@example.com', tags: ['zip:33570'] });
    expect(mockNsUpdates).toHaveLength(0);
    expect(subscribeOrResubscribe).toHaveBeenCalledTimes(2);
    expect(subscribeOrResubscribe.mock.calls[0][0]).toEqual({
      email: 'a@example.com', firstName: null, lastName: null, source: 'public_form', strict: true, requireConfirmation: true,
    });
  });

  test('a tag-write failure does not fail the signup and never logs zip/city', async () => {
    mockUpdateImpl = () => { throw Object.assign(new Error('update newsletter_subscribers set tags = \'["zip:33570"]\''), { code: 'XX000' }); };
    const out = await post({ email: 'waitlister@example.com', source: 'out_of_area_waitlist', tags: ['zip:33570', 'city:ruskin'] });
    expect(out).toEqual({ status: 200, body: { success: true, pending: true } });
    const logged = JSON.stringify([...logger.error.mock.calls, ...logger.info.mock.calls]);
    expect(logged).not.toMatch(/33570|ruskin/);
  });
});
