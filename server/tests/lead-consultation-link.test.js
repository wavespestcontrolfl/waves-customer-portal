/**
 * buildLeadConsultationLink / consultationUrlForLead / buildLeadConsultationSmsLine
 * (services/lead-consultation-link.js) — composer-contract shape
 * ({ url, line, reason }), gate-off dark-ship behavior, and the no-phone /
 * missing-lead / no-secret reasons (lead-inspection-link-scope.md §4).
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../utils/portal-url', () => ({ publicPortalUrl: () => 'https://portal.wavespestcontrol.com' }));
jest.mock('../services/short-url', () => ({
  createShortCode: jest.fn(async () => ({ code: 'abc123', shortUrl: 'https://waves.link/l/abc123' })),
}));
// buildLeadConsultationSmsLine's template render — getTemplate stubbed per
// test; admin-sms-templates' own inactive/missing/fallback semantics are
// admin-sms-templates-render.test.js's contract, not this file's.
// hasStopLine is real (a pure function, the SAME one admin-sms-templates.js's
// own save-time validator uses — pre-push Codex P1: this file's render-time
// re-check must exercise the actual detector, not a re-mocked stand-in).
jest.mock('../routes/admin-sms-templates', () => ({
  getTemplate: jest.fn(),
  hasStopLine: jest.requireActual('../routes/admin-sms-templates').hasStopLine,
}));

let mockBuilders = {};
const mockDb = jest.fn((table) => mockBuilders[table]);
jest.mock('../models/db', () => mockDb);

function chainBuilder({ firstRow = null } = {}) {
  const b = {};
  b.where = jest.fn(() => b);
  b.whereNull = jest.fn(() => b);
  b.first = jest.fn(async () => firstRow);
  return b;
}

const { createShortCode } = require('../services/short-url');
const { getTemplate } = require('../routes/admin-sms-templates');
const {
  buildLeadConsultationLink,
  buildLeadConsultationSmsLine,
  consultationUrlForLead,
  consultationSmsLineFor,
  consultationLinkAvailable,
} = require('../services/lead-consultation-link');

const LEAD_ID = '3f2f7b9c-1111-4222-8333-abcdefabcdef';
const originalGate = process.env.GATE_LEAD_INSPECTION_LINK;
const originalSecret = process.env.LEAD_PREFILL_SECRET;
const originalJwt = process.env.JWT_SECRET;

beforeEach(() => {
  jest.clearAllMocks();
  mockDb.mockClear();
  process.env.GATE_LEAD_INSPECTION_LINK = 'true';
  process.env.LEAD_PREFILL_SECRET = 'test-prefill-secret';
});

afterEach(() => {
  if (originalGate === undefined) delete process.env.GATE_LEAD_INSPECTION_LINK;
  else process.env.GATE_LEAD_INSPECTION_LINK = originalGate;
  if (originalSecret === undefined) delete process.env.LEAD_PREFILL_SECRET;
  else process.env.LEAD_PREFILL_SECRET = originalSecret;
  if (originalJwt === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = originalJwt;
});

describe('buildLeadConsultationLink — gate off', () => {
  test('returns url:null with a reason and never touches the DB', async () => {
    process.env.GATE_LEAD_INSPECTION_LINK = 'false';
    const result = await buildLeadConsultationLink(LEAD_ID);
    expect(result.url).toBeNull();
    expect(result.line).toBe('');
    expect(result.reason).toMatch(/switched off/i);
    expect(mockDb).not.toHaveBeenCalled();
  });

  test('any spelling other than exactly "true" is off (strict compare, per house style)', async () => {
    process.env.GATE_LEAD_INSPECTION_LINK = 'TRUE';
    const result = await buildLeadConsultationLink(LEAD_ID);
    expect(result.url).toBeNull();
  });
});

describe('buildLeadConsultationLink — gate on', () => {
  test('mints a short-wrapped consultation link with the composer line shape', async () => {
    mockBuilders = { leads: chainBuilder({ firstRow: { id: LEAD_ID, phone: '+19415550100', status: 'new', converted_at: null } }) };
    const result = await buildLeadConsultationLink(LEAD_ID);
    expect(result.url).toBe('https://waves.link/l/abc123');
    // The bearer-token long URL never rides the line itself.
    expect(result.line).not.toContain('/inspection/');
    expect(result.line).toBe(`Pick a time for us to stop by for a free consultation: ${result.url}\n\n`);
    expect(result.line.endsWith('\n\n')).toBe(true);
    expect(createShortCode).toHaveBeenCalledWith(
      expect.stringContaining(`/inspection/${LEAD_ID}.`),
      expect.objectContaining({ kind: 'consultation', leadId: LEAD_ID, expiresAt: expect.any(Date) })
    );
    // Rides to the composer for the scheduled-link fence (pre-push Codex P1).
    expect(result.expiresAt).toBeInstanceOf(Date);
    expect(result.immediateOnly).toBe(true);
  });

  test('fails closed when the short code cannot be minted (never passes the token URL through)', async () => {
    mockBuilders = { leads: chainBuilder({ firstRow: { id: LEAD_ID, phone: '+19415550100', status: 'new', converted_at: null } }) };
    createShortCode.mockRejectedValueOnce(new Error('short_codes insert failed'));
    const result = await buildLeadConsultationLink(LEAD_ID);
    expect(result.url).toBeNull();
    expect(result.line).toBe('');
    expect(result.reason).toBeTruthy();
  });

  test('accepts a lead object and re-resolves it from the DB (never trusts the passed-in row)', async () => {
    mockBuilders = { leads: chainBuilder({ firstRow: { id: LEAD_ID, phone: '+19415550100', status: 'new', converted_at: null } }) };
    const result = await buildLeadConsultationLink({ id: LEAD_ID, phone: 'stale-should-be-ignored' });
    expect(result.url).toBeTruthy();
    expect(mockDb).toHaveBeenCalledWith('leads');
  });

  test('missing lead (deleted or nonexistent) returns a reason, no link', async () => {
    mockBuilders = { leads: chainBuilder({ firstRow: null }) };
    const result = await buildLeadConsultationLink(LEAD_ID);
    expect(result.url).toBeNull();
    expect(result.reason).toMatch(/not found/i);
  });

  // Pre-push Codex P1: this is the CHOKEPOINT every caller (composer-
  // customer-links.js's buildConsultationLink, admin-communications.js's
  // resolveConsultationLeadOnly, admin-leads.js's GET
  // /:id/consultation-link) inherits — enforced here regardless of which
  // caller resolved the lead id and however permissive that caller's own
  // early filter is (or isn't).
  test.each([
    ['a CLOSED status (disqualified)', { status: 'disqualified', converted_at: null }],
    ['a CLOSED status (unresponsive)', { status: 'unresponsive', converted_at: null }],
    ['a CONVERTED lead (won, converted_at set)', { status: 'won', converted_at: new Date('2026-01-01') }],
    ['converted_at set even with an open-looking status', { status: 'new', converted_at: new Date('2026-01-01') }],
  ])('%s is unavailable — no link minted, whoever the caller is', async (_label, statusFields) => {
    mockBuilders = { leads: chainBuilder({ firstRow: { id: LEAD_ID, phone: '+19415550100', ...statusFields } }) };
    const result = await buildLeadConsultationLink(LEAD_ID);
    expect(result.url).toBeNull();
    expect(result.line).toBe('');
    expect(result.reason).toBe('That lead has already converted or closed');
    expect(createShortCode).not.toHaveBeenCalled();
  });

  test('lead with no phone returns a reason, no link', async () => {
    mockBuilders = { leads: chainBuilder({ firstRow: { id: LEAD_ID, phone: null, status: 'new', converted_at: null } }) };
    const result = await buildLeadConsultationLink(LEAD_ID);
    expect(result.url).toBeNull();
    expect(result.reason).toMatch(/no phone/i);
  });

  // Codex #4709 r17 P2: the send check's linked-customer rule applies at
  // mint time, so no unsendable 14-day code is created.
  test.each([
    ['archived', null, /archived/],
    ['on a different phone', { phone: '+19415559999' }, /different phone/],
    // Codex #4709 r19 P1: same last ten digits, different country.
    ['on an international number sharing the last ten digits', { phone: '+449415550100' }, /different phone/],
  ])('a lead whose linked customer is %s mints nothing', async (_label, ownerRow, reason) => {
    mockBuilders = {
      leads: chainBuilder({ firstRow: { id: LEAD_ID, phone: '+19415550100', status: 'new', converted_at: null, customer_id: 'cust-1' } }),
      customers: chainBuilder({ firstRow: ownerRow }),
    };
    const result = await buildLeadConsultationLink(LEAD_ID);
    expect(result.url).toBeNull();
    expect(result.reason).toMatch(reason);
    expect(createShortCode).not.toHaveBeenCalled();
  });

  // Codex #4709 r18 P2: non-US numbers are refused before minting.
  test('a lead with a non-US phone mints nothing', async () => {
    mockBuilders = { leads: chainBuilder({ firstRow: { id: LEAD_ID, phone: '+447700900123', status: 'new', converted_at: null } }) };
    const result = await buildLeadConsultationLink(LEAD_ID);
    expect(result.url).toBeNull();
    expect(result.reason).toMatch(/US numbers/);
    expect(createShortCode).not.toHaveBeenCalled();
  });

  // Codex #4709 r18 P2: the availability probe shares the same rules, so
  // the Leads button shows the reason before the click.
  test.each([
    ['archived customer', { customer_id: 'cust-1' }, null, /archived/],
    ['customer on a different phone', { customer_id: 'cust-1' }, { phone: '+19415559999' }, /different phone/],
    ['non-US phone', { phone: '+447700900123' }, null, /US numbers/],
  ])('the availability probe reports %s as unavailable', async (_label, leadPatch, ownerRow, reason) => {
    const { consultationLinkAvailable } = require('../services/lead-consultation-link');
    mockBuilders = {
      leads: chainBuilder({ firstRow: { id: LEAD_ID, phone: '+19415550100', status: 'new', converted_at: null, ...leadPatch } }),
      customers: chainBuilder({ firstRow: ownerRow }),
    };
    const result = await consultationLinkAvailable(LEAD_ID);
    expect(result).toMatchObject({ enabled: true, available: false });
    expect(result.reason).toMatch(reason);
  });

  test('no signing secret configured fails closed with a reason', async () => {
    delete process.env.LEAD_PREFILL_SECRET;
    delete process.env.JWT_SECRET;
    mockBuilders = { leads: chainBuilder({ firstRow: { id: LEAD_ID, phone: '+19415550100', status: 'new', converted_at: null } }) };
    const result = await buildLeadConsultationLink(LEAD_ID);
    expect(result.url).toBeNull();
    expect(result.reason).toMatch(/secret/i);
  });

  test('no lead id at all returns a reason without hitting the DB', async () => {
    const result = await buildLeadConsultationLink(null);
    expect(result.url).toBeNull();
    expect(mockDb).not.toHaveBeenCalled();
  });

  // Round 11 — Codex pre-push P1, 2026-09-24: an explicit { channel: 'sms' }
  // option rides into the minted token (createShortCode receives the LONG
  // url, so its own 4-segment token is directly observable here).
  // Codex #4737 r1 P1 follow-through: 'sms' is signed as the PHONE-BOUND
  // claim, the exact form the booking route's verifier accepts.
  test('{ channel: "sms" } mints the phone-bound claim for the fresh row\'s phone', async () => {
    const { verifyLeadConsultationToken, smsChannelFor } = require('../utils/lead-consultation-token');
    mockBuilders = { leads: chainBuilder({ firstRow: { id: LEAD_ID, phone: '+19415550100' } }) };
    await buildLeadConsultationLink(LEAD_ID, { channel: 'sms' });
    const longUrl = createShortCode.mock.calls[0][0];
    const verified = verifyLeadConsultationToken(longUrl.split('/inspection/')[1]);
    expect(verified).toEqual({ leadId: LEAD_ID, channel: smsChannelFor('9415550100') });
  });
});

describe('consultationUrlForLead', () => {
  test('returns the long URL directly (no short-url wrap)', () => {
    const url = consultationUrlForLead(LEAD_ID);
    expect(url).toMatch(new RegExp(`^https://portal\\.wavespestcontrol\\.com/inspection/${LEAD_ID}\\.\\d+\\.[A-Za-z0-9_-]+$`));
  });

  test('fails closed (null) with no signing secret', () => {
    delete process.env.LEAD_PREFILL_SECRET;
    delete process.env.JWT_SECRET;
    expect(consultationUrlForLead(LEAD_ID)).toBeNull();
  });

  // Round 11 — Codex pre-push P1, 2026-09-24: the optional channel claim
  // (the PR4 SMS send's evidence that THIS link reached the lead's own
  // phone) threads through to the minted token.
  test('an explicit channel mints a token carrying it', () => {
    const url = consultationUrlForLead(LEAD_ID, 'sms');
    expect(url).toMatch(new RegExp(`^https://portal\\.wavespestcontrol\\.com/inspection/${LEAD_ID}\\.\\d+\\.sms\\.[A-Za-z0-9_-]+$`));
  });

  test('no channel passed → the plain 3-segment token, unchanged from every other caller', () => {
    const url = consultationUrlForLead(LEAD_ID);
    expect(url.split('/inspection/')[1].split('.')).toHaveLength(3);
  });
});

describe('consultationSmsLineFor', () => {
  test('empty url yields empty line', () => {
    expect(consultationSmsLineFor(null)).toBe('');
    expect(consultationSmsLineFor('')).toBe('');
  });
});

describe('buildLeadConsultationSmsLine', () => {
  test('renders the admin template with {first_name, consultation_url}, collapsed to one line and flagged standalone', async () => {
    mockBuilders = {
      leads: chainBuilder({ firstRow: { id: LEAD_ID, phone: '+19415550100', status: 'new', converted_at: null } }),
      sms_templates: chainBuilder({ firstRow: { is_active: true } }),
    };
    getTemplate.mockResolvedValue(
      "Hi Pat, it's Waves. Pick a time for us to stop by for a free consultation: https://waves.link/l/abc123\n\nOr reply here and we'll set it up.\n\nReply STOP to opt out.",
    );
    const result = await buildLeadConsultationSmsLine(LEAD_ID, 'Pat');
    expect(getTemplate).toHaveBeenCalledWith('lead_consultation_link', {
      first_name: 'Pat',
      consultation_url: 'https://waves.link/l/abc123',
    }, {}, { requiredVars: ['consultation_url'] });
    expect(result.url).toBe('https://waves.link/l/abc123');
    expect(result.standalone).toBe(true);
    // Collapsed to one line (no embedded newlines other than the
    // required trailing '\n\n') so the composer's recipient-change strip
    // removes the whole rendered message as a unit.
    expect(result.line.endsWith('\n\n')).toBe(true);
    expect(result.line.slice(0, -2)).not.toMatch(/\n/);
    expect(result.line).toContain("Hi Pat, it's Waves.");
    expect(result.line).toContain('Reply STOP to opt out.');
    // Rides through for the scheduled-link fence (pre-push Codex P1).
    expect(result.expiresAt).toBeInstanceOf(Date);
    expect(result.immediateOnly).toBe(true);
  });

  // Inherited from buildLeadConsultationLink's chokepoint check — the SMS
  // wrapper never even reaches the template render for a closed/converted
  // lead (pre-push Codex P1).
  test('a closed/converted lead is unavailable — the template is never rendered', async () => {
    mockBuilders = {
      leads: chainBuilder({ firstRow: { id: LEAD_ID, phone: '+19415550100', status: 'won', converted_at: new Date('2026-01-01') } }),
      sms_templates: chainBuilder({ firstRow: { is_active: true } }),
    };
    const result = await buildLeadConsultationSmsLine(LEAD_ID, 'Pat');
    expect(result.url).toBeNull();
    expect(result.line).toBe('');
    expect(result.reason).toBe('That lead has already converted or closed');
    expect(result.standalone).toBeUndefined();
    expect(getTemplate).not.toHaveBeenCalled();
  });

  test('Codex #4709 r9 P2: a disabled or missing template mints nothing', async () => {
    mockBuilders = {
      leads: chainBuilder({ firstRow: { id: LEAD_ID, phone: '+19415550100', status: 'new', converted_at: null } }),
      sms_templates: chainBuilder({ firstRow: { is_active: false } }),
    };
    expect((await buildLeadConsultationSmsLine(LEAD_ID, 'Pat')).url).toBeNull();
    mockBuilders.sms_templates = chainBuilder({ firstRow: null });
    expect((await buildLeadConsultationSmsLine(LEAD_ID, 'Pat')).url).toBeNull();
    expect(createShortCode).not.toHaveBeenCalled();
  });

  test('Codex #4709 r9 P2: a STOP-less template is refused before any bearer is minted', async () => {
    mockBuilders = {
      leads: chainBuilder({ firstRow: { id: LEAD_ID, phone: '+19415550100', status: 'new', converted_at: null } }),
      sms_templates: chainBuilder({ firstRow: { is_active: true } }),
    };
    getTemplate.mockResolvedValue("Hi Pat, it's Waves. Pick a time: https://waves.link/l/abc123");
    expect((await buildLeadConsultationSmsLine(LEAD_ID, 'Pat')).url).toBeNull();
    expect(createShortCode).not.toHaveBeenCalled();
  });

  // Pre-push Codex P1: save-time validation (admin-sms-templates.js) now
  // refuses an edit that drops the keep-list disclosure, but a row that
  // slipped through before that guard existed (or was edited directly at
  // the DB) must not silently render without it either.
  test('a rendered body missing "Reply STOP to opt out." is unavailable — never sent without the disclosure', async () => {
    mockBuilders = {
      leads: chainBuilder({ firstRow: { id: LEAD_ID, phone: '+19415550100', status: 'new', converted_at: null } }),
      sms_templates: chainBuilder({ firstRow: { is_active: true } }),
    };
    getTemplate.mockResolvedValue(
      "Hi Pat, it's Waves. Pick a time for us to stop by for a free consultation: https://waves.link/l/abc123\n\nOr reply here and we'll set it up.",
    );
    const result = await buildLeadConsultationSmsLine(LEAD_ID, 'Pat');
    expect(result.url).toBeNull();
    expect(result.line).toBe('');
    expect(result.reason).toMatch(/Reply STOP to opt out/);
    expect(result.standalone).toBeUndefined();
  });

  // Pre-push Codex P1: hasStopLine (admin-sms-templates.js) used to detect
  // the disclosure by diffing against dropStop's STRIP output, which also
  // normalizes whitespace unrelated to the STOP line — a rendered body
  // with a whitespace-only quirk and no STOP line at all read as "has the
  // line". Reused here (this module's own hasStopLine call is the SAME
  // function), so this render-time re-check inherits the real fix.
  test('a rendered body with a whitespace-only quirk but NO STOP line is unavailable, not a false pass', async () => {
    mockBuilders = {
      leads: chainBuilder({ firstRow: { id: LEAD_ID, phone: '+19415550100', status: 'new', converted_at: null } }),
      sms_templates: chainBuilder({ firstRow: { is_active: true } }),
    };
    getTemplate.mockResolvedValue(
      "Hi Pat, it's Waves.   \nPick a time for us to stop by for a free consultation: https://waves.link/l/abc123\n\n\n\nOr reply here.",
    );
    const result = await buildLeadConsultationSmsLine(LEAD_ID, 'Pat');
    expect(result.url).toBeNull();
    expect(result.line).toBe('');
    expect(result.reason).toMatch(/Reply STOP to opt out/);
    expect(result.standalone).toBeUndefined();
  });

  test('missing first name falls back to "there"', async () => {
    mockBuilders = {
      leads: chainBuilder({ firstRow: { id: LEAD_ID, phone: '+19415550100', status: 'new', converted_at: null } }),
      sms_templates: chainBuilder({ firstRow: { is_active: true } }),
    };
    getTemplate.mockResolvedValue('Hi {first_name}');
    await buildLeadConsultationSmsLine(LEAD_ID, null);
    expect(getTemplate).toHaveBeenCalledWith('lead_consultation_link', expect.objectContaining({ first_name: 'there' }), {}, expect.objectContaining({ requiredVars: ['consultation_url'] }));
  });

  // Pre-push Codex P1 (round 2 — same class as the disabled-template P1
  // below): there is NO bare-clause fallback on ANY template failure. The
  // old bare buildLeadConsultationLink clause has no "Reply STOP to opt
  // out." footer, so falling back to it for a missing row, a missing
  // required placeholder, or a render throw is a keep-list violation on a
  // first-contact lead text exactly like the admin-disabled case is — the
  // template + keep-list is the single source of this copy, never a
  // hardcoded stand-in. Every one of these returns { url: null, line: '',
  // reason } instead.
  test('a missing template row (never seeded) is unavailable — no bare fallback clause, no standalone flag', async () => {
    mockBuilders = {
      leads: chainBuilder({ firstRow: { id: LEAD_ID, phone: '+19415550100', status: 'new', converted_at: null } }),
      sms_templates: chainBuilder({ firstRow: null }),
    };
    getTemplate.mockResolvedValue(null);
    const result = await buildLeadConsultationSmsLine(LEAD_ID, 'Pat');
    expect(result.url).toBeNull();
    expect(result.line).toBe('');
    expect(result.reason).toBeTruthy();
    expect(result.standalone).toBeUndefined();
  });

  test('a body that lost its required {consultation_url} placeholder is unavailable — getTemplate already refused to render it', async () => {
    mockBuilders = {
      leads: chainBuilder({ firstRow: { id: LEAD_ID, phone: '+19415550100', status: 'new', converted_at: null } }),
      sms_templates: chainBuilder({ firstRow: { is_active: true } }),
    };
    // getTemplate's own opts.requiredVars check returns null for a body an
    // admin edited to drop {consultation_url} — this module never
    // re-implements that check, it just refuses to fall back on a null.
    getTemplate.mockResolvedValue(null);
    const result = await buildLeadConsultationSmsLine(LEAD_ID, 'Pat');
    expect(result.url).toBeNull();
    expect(result.line).toBe('');
    expect(result.reason).toBeTruthy();
    expect(result.standalone).toBeUndefined();
  });

  // An admin-disabled template is a deliberate kill switch — it must never
  // fall back to the bare clause and getTemplate must never even be asked
  // to render it.
  test('a DISABLED template returns an unavailable result — never the bare fallback clause, never rendered', async () => {
    mockBuilders = {
      leads: chainBuilder({ firstRow: { id: LEAD_ID, phone: '+19415550100', status: 'new', converted_at: null } }),
      sms_templates: chainBuilder({ firstRow: { is_active: false } }),
    };
    const result = await buildLeadConsultationSmsLine(LEAD_ID, 'Pat');
    expect(result.url).toBeNull();
    expect(result.line).toBe('');
    expect(result.reason).toBe('template disabled');
    expect(getTemplate).not.toHaveBeenCalled();
  });

  test('a template render that throws is unavailable — no bare fallback clause', async () => {
    mockBuilders = {
      leads: chainBuilder({ firstRow: { id: LEAD_ID, phone: '+19415550100', status: 'new', converted_at: null } }),
      sms_templates: chainBuilder({ firstRow: { is_active: true } }),
    };
    getTemplate.mockRejectedValue(new Error('render exploded'));
    const result = await buildLeadConsultationSmsLine(LEAD_ID, 'Pat');
    expect(result.url).toBeNull();
    expect(result.line).toBe('');
    expect(result.reason).toBeTruthy();
    expect(result.standalone).toBeUndefined();
  });

  test('the sms_templates lookup itself throwing is unavailable — no bare fallback clause', async () => {
    mockBuilders = {
      leads: chainBuilder({ firstRow: { id: LEAD_ID, phone: '+19415550100', status: 'new', converted_at: null } }),
      sms_templates: { where: jest.fn(() => ({ first: jest.fn(async () => { throw new Error('db down'); }) })) },
    };
    const result = await buildLeadConsultationSmsLine(LEAD_ID, 'Pat');
    expect(result.url).toBeNull();
    expect(result.line).toBe('');
    expect(result.reason).toBeTruthy();
    expect(getTemplate).not.toHaveBeenCalled();
  });

  test('gate off / no link to build: the reason passes through untouched, getTemplate never called', async () => {
    process.env.GATE_LEAD_INSPECTION_LINK = 'false';
    const result = await buildLeadConsultationSmsLine(LEAD_ID, 'Pat');
    expect(result.url).toBeNull();
    expect(result.reason).toMatch(/switched off/i);
    expect(getTemplate).not.toHaveBeenCalled();
  });
});

// Pre-push Codex P2: expanding a lead row on the Leads page must not mint a
// live 14-day bearer short code — this probe reports the same eligibility
// buildLeadConsultationLink gates a real mint on, WITHOUT ever calling
// createShortCode.
describe('consultationLinkAvailable (read-only probe — never mints)', () => {
  test('gate off: unavailable, no DB touched', async () => {
    process.env.GATE_LEAD_INSPECTION_LINK = 'false';
    const result = await consultationLinkAvailable(LEAD_ID);
    expect(result).toEqual({ enabled: false, available: false, reason: expect.stringMatching(/switched off/i) });
    expect(mockDb).not.toHaveBeenCalled();
    expect(createShortCode).not.toHaveBeenCalled();
  });

  test('an open lead with a phone and an active template: available, and createShortCode is NEVER called', async () => {
    mockBuilders = {
      leads: chainBuilder({ firstRow: { id: LEAD_ID, phone: '+19415550100', status: 'new', converted_at: null } }),
      sms_templates: chainBuilder({ firstRow: { is_active: true } }),
    };
    const result = await consultationLinkAvailable(LEAD_ID);
    expect(result).toEqual({ enabled: true, available: true });
    expect(createShortCode).not.toHaveBeenCalled();
  });

  test('missing lead: unavailable, "Lead not found"', async () => {
    mockBuilders = { leads: chainBuilder({ firstRow: null }) };
    const result = await consultationLinkAvailable(LEAD_ID);
    expect(result).toEqual({ enabled: true, available: false, reason: 'Lead not found' });
  });

  test('a closed/converted lead: unavailable with the specific reason', async () => {
    mockBuilders = { leads: chainBuilder({ firstRow: { id: LEAD_ID, phone: '+19415550100', status: 'won', converted_at: new Date('2026-01-01') } }) };
    const result = await consultationLinkAvailable(LEAD_ID);
    expect(result).toEqual({ enabled: true, available: false, reason: 'That lead has already converted or closed' });
  });

  test('a lead with no phone: unavailable', async () => {
    mockBuilders = { leads: chainBuilder({ firstRow: { id: LEAD_ID, phone: null, status: 'new', converted_at: null } }) };
    const result = await consultationLinkAvailable(LEAD_ID);
    expect(result).toEqual({ enabled: true, available: false, reason: expect.stringMatching(/no phone/i) });
  });

  test('no signing secret configured: unavailable (checked without minting — pure HMAC, no DB write)', async () => {
    delete process.env.LEAD_PREFILL_SECRET;
    delete process.env.JWT_SECRET;
    mockBuilders = { leads: chainBuilder({ firstRow: { id: LEAD_ID, phone: '+19415550100', status: 'new', converted_at: null } }) };
    const result = await consultationLinkAvailable(LEAD_ID);
    expect(result).toEqual({ enabled: true, available: false, reason: expect.stringMatching(/secret/i) });
  });

  test('an admin-DISABLED template: unavailable with the same reason the render-time check uses', async () => {
    mockBuilders = {
      leads: chainBuilder({ firstRow: { id: LEAD_ID, phone: '+19415550100', status: 'new', converted_at: null } }),
      sms_templates: chainBuilder({ firstRow: { is_active: false } }),
    };
    const result = await consultationLinkAvailable(LEAD_ID);
    expect(result).toEqual({ enabled: true, available: false, reason: 'template disabled' });
  });
});
