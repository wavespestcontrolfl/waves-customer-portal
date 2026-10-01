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

// The cited-page ranking reads the DB; every run here gets an empty one unless a test passes citedPagesFn.
jest.mock('../services/seo/cited-pages', () => ({
  ...jest.requireActual('../services/seo/cited-pages'),
  loadCitedPages: jest.fn(async () => ({ pages: [] })),
}));

const worker = require('../services/seo/link-prospect-worker');
const drafter = require('../services/seo/backlink-outreach-drafter');
const { parseDraft, pickLocation, SYSTEM_PROMPT, citedPagesFor, pickCitedPage, citedPagesByHost, citedPageVerdict, buildUserPrompt, WAVES_FACTS, WAVES_LISTED_RE } = drafter._internals;

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

  // Codex r13 on #4884: "   " passed the old truthiness check and parked an
  // empty draft as 'drafted'; numbers/objects were String()-coerced into a
  // meaningless one. Both legs read parseDraft, so both now reject these.
  test.each([
    ['blank subject and body', { subject: '   ', body: '   ' }],
    ['blank body', { subject: 'Quick idea', body: '\n\t ' }],
    ['numeric subject', { subject: 42, body: 'Body' }],
    ['object body', { subject: 'Quick idea', body: { text: 'Body' } }],
    ['array body', { subject: 'Quick idea', body: ['Body'] }],
  ])('%s is not a usable draft', (_label, draft) => {
    expect(parseDraft(JSON.stringify(draft))).toBeNull();
  });

  test('surrounding whitespace is trimmed from a real draft', () => {
    const text = JSON.stringify({ subject: '  Quick idea ', body: '\n Hello there \n' });
    expect(parseDraft(text)).toEqual({ subject: 'Quick idea', body: 'Hello there' });
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

describe('the follow-up prompt timing (Codex r13 P2)', () => {
  const { buildFollowUpPrompt, sentLine, FOLLOW_UP_SYSTEM_PROMPT } = drafter._internals;
  const profile = { brand: 'Waves Pest Control', locations: [{ id: 'brad', name: 'Bradenton, FL', phone: '941' }], default_location_id: 'brad' };
  test('the prompt carries the pitch\'s real send date and elapsed days — never a fixed "ten days ago"; the system prompt forbids stating a duration', () => {
    const now = new Date('2026-10-05T14:00:00Z');
    const p = { target_domain: 'example.org', outreach_subject: 'A resource', outreach_body: 'hi', outreach_sent_at: '2026-09-10T13:00:00Z' };
    expect(sentLine(p, now)).toBe('- sent: 2026-09-10 (25 days ago, as of 2026-10-05)');
    expect(buildFollowUpPrompt(p, profile, profile.locations[0], now)).toContain('- sent: 2026-09-10 (25 days ago, as of 2026-10-05)');
    expect(sentLine({ ...p, outreach_sent_at: null }, now)).toMatch(/date unknown/);
    // ET calendar days, not elapsed hours: 02:30 EST → 02:30 EDT ten calendar days later is 239 hours (Codex r14 P2)
    expect(sentLine({ ...p, outreach_sent_at: '2026-03-05T07:30:00Z' }, new Date('2026-03-15T06:30:00Z'))).toBe('- sent: 2026-03-05 (10 days ago, as of 2026-03-15)');
    expect(FOLLOW_UP_SYSTEM_PROMPT).not.toMatch(/Ten days ago/);
    expect(FOLLOW_UP_SYSTEM_PROMPT).toMatch(/never state a number of days or weeks/);
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

describe('cited-page pitches', () => {
  const ARTICLE = 'Our picks for the best pest control companies in Sarasota, with notes on service area, pricing and reviews. '.repeat(6);
  const citedPage = (o = {}) => ({
    key: 'floridist.com/best-pest-control-sarasota', host: 'floridist.com', url: 'https://floridist.com/best-pest-control-sarasota',
    listPage: true, tier: 1, rank: 1, currentMisses: 2,
    questions: [{ id: 'Q1', query: 'Who is the best pest control company in Sarasota FL?', engines: ['claude', 'perplexity'], provider: true, miss: true, current: true }],
    ...o,
  });
  const cited = prospect({ id: 'p9', target_domain: 'floridist.com', link_type: 'editorial', tier: 2, contact_email: 'editor@floridist.com' });

  test('the system prompt names the business without "& Lawn Care" and carries the cited-page angle', () => {
    expect(SYSTEM_PROMPT).not.toMatch(/& Lawn Care/);
    expect(SYSTEM_PROMPT).toMatch(/CITED-PAGE ANGLE/);
    expect(SYSTEM_PROMPT).toMatch(/No payment, no reciprocal link/);
  });

  test('a prospect matches its own cited page first, else its host\'s best-ranked page; www and subdomains are exact', () => {
    const best = citedPage();
    const other = citedPage({ key: 'floridist.com/lwr', url: 'https://floridist.com/lwr', rank: 2 });
    const byHost = citedPagesByHost([best, other]);
    expect(citedPagesFor({ target_domain: 'www.floridist.com' }, byHost)).toEqual([best, other]);
    expect(citedPagesFor({ target_domain: 'floridist.com', target_url: 'https://floridist.com/LWR/?utm_source=x' }, byHost)).toEqual([other, best]);
    expect(citedPagesFor({ target_domain: 'blog.floridist.com' }, byHost)).toEqual([]);
    expect(citedPagesFor({ target_domain: 'floridist.com' }, new Map())).toEqual([]);
  });

  test('the prompt carries the page, its questions and engines, and only the approved Waves facts', () => {
    const text = buildUserPrompt(cited, worker.businessProfile(), null, null, citedPage());
    expect(text).toMatch(/CITED PAGE/);
    expect(text).toMatch(/https:\/\/floridist\.com\/best-pest-control-sarasota/);
    expect(text).toMatch(/"Who is the best pest control company in Sarasota FL\?" \(claude, perplexity\) — the current answer does not name Waves/);
    expect(WAVES_FACTS.length).toBe(4);
    for (const f of WAVES_FACTS) expect(text).toContain(f);
    expect(WAVES_FACTS.join(' ')).toMatch(/JB351547/);
    expect(buildUserPrompt(cited, worker.businessProfile(), null, null, null)).not.toMatch(/CITED PAGE/);
  });

  test('run reads the cited page (not the homepage), drafts with the angle, and notes the page on the report', async () => {
    claims([cited]);
    const fetchPageFn = jest.fn(async () => ({ title: 'Best Pest Control in Sarasota', snippet: 'Our picks', text: ARTICLE }));
    const create = jest.fn(async () => ({ content: [{ type: 'text', text: '{"subject":"Your Sarasota list","body":"Hi"}' }] }));
    const r = await drafter.run({ anthropic: { messages: { create } }, fetchPageFn, citedPagesFn: async () => ({ pages: [citedPage()] }) });
    expect(r.drafted).toBe(1);
    expect(fetchPageFn).toHaveBeenCalledWith('https://floridist.com/best-pest-control-sarasota', { withText: true });
    expect(create.mock.calls[0][0].messages[0].content).toMatch(/CITED PAGE/);
    expect(worker.report).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'drafted', notes: expect.stringContaining('cited page https://floridist.com/best-pest-control-sarasota') }));
  });

  test('a cited page that already names Waves is skipped, never pitched', async () => {
    claims([cited]);
    const create = jest.fn();
    const r = await drafter.run({ anthropic: { messages: { create } }, fetchPageFn: async () => ({ title: 't', snippet: 's', text: `${ARTICLE} 3. Waves Pest Control (Lakewood Ranch)` }), citedPagesFn: async () => ({ pages: [citedPage()] }) });
    expect(create).not.toHaveBeenCalled();
    expect(r.skipped).toBe(1);
    expect(worker.report).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'skipped', notes: expect.stringMatching(/Waves already on the cited page/) }));
  });

  test('a cited page that cannot be read fails the lease (retried) — never pitched unchecked', async () => {
    claims([cited]);
    const create = jest.fn();
    const r = await drafter.run({ anthropic: { messages: { create } }, fetchPageFn: noFetch, citedPagesFn: async () => ({ pages: [citedPage()] }) });
    expect(create).not.toHaveBeenCalled();
    expect(r.failed).toBe(1);
    expect(worker.report).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed', notes: expect.stringMatching(/cited page could not be read/) }));
  });

  test('an HTML-encoded space never hides an existing listing (fetchPageText decodes entities)', async () => {
    const { fetchPageText } = require('../services/seo/contact-finder');
    const html = '<html><title>Best Pest Control</title><body>3. Waves&#32;Pest&nbsp;Control &mdash; Lakewood Ranch</body></html>';
    const fetchFn = jest.fn(async () => ({ ok: true, status: 200, headers: { get: (n) => (n === 'content-type' ? 'text/html' : null) }, body: null, text: async () => html }));
    const page = await fetchPageText('https://8.8.8.8/best', { fetchFn, withText: true });
    expect(page && page.text).toMatch(/Waves Pest Control — Lakewood Ranch/);
    expect(WAVES_LISTED_RE.test(page.text)).toBe(true);
    expect(WAVES_LISTED_RE.test('Gulf waves and pest control tips')).toBe(false);
  });

  test('a top list that already names Waves never rules out the publisher\'s other cited list', async () => {
    const listed = citedPage();
    const other = citedPage({ key: 'floridist.com/best-exterminators-venice', url: 'https://floridist.com/best-exterminators-venice', rank: 2 });
    claims([cited]);
    const fetchPageFn = jest.fn(async (url) => ({ title: 't', snippet: 's', text: url === listed.url ? `${ARTICLE} Waves Pest Control` : ARTICLE }));
    const create = jest.fn(async () => ({ content: [{ type: 'text', text: '{"subject":"S","body":"B"}' }] }));
    const r = await drafter.run({ anthropic: { messages: { create } }, fetchPageFn, citedPagesFn: async () => ({ pages: [listed, other] }) });
    expect(r.drafted).toBe(1);
    expect(create.mock.calls[0][0].messages[0].content).toContain(other.url);
    expect(worker.report).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'drafted', notes: expect.stringContaining(`cited page ${other.url}`) }));
  });

  test('pickCitedPage: an unreadable candidate makes the prospect retry, never skip', async () => {
    const a = citedPage();
    const b = citedPage({ key: 'floridist.com/b', url: 'https://floridist.com/b' });
    const fetchPageFn = async (url) => (url === a.url ? null : { text: `${ARTICLE} Waves Pest Control` });
    expect(await pickCitedPage([a, b], fetchPageFn)).toEqual({ verdict: { fail: expect.stringMatching(/could not be read/) } });
  });

  test('a cited page cut short (text null) fails the lease too', async () => {
    claims([cited]);
    const create = jest.fn();
    const r = await drafter.run({ anthropic: { messages: { create } }, fetchPageFn: async () => ({ title: 't', snippet: 's', text: null }), citedPagesFn: async () => ({ pages: [citedPage()] }) });
    expect(create).not.toHaveBeenCalled();
    expect(r.failed).toBe(1);
  });

  test('an empty, title-only or bot-challenge page fails; a redirect to another page skips', () => {
    const c = citedPage();
    const unread = { fail: expect.stringMatching(/could not be read in full/) };
    expect(citedPageVerdict({ text: '   ', finalUrl: c.url }, c)).toEqual(unread);
    expect(citedPageVerdict({ title: 'Best Pest Control in Sarasota', text: 'Best Pest Control in Sarasota' }, c)).toEqual(unread);
    expect(citedPageVerdict({ title: 'Just a moment...', text: `Just a moment... Verify you are human. ${ARTICLE}` }, c)).toEqual(unread);
    expect(citedPageVerdict({ text: ARTICLE, finalUrl: 'https://floridist.com/' }, c)).toEqual({ skip: expect.stringMatching(/now redirects to https:\/\/floridist\.com\//) });
    expect(citedPageVerdict({ text: ARTICLE, finalUrl: 'https://www.floridist.com/best-pest-control-sarasota/' }, c)).toBeNull();
    expect(citedPageVerdict({ text: ARTICLE }, c)).toBeNull();
    // a full article that mentions JavaScript somewhere is still the article
    expect(citedPageVerdict({ text: `${ARTICLE.repeat(4)} Please enable JavaScript to use our contact form.` }, c)).toBeNull();
  });

  test('a page that is not itself a list never carries the angle, whatever question cited it', () => {
    expect(citedPagesFor({ target_domain: 'floridist.com' }, citedPagesByHost([citedPage({ listPage: false })]))).toEqual([]);
  });

  test('only pages cited for a provider question carry the angle — a cost guide keeps the usual pitch', () => {
    const costGuide = citedPage({ key: 'floridist.com/cost', url: 'https://floridist.com/cost', questions: [{ id: 'Q3', query: 'How much does pest control cost?', engines: ['claude'], provider: false }] });
    expect(citedPagesFor({ target_domain: 'floridist.com' }, citedPagesByHost([costGuide]))).toEqual([]);
  });

  test('a failed ranking read drafts with the usual angle', async () => {
    claims([cited]);
    const create = jest.fn(async () => ({ content: [{ type: 'text', text: '{"subject":"S","body":"B"}' }] }));
    const r = await drafter.run({ anthropic: { messages: { create } }, fetchPageFn: noFetch, citedPagesFn: async () => { throw new Error('db down'); } });
    expect(r.drafted).toBe(1);
    expect(create.mock.calls[0][0].messages[0].content).not.toMatch(/CITED PAGE/);
  });
});
