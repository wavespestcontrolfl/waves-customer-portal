const {
  assessFlagshipEventSelection,
  isFlagshipSend,
  filterPreviouslyFeaturedIdentities,
  filterRepeatedDateIdentities,
} = require('../services/newsletter-event-selection');

const REFERENCE = new Date('2026-07-20T12:00:00Z'); // Monday 8 AM EDT
const ID_1 = '11111111-1111-4111-8111-111111111111';
const ID_2 = '22222222-2222-4222-8222-222222222222';

function send(ids = [ID_1]) {
  return { newsletter_type: 'local-weekly-fresh-events', event_ids: ids };
}

function event(id = ID_1, overrides = {}) {
  return {
    id,
    title: 'Saturday Art Walk',
    description: 'A one-time downtown event.',
    admin_status: 'approved',
    start_at: '2026-07-25T22:00:00Z',
    end_at: null,
    event_url: `https://events.example/${id}`,
    event_type: 'one_time',
    recurrence_type: 'none',
    freshness_status: 'fresh_one_time',
    times_featured: 0,
    last_featured_at: null,
    pulled_at: '2026-07-19T12:00:00Z',
    merged_into: null,
    ...overrides,
  };
}

describe('flagship final event-selection gate', () => {
  test('treats a legacy NULL-typed send linked to the calendar as flagship', async () => {
    const query = {};
    query.where = jest.fn(() => query);
    query.first = jest.fn(async () => ({ id: 'calendar-row' }));
    const knex = jest.fn(() => query);

    await expect(isFlagshipSend({ id: 'legacy-send', newsletter_type: null }, { knex })).resolves.toBe(true);
    expect(knex).toHaveBeenCalledWith('newsletter_calendar');
    await expect(isFlagshipSend({ id: 'manual', newsletter_type: 'service-promo' }, { knex })).resolves.toBe(false);
    expect(knex).toHaveBeenCalledTimes(1);
  });

  test('shared pre-draft filter removes a re-ingested previously featured identity', async () => {
    const prior = event(ID_2, {
      title: 'Sunset Yoga',
      times_featured: 1,
      last_featured_at: '2026-07-07T10:00:00Z',
    });
    const query = {};
    query.select = jest.fn(() => query);
    query.where = jest.fn(async () => [prior]);
    const knex = jest.fn(() => query);

    const rows = await filterPreviouslyFeaturedIdentities([
      event(ID_1, { title: 'Sunset Yoga' }),
      event(ID_2, { title: 'Harbor Art Walk' }),
    ], { knex, reference: REFERENCE });
    expect(rows.map((row) => row.title)).toEqual(['Harbor Art Walk']);
  });

  test('shared DB-backed routine filter sees a same-title occurrence in the following issue week', async () => {
    const locked = event(ID_1, { title: 'Sunset Yoga', start_at: '2026-07-25T22:00:00Z' });
    const nextWeek = event(ID_2, { title: 'Sunset Yoga', start_at: '2026-08-01T22:00:00Z' });
    const unique = event(ID_2, { title: 'Harbor Art Walk', start_at: '2026-07-25T18:00:00Z' });
    const query = {
      select: jest.fn(),
      whereNull: jest.fn(),
      where: jest.fn(),
      then: (resolve, reject) => Promise.resolve([locked, nextWeek, unique]).then(resolve, reject),
    };
    query.select.mockReturnValue(query);
    query.whereNull.mockReturnValue(query);
    query.where.mockReturnValue(query);
    const knex = jest.fn(() => query);

    const rows = await filterRepeatedDateIdentities([locked, unique], { knex, reference: REFERENCE });
    expect(rows.map((row) => row.title)).toEqual(['Harbor Art Walk']);
    expect(query.where).toHaveBeenCalledWith('start_at', '<=', expect.any(Date));
  });

  test('prior-only and rejected siblings remain recurrence evidence', async () => {
    const locked = event(ID_1, { title: 'Sunset Yoga', start_at: '2026-07-25T22:00:00Z' });
    const rejectedPrior = event(ID_2, {
      title: 'Sunset Yoga',
      admin_status: 'rejected',
      start_at: '2026-07-18T22:00:00Z',
    });
    const rows = await filterRepeatedDateIdentities([locked], {
      reference: REFERENCE,
      identityPool: [rejectedPrior, locked],
    });
    expect(rows).toEqual([]);
  });

  test('accepts a new, approved event in the upcoming Tue–Mon issue window', () => {
    expect(assessFlagshipEventSelection(send(), [event()], REFERENCE)).toMatchObject({
      valid: true,
      errors: [],
    });
  });

  test('blocks a legacy recurring event even when the stored draft predates the policy', () => {
    const result = assessFlagshipEventSelection(send(), [event(ID_1, {
      title: 'Weekly Yoga',
      event_type: 'recurring_series',
      recurrence_type: 'weekly',
      freshness_status: 'fresh_series_launch',
    })], REFERENCE);
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('Weekly Yoga');
  });

  test('blocks previously featured, expired, missing, and out-of-window rows', () => {
    expect(assessFlagshipEventSelection(send(), [event(ID_1, { times_featured: 1 })], REFERENCE).valid).toBe(false);
    expect(assessFlagshipEventSelection(send(), [event(ID_1, { freshness_status: 'expired' })], REFERENCE).valid).toBe(false);
    expect(assessFlagshipEventSelection(send(), [], REFERENCE).valid).toBe(false);
    expect(assessFlagshipEventSelection(send(), [event(ID_1, { start_at: '2026-08-08T22:00:00Z' })], REFERENCE).valid).toBe(false);
  });

  test('blocks a newly ingested row whose canonical title was featured on an older row', () => {
    const current = event(ID_1, { title: 'Sunset Yoga' });
    const prior = event(ID_2, {
      title: 'Sunset Yoga',
      start_at: '2026-07-12T22:00:00Z',
      times_featured: 1,
      last_featured_at: '2026-07-07T10:00:00Z',
    });
    const result = assessFlagshipEventSelection(send(), [current], REFERENCE, [prior]);
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('Sunset Yoga');
  });

  test('blocks one locked occurrence when an unselected same-title sibling exists on another date', () => {
    const locked = event(ID_1, {
      title: 'Sunset Yoga',
      start_at: '2026-07-22T22:00:00Z',
    });
    const unselectedSibling = event(ID_2, {
      title: 'Sunset Yoga',
      start_at: '2026-08-01T22:00:00Z',
    });
    const result = assessFlagshipEventSelection(
      send(),
      [locked],
      REFERENCE,
      [],
      [locked, unselectedSibling],
    );
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('Sunset Yoga');
  });

  test('blocks duplicate normalized titles across distinct ids', () => {
    const first = event(ID_1, {
      title: 'Bubbles Under the Banyans',
      event_url: 'https://events.example/bubbles?utm_source=one',
    });
    const second = event(ID_2, {
      title: 'Bubbles under Banyans!',
      event_url: 'https://www.events.example/bubbles#tickets',
    });
    const result = assessFlagshipEventSelection(send([ID_1, ID_2]), [first, second], REFERENCE);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Flagship draft contains duplicate event identities.');
  });
});
