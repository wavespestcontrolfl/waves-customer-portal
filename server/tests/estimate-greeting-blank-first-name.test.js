/**
 * Every estimate greeting site greets a blank-first-name customer with
 * 'there', not the surname that customer_name starts with. Behavioral for the
 * estimate-public resolver; source pins for the rest (they are large async
 * senders whose collaborators are mocked elsewhere).
 */

const fs = require('fs');
const path = require('path');

const mockDb = jest.fn();
mockDb.schema = { hasTable: jest.fn(async () => true) };
jest.mock('../models/db', () => mockDb);

const { resolveEstimateGreetingFirstName } = require('../routes/estimate-public');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

function makeConn(rows) {
  return (table) => {
    const chain = {
      where: () => chain,
      first: async () => rows[table] ?? null,
    };
    return chain;
  };
}

describe('resolveEstimateGreetingFirstName (estimate-public)', () => {
  const estimate = { id: 'est-1', customer_id: 'cust-1', customer_name: 'Example' };

  test('linked blank-first-name customer: empty (callers fall back to "there")', async () => {
    const database = makeConn({ customers: { first_name: '', last_name: 'Example' } });
    expect(await resolveEstimateGreetingFirstName(estimate, { customerName: 'Example' }, { database })).toBe('');
  });

  test('linked customer with a first name keeps it', async () => {
    const database = makeConn({ customers: { first_name: 'Sample', last_name: 'Example' } });
    expect(await resolveEstimateGreetingFirstName(
      { ...estimate, customer_name: 'Sample Example' },
      { customerName: 'Sample Example' },
      { database },
    )).toBe('Sample');
  });

  test('unlinked estimate keeps the first token of the resolved contact name', async () => {
    const database = makeConn({});
    expect(await resolveEstimateGreetingFirstName(
      { id: 'est-2', customer_name: null },
      { customerName: 'Sample Example' },
      { database },
    )).toBe('Sample');
  });
});

describe('greeting sites route through the shared helper', () => {
  const SPLIT_ON_NAME = /customer_?[nN]ame[^;\n]*\.split\([^)]*\)\[0\]/;

  const files = {
    'routes/admin-estimates.js': 4,
    'routes/estimate-public.js': 1,
    'services/estimate-follow-up.js': 6,
    'services/estimate-engagement-engine.js': 1,
    'services/estimate-extension.js': 2,
    'services/estimate-auto-renew.js': 1,
  };

  test.each(Object.entries(files))('%s uses estimateGreetingFirstName and never splits customer_name', (rel, count) => {
    const src = read(rel);
    expect(src).toMatch(/require\(["']\.\.\/utils\/greeting-first-name["']\)/);
    expect(src.split('estimateGreetingFirstName(').length - 1).toBeGreaterThanOrEqual(count);
    expect(src).not.toMatch(SPLIT_ON_NAME);
  });

  test('the estimate_sent automation enrollment takes the greeting token, never the surname (codex #5612 r1)', () => {
    const src = read('routes/admin-estimates.js');
    const start = src.indexOf("templateKey: 'estimate_sent',");
    const block = src.slice(src.lastIndexOf('const parts =', start), start + 400);
    expect(block).toContain('const greetingToken = await estimateGreetingFirstToken(db, estimate);');
    expect(block).toContain("first_name: greetingToken || (parts.length ? 'there' : ''),");
    expect(block).toContain("last_name: (greetingToken ? parts.slice(1) : parts).join(' ') || '',");
  });

  test('the expired-estimate nurture email and the click-followup SMS draft use the shared rule (codex #5612 r2)', () => {
    const nurture = read('services/email-division/payload-builders.js');
    expect(nurture).toContain("first_name: firstToken(greetingFirstToken({ customerName: estimate.customer_name, customer })) || clean(customer.first_name) || 'there',");
    expect(nurture).toContain(".first('id', 'first_name', 'last_name', 'email', 'latitude', 'longitude');");
    const click = read('services/click-followup.js');
    expect(click).toContain("firstNameOf(await estimateGreetingFirstToken(db, est))");
    expect(click).not.toContain('firstNameOf(est.customer_name)');
  });

  test('Ask Waves addresses a blank-first-name customer by no name, never the surname (codex #5612 r3)', () => {
    const { buildEstimateAssistantContext } = require('../services/estimate-assistant');
    const ctx = (estimate, greetingFirstName) => buildEstimateAssistantContext({ estimate, greetingFirstName });
    expect(ctx({ customer_name: 'Sample' }, '').customerFirstName).toBeNull();
    expect(ctx({ customer_name: 'Example Sample' }, 'Example').customerFirstName).toBe('Example');
    expect(ctx({ customer_name: 'Example Sample' }).customerFirstName).toBe('Example'); // legacy callers
    expect(ctx({ customer_name: '', customerFirstName: 'Example' }, '').customerFirstName).toBe('Example');
    const src = read('services/estimate-assistant.js');
    expect(src).toContain('const greetingFirstName = await estimateGreetingFirstToken(database, estimate);');
  });

  test('the accept contact patch re-resolves the greeting instead of taking the surname (codex #5612 r4)', () => {
    const src = read('routes/estimate-public.js');
    expect(src).toContain('|| await estimateGreetingFirstName(trx, { ...estimate, customer_id: customerId || estimate.customer_id });');
    expect(src).not.toContain('contactGapNameTokens(estimate.customer_name)[0] || firstName');
  });

  test('the public payload change is documented (codex #5612 r1)', () => {
    const doc = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'public-route-contracts.md'), 'utf8');
    expect(doc).toContain('`estimate.customerFirstName` is the greeting token');
  });

  test('estimate-public renderers read the resolved greeting, not customerName.split', () => {
    const src = read('routes/estimate-public.js');
    expect(src).not.toMatch(/\(est\.customerName \|\| ''\)\.split/);
    expect(src).not.toMatch(/\(estimate\.customerName \|\| ''\)\.split/);
    expect(src).not.toMatch(/\(contact\.customerName \|\| ''\)\.split/);
    expect(src).toContain("const firstName = escapeHtml(viewGreetingFirstName(est));");
    expect(src).toContain('customerFirstName: (await resolveEstimateGreetingFirstName(estimate, contact)) || null');
    expect(src).toContain("const firstName = (await resolveEstimateGreetingFirstName(estimate, contact)) || 'there';");
    expect(src).toContain('greetingFirstName: legacyGreetingFirstName');
  });

  test('estimate-deposits receipts pass the customer row so a blank first name is not backfilled with the surname', () => {
    const src = read('services/estimate-deposits.js');
    expect(src.split('greetingFirstName({ customerName: estimate.customer_name, customer })').length - 1).toBe(2);
    expect(src).not.toMatch(SPLIT_ON_NAME);
  });

  test('accepted-email recipient reads last_name and uses the helper', () => {
    const src = read('services/estimate-accepted-email.js');
    expect(src).toContain("'id', 'first_name', 'last_name', 'email'");
    expect(src).toContain('greetingFirstToken({ customerName: own?.customer_name, customer })');
  });

  test('add-service-request and conversion-agent drafts use the helper with the customer row', () => {
    const add = read('services/estimate-add-service-request.js');
    expect(add).toContain('greetingFirstName({ customerName: estimate.customer_name, customer })');
    const agent = read('services/estimate-conversion-agent.js');
    expect(agent.split('greetingFirstToken({ customerName: context.estimate?.customer_name, customer: context.customer })').length - 1).toBe(2);
  });
});
