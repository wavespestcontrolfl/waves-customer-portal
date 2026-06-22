// Mock the worker so run() doesn't touch the DB.
jest.mock('../services/seo/link-prospect-worker', () => {
  const isValidEmail = (e) => typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
  return {
    claim: jest.fn(),
    report: jest.fn(async () => ({ ok: true, status: 'prospect', attempts: 1 })),
    releaseClaims: jest.fn(async () => ({ released: 0 })),
    businessProfile: () => ({
      brand: 'Waves Pest Control', website: 'https://wavespestcontrol.com',
      contact_email: 'contact@wavespestcontrol.com', default_location_id: 'bradenton',
      locations: [
        { id: 'bradenton', name: 'Bradenton, FL', address: '...', phone: '(941) 297-5749' },
        { id: 'sarasota', name: 'Sarasota, FL', address: '...', phone: '(941) 297-2606' },
      ],
    }),
    isValidEmail,
    OUTREACH_TYPES: ['editorial', 'resource', 'guest_post', 'haro'],
  };
});

const worker = require('../services/seo/link-prospect-worker');
const drafter = require('../services/seo/backlink-outreach-drafter');
const { parseDraft, pickLocation, SYSTEM_PROMPT } = drafter._internals;

const fakeAnthropic = (text) => ({ messages: { create: async () => ({ content: [{ type: 'text', text }] }) } });
const noFetch = async () => null; // skip personalization fetch in tests

const prospect = (o = {}) => ({
  id: 'p1', target_domain: 'directinspections.com', target_url: null,
  target_page: 'https://wavespestcontrol.com/', link_type: 'resource', tier: 1,
  priority: 'high', notes: 'home inspector', anchor_planned: null,
  contact_email: 'michael@directinspections.com', lease_token: '2026-06-22T00:00:00.000Z', ...o,
});

beforeEach(() => { worker.claim.mockReset(); worker.report.mockReset(); worker.report.mockResolvedValue({ ok: true }); });

describe('parseDraft', () => {
  test('extracts subject/body from fenced + plain JSON, null on garbage', () => {
    expect(parseDraft('```json\n{"subject":"Hi","body":"Body\\nhere"}\n```')).toEqual({ subject: 'Hi', body: 'Body\nhere' });
    expect(parseDraft('prose {"subject":"S","body":"B"} trailing')).toEqual({ subject: 'S', body: 'B' });
    expect(parseDraft('no json at all')).toBeNull();
    expect(parseDraft('{"subject":"S"}')).toBeNull(); // missing body
  });
});

describe('pickLocation', () => {
  const profile = worker.businessProfile();
  test('picks the market hinted in the prospect, else the default location', () => {
    expect(pickLocation({ target_page: 'https://wavespestcontrol.com/pest-control-sarasota-fl/' }, profile).id).toBe('sarasota');
    expect(pickLocation({ notes: 'generic' }, profile).id).toBe('bradenton'); // default
  });
});

describe('SYSTEM_PROMPT playbook', () => {
  test('encodes the angles + asset + signature', () => {
    expect(SYSTEM_PROMPT).toMatch(/WDO/);
    expect(SYSTEM_PROMPT).toMatch(/Pest Pressure/);
    expect(SYSTEM_PROMPT).toMatch(/preferred vendors|resources/i);
    expect(SYSTEM_PROMPT).toMatch(/The Waves Pest Control Team/);
  });
});

describe('run', () => {
  test('drafts a claimed prospect and parks it with the STORED contact_email (never the model’s)', async () => {
    worker.claim.mockResolvedValue([prospect()]);
    // Even if the model emits a different email, we must not use it.
    const a = fakeAnthropic('{"subject":"Add Waves to your vendor resources?","body":"Hi Michael,\\n...\\n— The Waves Pest Control Team","recipient":"evil@attacker.com"}');
    const r = await drafter.run({ anthropic: a, fetchPageFn: noFetch });
    expect(r).toMatchObject({ claimed: 1, drafted: 1, skipped: 0, failed: 0 });
    expect(worker.report).toHaveBeenCalledTimes(1);
    const call = worker.report.mock.calls[0][0];
    expect(call.outcome).toBe('drafted');
    expect(call.outreach_to_email).toBe('michael@directinspections.com'); // stored, not evil@
    expect(call.outreach_subject).toMatch(/vendor resources/);
    expect(call.lease_token).toBe('2026-06-22T00:00:00.000Z');
  });

  test('claims outreach prospects requiring a contact email', async () => {
    worker.claim.mockResolvedValue([]);
    await drafter.run({ anthropic: fakeAnthropic('{}'), fetchPageFn: noFetch });
    expect(worker.claim).toHaveBeenCalledWith({ n: 10, type: 'outreach', requireContactEmail: true });
  });

  test('dry-run writes nothing', async () => {
    worker.claim.mockResolvedValue([prospect()]);
    const r = await drafter.run({ anthropic: fakeAnthropic('{"subject":"S","body":"B\\n— The Waves Pest Control Team"}'), fetchPageFn: noFetch, dryRun: true });
    expect(r.drafted).toBe(1);
    expect(worker.report).not.toHaveBeenCalled();
    expect(worker.releaseClaims).toHaveBeenCalledWith(['p1']); // dry-run releases its lease
  });

  test('unparseable model output → reports failed (not drafted)', async () => {
    worker.claim.mockResolvedValue([prospect()]);
    const r = await drafter.run({ anthropic: fakeAnthropic('sorry, I cannot'), fetchPageFn: noFetch });
    expect(r).toMatchObject({ drafted: 0, failed: 1 });
    expect(worker.report.mock.calls[0][0].outcome).toBe('failed');
  });

  test('no Anthropic client/key → no-op, never claims', async () => {
    const prev = process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_API_KEY;
    const r = await drafter.run({ fetchPageFn: noFetch });
    expect(r.note).toBe('no_anthropic');
    expect(worker.claim).not.toHaveBeenCalled();
    if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev;
  });
});
