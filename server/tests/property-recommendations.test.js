// Portal home recommendations composer + route contracts (portal roadmap
// bet 2, owner rulings 2026-08-13): the stack may pile advice cards around
// at most ONE matrix offer; never a service the customer owns; never
// one-time services; gate-off renders nothing.

jest.mock('../services/service-report/cross-sell', () => ({
  ...jest.requireActual('../services/service-report/cross-sell'),
  buildPortalOffer: jest.fn(async () => null),
}));
jest.mock('../services/waveguard-existing-services', () => ({
  ...jest.requireActual('../services/waveguard-existing-services'),
  loadOwnedRecurringServiceKeys: jest.fn(async () => []),
}));

const { buildPortalOffer } = require('../services/service-report/cross-sell');
const { loadOwnedRecurringServiceKeys } = require('../services/waveguard-existing-services');
const {
  buildPropertyRecommendations,
  _test: { offerCard, mosquitoSeasonElevated, IRRIGATION_ADVICE },
} = require('../services/property-recommendations');

// Minimal knex fake: only lawn_water_intake_snapshots is read directly by
// the composer (everything else goes through the mocked collaborators).
function knexWithSnapshot(snapshot) {
  return (table) => {
    const q = {
      where() { return q; },
      orderBy() { return q; },
      first: async () => (table === 'lawn_water_intake_snapshots' ? snapshot : null),
    };
    return q;
  };
}

const JULY = 6; // month index — mosquito baseline 8 (elevated)
const JANUARY = 0; // baseline 2 (not elevated)

// Snapshot dates computed relative to now so the freshness cutoff never
// ages the suite out.
const daysAgo = (n) => new Date(Date.now() - n * 24 * 3600 * 1000).toISOString().slice(0, 10);
const FRESH_DATE = daysAgo(3);
const STALE_DATE = daysAgo(120);

beforeEach(() => {
  buildPortalOffer.mockReset();
  buildPortalOffer.mockImplementation(async () => null);
  loadOwnedRecurringServiceKeys.mockReset();
  loadOwnedRecurringServiceKeys.mockImplementation(async () => []);
});

describe('offerCard', () => {
  const OFFER = {
    serviceKey: 'tree_shrub',
    label: 'Tree & Shrub Care',
    mode: 'priced',
    relationship: 'add',
    option: { id: 'tree-standard', label: 'Tree & Shrub Care', cadence: '6x', perVisit: 84 },
    fingerprint: 'abc',
  };

  test('priced offer → purchase CTA with the server fingerprint riding along', () => {
    const card = offerCard(OFFER);
    expect(card.id).toBe('plan_offer');
    expect(card.kind).toBe('offer');
    expect(card.ctaLabel).toBe('Add Tree & Shrub Care');
    expect(card.fingerprint).toBe('abc');
    expect(card.option.perVisit).toBe(84);
  });

  test('quote_cta offer → request-a-quote CTA, no option', () => {
    const card = offerCard({ ...OFFER, mode: 'quote_cta', option: null });
    expect(card.ctaLabel).toBe('Request a quote');
    expect(card.option).toBeNull();
  });

  test('no offer → no card', () => {
    expect(offerCard(null)).toBeNull();
  });
});

describe('mosquito seasonal note', () => {
  test('elevated month + no mosquito program → quote-only note (never priced)', async () => {
    loadOwnedRecurringServiceKeys.mockImplementation(async () => ['pest_control']);
    const result = await buildPropertyRecommendations('cust-1', {
      knex: knexWithSnapshot(null), monthIndex: JULY,
    });
    const note = result.cards.find((c) => c.id === 'mosquito_note');
    expect(note).toBeTruthy();
    expect(note.kind).toBe('ask');
    expect(note.option).toBeUndefined();
    expect(note.fingerprint).toBeUndefined();
  });

  test('mosquito already owned → no note (never sell what they already have)', async () => {
    loadOwnedRecurringServiceKeys.mockImplementation(async () => ['pest_control', 'mosquito']);
    const result = await buildPropertyRecommendations('cust-1', {
      knex: knexWithSnapshot(null), monthIndex: JULY,
    });
    expect(result.cards.find((c) => c.id === 'mosquito_note')).toBeUndefined();
  });

  test('off-season month → no note', async () => {
    const result = await buildPropertyRecommendations('cust-1', {
      knex: knexWithSnapshot(null), monthIndex: JANUARY,
    });
    expect(result.cards.find((c) => c.id === 'mosquito_note')).toBeUndefined();
  });

  test('unreadable ownership → no note (a coverage gap we cannot prove is never claimed)', async () => {
    loadOwnedRecurringServiceKeys.mockImplementation(async () => { throw new Error('catalog down'); });
    const result = await buildPropertyRecommendations('cust-1', {
      knex: knexWithSnapshot(null), monthIndex: JULY,
    });
    expect(result.cards.find((c) => c.id === 'mosquito_note')).toBeUndefined();
  });

  test('seasonal threshold reads the forecast baseline', () => {
    expect(mosquitoSeasonElevated(JULY)).toBe(true);
    expect(mosquitoSeasonElevated(JANUARY)).toBe(false);
  });
});

describe('irrigation advice card', () => {
  test.each(Object.keys(IRRIGATION_ADVICE))('interpretation %s → advice card', async (interpretation) => {
    const result = await buildPropertyRecommendations('cust-1', {
      knex: knexWithSnapshot({ status: 'high', interpretation, service_date: FRESH_DATE }),
      monthIndex: JANUARY,
    });
    const card = result.cards.find((c) => c.id === 'irrigation_advice');
    expect(card).toBeTruthy();
    expect(card.kind).toBe('advice');
    expect(card.title).toBe(IRRIGATION_ADVICE[interpretation].title);
  });

  test('balanced water picture → no advice card', async () => {
    const result = await buildPropertyRecommendations('cust-1', {
      knex: knexWithSnapshot({ status: 'balanced', interpretation: 'water_balance_ok', service_date: FRESH_DATE }),
      monthIndex: JANUARY,
    });
    expect(result.cards.find((c) => c.id === 'irrigation_advice')).toBeUndefined();
  });

  test('a stale snapshot never drives current advice (freshness cutoff)', async () => {
    const result = await buildPropertyRecommendations('cust-1', {
      knex: knexWithSnapshot({ status: 'high', interpretation: 'wet_condition_watch', service_date: STALE_DATE }),
      monthIndex: JANUARY,
    });
    expect(result.cards.find((c) => c.id === 'irrigation_advice')).toBeUndefined();
  });

  test('no snapshot → no advice card, stack still returns', async () => {
    const result = await buildPropertyRecommendations('cust-1', {
      knex: knexWithSnapshot(null), monthIndex: JANUARY,
    });
    expect(result.cards).toEqual([]);
  });
});

describe('composition', () => {
  test('advice + offer + note pile together, offer carries the payload verbatim', async () => {
    buildPortalOffer.mockImplementation(async () => ({
      serviceKey: 'tree_shrub', label: 'Tree & Shrub Care', mode: 'priced', relationship: 'add',
      option: { id: 'tree-standard', label: 'Tree & Shrub Care', cadence: '6x', perVisit: 84 },
      fingerprint: 'fp-1',
    }));
    loadOwnedRecurringServiceKeys.mockImplementation(async () => ['pest_control', 'lawn_care']);
    const result = await buildPropertyRecommendations('cust-1', {
      knex: knexWithSnapshot({ status: 'high', interpretation: 'wet_condition_watch', service_date: FRESH_DATE }),
      monthIndex: JULY,
    });
    expect(result.cards.map((c) => c.id)).toEqual(['irrigation_advice', 'plan_offer', 'mosquito_note']);
    expect(result.cards.filter((c) => c.kind === 'offer')).toHaveLength(1);
  });

  test('a thrown offer build never kills the advice cards', async () => {
    // buildPortalOffer itself never throws by contract, but the composer
    // must not depend on that contract to keep the stack alive.
    buildPortalOffer.mockImplementation(async () => { throw new Error('unexpected'); });
    const result = await buildPropertyRecommendations('cust-1', {
      knex: knexWithSnapshot({ status: 'high', interpretation: 'wet_condition_watch', service_date: FRESH_DATE }),
      monthIndex: JANUARY,
    });
    expect(result.cards.map((c) => c.id)).toEqual(['irrigation_advice']);
  });
});

describe('route contracts (gate + drift)', () => {
  const express = require('express');

  // No supertest in this repo — bind an ephemeral listener and use fetch.
  let server = null;
  const listen = (app) => new Promise((resolve) => {
    server = app.listen(0, () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
  const post = async (base, body) => fetch(`${base}/api/property-recommendations/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  jest.resetModules();

  // Controls the route's mosquito revalidation without touching a DB.
  const mosquitoNote = jest.fn(async () => null);

  // The tables the real request writer and the bell read, as one in-memory
  // request row.
  function requestTableDb() {
    const requests = [];
    const table = (name) => {
      const q = {
        where() { return q; },
        whereIn() { return q; },
        whereNotIn() { return q; },
        orderBy() { return q; },
        forUpdate() { return q; },
        first: async () => (name === 'service_requests'
          ? (requests[0] || null)
          : { id: 'cust-1', first_name: 'Pat', last_name: 'Customer' }),
        update: async (patch) => { Object.assign(requests[0], patch); return 1; },
        insert: (row) => ({
          returning: async () => { const saved = { id: 'req-1', ...row }; requests.push(saved); return [saved]; },
        }),
      };
      return q;
    };
    const fake = (name) => table(name);
    fake.transaction = (fn) => fn(table);
    return { fake, requests };
  }

  // `offer` is what the route's recompute answers (default: no offer, this
  // suite's stance). `ctaWrites` collects what the route hands the request
  // writer, in place of a database write. `realWriter` runs the real writer
  // over { db, bells }: an in-memory request table and the bells it rang.
  function appWithGate(gateOn, { offer = null, ctaWrites = null, realWriter = null } = {}) {
    if (realWriter) {
      jest.doMock('../models/db', () => realWriter.db);
      jest.doMock('../services/notification-triggers', () => ({
        triggerNotification: async (type, payload) => { realWriter.bells.push({ type, payload }); },
      }));
    }
    jest.doMock('../middleware/auth', () => ({
      authenticate: (req, _res, nextFn) => { req.customerId = 'cust-1'; nextFn(); },
    }));
    jest.doMock('../services/service-report/cross-sell', () => ({
      ...jest.requireActual('../services/service-report/cross-sell'),
      buildPortalOffer: async () => offer,
    }));
    if (ctaWrites) {
      jest.doMock('../services/cta-service-request', () => ({
        ...jest.requireActual('../services/cta-service-request'),
        // deduped: the route rings no bell, so the test reads no customer row.
        writeOrRefreshCtaRequest: async (_db, args) => {
          ctaWrites.push(args);
          return { deduped: true, request: { id: 'req-1' } };
        },
      }));
    }
    jest.doMock('../services/property-recommendations', () => ({
      buildPropertyRecommendations: async () => ({ cards: [] }),
      mosquitoNoteCard: mosquitoNote,
    }));
    // reports-public is a very heavy route module — the route only borrows
    // its structural snapshot compare, so a stub keeps this suite light.
    jest.doMock('../routes/reports-public', () => ({
      storedRevisionMatches: () => false,
    }));
    const prev = process.env.GATE_PROPERTY_RECOMMENDATIONS;
    process.env.GATE_PROPERTY_RECOMMENDATIONS = gateOn ? 'true' : '';
    let router;
    jest.isolateModules(() => {
      router = require('../routes/property-recommendations');
    });
    process.env.GATE_PROPERTY_RECOMMENDATIONS = prev;
    const app = express();
    app.use(express.json());
    // The gate reads the env at REQUEST time, so re-set it per request.
    app.use((req, _res, nextFn) => {
      process.env.GATE_PROPERTY_RECOMMENDATIONS = gateOn ? 'true' : '';
      nextFn();
    });
    app.use('/api/property-recommendations', router);
    return app;
  }

  afterEach(async () => {
    delete process.env.GATE_PROPERTY_RECOMMENDATIONS;
    jest.dontMock('../middleware/auth');
    jest.dontMock('../routes/reports-public');
    jest.dontMock('../services/property-recommendations');
    jest.dontMock('../services/cta-service-request');
    jest.dontMock('../models/db');
    jest.dontMock('../services/notification-triggers');
    mosquitoNote.mockReset();
    mosquitoNote.mockImplementation(async () => null);
    if (server) { await new Promise((resolve) => server.close(resolve)); server = null; }
  });

  test('gate off: GET answers available:false, POST answers 404', async () => {
    const base = await listen(appWithGate(false));
    const got = await fetch(`${base}/api/property-recommendations/`);
    expect(got.status).toBe(200);
    expect(await got.json()).toEqual({ available: false, reason: 'disabled' });
    const posted = await post(base, { cardId: 'plan_offer' });
    expect(posted.status).toBe(404);
  });

  test('gate on: unknown card 400; vanished offer 409', async () => {
    const base = await listen(appWithGate(true));
    const bad = await post(base, { cardId: 'nope' });
    expect(bad.status).toBe(400);
    // buildPortalOffer is mocked to null in this suite — any plan_offer tap
    // recomputes to "no offer" and must 409, never write.
    const stale = await post(base, {
      cardId: 'plan_offer', serviceKey: 'tree_shrub', offerMode: 'priced', perApplication: 84, optionId: 'x', fingerprint: 'fp',
    });
    expect(stale.status).toBe(409);
  });

  test('gate on: mosquito note revalidates before writing — ineligible taps 409', async () => {
    const base = await listen(appWithGate(true));
    // mosquitoNote answers null (season over / ownership changed / unknowable)
    // — the write path must reject, never file the request.
    const gone = await post(base, { cardId: 'mosquito_note' });
    expect(gone.status).toBe(409);
    expect(mosquitoNote).toHaveBeenCalled();
  });

  // Owner 2026-11-21: the Billing tab shows the same offer card. The office
  // must read which tab the customer tapped on, and one offer tapped on both
  // tabs must stay one open request.
  test('gate on: a Billing tap names Billing for the office; a Home tap stores what it stored before', async () => {
    const offer = {
      serviceKey: 'lawn_care', label: 'Lawn Care', mode: 'priced', relationship: 'add',
      fingerprint: 'fp-1', option: { id: 'opt-1', perVisit: 62 },
    };
    const ctaWrites = [];
    const base = await listen(appWithGate(true, { offer, ctaWrites }));
    const tap = {
      cardId: 'plan_offer', serviceKey: 'lawn_care', offerMode: 'priced', perApplication: 62, optionId: 'opt-1', fingerprint: 'fp-1',
    };

    expect((await post(base, tap)).status).toBe(200);
    expect((await post(base, { ...tap, surface: 'billing' })).status).toBe(200);
    // Only the known tab name reaches the office text; anything else is Home.
    expect((await post(base, { ...tap, surface: 'Billing <b>' })).status).toBe(200);

    const [home, billing, unknown] = ctaWrites;
    expect(home.subject).toBe('Add Lawn Care — requested from portal home');
    expect(home.description).toContain('on the portal home recommendations (shown $62.00 per application on portal home)');
    expect(home.revisionSnapshot).toEqual({ source: 'portal_home', offer });

    expect(billing.subject).toBe('Add Lawn Care — requested from portal Billing');
    expect(billing.description).toContain('on the portal Billing recommendations (shown $62.00 per application on portal Billing)');
    // The same open-request slot and the same price-lock snapshot as Home:
    // the tab is office text only, so it never looks like a new offer.
    expect(billing.source).toBe('portal_home');
    expect(billing.requestedService).toBe(home.requestedService);
    expect(billing.revisionSnapshot).toEqual(home.revisionSnapshot);
    expect(billing.sameAskSubjects).toEqual([home.subject, billing.subject]);
    expect(home.sameAskSubjects).toEqual(billing.sameAskSubjects);

    expect(unknown.subject).toBe(home.subject);
    expect(unknown.revisionSnapshot).toEqual(home.revisionSnapshot);
  });

  test('gate on: the same offer tapped on Home and then on Billing is one request and one bell (real writer)', async () => {
    const offer = {
      serviceKey: 'lawn_care', label: 'Lawn Care', mode: 'priced', relationship: 'add',
      fingerprint: 'fp-1', option: { id: 'opt-1', perVisit: 62 },
    };
    const { fake, requests } = requestTableDb();
    const bells = [];
    const app = appWithGate(true, { offer, realWriter: { db: fake, bells } });
    const base = await listen(app);
    const tap = {
      cardId: 'plan_offer', serviceKey: 'lawn_care', offerMode: 'priced', perApplication: 62, optionId: 'opt-1', fingerprint: 'fp-1',
    };

    const first = await post(base, tap);
    expect(await first.json()).toEqual({ success: true, deduped: false });
    expect(requests).toHaveLength(1);
    expect(bells).toHaveLength(1);
    expect(bells[0].payload.suggestedService).toBe('Lawn Care (shown $62.00 per application on portal home)');

    const second = await post(base, { ...tap, surface: 'billing' });
    expect(await second.json()).toEqual({ success: true, deduped: true });
    expect(requests).toHaveLength(1);
    expect(requests[0].subject).toBe('Add Lawn Care — requested from portal home');
    expect(bells).toHaveLength(1);

    // A moved price is a new offer: the row refreshes under the tab the
    // customer tapped on, and the office hears about it.
    offer.option = { id: 'opt-1', perVisit: 70 };
    const moved = await post(base, { ...tap, perApplication: 70, surface: 'billing' });
    expect(await moved.json()).toEqual({ success: true, deduped: false });
    expect(requests).toHaveLength(1);
    expect(requests[0].subject).toBe('Add Lawn Care — requested from portal Billing');
    expect(bells).toHaveLength(2);
    expect(bells[1].payload.refreshed).toBe(true);
  });
});
