/**
 * buildConsultationEmailBlock (services/lead-consultation-email-block.js) —
 * the new_lead automation email's recurring-lead booking block. Contract:
 * '' on both sides for every ineligible/error case, a full block (heading +
 * 3 slot links + "See all open times") for an eligible recurring lead with
 * open slots, never "Adam", and the minted link's channel is 'email' (or
 * unset) — never 'sms'.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../utils/portal-url', () => ({ publicPortalUrl: () => 'https://portal.wavespestcontrol.com' }));
// The short_codes chokepoint: records every (target, opts) and hands back a
// branded /l/<code>. Tests assert the RAW token never reaches the email.
const mockShortCalls = [];
const mockCreateShortCode = jest.fn(async (targetUrl, opts) => {
  mockShortCalls.push({ targetUrl, opts });
  return { code: `c${mockShortCalls.length}`, shortUrl: `https://portal.wavespestcontrol.com/l/c${mockShortCalls.length}` };
});
jest.mock('../services/short-url', () => ({ createShortCode: (...args) => mockCreateShortCode(...args) }));

let mockBuilders = {};
const mockDb = jest.fn((table) => mockBuilders[table]);
jest.mock('../models/db', () => mockDb);

const mockComputeConsultationSlotsForLead = jest.fn();
jest.mock('../routes/inspection-public', () => ({
  _internals: { computeConsultationSlotsForLead: (...args) => mockComputeConsultationSlotsForLead(...args) },
}));

function chainBuilder({ firstRow = null } = {}) {
  const b = {};
  b.where = jest.fn(() => b);
  b.whereNull = jest.fn(() => b);
  b.first = jest.fn(async () => firstRow);
  return b;
}

const { buildConsultationEmailBlock } = require('../services/lead-consultation-email-block');
const { verifyLeadConsultationToken } = require('../utils/lead-consultation-token');

const LEAD_ID = '3f2f7b9c-1111-4222-8333-abcdefabcdef';
const originalGate = process.env.GATE_LEAD_INSPECTION_LINK;
const originalSecret = process.env.LEAD_PREFILL_SECRET;

const OPEN_RECURRING_LEAD = {
  id: LEAD_ID,
  phone: '9415551234',
  service_interest: 'Recurring Pest Control',
  status: 'new',
  converted_at: null,
};

const THREE_SLOTS = [
  { date: '2026-09-26', start_time: '09:00', dayOfWeek: 'Thu', month: 'Sep', dayNum: 26, start_label: '9:00 AM' },
  { date: '2026-09-26', start_time: '11:00', dayOfWeek: 'Thu', month: 'Sep', dayNum: 26, start_label: '11:00 AM' },
  { date: '2026-09-27', start_time: '10:00', dayOfWeek: 'Fri', month: 'Sep', dayNum: 27, start_label: '10:00 AM' },
];

beforeEach(() => {
  mockShortCalls.length = 0;
  mockCreateShortCode.mockClear();
  jest.clearAllMocks();
  mockBuilders = { leads: chainBuilder({ firstRow: OPEN_RECURRING_LEAD }) };
  process.env.GATE_LEAD_INSPECTION_LINK = 'true';
  process.env.LEAD_PREFILL_SECRET = 'test-prefill-secret';
  mockComputeConsultationSlotsForLead.mockResolvedValue({ ok: true, slots: THREE_SLOTS, needsAddress: false });
});

afterEach(() => {
  if (originalGate === undefined) delete process.env.GATE_LEAD_INSPECTION_LINK;
  else process.env.GATE_LEAD_INSPECTION_LINK = originalGate;
  if (originalSecret === undefined) delete process.env.LEAD_PREFILL_SECRET;
  else process.env.LEAD_PREFILL_SECRET = originalSecret;
});

// Slot links are short-wrapped in the email; the ?slot= targets live in the
// short_codes rows, so read them back from the recorded createShortCode calls.
function slotTargets() {
  return mockShortCalls.map((c) => c.targetUrl).filter((u) => u.includes('?slot='));
}
function shortLinksIn(html) {
  return [...html.matchAll(/href="([^"]*\/l\/[^"]*)"/g)].map((m) => m[1]);
}

describe('buildConsultationEmailBlock — hidden cases', () => {
  test('gate off renders empty and never touches the DB', async () => {
    process.env.GATE_LEAD_INSPECTION_LINK = 'false';
    const result = await buildConsultationEmailBlock({ leadId: LEAD_ID });
    expect(result).toEqual({ html: '', text: '' });
    expect(mockDb).not.toHaveBeenCalled();
  });

  test('no leadId renders empty', async () => {
    const result = await buildConsultationEmailBlock({});
    expect(result).toEqual({ html: '', text: '' });
    expect(mockDb).not.toHaveBeenCalled();
  });

  test('one-time (non-recurring) lead renders empty', async () => {
    mockBuilders.leads = chainBuilder({ firstRow: { ...OPEN_RECURRING_LEAD, service_interest: 'One-Time Pest Control' } });
    const result = await buildConsultationEmailBlock({ leadId: LEAD_ID });
    expect(result).toEqual({ html: '', text: '' });
    expect(mockComputeConsultationSlotsForLead).not.toHaveBeenCalled();
  });

  test('blank service_interest renders empty', async () => {
    mockBuilders.leads = chainBuilder({ firstRow: { ...OPEN_RECURRING_LEAD, service_interest: null } });
    const result = await buildConsultationEmailBlock({ leadId: LEAD_ID });
    expect(result).toEqual({ html: '', text: '' });
  });

  test('closed/converted lead renders empty', async () => {
    mockBuilders.leads = chainBuilder({ firstRow: { ...OPEN_RECURRING_LEAD, status: 'converted', converted_at: new Date() } });
    const result = await buildConsultationEmailBlock({ leadId: LEAD_ID });
    expect(result).toEqual({ html: '', text: '' });
    expect(mockComputeConsultationSlotsForLead).not.toHaveBeenCalled();
  });

  test('lost/cancelled status renders empty', async () => {
    mockBuilders.leads = chainBuilder({ firstRow: { ...OPEN_RECURRING_LEAD, status: 'cancelled' } });
    const result = await buildConsultationEmailBlock({ leadId: LEAD_ID });
    expect(result).toEqual({ html: '', text: '' });
  });

  test('non-US phone renders empty', async () => {
    mockBuilders.leads = chainBuilder({ firstRow: { ...OPEN_RECURRING_LEAD, phone: '+442071234567' } });
    const result = await buildConsultationEmailBlock({ leadId: LEAD_ID });
    expect(result).toEqual({ html: '', text: '' });
    expect(mockComputeConsultationSlotsForLead).not.toHaveBeenCalled();
  });

  test('lead not found renders empty', async () => {
    mockBuilders.leads = chainBuilder({ firstRow: null });
    const result = await buildConsultationEmailBlock({ leadId: LEAD_ID });
    expect(result).toEqual({ html: '', text: '' });
  });

  test('no bookable slots renders empty', async () => {
    mockComputeConsultationSlotsForLead.mockResolvedValue({ ok: true, slots: [], needsAddress: false });
    const result = await buildConsultationEmailBlock({ leadId: LEAD_ID });
    expect(result).toEqual({ html: '', text: '' });
  });

  test('slot computation refused (ok:false) renders empty', async () => {
    mockComputeConsultationSlotsForLead.mockResolvedValue({ ok: false });
    const result = await buildConsultationEmailBlock({ leadId: LEAD_ID });
    expect(result).toEqual({ html: '', text: '' });
  });

  test('error computing availability renders empty and never throws', async () => {
    mockComputeConsultationSlotsForLead.mockRejectedValue(new Error('boom'));
    await expect(buildConsultationEmailBlock({ leadId: LEAD_ID })).resolves.toEqual({ html: '', text: '' });
  });

  test('no signing secret configured renders empty', async () => {
    delete process.env.LEAD_PREFILL_SECRET;
    delete process.env.JWT_SECRET;
    const result = await buildConsultationEmailBlock({ leadId: LEAD_ID });
    expect(result).toEqual({ html: '', text: '' });
  });
});

describe('buildConsultationEmailBlock — full block', () => {
  test('renders 3 slot links + a see-all link, no "Adam", email-channeled (or unset) token', async () => {
    const result = await buildConsultationEmailBlock({ leadId: LEAD_ID });
    expect(result.html).not.toBe('');
    expect(result.text).not.toBe('');

    const links = slotTargets();
    expect(links).toHaveLength(3);
    expect(links[0]).toContain(`?slot=${encodeURIComponent('2026-09-26|09:00')}`);
    expect(links[1]).toContain(`?slot=${encodeURIComponent('2026-09-26|11:00')}`);
    expect(links[2]).toContain(`?slot=${encodeURIComponent('2026-09-27|10:00')}`);
    // 4 short links in the HTML (3 slots + see-all), and the raw bearer
    // token appears NOWHERE in either body.
    expect(shortLinksIn(result.html)).toHaveLength(4);
    expect(result.html).not.toContain('/inspection/');
    expect(result.text).not.toContain('/inspection/');
    expect(result.text).toContain('/l/');
    for (const call of mockShortCalls) {
      expect(call.opts).toMatchObject({ kind: 'consultation', entityType: 'leads', entityId: LEAD_ID, leadId: LEAD_ID });
      const ttlMs = call.opts.expiresAt.getTime() - Date.now();
      expect(ttlMs).toBeGreaterThan(13 * 24 * 3600 * 1000);
      expect(ttlMs).toBeLessThanOrEqual(14 * 24 * 3600 * 1000);
    }

    expect(result.html).toContain('See all open times');
    expect(result.html).not.toMatch(/Adam/);
    expect(result.text).not.toMatch(/Adam/);
    expect(result.text).toContain('Pick a time for us to stop by for a free consultation:');

    // The see-all link (bare, no ?slot=) and every slot link share the same
    // token — pull it out of a slot link and verify it independently.
    const tokenMatch = links[0].match(/\/inspection\/([^?]+)\?/);
    expect(tokenMatch).toBeTruthy();
    const verified = verifyLeadConsultationToken(tokenMatch[1]);
    expect(verified).toBeTruthy();
    expect(verified.leadId).toBe(LEAD_ID);
    // Channel is 'email' (or, if the verifier ever stops accepting a bare
    // 'email' claim, undefined) — NEVER the phone-bound 'sms' claim.
    expect(verified.channel).not.toBe('sms');
  });

  test('needsAddress (no address on file) renders heading + sentence + see-all only, no slot buttons', async () => {
    mockComputeConsultationSlotsForLead.mockResolvedValue({ ok: true, slots: [], needsAddress: true });
    const result = await buildConsultationEmailBlock({ leadId: LEAD_ID });
    expect(result.html).toContain('Pick a time for us to stop by');
    expect(result.html).toContain('See all open times');
    expect(slotTargets()).toHaveLength(0);
    expect(shortLinksIn(result.html)).toHaveLength(1);
    expect(result.text).toContain('Pick a time for us to stop by for a free consultation:');
  });

  test('linked customer archived → empty (same refusal rule as the text link)', async () => {
    mockBuilders.leads = chainBuilder({ firstRow: { ...OPEN_RECURRING_LEAD, customer_id: 'cust-1' } });
    mockBuilders.customers = chainBuilder({ firstRow: null });
    const result = await buildConsultationEmailBlock({ leadId: LEAD_ID });
    expect(result).toEqual({ html: '', text: '' });
    expect(mockCreateShortCode).not.toHaveBeenCalled();
  });

  test('linked customer now on a different phone → empty', async () => {
    mockBuilders.leads = chainBuilder({ firstRow: { ...OPEN_RECURRING_LEAD, customer_id: 'cust-1' } });
    mockBuilders.customers = chainBuilder({ firstRow: { phone: '+19415559999' } });
    const result = await buildConsultationEmailBlock({ leadId: LEAD_ID });
    expect(result).toEqual({ html: '', text: '' });
    expect(mockCreateShortCode).not.toHaveBeenCalled();
  });

  test('linked customer live and on the lead\'s phone → full block', async () => {
    mockBuilders.leads = chainBuilder({ firstRow: { ...OPEN_RECURRING_LEAD, customer_id: 'cust-1' } });
    mockBuilders.customers = chainBuilder({ firstRow: { phone: '+19415551234' } });
    const result = await buildConsultationEmailBlock({ leadId: LEAD_ID });
    expect(shortLinksIn(result.html)).toHaveLength(4);
  });

  test('short-wrap failure renders EMPTY — the raw token never falls through', async () => {
    mockCreateShortCode.mockRejectedValueOnce(new Error('short_codes insert failed'));
    const result = await buildConsultationEmailBlock({ leadId: LEAD_ID });
    expect(result).toEqual({ html: '', text: '' });
  });

  test('a short-url that hands the long URL back is treated as a failure', async () => {
    mockCreateShortCode.mockImplementationOnce(async (targetUrl) => ({ code: null, shortUrl: targetUrl }));
    const result = await buildConsultationEmailBlock({ leadId: LEAD_ID });
    expect(result).toEqual({ html: '', text: '' });
  });
});
