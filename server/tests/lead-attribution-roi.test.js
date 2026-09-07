// Revenue accuracy for calculateSourceROI — the attribution dashboard's ROI is
// only as honest as this number. Locks in two fixes:
//   • the invoice query is bounded to the period END (was `>= start` only).
//   • revenue is attributed PER won-lead, counted from its conversion onward —
//     never the customer's pre-conversion billing history.
let mockDbConfig = {};
let mockWhereCalls = [];

jest.mock('../models/db', () => {
  const makeBuilder = (table) => {
    const rows = mockDbConfig[table];
    const builder = {
      where(...args) { mockWhereCalls.push([table, ...args]); return builder; },
      whereNull(...args) { mockWhereCalls.push([table, 'whereNull', ...args]); return builder; },
      whereIn(...args) { mockWhereCalls.push([table, 'whereIn', args[0]]); return builder; },
      whereNotIn(...args) { mockWhereCalls.push([table, 'whereNotIn', ...args]); return builder; },
      whereRaw(...args) { mockWhereCalls.push([table, 'whereRaw', ...args]); return builder; },
      modify(fn) { fn(builder); return builder; },
      first: async () => (Array.isArray(rows) ? (rows[0] ?? null) : (rows ?? null)),
      select: async () => (Array.isArray(rows) ? rows : []),
      then(resolve, reject) {
        return Promise.resolve(Array.isArray(rows) ? rows : []).then(resolve, reject);
      },
    };
    return builder;
  };
  const db = (table) => makeBuilder(table);
  db.raw = (s) => ({ __raw: s });
  db.fn = { now: () => 'NOW' };
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { calculateSourceROI, allocatePooledChannelCost } = require('../services/lead-attribution');

describe('calculateSourceROI — window- and conversion-bounded revenue', () => {
  const start = new Date('2026-06-01T00:00:00Z');
  const end = new Date('2026-06-30T23:59:59Z');

  beforeEach(() => { mockDbConfig = {}; mockWhereCalls = []; });

  function setup({ leads, costs = [], invoices = [], services = [], monthlyCost = 0 }) {
    mockDbConfig = {
      lead_sources: { id: 'src-1', name: 'GBP', monthly_cost: monthlyCost, channel: 'organic' },
      leads,
      lead_source_costs: costs,
      invoices,
      service_records: services,
    };
  }

  test('excludes invoices dated BEFORE the lead converted (no pre-conversion history)', async () => {
    const convertedAt = new Date('2026-06-15T00:00:00Z');
    setup({
      costs: [{ cost_amount: 3 }],
      leads: [{ id: 'L1', status: 'won', customer_id: 'c1', converted_at: convertedAt }],
      invoices: [
        { id: 'i1', customer_id: 'c1', total: '500', created_at: new Date('2026-06-10T00:00:00Z') }, // pre-conversion → ignored
        { id: 'i2', customer_id: 'c1', total: '120', created_at: new Date('2026-06-20T00:00:00Z') }, // post-conversion → counted
      ],
    });

    const res = await calculateSourceROI('src-1', start, end);
    expect(res.totalRevenue).toBe(120);
    expect(res.roi).toBeCloseTo(3900, 0); // (120 - 3) / 3 * 100
  });

  test('excludeCustomerNames filters internal/test accounts out of the leads query', async () => {
    setup({
      costs: [{ cost_amount: 3 }],
      leads: [{ id: 'L1', status: 'won', customer_id: 'c1', converted_at: start }],
      invoices: [{ customer_id: 'c1', total: '100', created_at: start }],
    });

    await calculateSourceROI('src-1', start, end, { excludeCustomerNames: ['adam martinez'] });
    const exclusion = mockWhereCalls.find((c) => c[0] === 'leads' && c[1] === 'whereNotIn');
    expect(exclusion).toBeTruthy();
    expect(exclusion[3]).toEqual(['adam martinez']);
  });

  test('non-engaged rows (spam / cancelled / auto-filed duplicate) are excluded from the source population', async () => {
    setup({ costs: [{ cost_amount: 3 }], leads: [], invoices: [] });
    await calculateSourceROI('src-1', start, end);
    const statusExclusion = mockWhereCalls.find((c) => c[0] === 'leads' && c[1] === 'whereNotIn' && c[2] === 'leads.status');
    expect(statusExclusion).toBeTruthy();
    // A converted repeat keeps its ancestry marker: it is excluded only as a
    // SECOND win — when its original is won too (pre-push r13); a won repeat
    // whose original is lost / foreign / gone is the deal's only won row and
    // counts (codex r14 P2).
    const { SECOND_WIN_SQL } = require('../services/lead-statuses');
    const secondWin = mockWhereCalls.find((c) => c[0] === 'leads' && c[1] === 'whereRaw' && /duplicate_of_lead_id/.test(c[2]));
    expect(secondWin[2]).toBe(SECOND_WIN_SQL);
    // The walk resolves the whole marker chain (B → A → O), bounded and
    // through live duplicate hops only, on the uuid primary key.
    expect(SECOND_WIN_SQL).toMatch(/WITH RECURSIVE chain AS/);
    expect(SECOND_WIN_SQL).toMatch(/WHERE chain\.status = 'duplicate' AND chain\.deleted_at IS NULL AND chain\.depth < 8/);
    // ...and a won root is a second win only for the SAME opportunity by the
    // accept path's rule: same customer when both are linked, else the
    // root's current phone or email still matches (codex r15 P2, r16 P2).
    expect(SECOND_WIN_SQL).toMatch(/WHEN chain\.customer_id IS NOT NULL AND leads\.customer_id IS NOT NULL THEN chain\.customer_id = leads\.customer_id/);
    expect(SECOND_WIN_SQL).toMatch(/right\(regexp_replace\(COALESCE\(chain\.phone, ''\), '\[\^0-9\]', '', 'g'\), 10\) = right\(regexp_replace\(COALESCE\(leads\.phone, ''\), '\[\^0-9\]', '', 'g'\), 10\)/);
    expect(SECOND_WIN_SQL).toMatch(/LOWER\(TRIM\(chain\.email\)\) = LOWER\(TRIM\(leads\.email\)\)/);
    // ...and never through a DIFFERENT estimate: a root won on estimate X
    // while the repeat won on estimate Y is a different deal, exactly as the
    // accept path promotes it (codex r17 P2) — judged on the scope each win
    // persisted (won_estimate_id, else the row's own link) on BOTH sides, so
    // an unlinked repeat that won on estimate B stays counted once its root
    // linked to estimate A wins too (PR B pre-push P1).
    expect(SECOND_WIN_SQL).toMatch(/AND NOT \(chain\.won_scope IS NOT NULL AND COALESCE\(leads\.extracted_data->>'won_estimate_id', leads\.estimate_id::text\) IS NOT NULL AND chain\.won_scope <> COALESCE\(leads\.extracted_data->>'won_estimate_id', leads\.estimate_id::text\)\)/);
    expect(SECOND_WIN_SQL).toMatch(/SELECT o\.status, o\.deleted_at, o\.customer_id, COALESCE\(o\.extracted_data->>'won_estimate_id', o\.estimate_id::text\) AS won_scope, o\.phone, o\.email/);
    expect(SECOND_WIN_SQL).toMatch(/SELECT p\.status, p\.deleted_at, p\.customer_id, COALESCE\(p\.extracted_data->>'won_estimate_id', p\.estimate_id::text\), p\.phone, p\.email/);
    expect(SECOND_WIN_SQL).not.toMatch(/chain\.estimate_id/);
    // The sources summary counts (GET /leads/sources) splice the same scope
    // into every COUNT subquery, so the client-derived source conversion
    // rate agrees with the ROI (codex r16 P2).
    const { PROSPECT_SCOPE_SQL, WON_DESCENDANT_SQL } = require('../services/lead-statuses');
    expect(PROSPECT_SCOPE_SQL).toBe(`leads.status NOT IN ('cancelled', 'spam', 'duplicate') AND ${SECOND_WIN_SQL} AND ${WON_DESCENDANT_SQL}`);
    // The mirror from the root's side: an OPEN root with a live won repeat of
    // the same opportunity in its ancestry is that deal already counted — a
    // repeat's win settles onto the root's funnel row and leaves the root's
    // lead row open for the office to merge (codex #3834 r35 P2). The
    // descent walks the marker as text so the expression index serves it.
    const wonDescendant = mockWhereCalls.find((c) => c[0] === 'leads' && c[1] === 'whereRaw' && /WITH RECURSIVE down AS/.test(c[2]));
    expect(wonDescendant[2]).toBe(WON_DESCENDANT_SQL);
    expect(WON_DESCENDANT_SQL).toMatch(/^\(leads\.status NOT IN \('new', 'contacted', 'estimate_sent', 'estimate_viewed'\) OR NOT EXISTS/);
    expect(WON_DESCENDANT_SQL).toMatch(/WHERE d\.lead_type = 'quote_wizard' AND d\.extracted_data->>'duplicate_of_lead_id' = leads\.id::text/);
    expect(WON_DESCENDANT_SQL).toMatch(/JOIN leads c ON c\.lead_type = 'quote_wizard' AND c\.extracted_data->>'duplicate_of_lead_id' = down\.id::text/);
    expect(WON_DESCENDANT_SQL).toMatch(/WHERE down\.status = 'duplicate' AND down\.deleted_at IS NULL AND down\.depth < 8/);
    expect(WON_DESCENDANT_SQL).toMatch(/WHERE down\.status = 'won' AND down\.deleted_at IS NULL/);
    // ...on the scope the win persisted (won_estimate_id, a deposit on
    // estimate B converting an unlinked repeat), else the repeat's own link:
    // a root linked to estimate A is a different deal and stays counted.
    expect(WON_DESCENDANT_SQL).toMatch(/COALESCE\(d\.extracted_data->>'won_estimate_id', d\.estimate_id::text\) AS won_scope/);
    expect(WON_DESCENDANT_SQL).toMatch(/AND NOT \(down\.won_scope IS NOT NULL AND leads\.estimate_id IS NOT NULL AND down\.won_scope <> leads\.estimate_id::text\)/);
    expect(WON_DESCENDANT_SQL).toMatch(/WHEN down\.customer_id IS NOT NULL AND leads\.customer_id IS NOT NULL THEN down\.customer_id = leads\.customer_id/);
    const adminLeadsSrc = require('fs').readFileSync(require('path').join(__dirname, '../routes/admin-leads.js'), 'utf8');
    expect((adminLeadsSrc.match(/leads\.deleted_at IS NULL AND \$\{PROSPECT_SCOPE_SQL\}/g) || []).length).toBe(4);
    // The dashboard breakdowns (leads-by-source over `leads as l`, channel-mix)
    // apply the same scope — alias-aware, so every outer reference follows
    // the alias and none is left on the bare table name (codex r18 P2).
    const { scopeToProspects } = require('../services/lead-statuses');
    const aliased = [];
    const qb = { whereNotIn: (...a) => { aliased.push(['whereNotIn', ...a]); return qb; }, whereRaw: (...a) => { aliased.push(['whereRaw', ...a]); return qb; } };
    scopeToProspects(qb, 'l');
    expect(aliased[0]).toEqual(['whereNotIn', 'l.status', expect.arrayContaining(['duplicate', 'spam', 'cancelled'])]);
    expect(aliased[1][1]).toMatch(/^\(l\.status IS DISTINCT FROM 'won' OR NOT EXISTS/);
    expect(aliased[1][1]).not.toMatch(/\bleads\.(status|extracted_data|customer_id|estimate_id|phone|email)\b/);
    expect(aliased[1][1]).toMatch(/FROM chain JOIN leads p ON/); // the inner walk still names the table
    expect(aliased[2][1]).toMatch(/^\(l\.status NOT IN \(/);
    expect(aliased[2][1]).not.toMatch(/\bleads\.(status|extracted_data|customer_id|estimate_id|phone|email|id)\b/);
    expect(aliased[2][1]).toMatch(/= l\.id::text/);
    // The cross-source winner map (calculateAllSourceROI) is built over the
    // same population, so a second win never claims a customer its own
    // source cannot credit (codex r20 P2).
    const attributionSrc = require('fs').readFileSync(require('path').join(__dirname, '../services/lead-attribution.js'), 'utf8');
    expect(attributionSrc).toMatch(/\.whereNotNull\('customer_id'\)\n\s+\.modify\(\(qb\) => applyNameExclusion\(qb, excludeCustomerNames\)\)\n(\s+\/\/.*\n)*\s+\.modify\(scopeToProspects\)\n\s+\.orderByRaw\('COALESCE\(converted_at, \?\) ASC', \[start\]\)/);
    const dashboardSrc = require('fs').readFileSync(require('path').join(__dirname, '../routes/admin-dashboard.js'), 'utf8');
    expect(dashboardSrc).toMatch(/\.whereNull\('l\.deleted_at'\)\n\s+\.modify\(\(qb\) => scopeToProspects\(qb, 'l'\)\),/);
    expect(dashboardSrc).toMatch(/applyETTimestampWindow\(db\('leads'\)\.whereNull\('deleted_at'\)\.modify\(scopeToProspects\), 'first_contact_at', win\.from, win\.to\)/);
    expect(statusExclusion[3]).toEqual(expect.arrayContaining(['duplicate', 'spam', 'cancelled']));
  });

  test('bounds the invoice query to the period end (created_at <= end)', async () => {
    setup({
      costs: [{ cost_amount: 3 }],
      leads: [{ id: 'L1', status: 'won', customer_id: 'c1', converted_at: start }],
      invoices: [{ customer_id: 'c1', total: '100', created_at: start }],
    });

    await calculateSourceROI('src-1', start, end);
    const hasUpperBound = mockWhereCalls.some(
      (c) => c[0] === 'invoices' && c[1] === 'created_at' && c[2] === '<=' && c[3] === end,
    );
    expect(hasUpperBound).toBe(true);
  });

  test('falls back to captured monthly_value + initial_service_value when not yet billed', async () => {
    setup({
      costs: [{ cost_amount: 3 }],
      leads: [{
        id: 'L1', status: 'won', customer_id: 'c1', converted_at: end,
        monthly_value: '80', initial_service_value: '200',
      }],
      invoices: [],
      services: [],
    });

    const res = await calculateSourceROI('src-1', start, end);
    expect(res.totalRevenue).toBe(280); // 1 month * 80 + 200
  });

  test('a source with cost but no conversions reads negative ROI, not a placeholder', async () => {
    setup({
      costs: [{ cost_amount: 3 }],
      leads: [{ id: 'L1', status: 'new', customer_id: null }],
    });

    const res = await calculateSourceROI('src-1', start, end);
    expect(res.totalRevenue).toBe(0);
    expect(res.conversions).toBe(0);
    expect(res.roi).toBe(-100); // (0 - 3) / 3 * 100
  });

  test('de-duplicates an invoice across repeat won leads for the same customer', async () => {
    setup({
      costs: [{ cost_amount: 3 }],
      leads: [
        { id: 'L1', status: 'won', customer_id: 'c1', converted_at: new Date('2026-06-10T00:00:00Z') },
        { id: 'L2', status: 'won', customer_id: 'c1', converted_at: new Date('2026-06-12T00:00:00Z') },
      ],
      // One invoice, dated after BOTH conversions — must be counted ONCE, not per lead.
      invoices: [{ id: 'i1', customer_id: 'c1', total: '300', created_at: new Date('2026-06-20T00:00:00Z') }],
    });

    const res = await calculateSourceROI('src-1', start, end);
    expect(res.conversions).toBe(2);
    expect(res.totalRevenue).toBe(300); // not 600
  });

  test('skips the captured-value fallback when the conversion is AFTER the report end', async () => {
    setup({
      costs: [{ cost_amount: 3 }],
      // First-contacted in window but won after `end` → no revenue in this closed period.
      leads: [{
        id: 'L1', status: 'won', customer_id: 'c1',
        converted_at: new Date('2026-07-15T00:00:00Z'),
        monthly_value: '80', initial_service_value: '200',
      }],
      invoices: [],
      services: [],
    });

    const res = await calculateSourceROI('src-1', start, end);
    expect(res.totalRevenue).toBe(0);
  });

  test('uses the window start (NOT updated_at) as the cutoff when converted_at is missing', async () => {
    setup({
      costs: [{ cost_amount: 3 }],
      // converted_at null + a late updated_at; the in-window invoice predates
      // updated_at and would be wrongly dropped if updated_at were the cutoff.
      leads: [{
        id: 'L1', status: 'won', customer_id: 'c1',
        converted_at: null, updated_at: new Date('2026-06-28T00:00:00Z'),
      }],
      invoices: [{ id: 'i1', customer_id: 'c1', total: '150', created_at: new Date('2026-06-10T00:00:00Z') }],
    });

    const res = await calculateSourceROI('src-1', start, end);
    expect(res.totalRevenue).toBe(150);
  });

  test('credits NO revenue when another source is the customer’s earliest-conversion winner', async () => {
    setup({
      costs: [{ cost_amount: 3 }],
      leads: [{
        id: 'L1', status: 'won', customer_id: 'c1', converted_at: start,
        monthly_value: '80', initial_service_value: '200',
      }],
      invoices: [{ id: 'i1', customer_id: 'c1', total: '500', created_at: new Date('2026-06-20T00:00:00Z') }],
    });

    // c1's revenue belongs to a DIFFERENT source (earliest conversion) — this
    // source still counts the conversion but neither the invoice nor the fallback.
    const res = await calculateSourceROI('src-1', start, end, {
      revenueSourceByCustomer: new Map([['c1', 'other-src']]),
    });
    expect(res.conversions).toBe(1);
    expect(res.totalRevenue).toBe(0); // not 500, not 280
  });

  test('credits revenue when THIS source is the customer’s winner', async () => {
    setup({
      costs: [{ cost_amount: 3 }],
      leads: [{ id: 'L1', status: 'won', customer_id: 'c1', converted_at: start }],
      invoices: [{ id: 'i1', customer_id: 'c1', total: '200', created_at: new Date('2026-06-20T00:00:00Z') }],
    });

    const res = await calculateSourceROI('src-1', start, end, {
      revenueSourceByCustomer: new Map([['c1', 'src-1']]),
    });
    expect(res.totalRevenue).toBe(200);
  });

  test('bounds lead_source_costs by an ET date string, not the month-start timestamp', async () => {
    setup({ costs: [{ cost_amount: 5 }], leads: [] });
    await calculateSourceROI('src-1', start, end);

    const costLower = mockWhereCalls.find(
      (c) => c[0] === 'lead_source_costs' && c[1] === 'month' && c[2] === '>=',
    );
    expect(costLower).toBeDefined();
    // A 'YYYY-MM-DD' string (date column), not a Date/timestamp — otherwise the
    // ET month-start timestamp (04:00 UTC) would drop the current month's DATE row.
    expect(typeof costLower[3]).toBe('string');
    expect(costLower[3]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('credits a service_record fallback (ET date-bounded) when the customer has no invoices', async () => {
    setup({
      costs: [{ cost_amount: 3 }],
      leads: [{ id: 'L1', status: 'won', customer_id: 'c1', converted_at: new Date('2026-06-05T00:00:00Z') }],
      invoices: [],
      services: [{ id: 's1', customer_id: 'c1', revenue: '90', service_date: '2026-06-10', status: 'completed' }],
    });

    const res = await calculateSourceROI('src-1', start, end);
    expect(res.totalRevenue).toBe(90); // service.revenue after conversion day, no invoices

    // service_date (a DATE column) is bound by a date string, like the cost month.
    const svcLower = mockWhereCalls.find(
      (c) => c[0] === 'service_records' && c[1] === 'service_date' && c[2] === '>=',
    );
    expect(svcLower).toBeDefined();
    expect(typeof svcLower[3]).toBe('string');
    expect(svcLower[3]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('filters to billed invoices and completed services (status guards)', async () => {
    // A won lead with a customer makes the invoice/service queries run.
    setup({
      costs: [{ cost_amount: 3 }],
      leads: [{ id: 'L1', status: 'won', customer_id: 'c1', converted_at: start }],
      invoices: [],
      services: [],
    });
    await calculateSourceROI('src-1', start, end);

    const invStatus = mockWhereCalls.find(
      (c) => c[0] === 'invoices' && c[1] === 'whereNotIn' && c[2] === 'status',
    );
    expect(invStatus).toBeDefined();
    expect(invStatus[3]).toEqual(expect.arrayContaining(['void', 'cancelled', 'draft', 'refunded']));

    const svcStatus = mockWhereCalls.find(
      (c) => c[0] === 'service_records' && c[1] === 'status' && c[2] === 'completed',
    );
    expect(svcStatus).toBeDefined();
  });
});

describe('calculateSourceROI — channelSpend (the poolable share of cost)', () => {
  const start = new Date('2026-06-01T00:00:00Z');
  const end = new Date('2026-06-30T23:59:59Z');
  beforeEach(() => { mockDbConfig = {}; mockWhereCalls = []; });

  test('default-category monthly_fee and ad_spend pool; setup/other do not', async () => {
    mockDbConfig = {
      lead_sources: { id: 'g', name: 'Google Ads — Pest (call-extension)', source_type: 'google_ads', monthly_cost: 0 },
      leads: [], lead_source_costs: [
        { cost_amount: 500, cost_category: 'monthly_fee' }, // Log Cost UI default
        { cost_amount: 250, cost_category: 'ad_spend' },
        { cost_amount: 40, cost_category: 'setup' },
      ], invoices: [], service_records: [],
    };
    const r = await calculateSourceROI('g', start, end);
    expect(r.totalCost).toBe(790);
    expect(r.channelSpend).toBe(750);
  });

  test('monthly_cost still applies when only one-off costs were logged (mixed configuration)', async () => {
    mockDbConfig = {
      lead_sources: { id: 'g', name: 'Google Ads — Pest (call-extension)', source_type: 'google_ads', monthly_cost: 300 },
      leads: [], lead_source_costs: [{ cost_amount: 40, cost_category: 'setup' }], invoices: [], service_records: [],
    };
    const r = await calculateSourceROI('g', start, end);
    expect(r.channelSpend).toBe(300);
    expect(r.totalCost).toBe(340);
  });

  test('the monthly_cost fallback is channel spend', async () => {
    mockDbConfig = {
      lead_sources: { id: 'g', name: 'Google Ads — Pest (call-extension)', source_type: 'google_ads', monthly_cost: 300 },
      leads: [], lead_source_costs: [], invoices: [], service_records: [],
    };
    const r = await calculateSourceROI('g', start, end);
    expect(r.totalCost).toBe(300);
    expect(r.channelSpend).toBe(300);
  });
});

describe('allocatePooledChannelCost — Google Ads channel spend is one budget across its rows', () => {
  // totalCost = row-specific (one-off) costs + channelSpend; only channelSpend is pooled.
  const row = (name, totalLeads, conversions, totalRevenue, channelSpend, ownCost = 0, source_type = 'google_ads') => {
    const totalCost = ownCost + channelSpend;
    return {
      source: { name, source_type }, totalLeads, conversions, totalRevenue, totalCost, channelSpend,
      costPerLead: totalLeads ? totalCost / totalLeads : 0,
      costPerAcquisition: conversions ? totalCost / conversions : 0,
      roi: totalCost > 0 ? ((totalRevenue - totalCost) / totalCost) * 100 : (totalRevenue > 0 ? 9999 : 0),
    };
  };

  test('re-allocates ad spend across google_ads rows by lead share; row-specific costs stay put', () => {
    const call = row('Google Ads — Pest (call-extension)', 2, 1, 400, 900, 50); // $50 one-off 'setup' is the call row's own
    const form = row('Google Ads — Web Form', 6, 3, 1200, 0);
    const other = row('Main Site (wavespestcontrol.com)', 10, 2, 800, 0, 0, 'main_site');
    const out = allocatePooledChannelCost([call, form, other]);
    expect(out).toHaveLength(3);
    // 900 pooled ad spend, 8 leads → 112.5/lead: call 225 (+50 own), form 675
    expect(call.channelSpend).toBe(225);
    expect(call.totalCost).toBe(275);
    expect(form.channelSpend).toBe(675);
    expect(form.totalCost).toBe(675);
    expect(call.channelSpend + form.channelSpend).toBe(900);
    expect(form.roi).toBe(Math.round(((1200 - 675) / 675) * 1000) / 10);
    expect(form.costPerLead).toBe(112.5);
    expect(form.costPerAcquisition).toBe(225);
    expect(call.pooledCostAllocation).toEqual({ pooledChannelSpend: 900, share: 0.25 });
    // Non-pooled source types untouched.
    expect(other.totalCost).toBe(0);
    expect(other.pooledCostAllocation).toBeUndefined();
  });

  test('one-off row-specific cost on a google_ads row is NOT pooled', () => {
    const call = row('Google Ads — Pest (call-extension)', 1, 0, 0, 0, 120); // 'setup' only
    const form = row('Google Ads — Web Form', 3, 1, 500, 0);
    allocatePooledChannelCost([call, form]);
    expect(call.totalCost).toBe(120);
    expect(form.totalCost).toBe(0);
    expect(form.pooledCostAllocation).toBeUndefined();
  });

  test('splits equally when the pool has spend but no leads', () => {
    const a = row('Google Ads — Pest (call-extension)', 0, 0, 0, 300);
    const b = row('Google Ads — Web Form', 0, 0, 0, 0);
    allocatePooledChannelCost([a, b]);
    expect(a.totalCost).toBe(150);
    expect(b.totalCost).toBe(150);
  });

  test('allocates integer cents — rows always sum to the pool, remainder goes to the largest fraction', () => {
    // $0.01 split equally: naive per-row rounding reports $0.01 + $0.01.
    const a = row('Google Ads — Pest (call-extension)', 0, 0, 0, 0.01);
    const b = row('Google Ads — Web Form', 0, 0, 0, 0);
    allocatePooledChannelCost([a, b]);
    expect(a.totalCost + b.totalCost).toBe(0.01);
    expect([a.totalCost, b.totalCost]).toEqual([0.01, 0]); // tie → input order

    // $1.00 over 3 leads (1/1/1): 33/33/34 cents, not 33.33 ×3.
    const rows = [
      row('Google Ads — Pest (call-extension)', 1, 0, 0, 1),
      row('Google Ads - Call Reporting Bridge', 1, 0, 0, 0),
      row('Google Ads — Web Form', 1, 1, 10, 0),
    ];
    allocatePooledChannelCost(rows);
    const cents = rows.map((r) => Math.round(r.totalCost * 100));
    expect(cents.reduce((x, y) => x + y, 0)).toBe(100);
    expect(cents.sort()).toEqual([33, 33, 34]);
    // ROI derives from the allocated cost, not an unrounded share.
    const form = rows.find((r) => r.source.name === 'Google Ads — Web Form');
    expect(form.roi).toBe(Math.round(((10 - form.totalCost) / form.totalCost) * 1000) / 10);
  });

  test('a single google_ads row is left exactly as computed', () => {
    const only = row('Google Ads — Web Form', 4, 1, 700, 200);
    const before = { ...only };
    allocatePooledChannelCost([only]);
    expect(only).toEqual(before);
  });
});
