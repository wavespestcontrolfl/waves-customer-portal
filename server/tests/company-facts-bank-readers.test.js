/**
 * Company facts bank PR 3: the voice and email readers. An empty (or stale) bank leaves both byte-identical; an approved
 * line reaches the next call and the next draft; a call keeps the lines it started with; the bank hash is stamped.
 * Fakes only: the Anthropic SDK is stubbed so no model call is made.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/lead-from-extraction', () => ({ createLeadFromExtraction: jest.fn() }));
jest.mock('../services/conversations', () => ({ syncVoiceMessageForCall: jest.fn() }));
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: {
    create: jest.fn().mockRejectedValue(new Error('no model calls in tests')),
    stream: jest.fn(() => { throw new Error('no model calls in tests'); }),
  },
})));

const crypto = require('crypto');
const Bank = require('../services/company-facts-bank');
const { RelayConversation, SYSTEM_PROMPT, buildBasePrompt } = require('../services/voice-agent/relay-conversation');
const { renderCompanyFactsSection } = require('../services/sms-company-facts');
const { hasBannedCustomerCopy } = require('../services/sms-shadow-drafter');
const { __test: emailTest } = require('../services/email/email-actions');

const sha256 = (t) => crypto.createHash('sha256').update(t).digest('hex');
const OWNER = 'bbbbbbbb-0000-4000-8000-000000000001';
const FACT_A = 'We treat honeybee swarms on request.';
const FACT_B = 'We service boat docks in Manatee County.';
const row = (n, text) => ({
  id: `00000000-0000-4000-8000-00000000000${n}`, topic: `Topic ${n}`, fact_text: text, text_sha256: sha256(text), approved_at: new Date(2026, 10, 25, 10, n), approved_by: OWNER,
});
// A database handle that answers only the reads the snapshot loader makes.
const fakeDb = (rows) => (table) => {
  const answers = {
    products_catalog: [],
    company_fact_bank_events: rows.map((r) => ({ fact_id: r.id, actor_id: r.approved_by, detail: { owner: true, text_sha256: r.text_sha256 } })),
  };
  const chain = { where: () => chain, orderBy: () => chain, whereIn: () => chain, whereNotIn: () => chain, select: () => Promise.resolve(answers[table] || rows) };
  return chain;
};
const load = (rows) => Bank.refreshBankFacts({ dbi: fakeDb(rows) });
const company = () => renderCompanyFactsSection().replace(/\n$/, '');

const ENTRY_TAIL = '\nUse only the lines that answer what the customer asked. They promise no visit, date, price, or contact; the rules above still apply.';
const FRAME = '\nThese facts answer general questions.';

beforeEach(() => { Bank._test.resetSnapshot(); });

describe('the bank section', () => {
  test('is empty for an empty bank, and its wording passes the banned-copy screen', async () => {
    expect(Bank.renderBankFactsSection([])).toBe('');
    await load([row(1, FACT_A), row(2, FACT_B)]);
    const section = Bank.renderBankFactsSection();
    expect(section).toBe(`${Bank.BANK_SECTION_HEADER}\n- ${FACT_A}\n- ${FACT_B}`);
    expect(hasBannedCustomerCopy(section)).toBe(false);
  });
});

describe('voice', () => {
  test('an empty bank: the prompt is byte-identical, SYSTEM_PROMPT is untouched', () => {
    expect(buildBasePrompt(false, null, { bankFacts: [] })).toBe(SYSTEM_PROMPT);
    expect(buildBasePrompt(false, null, { bankFacts: null })).toBe(SYSTEM_PROMPT);
    expect(buildBasePrompt(false)).toBe(SYSTEM_PROMPT);
    expect(SYSTEM_PROMPT).not.toContain(Bank.BANK_SECTION_HEADER);
  });

  test('a bank fact sits right after the code lines and before the speech framing, in both context states', async () => {
    await load([row(1, FACT_A)]);
    const facts = Bank.getApprovedBankFacts();
    for (const context of [false, true]) {
      expect(buildBasePrompt(context, null, { bankFacts: facts })).toContain(`${company()}\n${Bank.BANK_SECTION_HEADER}\n- ${FACT_A}${FRAME}`);
    }
    // The bank adds only that section: removing it gives the unchanged prompt.
    expect(buildBasePrompt(false, null, { bankFacts: facts }).replace(`\n${Bank.renderBankFactsSection(facts)}`, '')).toBe(SYSTEM_PROMPT);
  });

  test('the frame anchor still exists once in SYSTEM_PROMPT (a moved line would silently drop the bank)', () => {
    expect(SYSTEM_PROMPT.split(FRAME)).toHaveLength(2);
  });

  test('built per call, not at module load; a call in progress keeps its prompt after an approve; the prompt hash and bank hash change', async () => {
    const before = new RelayConversation({ callSid: 'CA-bank-0', from: '+19415551234', send: jest.fn() });
    await before._runLoop('hi').catch(() => {});
    expect(before._systemBlocks[0].text).toBe(SYSTEM_PROMPT);
    expect(before._bankFactsSha).toBeNull();
    expect(before._versionStamps().bank_facts_sha).toBeNull();

    await load([row(1, FACT_A)]); // an approve reaches the snapshot
    await before._runLoop('second turn').catch(() => {});
    expect(before._systemBlocks[0].text).toBe(SYSTEM_PROMPT); // frozen for the call

    const next = new RelayConversation({ callSid: 'CA-bank-1', from: '+19415551234', send: jest.fn() });
    await next._runLoop('hi').catch(() => {});
    expect(next._systemBlocks[0].text).toContain(`- ${FACT_A}`);
    expect(next._bankFactsSha).toBe(Bank.bankVersionHash(Bank.getApprovedBankFacts()));
    expect(next._versionStamps().bank_facts_sha).toMatch(/^[0-9a-f]{64}$/);
    expect(next._promptSha).not.toBe(before._promptSha);

    await load([row(1, FACT_A), row(2, FACT_B)]);
    const third = new RelayConversation({ callSid: 'CA-bank-2', from: '+19415551234', send: jest.fn() });
    await third._runLoop('hi').catch(() => {});
    expect(third._promptSha).not.toBe(next._promptSha);
    expect(third._bankFactsSha).not.toBe(next._bankFactsSha);
  });

  test('a practice-line call uses the same builder', async () => {
    await load([row(1, FACT_A)]);
    const convo = new RelayConversation({ callSid: 'CA-bank-p', from: '+19415551234', send: jest.fn(), sandbox: true, practiceLine: true });
    await convo._runLoop('hi').catch(() => {});
    expect(convo._practiceLine).toBe(true);
    expect(convo._systemBlocks[0].text).toContain(`- ${FACT_A}`);
  });

  test('a stale snapshot reads as an empty bank: the prompt is byte-identical', async () => {
    await load([row(1, FACT_A)]);
    const stale = Bank.getApprovedBankFacts({ now: Date.now() + Bank.STALE_MS + 1000 });
    expect(stale).toEqual([]);
    expect(buildBasePrompt(false, null, { bankFacts: stale })).toBe(SYSTEM_PROMPT);
  });
});

describe('email', () => {
  test('an empty bank: the entry is byte-identical to the code lines plus the closing rule', () => {
    expect(emailTest.companyFactsSystemEntry()).toBe(`${company()}${ENTRY_TAIL}`);
  });

  test('a bank fact follows the code lines and comes before the closing rule; read per draft', async () => {
    await load([row(1, FACT_A)]);
    expect(emailTest.companyFactsSystemEntry()).toBe(`${company()}\n${Bank.BANK_SECTION_HEADER}\n- ${FACT_A}${ENTRY_TAIL}`);
    Bank._test.resetSnapshot(); // a retire: the next draft is back to the code lines
    expect(emailTest.companyFactsSystemEntry()).toBe(`${company()}${ENTRY_TAIL}`);
  });
});
