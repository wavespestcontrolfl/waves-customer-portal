jest.mock('../models/db', () => jest.fn());

const db = require('../models/db');
const SiteRollup = require('../services/seo/site-rollup');
const { NETWORK_DOMAINS } = require('../utils/normalize-url');
const { MAIN_SITE_NAME } = require('../services/lead-source-resolver');

afterEach(() => {
  db.mockReset();
  delete db.raw;
});

const site = (result, domain) => result.sites.find((s) => s.domain === domain);

describe('assembleRollup — call attribution', () => {
  test('spoke tracking number rolls up to its domain, counts parsed from strings', () => {
    const result = SiteRollup.assembleRollup({
      callRows: [{ to_phone: '+19412998937', calls: '7', missed: '2' }],
      leadRows: [],
    });
    const venice = site(result, 'veniceexterminator.com');
    expect(venice.calls).toBe(7);
    expect(venice.missedCalls).toBe(2);
    expect(result.totals.calls).toBe(7);
    expect(result.totals.siteCalls).toBe(7);
  });

  test('shared LWR GBP number and main line both attribute to the hub (domain tracking wins)', () => {
    const result = SiteRollup.assembleRollup({
      callRows: [
        { to_phone: '+19413187612', calls: '3', missed: '0' },
        { to_phone: '+19412975749', calls: '4', missed: '1' },
      ],
      leadRows: [],
    });
    expect(site(result, 'wavespestcontrol.com').calls).toBe(7);
    expect(result.nonSiteLines).toHaveLength(0);
  });

  test('legacy 10-digit to_phone still matches via last-10 digits', () => {
    const result = SiteRollup.assembleRollup({
      callRows: [{ to_phone: '9413265011', calls: 2, missed: 0 }],
      leadRows: [],
    });
    expect(site(result, 'bradentonflpestcontrol.com').calls).toBe(2);
  });

  test('location-only, paid, and unknown numbers land in nonSiteLines, never dropped', () => {
    const result = SiteRollup.assembleRollup({
      callRows: [
        { to_phone: '+19412972817', calls: 5, missed: 1 }, // Parrish GBP line — not domain-tracked
        { to_phone: '+19412691697', calls: 2, missed: 0 }, // Google Ads
        { to_phone: '+15555550100', calls: 1, missed: 1 }, // not in config
      ],
      leadRows: [],
    });
    expect(result.totals.siteCalls).toBe(0);
    expect(result.totals.calls).toBe(8);
    expect(result.totals.missedCalls).toBe(2);
    const labels = result.nonSiteLines.map((l) => l.label);
    expect(labels).toContain('Parrish (Pest)');
    expect(labels).toContain('Google Ads — Pest');
    expect(labels.some((l) => l.startsWith('Unrecognized'))).toBe(true);
    expect(result.nonSiteLines[0].calls).toBe(5); // sorted by call volume
  });
});

describe('assembleRollup — lead attribution', () => {
  test('main-site and spoke source names map to their domains', () => {
    const result = SiteRollup.assembleRollup({
      callRows: [],
      leadRows: [
        { source_id: 'a', source_name: MAIN_SITE_NAME, source_domain: null, leads: '10', form_leads: '8', call_leads: '2', won: '3' },
        { source_id: 'b', source_name: 'Spoke Pest — parrishpestcontrol.com', source_domain: 'parrishpestcontrol.com', leads: '4', form_leads: '1', call_leads: '3', won: '1' },
      ],
    });
    const hub = site(result, 'wavespestcontrol.com');
    expect(hub.leads).toBe(10);
    expect(hub.formLeads).toBe(8);
    expect(hub.callLeads).toBe(2);
    expect(hub.won).toBe(3);
    expect(site(result, 'parrishpestcontrol.com').leads).toBe(4);
    expect(result.totals.leads).toBe(14);
    expect(result.totals.siteLeads).toBe(14);
    expect(result.totals.won).toBe(4);
  });

  test('unknown name with a fleet source_domain still maps to the site', () => {
    const result = SiteRollup.assembleRollup({
      callRows: [],
      leadRows: [
        { source_id: 'c', source_name: 'Old renamed source', source_domain: 'venicelawncare.com', leads: 2, form_leads: 2, call_leads: 0, won: 0 },
      ],
    });
    expect(site(result, 'venicelawncare.com').leads).toBe(2);
  });

  test('non-site sources and unattributed leads are kept separate, totals reconcile', () => {
    const result = SiteRollup.assembleRollup({
      callRows: [],
      leadRows: [
        { source_id: 'd', source_name: 'GBP — Lakewood Ranch', source_domain: null, leads: 6, form_leads: 0, call_leads: 6, won: 2 },
        { source_id: 'e', source_name: 'Referral Program', source_domain: null, leads: 3, form_leads: 0, call_leads: 0, won: 1 },
        { source_id: null, source_name: null, source_domain: null, leads: 5, form_leads: 1, call_leads: 2, won: 0 },
      ],
    });
    expect(result.totals.siteLeads).toBe(0);
    expect(result.otherSources.map((s) => s.name)).toEqual(['GBP — Lakewood Ranch', 'Referral Program']);
    expect(result.unattributed).toEqual({ leads: 5, formLeads: 1, callLeads: 2, won: 0 });
    expect(result.totals.leads).toBe(14);
    expect(result.totals.won).toBe(3);
  });
});

describe('assembleRollup — site universe and ordering', () => {
  test('every fleet domain is present even with zero activity, hubs first', () => {
    const result = SiteRollup.assembleRollup({ callRows: [], leadRows: [] });
    expect(result.sites.map((s) => s.domain).sort()).toEqual([...NETWORK_DOMAINS].sort());
    expect(result.sites[0].kind).toBe('hub');
    expect(result.sites[1].kind).toBe('hub');
    expect(result.sites.slice(2).every((s) => s.kind === 'spoke')).toBe(true);
  });

  test('spokes sort by combined call+lead volume', () => {
    const result = SiteRollup.assembleRollup({
      callRows: [{ to_phone: '+19412998937', calls: 1, missed: 0 }], // veniceexterminator
      leadRows: [
        { source_id: 'a', source_name: 'Spoke Pest — parrishpestcontrol.com', source_domain: null, leads: 9, form_leads: 9, call_leads: 0, won: 0 },
      ],
    });
    const spokes = result.sites.filter((s) => s.kind === 'spoke').map((s) => s.domain);
    expect(spokes[0]).toBe('parrishpestcontrol.com');
    expect(spokes[1]).toBe('veniceexterminator.com');
  });

  test('lanes are tagged pest vs lawn', () => {
    const result = SiteRollup.assembleRollup({ callRows: [], leadRows: [] });
    expect(site(result, 'bradentonfllawncare.com').lane).toBe('lawn');
    expect(site(result, 'waveslawncare.com').lane).toBe('lawn');
    expect(site(result, 'bradentonflpestcontrol.com').lane).toBe('pest');
    expect(site(result, 'wavespestcontrol.com').lane).toBe('pest');
  });
});

describe('getRollup', () => {
  function thenableBuilder(rows) {
    const builder = {
      where: jest.fn(() => builder),
      leftJoin: jest.fn(() => builder),
      groupBy: jest.fn(() => builder),
      select: jest.fn(() => builder),
      count: jest.fn(() => builder),
      then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
    };
    return builder;
  }

  test('clamps days and binds a real Date for the window', async () => {
    const callBuilder = thenableBuilder([]);
    const leadBuilder = thenableBuilder([]);
    db.mockImplementation((table) => (table === 'call_log' ? callBuilder : leadBuilder));
    db.raw = jest.fn((sql) => sql);

    const result = await SiteRollup.getRollup('9999');
    expect(result.days).toBe(365);
    expect(result.sites).toHaveLength(NETWORK_DOMAINS.length);

    const sinceArg = callBuilder.where.mock.calls.find((c) => c[0] === 'created_at');
    expect(sinceArg[1]).toBe('>=');
    expect(sinceArg[2]).toBeInstanceOf(Date);

    expect((await SiteRollup.getRollup('abc')).days).toBe(30);
    expect((await SiteRollup.getRollup(0)).days).toBe(30); // falsy → default
    expect((await SiteRollup.getRollup(-5)).days).toBe(1);
    expect((await SiteRollup.getRollup()).days).toBe(30);
  });
});
