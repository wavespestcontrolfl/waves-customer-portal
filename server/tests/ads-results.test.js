/**
 * Ad results report (services/ads/ad-results.js). Read-only: counts per (campaign, ET day) from
 * ad_performance_daily, ad_service_attribution, paid invoices, customers and the rain-day record.
 */
jest.mock('../models/db', () => jest.fn());

const { adResults, NO_CAMPAIGN } = require('../services/ads/ad-results');

// Each table is a canned row list; the SQL filters are not simulated (the date window, the status and the
// customer filters belong to the queries), so every rule the service applies in JS is what these tests drive.
// Money in (netCollections reads payments and estimate_deposits). With no payments fixture, each paid invoice is
// one payment of its total on its paid_at, so a test about invoice dates reads the same money.
function fakeConn(given) {
  const tables = {
    ...given,
    payments: given.payments || (given.invoices || []).map((i) => ({ customer_id: i.customer_id, at: i.paid_at, net: i.total })),
  };
  const conn = jest.fn((name) => {
    const rows = (tables[String(name).split(' ')[0]] || []).slice();
    const builder = new Proxy({}, {
      get: (_t, prop) => {
        if (prop === 'then') return (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
        if (prop === 'first') return () => Promise.resolve(rows[0] || null);
        return () => builder;
      },
    });
    return builder;
  });
  conn.raw = (sql) => sql;
  return conn;
}

const CAMP = 'camp-a';
const CAMP_ROW = { campaign_name: 'Test Campaign A', platform: 'google_ads' };
const lead = (over = {}) => ({
  id: 'l1', campaign_id: CAMP, customer_id: null, lead_date: '2026-10-01', lead_source: 'google_ads',
  funnel_stage: 'lead', source_call_id: null, ...CAMP_ROW, lead_first_name: null, lead_last_name: null, ...over,
});
const customer = (id, over = {}) => ({
  id, first_name: 'Test', last_name: id, waveguard_tier: null, monthly_rate: 0, pipeline_stage: 'active_customer', ...over,
});
const invoice = (customerId, paidAt, total, over = {}) => ({
  id: `inv-${customerId}-${paidAt}`, customer_id: customerId, total, paid_at: new Date(paidAt),
  service_type: 'General Pest Control', title: null, ...over,
});
const WINDOW = { since: '2026-10-01', until: '2026-12-31' };
const rowOf = (out, campaignId, date) => out.rows.find((r) => r.campaign_id === campaignId && r.date === date);

describe('adResults', () => {
  test('spend and clicks come from ad_performance_daily for that day, not the split ad_cost', async () => {
    const conn = fakeConn({
      ad_performance_daily: [
        { campaign_id: CAMP, date: new Date('2026-10-01T00:00:00Z'), cost: '12.50', clicks: 7, ...CAMP_ROW },
        { campaign_id: CAMP, date: '2026-10-02', cost: '3.25', clicks: 2, ...CAMP_ROW },
      ],
      // The month split evenly: must never reach the report.
      ad_service_attribution: [lead({ ad_cost: '99.00' })],
    });
    const out = await adResults({ ...WINDOW, conn });
    expect(rowOf(out, CAMP, '2026-10-01')).toMatchObject({ spend: 12.5, clicks: 7, leads: 1, campaign: 'Test Campaign A' });
    expect(rowOf(out, CAMP, '2026-10-02')).toMatchObject({ spend: 3.25, clicks: 2, leads: 0 });
    expect(out.totals).toMatchObject({ spend: 15.75, clicks: 9, leads: 1 });
  });

  test('a lead with no campaign gets one row per lead source; calls and booked count', async () => {
    const conn = fakeConn({
      ad_service_attribution: [
        lead({ id: 'a', campaign_id: null, campaign_name: null, platform: null, lead_source: 'google_ads', source_call_id: 'call-1', funnel_stage: 'booked' }),
        lead({ id: 'b', campaign_id: null, campaign_name: null, platform: null, lead_source: 'google_ads', funnel_stage: 'completed' }),
        lead({ id: 'c', campaign_id: null, campaign_name: null, platform: null, lead_source: 'google_lsa' }),
      ],
    });
    const out = await adResults({ ...WINDOW, conn });
    const none = out.rows.filter((r) => r.campaign_id === null);
    expect(none.map((r) => [r.campaign, r.platform, r.leads, r.calls, r.booked]).sort()).toEqual([
      [NO_CAMPAIGN, 'google_ads', 2, 1, 2],
      [NO_CAMPAIGN, 'google_lsa', 1, 0, 0],
    ]);
  });

  test('a paid invoice before lead_date does not count; one on the lead day does', async () => {
    const conn = fakeConn({
      ad_service_attribution: [
        lead({ id: 'a', customer_id: 'c-before' }),
        lead({ id: 'b', customer_id: 'c-sameday' }),
      ],
      customers: [customer('c-before'), customer('c-sameday')],
      invoices: [
        invoice('c-before', '2026-09-30T15:00:00Z', 10),
        // 02:00 UTC on Oct 2 is still Oct 1 in ET.
        invoice('c-sameday', '2026-10-02T02:00:00Z', 20),
      ],
    });
    const out = await adResults({ ...WINDOW, conn });
    const row = rowOf(out, CAMP, '2026-10-01');
    expect(row).toMatchObject({ leads: 2, paid_customers: 1, paid90: 20 });
    expect(row.customers.map((c) => c.customer_id)).toEqual(['c-sameday']);
    expect(row.customers[0]).toMatchObject({ first_paid_date: '2026-10-01', service: 'General Pest Control' });
  });

  test('paid90 stops at day 90 after the lead; the customer still counts as paid', async () => {
    const conn = fakeConn({
      ad_service_attribution: [lead({ customer_id: 'c1' })],
      customers: [customer('c1')],
      invoices: [
        invoice('c1', '2026-10-05T15:00:00Z', 10),
        invoice('c1', '2026-12-30T15:00:00Z', 20), // day 90: counts
        invoice('c1', '2026-12-31T15:00:00Z', 40), // day 91: does not
      ],
    });
    const out = await adResults({ ...WINDOW, conn });
    expect(rowOf(out, CAMP, '2026-10-01')).toMatchObject({ paid_customers: 1, paid90: 30 });
  });

  test('plan or one-time comes from isMembershipCustomerRow, churn from the current stage', async () => {
    const conn = fakeConn({
      ad_service_attribution: [
        lead({ id: 'a', customer_id: 'c-tier' }),
        lead({ id: 'b', customer_id: 'c-rate' }),
        lead({ id: 'c', customer_id: 'c-once' }),
        lead({ id: 'd', customer_id: 'c-nonmember-tier' }),
      ],
      customers: [
        customer('c-tier', { waveguard_tier: 'Gold' }),
        customer('c-rate', { monthly_rate: '40.00', pipeline_stage: 'churned' }),
        customer('c-once'),
        // A tier that is not a membership beats a positive monthly_rate.
        customer('c-nonmember-tier', { waveguard_tier: 'None', monthly_rate: 40 }),
      ],
      invoices: ['c-tier', 'c-rate', 'c-once', 'c-nonmember-tier'].map((id) => invoice(id, '2026-10-03T15:00:00Z', 10)),
    });
    const out = await adResults({ ...WINDOW, conn });
    const row = rowOf(out, CAMP, '2026-10-01');
    expect(row).toMatchObject({ paid_customers: 4, plan_customers: 2, one_time_customers: 2, cancels: 1 });
    const by = Object.fromEntries(row.customers.map((c) => [c.customer_id, c]));
    expect(by['c-tier'].plan).toBe(true);
    expect(by['c-rate']).toMatchObject({ plan: true, churned: true });
    expect(by['c-once'].plan).toBe(false);
    expect(by['c-nonmember-tier'].plan).toBe(false);
  });

  test('a customer is credited to the first lead only, so totals do not double count', async () => {
    const conn = fakeConn({
      ad_service_attribution: [
        lead({ id: 'a', customer_id: 'c1', lead_date: '2026-10-01' }),
        lead({ id: 'b', customer_id: 'c1', lead_date: '2026-10-09' }),
      ],
      customers: [customer('c1')],
      invoices: [invoice('c1', '2026-10-12T15:00:00Z', 10)],
    });
    const out = await adResults({ ...WINDOW, conn });
    expect(out.totals).toMatchObject({ leads: 2, paid_customers: 1, paid90: 10 });
    expect(rowOf(out, CAMP, '2026-10-01').paid_customers).toBe(1);
    expect(rowOf(out, CAMP, '2026-10-09').paid_customers).toBe(0);
  });

  test('the rain day record joins on the ET day: the call and the measured result', async () => {
    const conn = fakeConn({
      ad_performance_daily: [
        { campaign_id: CAMP, date: '2026-10-01', cost: 1, clicks: 1, ...CAMP_ROW },
        { campaign_id: CAMP, date: '2026-10-02', cost: 1, clicks: 1, ...CAMP_ROW },
        { campaign_id: CAMP, date: '2026-10-03', cost: 1, clicks: 1, ...CAMP_ROW },
      ],
      system_settings: [{
        key: 'ads.rain_mode.days',
        value: JSON.stringify({
          '2026-10-01': { day: '2026-10-01', call: 'rain', cutoff_call: 'dry', score: { wet_day: true, hit: true, cutoff_hit: false } },
          '2026-10-02': { day: '2026-10-02', call: 'dry', cutoff_call: 'dry' },
          '2026-11-05': { day: '2026-11-05', call: 'rain', cutoff_call: 'rain' },
          '2027-01-02': { day: '2027-01-02', call: 'rain', cutoff_call: 'rain' },
        }),
      }],
    });
    const out = await adResults({ ...WINDOW, conn });
    expect(rowOf(out, CAMP, '2026-10-01').rain_day).toEqual({
      call: 'rain', cutoff_call: 'dry', scored: true, wet_day: true, hit: true, cutoff_hit: false,
    });
    expect(rowOf(out, CAMP, '2026-10-02').rain_day).toMatchObject({ call: 'dry', scored: false, wet_day: null, hit: null });
    expect(rowOf(out, CAMP, '2026-10-03').rain_day).toBeNull();
    // Every recorded day in the window, with or without an ad row; a day outside the window is left out.
    expect(out.rain_days.map((d) => [d.date, d.cutoff_call])).toEqual([
      ['2026-10-01', 'dry'], ['2026-10-02', 'dry'], ['2026-11-05', 'rain'],
    ]);
  });

  test('the owner test account is left out', async () => {
    const conn = fakeConn({
      ad_service_attribution: [lead({ customer_id: 'c1' })],
      customers: [{ ...customer('c1'), first_name: 'Shakedown', last_name: 'Test' }],
      invoices: [invoice('c1', '2026-10-03T15:00:00Z', 10)],
    });
    const out = await adResults({ ...WINDOW, conn });
    expect(out.totals).toMatchObject({ leads: 0, paid_customers: 0, paid90: 0 });
  });

  test('the customer list per row is capped, the counts are not', async () => {
    const ids = Array.from({ length: 30 }, (_, i) => `c${i}`);
    const conn = fakeConn({
      ad_service_attribution: ids.map((id) => lead({ id: `l-${id}`, customer_id: id })),
      customers: ids.map((id) => customer(id)),
      invoices: ids.map((id) => invoice(id, '2026-10-03T15:00:00Z', 10)),
    });
    const row = rowOf(await adResults({ ...WINDOW, conn }), CAMP, '2026-10-01');
    expect(row.paid_customers).toBe(30);
    expect(row.customers).toHaveLength(25);
  });
  test('money paid counts what came in, not the invoice face', async () => {
    // A 100 invoice settled by 30 of account credit and a 70 payment; a deposit of 15 counts too.
    const conn = fakeConn({
      ad_service_attribution: [lead({ customer_id: 'c1' })],
      customers: [customer('c1')],
      invoices: [invoice('c1', '2026-10-03T15:00:00Z', 100)],
      payments: [{ customer_id: 'c1', at: new Date('2026-10-03T15:00:00Z'), net: 70 }],
      estimate_deposits: [{ customer_id: 'c1', at: new Date('2026-10-02T15:00:00Z'), net: 15 }],
    });
    const out = await adResults({ ...WINDOW, conn });
    expect(out.totals).toMatchObject({ paid_customers: 1, paid90: 85 });
  });

  test('a payment before the lead day is not money from the ad', async () => {
    const conn = fakeConn({
      ad_service_attribution: [lead({ customer_id: 'c1', lead_date: '2026-10-05' })],
      customers: [customer('c1')],
      invoices: [invoice('c1', '2026-10-06T15:00:00Z', 100)],
      payments: [
        { customer_id: 'c1', at: new Date('2026-10-04T15:00:00Z'), net: 40 },
        { customer_id: 'c1', at: new Date('2026-10-06T15:00:00Z'), net: 60 },
      ],
    });
    const out = await adResults({ ...WINDOW, conn });
    expect(out.totals).toMatchObject({ paid_customers: 1, paid90: 60 });
  });

  test('a payment DATE on the lead day and on day 90 counts; day 91 does not', async () => {
    // node-postgres hands a DATE back as UTC midnight; an ET shift would move it to the day before.
    const conn = fakeConn({
      ad_service_attribution: [lead({ customer_id: 'c1' })],
      customers: [customer('c1')],
      invoices: [invoice('c1', '2026-10-01T15:00:00Z', 100)],
      payments: [
        { customer_id: 'c1', at: new Date('2026-10-01T00:00:00Z'), net: 5 },
        { customer_id: 'c1', at: new Date('2026-12-30T00:00:00Z'), net: 7 },
        { customer_id: 'c1', at: new Date('2026-12-31T00:00:00Z'), net: 11 },
      ],
    });
    const out = await adResults({ ...WINDOW, conn });
    expect(out.totals.paid90).toBe(12);
  });

  test('a test lead is left out by phone or email, under any name', async () => {
    const saved = process.env.ADAM_PHONE;
    process.env.ADAM_PHONE = '+19415550100';
    try {
      const conn = fakeConn({
        ad_service_attribution: [
          lead({ id: 'l1', customer_id: 'c1', lead_phone: '(941) 555-0100' }),
          lead({ id: 'l2', customer_id: 'c2', lead_email: 'appreview+demo@wavespestcontrol.com' }),
          lead({ id: 'l3', customer_id: 'c3' }),
        ],
        customers: [customer('c1'), customer('c2'), customer('c3', { phone: '9415550100' })],
        invoices: ['c1', 'c2', 'c3'].map((id) => invoice(id, '2026-10-03T15:00:00Z', 10)),
      });
      const out = await adResults({ ...WINDOW, conn });
      expect(out.totals).toMatchObject({ leads: 0, paid_customers: 0 });
    } finally {
      if (saved === undefined) delete process.env.ADAM_PHONE; else process.env.ADAM_PHONE = saved;
    }
  });

  test('a deposit with no paid invoice yet counts as money in, not as a paid customer', async () => {
    const conn = fakeConn({
      ad_service_attribution: [lead({ customer_id: 'c1' })],
      customers: [customer('c1')],
      invoices: [],
      payments: [],
      estimate_deposits: [{ customer_id: 'c1', at: new Date('2026-10-02T15:00:00Z'), net: 25 }],
    });
    const out = await adResults({ ...WINDOW, conn });
    expect(out.totals).toMatchObject({ paid_customers: 0, paid90: 25 });
    expect(rowOf(out, CAMP, '2026-10-01').customers).toEqual([]);
  });

  test('two leads on one day: the earlier-created lead gets the paid credit', async () => {
    const conn = fakeConn({
      ad_service_attribution: [
        lead({ id: 'l1', campaign_id: 'camp-b', customer_id: 'c1', created_at: '2026-10-01T18:00:00Z' }),
        lead({ id: 'l2', customer_id: 'c1', created_at: '2026-10-01T13:00:00Z' }),
      ],
      customers: [customer('c1')],
      invoices: [invoice('c1', '2026-10-03T15:00:00Z', 10)],
    });
    const out = await adResults({ ...WINDOW, conn });
    expect(rowOf(out, CAMP, '2026-10-01').paid_customers).toBe(1);
    expect(rowOf(out, 'camp-b', '2026-10-01').paid_customers).toBe(0);
  });

  test('a test lead linked to a customer with another name is still left out', async () => {
    const conn = fakeConn({
      ad_service_attribution: [lead({ customer_id: 'c1', lead_first_name: 'Shakedown', lead_last_name: 'Test' })],
      customers: [customer('c1')],
      invoices: [invoice('c1', '2026-10-03T15:00:00Z', 10)],
    });
    const out = await adResults({ ...WINDOW, conn });
    expect(out.totals).toMatchObject({ leads: 0, paid_customers: 0 });
  });
});
