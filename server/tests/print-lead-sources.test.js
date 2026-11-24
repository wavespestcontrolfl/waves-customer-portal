// Printed pieces (business card, yard sign, new-home postcard) as lead sources.
// Every web path resolves the same print source, with one precedence:
// GBP/Maps and paid click ids/tags beat print; print beats the website landing.

jest.mock('../models/db', () => { const db = jest.fn(); db.raw = jest.fn(); return db; });
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/locations', () => ({
  isGbpUtmCampaign: jest.fn(() => false),
  findGbpLocationByUtmContent: jest.fn(() => null),
}));

const db = require('../models/db');
const { _test } = require('../routes/lead-webhook');
const { determineLeadSource, resolveLeadSourceId } = _test;
const { resolveLeadSource } = require('../services/lead-source-resolver');
const { classifyAttributionSignals, sourceEvidenceFromAttribution } = require('../services/lead-source-evidence');
const { findPrintSource, printSourceByKey, PRINT_SOURCES, PRINT_OTHER } = require('../services/print-lead-sources');
const { attributionForSourceType } = require('../services/ads/call-attribution');
const { SOURCE_NAMES } = require('../services/source-names');
const migration = require('../models/migrations/20261124150000_print_lead_sources');

const HUB = 'https://www.wavespestcontrol.com';
const CARD_QUOTE = `${HUB}/quote/?utm_source=business_card`;
const SIGN_URL = `${HUB}/neighbor/?utm_source=yard_sign&utm_medium=print&utm_campaign=neighbor`;

// args: (pageUrl, landingUrl, utmSource, utmMedium, utmCampaign, utmContent,
//        fbclid, fbc, gclid, wbraid, gbraid, referrer)
const classify = (landing, source, medium, campaign = '', extra = {}) => determineLeadSource(
  '', landing, source, medium, campaign, extra.content || '',
  extra.fbclid || '', extra.fbc || '', extra.gclid || '', extra.wbraid || '', extra.gbraid || '', extra.referrer || '',
);

describe('print-lead-sources table', () => {
  test('a utm_source naming a piece decides, whatever the medium', () => {
    expect(findPrintSource('business_card', '').key).toBe('business_card');
    expect(findPrintSource('business_card', 'cpc').key).toBe('business_card');
    expect(findPrintSource('yard_sign', 'print').key).toBe('yard_sign');
    expect(findPrintSource('new_home_postcard', 'print').key).toBe('new_home_postcard');
  });

  test('utm_medium=print with an unknown source falls back to Print — other', () => {
    expect(findPrintSource('flyer', 'print')).toBe(PRINT_OTHER);
    expect(findPrintSource('', 'print')).toBe(PRINT_OTHER);
  });

  test('anything else is not print', () => {
    expect(findPrintSource('newsletter', 'email')).toBeNull();
    expect(findPrintSource('', '')).toBeNull();
  });

  test('every piece has a unique key, source_type and name, and a funnel channel and label', () => {
    const all = [...PRINT_SOURCES, PRINT_OTHER];
    expect(new Set(all.map((r) => r.key)).size).toBe(4);
    expect(new Set(all.map((r) => r.sourceType)).size).toBe(4);
    for (const row of all) {
      expect(printSourceByKey(row.key)).toBe(row);
      expect(attributionForSourceType(row.sourceType)).toEqual({ leadSource: row.key, isPaid: false });
      expect(SOURCE_NAMES[row.key]).toBeTruthy();
    }
    expect(printSourceByKey('waves_website')).toBeNull();
  });
});

describe('classifyAttributionSignals — print bucket and precedence', () => {
  const attr = (utm, extra = {}) => ({ landing_url: CARD_QUOTE, utm, ...extra });

  test('business card tag with no medium is print', () => {
    const c = classifyAttributionSignals(attr({ source: 'business_card' }));
    expect(c).toMatchObject({ bucket: 'print', reason: 'print_source' });
    expect(c.print.key).toBe('business_card');
  });

  test('hyphen and case variants of the source normalize', () => {
    expect(classifyAttributionSignals(attr({ source: 'Yard-Sign', medium: 'PRINT' })).print.key).toBe('yard_sign');
  });

  test('an unknown source with medium print is the generic print bucket', () => {
    const c = classifyAttributionSignals(attr({ source: 'flyer', medium: 'print' }));
    expect(c).toMatchObject({ bucket: 'print', reason: 'print_medium' });
    expect(c.print.key).toBe('print_other');
  });

  test.each([
    ['gclid', { gclid: 'g1' }, 'google_ads'],
    ['wbraid', { wbraid: 'w1' }, 'google_ads'],
    ['gbraid', { gbraid: 'g2' }, 'google_ads'],
    ['fbclid', { fbclid: 'f1' }, 'meta_ads'],
    ['fbc', { fbc: 'fb.1.1.f1' }, 'meta_ads'],
  ])('a %s click id beats a print tag', (_n, ids, bucket) => {
    expect(classifyAttributionSignals(attr({ source: 'business_card', medium: 'print' }, ids)).bucket).toBe(bucket);
  });

  test('a GBP tag or a Google Maps referrer beats print', () => {
    expect(classifyAttributionSignals(attr({ source: 'gbp', medium: 'print' })).bucket).toBe('google_business');
    const maps = classifyAttributionSignals(attr({ source: 'yard_sign', medium: 'print' }, { referrer: 'https://www.google.com/maps/place/x' }));
    expect(maps.bucket).toBe('google_business');
  });

  test('print beats an AI, social, search or own-site referrer and the website landing', () => {
    const utm = { source: 'yard_sign', medium: 'print' };
    expect(classifyAttributionSignals(attr(utm, { referrer: 'https://chatgpt.com/c/1' })).bucket).toBe('print');
    expect(classifyAttributionSignals(attr(utm, { referrer: 'https://www.facebook.com/' })).bucket).toBe('print');
    expect(classifyAttributionSignals(attr(utm, { referrer: 'https://www.google.com/search?q=x' })).bucket).toBe('print');
    expect(classifyAttributionSignals(attr(utm, { referrer: `${HUB}/` })).bucket).toBe('print');
    expect(classifyAttributionSignals(attr(utm)).bucket).toBe('print');
  });

  test('a paid google/cpc tag stays paid', () => {
    expect(classifyAttributionSignals(attr({ source: 'google', medium: 'cpc' })).bucket).toBe('google_ads');
  });

  test('no print signal leaves classification unchanged', () => {
    expect(classifyAttributionSignals(attr({ source: 'newsletter', medium: 'email' })).bucket).toBe('website');
  });
});

describe('sourceEvidenceFromAttribution — print', () => {
  test('names the piece as an offline source and never carries the URL', () => {
    const e = sourceEvidenceFromAttribution({ landing_url: CARD_QUOTE, utm: { source: 'business_card' } });
    expect(e).toMatchObject({ kind: 'offline', label: 'Business card', detail: 'Printed piece' });
    expect(JSON.stringify(e)).not.toContain('wavespestcontrol.com');
  });

  test('a click id still reads as paid evidence', () => {
    expect(sourceEvidenceFromAttribution({ gclid: 'g1', utm: { source: 'business_card' } }).kind).toBe('google_ads');
  });
});

describe('determineLeadSource (webhook + self-booking classifier) — print', () => {
  test('business card quote link: print, not waves_website', () => {
    expect(classify(CARD_QUOTE, 'business_card', '')).toMatchObject({
      source: 'business_card', detail: 'Business card', channel: 'offline',
    });
  });

  test('yard sign keeps its campaign in the detail', () => {
    expect(classify(SIGN_URL, 'yard_sign', 'print', 'neighbor')).toMatchObject({
      source: 'yard_sign', detail: 'Yard sign — neighbor', channel: 'offline',
    });
  });

  test('typed-link miss tagged for the postcard', () => {
    expect(classify(`${HUB}/`, 'new_home_postcard', 'print')).toMatchObject({ source: 'new_home_postcard', channel: 'offline' });
  });

  test('unknown print source falls back to print_other', () => {
    expect(classify(`${HUB}/`, 'flyer', 'print')).toMatchObject({ source: 'print_other', detail: 'Print — other' });
  });

  test('print on a hub city page keeps the city area', () => {
    expect(classify(`${HUB}/pest-control-sarasota-fl/`, 'business_card', '')).toMatchObject({ source: 'business_card', area: 'Sarasota' });
  });

  test('print beats a spoke domain landing', () => {
    expect(classify('https://www.veniceflpestcontrol.com/', 'yard_sign', 'print')).toMatchObject({ source: 'yard_sign', area: 'Venice' });
  });

  test('precedence: gclid beats print', () => {
    expect(classify(CARD_QUOTE, 'business_card', '', '', { gclid: 'g1' })).toMatchObject({ source: 'google_ads', channel: 'paid' });
  });

  test('precedence: fbclid beats print', () => {
    expect(classify(SIGN_URL, 'yard_sign', 'print', '', { fbclid: 'f1' })).toMatchObject({ source: 'facebook', channel: 'paid' });
  });

  test('precedence: GBP tags beat print', () => {
    expect(classify(CARD_QUOTE, 'gbp', 'organic', 'gbp').source).toBe('google_business');
  });

  test('precedence: print beats the website landing check', () => {
    expect(classify(`${HUB}/quote/`, '', '').source).toBe('waves_website');
    expect(classify(`${HUB}/quote/`, 'business_card', '').source).toBe('business_card');
  });
});

describe('resolveLeadSource (quote wizard path) — print', () => {
  const ROWS = {
    business_card: { id: 'ls-card', name: 'Business card', source_type: 'business_card' },
    yard_sign: { id: 'ls-sign', name: 'Yard sign', source_type: 'yard_sign' },
    new_home_postcard: { id: 'ls-pc', name: 'New-home postcard', source_type: 'new_home_postcard' },
    print_other: { id: 'ls-other', name: 'Print — other', source_type: 'print_other' },
  };
  const MAIN = { id: 'ls-main', name: 'Main Site (wavespestcontrol.com)', source_type: 'main_site' };
  const GOOGLE_WEB = { id: 'ls-gweb', name: 'Google Ads — Web Form', source_type: 'google_ads' };

  beforeEach(() => {
    jest.clearAllMocks();
    db.mockImplementation(() => ({
      whereRaw: () => ({ first: async () => null }),
      where: (clause) => ({
        first: async () => {
          if (clause && clause.source_type) return ROWS[clause.source_type] || null;
          if (clause && clause.name === GOOGLE_WEB.name) return GOOGLE_WEB;
          if (clause && clause.name === MAIN.name) return MAIN;
          return null;
        },
      }),
    }));
  });

  test('business card quote resolves the Business card row, not Main Site', async () => {
    const res = await resolveLeadSource({ landing_url: CARD_QUOTE, utm: { source: 'business_card' } });
    expect(res).toMatchObject({
      leadSourceId: 'ls-card', leadSourceName: 'Business card', sourceType: 'business_card',
      leadSourceDetail: 'Business card', isPaidClick: false,
    });
  });

  test('yard sign resolves its row and keeps the campaign in the detail', async () => {
    const res = await resolveLeadSource({ landing_url: SIGN_URL, utm: { source: 'yard_sign', medium: 'print', campaign: 'neighbor' } });
    expect(res).toMatchObject({ leadSourceId: 'ls-sign', sourceType: 'yard_sign', leadSourceDetail: 'Yard sign — neighbor' });
  });

  test('postcard typed-link miss resolves the postcard row', async () => {
    const res = await resolveLeadSource({ landing_url: `${HUB}/`, utm: { source: 'new_home_postcard', medium: 'print' } });
    expect(res).toMatchObject({ leadSourceId: 'ls-pc', sourceType: 'new_home_postcard' });
  });

  test('unknown print source resolves Print — other', async () => {
    const res = await resolveLeadSource({ landing_url: `${HUB}/`, utm: { source: 'flyer', medium: 'print' } });
    expect(res).toMatchObject({ leadSourceId: 'ls-other', sourceType: 'print_other' });
  });

  test('keeps the source type with a null id when the seed row is missing (never Main Site)', async () => {
    db.mockImplementation(() => ({ whereRaw: () => ({ first: async () => null }), where: () => ({ first: async () => null }) }));
    const res = await resolveLeadSource({ landing_url: CARD_QUOTE, utm: { source: 'business_card' } });
    expect(res).toMatchObject({ leadSourceId: null, sourceType: 'business_card', leadSourceName: 'Business card' });
  });

  test('a lookup failure still returns the classified print strings', async () => {
    db.mockImplementation(() => { throw new Error('db down'); });
    const res = await resolveLeadSource({ landing_url: CARD_QUOTE, utm: { source: 'business_card' } });
    expect(res).toMatchObject({ leadSourceId: null, leadSourceName: 'Business card', sourceType: 'business_card' });
  });

  test('precedence: gclid beats print (Google Ads — Web Form)', async () => {
    const res = await resolveLeadSource({ gclid: 'g1', landing_url: CARD_QUOTE, utm: { source: 'business_card' } });
    expect(res).toMatchObject({ leadSourceId: 'ls-gweb', sourceType: 'google_ads', isPaidClick: true });
  });

  test('precedence: print beats the Main Site landing', async () => {
    const plain = await resolveLeadSource({ landing_url: `${HUB}/quote/` });
    expect(plain.leadSourceId).toBe('ls-main');
    const card = await resolveLeadSource({ landing_url: CARD_QUOTE, utm: { source: 'business_card' } });
    expect(card.leadSourceId).toBe('ls-card');
  });
});

describe('lead-webhook resolveLeadSourceId — print', () => {
  function mockRows(rows) {
    const seen = [];
    db.mockImplementation((table) => {
      const q = { table, conds: [] };
      const builder = {
        where: (...args) => { q.conds.push(args); return builder; },
        whereRaw: () => builder,
        orderByRaw: () => builder,
        first: async () => {
          seen.push(q);
          const typeCond = q.conds.find((c) => c[0] === 'source_type');
          return typeCond ? rows[typeCond[1]] || null : null;
        },
      };
      return builder;
    });
    return seen;
  }

  test.each([
    ['business_card', 'ls-card'],
    ['yard_sign', 'ls-sign'],
    ['new_home_postcard', 'ls-pc'],
    ['print_other', 'ls-other'],
  ])('lead_source %s resolves its lead_sources row by source_type', async (key, id) => {
    mockRows({
      business_card: { id: 'ls-card' }, yard_sign: { id: 'ls-sign' },
      new_home_postcard: { id: 'ls-pc' }, print_other: { id: 'ls-other' },
    });
    expect(await resolveLeadSourceId({ source: key, detail: 'x', channel: 'offline' }, '')).toBe(id);
  });

  test('a paused row still resolves (is_active is not filtered)', async () => {
    const seen = mockRows({ yard_sign: { id: 'ls-sign', is_active: false } });
    expect(await resolveLeadSourceId({ source: 'yard_sign' }, '')).toBe('ls-sign');
    expect(seen[0].conds.some((c) => c[0] === 'is_active')).toBe(false);
  });

  test('a missing seed row leaves the id null', async () => {
    mockRows({});
    expect(await resolveLeadSourceId({ source: 'business_card' }, '')).toBeNull();
  });

  test('the classifier output for a business card form lead resolves end to end', async () => {
    mockRows({ business_card: { id: 'ls-card' } });
    const leadSource = classify(CARD_QUOTE, 'business_card', '');
    expect(await resolveLeadSourceId(leadSource, '')).toBe('ls-card');
  });
});

describe('migration 20261124150000 — print lead_sources seed', () => {
  function makeKnex({ hasTable = true, hasAudit = true, existingTypes = [] } = {}) {
    const inserted = [];
    const lookups = [];
    const knex = (table) => ({
      where: (cond) => ({
        first: async () => {
          lookups.push({ table, cond });
          return existingTypes.includes(cond.source_type) ? { id: `old-${cond.source_type}` } : null;
        },
      }),
      insert: (row) => ({
        returning: async () => { inserted.push({ table, row }); return [{ id: `new-${row.source_type}`, name: row.name }]; },
      }),
    });
    knex.schema = { hasTable: async (t) => (t === 'audit_log' ? hasAudit : hasTable) };
    knex._inserted = inserted;
    knex._lookups = lookups;
    return knex;
  }

  let audit;
  beforeEach(() => {
    audit = jest.spyOn(require('../services/audit-log'), 'recordAuditEvent').mockResolvedValue('audit-id');
  });
  afterEach(() => audit.mockRestore());

  test('inserts the four offline rows with the names the code expects', async () => {
    const knex = makeKnex();
    await migration.up(knex);
    expect(knex._inserted.map((i) => i.row.source_type)).toEqual(['business_card', 'yard_sign', 'new_home_postcard', 'print_other']);
    expect(knex._inserted.map((i) => i.row.name)).toEqual(['Business card', 'Yard sign', 'New-home postcard', 'Print — other']);
    for (const { table, row } of knex._inserted) {
      expect(table).toBe('lead_sources');
      expect(row).toMatchObject({ channel: 'offline', cost_type: 'free', monthly_cost: 0, is_active: true });
    }
    for (const row of [...PRINT_SOURCES, PRINT_OTHER]) {
      const seeded = knex._inserted.find((i) => i.row.source_type === row.sourceType);
      expect(seeded.row.name).toBe(row.name);
    }
    expect(audit).toHaveBeenCalledTimes(4);
  });

  test('idempotent: existing rows are never touched or audited again', async () => {
    const knex = makeKnex({ existingTypes: ['business_card', 'yard_sign', 'new_home_postcard', 'print_other'] });
    await migration.up(knex);
    expect(knex._inserted).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  test('inserts only the missing rows', async () => {
    const knex = makeKnex({ existingTypes: ['business_card'] });
    await migration.up(knex);
    expect(knex._inserted.map((i) => i.row.source_type)).toEqual(['yard_sign', 'new_home_postcard', 'print_other']);
  });

  test('no-ops without the lead_sources table; skips the audit without audit_log', async () => {
    const none = makeKnex({ hasTable: false });
    await migration.up(none);
    expect(none._lookups).toEqual([]);
    const noAudit = makeKnex({ hasAudit: false });
    await migration.up(noAudit);
    expect(noAudit._inserted).toHaveLength(4);
    expect(audit).not.toHaveBeenCalled();
  });

  test('down is a no-op', async () => {
    await expect(migration.down()).resolves.toBeUndefined();
  });
});
