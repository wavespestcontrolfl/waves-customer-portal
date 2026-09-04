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

// the claim mock answers per lane: the follow-up pass (followUp: true) runs first and finds nothing unless a test says so
const claims = (pitches = [], followUps = []) => worker.claim.mockImplementation(async (o) => (o && o.followUp ? followUps : pitches));
beforeEach(() => { worker.claim.mockReset(); worker.report.mockReset(); worker.report.mockResolvedValue({ ok: true }); claims(); });

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
    claims([prospect()]);
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

  test('claims outreach prospects requiring a contact email — after the follow-up lease', async () => {
    await drafter.run({ anthropic: fakeAnthropic('{}'), fetchPageFn: noFetch });
    expect(worker.claim).toHaveBeenCalledWith({ n: 10, type: 'outreach', requireContactEmail: true });
    expect(worker.claim).toHaveBeenCalledWith({ n: 10, type: 'outreach', followUp: true });
  });

  test('ONE batch budget for both lanes: follow-ups first, pitches on what remains — a batch spent on follow-ups claims no pitch (Codex r4)', async () => {
    const sent = prospect({ id: 'p2', outreach_to_email: 'michael@directinspections.com', outreach_subject: 'Add Waves to your vendor resources?', outreach_body: 'Hi Michael, …', outreach_status: 'sent', follow_up_status: 'due', lease_token: '2026-07-02T00:00:00.000Z' });
    claims([prospect()], [sent]);
    const a = fakeAnthropic('{"subject":"Re: Add Waves to your vendor resources?","body":"Hi Michael, a quick nudge.\\n— The Waves Pest Control Team"}');
    const r = await drafter.run({ batchSize: 1, anthropic: a, fetchPageFn: noFetch });
    expect(r).toMatchObject({ claimed: 1, drafted: 1, skipped: 0, failed: 0, followUps: { claimed: 1, drafted: 1, failed: 0 } }); // the totals the cron log and the CLI print carry both lanes
    expect(worker.claim).toHaveBeenCalledTimes(1); // the follow-up lease only — no pitch claim on a spent budget
    expect(worker.claim).toHaveBeenCalledWith({ n: 1, type: 'outreach', followUp: true });
    worker.claim.mockClear();
    await drafter.run({ batchSize: 3, anthropic: a, fetchPageFn: noFetch });
    expect(worker.claim).toHaveBeenCalledWith({ n: 2, type: 'outreach', requireContactEmail: true }); // three minus the one follow-up
  });

  test('a due follow-up is drafted in the pitch\'s thread and reported on the follow-up lane (subject Re:, no recipient, the lease token)', async () => {
    const sent = prospect({ id: 'p2', outreach_to_email: 'michael@directinspections.com', outreach_subject: 'Add Waves to your vendor resources?', outreach_body: 'Hi Michael, …', outreach_status: 'sent', follow_up_status: 'due', lease_token: '2026-07-02T00:00:00.000Z' });
    claims([], [sent]);
    // through the shared caller (llm/call.js): the system prompt travels as a cached text block, the prompt as content blocks
    const a = { messages: { create: jest.fn(async ({ system, messages }) => {
      expect(JSON.stringify(system)).toMatch(/follow-up/i);
      expect(JSON.stringify(messages[0].content)).toMatch(/Add Waves to your vendor resources\?/);
      return { content: [{ type: 'text', text: '{"subject":"Re: Add Waves to your vendor resources?","body":"Hi Michael, a quick nudge.\\n— The Waves Pest Control Team","recipient":"evil@attacker.com"}' }] };
    }) } };
    const r = await drafter.run({ anthropic: a, fetchPageFn: noFetch });
    expect(r.followUps).toEqual({ claimed: 1, drafted: 1, failed: 0 });
    expect(worker.report).toHaveBeenCalledTimes(1);
    const call = worker.report.mock.calls[0][0];
    expect(call).toMatchObject({ prospect_id: 'p2', outcome: 'drafted', lease_token: '2026-07-02T00:00:00.000Z', outreach_subject: 'Re: Add Waves to your vendor resources?' });
    expect(call.outreach_to_email).toBeUndefined(); // the recipient is the thread's — never the model's
  });

  test('an unusable follow-up draft reports failed on the lease (the row returns to due)', async () => {
    claims([], [prospect({ id: 'p2', outreach_status: 'sent', follow_up_status: 'due' })]);
    const r = await drafter.run({ anthropic: fakeAnthropic('no json'), fetchPageFn: noFetch });
    expect(r.followUps).toEqual({ claimed: 1, drafted: 0, failed: 1 });
    expect(worker.report.mock.calls[0][0]).toMatchObject({ prospect_id: 'p2', outcome: 'failed' });
  });

  test('dry-run writes nothing', async () => {
    claims([prospect()]);
    const r = await drafter.run({ anthropic: fakeAnthropic('{"subject":"S","body":"B\\n— The Waves Pest Control Team"}'), fetchPageFn: noFetch, dryRun: true });
    expect(r.drafted).toBe(1);
    expect(worker.report).not.toHaveBeenCalled();
    // dry-run releases its lease keyed on the exact lease_token (not just id)
    expect(worker.claim).toHaveBeenCalledWith(expect.objectContaining({ preview: true })); // read-only: a live claim would settle candidates before leasing
    expect(worker.releaseClaims).not.toHaveBeenCalled(); // nothing was leased
    // previews are returned (for the CLI's stdout), not logged
    expect(r.samples).toHaveLength(1);
    expect(r.samples[0]).toMatchObject({ domain: 'directinspections.com', to_email: 'michael@directinspections.com' });
  });

  test('unparseable model output → reports failed (not drafted)', async () => {
    claims([prospect()]);
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
