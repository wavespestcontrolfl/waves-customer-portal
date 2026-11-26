// The company facts bank on a real, migrated PostgreSQL (services/company-facts-bank.js, migration 20261125120000): the
// state machine, the guard trigger (approved text, status moves, deletes), the live-text unique index, the append-only
// history, the atomic edit-as-new-draft, the owner-only approve, the cap, and the snapshot reading real rows. Every row is
// written inside ONE root transaction that is rolled back at the end (services reach it through savepoints), so nothing
// persists. Synthetic text only; no message is sent.

// CI's DB-gated step selects suites by this exact line.
const SKIP = !process.env.DATABASE_URL;
const connection = process.env.DATABASE_URL;

const { randomUUID } = require('node:crypto');

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// The audit writer, passed through; one test makes the second call fail to prove the approve is one transaction.
const mockAudit = jest.fn();
jest.mock('../services/audit-log', () => {
  const actual = jest.requireActual('../services/audit-log');
  return { ...actual, recordAuditEvent: (...args) => mockAudit(...args) };
});

jest.setTimeout(120000);

(SKIP ? describe.skip : describe)('company facts bank (PostgreSQL)', () => {
  let database;
  let root;
  let Bank;
  const owner = { id: randomUUID(), isOwner: true };
  const admin = { id: randomUUID(), isOwner: false };
  const opts = () => ({ dbi: root });
  let n = 0;
  const line = (extra = '') => `We service zone number ${(n += 1)} on request${extra}.`;
  const draft = (text = line(), more = {}) => Bank.createDraft({ topic: 'Areas', factText: text, ...more }, admin, opts());
  // Presses Approve as the page does: with the hash of the wording it showed (the row as it stands, unless a test says otherwise).
  const approve = async (id, input = {}, actor = owner) => {
    const shown = (await row(id))?.text_sha256;
    return Bank.approveFact(id, { textSha256: shown, ...input }, actor, opts());
  };
  const live = async (text = line()) => approve((await draft(text)).id);
  const row = (id) => root('company_facts').where({ id }).first();
  const events = async (id) => (await Bank.factHistory(id, opts())).map((e) => e.action);

  // A statement the database must refuse; its savepoint rolls back and the root transaction carries on.
  async function refused(work) {
    let caught;
    try {
      await root.transaction(async (sp) => { await work(sp); });
    } catch (err) { caught = err; }
    expect(caught).toBeDefined();
    return caught;
  }

  beforeAll(async () => {
    database = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 3 } });
    root = await database.transaction();
    Bank = require('../services/company-facts-bank');
    await root('products_catalog').insert({ name: 'Zorbex Pro 4L', category: 'insecticide' });
  });
  afterAll(async () => {
    Bank.stopBankRefresh();
    if (root) await root.rollback();
    if (database) await database.destroy();
  });
  beforeEach(async () => {
    mockAudit.mockImplementation((...args) => jest.requireActual('../services/audit-log').recordAuditEvent(...args));
    Bank._test.resetSnapshot();
    await root('company_facts').update({ status: 'retired', retired_at: root.fn.now(), retire_reason: 'test reset' }).where({ status: 'approved' });
    await root('company_facts').where({ status: 'draft' }).del();
  });

  // FIRST in the file on purpose: the suite's root transaction takes the bank-wide lock at its first approve and keeps it until it
  // rolls back at the end, so this test (own connections) must run before any approve of the root.
  describe('bank-wide approve lock', () => {
    test('approve takes the bank-wide lock: while another transaction holds it, an approve waits (and times out here)', async () => {
      const a = await database.transaction();
      const b = await database.transaction();
      try {
        const d = await Bank.createDraft({ topic: 'Areas', factText: line(' lock') }, admin, { dbi: a });
        await b.raw('SELECT pg_advisory_xact_lock(hashtext(?))', ['company_facts_bank_approve']);
        let caught;
        try {
          await a.transaction(async (sp) => {
            await sp.raw("SET LOCAL lock_timeout = '300ms'");
            await Bank.approveFact(d.id, { textSha256: d.text_sha256 }, owner, { dbi: sp });
          });
        } catch (err) { caught = err; }
        expect(caught && caught.code).toBe('55P03');
        await b.rollback();
        await expect(Bank.approveFact(d.id, { textSha256: d.text_sha256 }, owner, { dbi: a })).resolves.toMatchObject({ status: 'approved' });
      } finally {
        await a.rollback();
        if (!b.isCompleted()) await b.rollback();
      }
    });
  });

  describe('state machine', () => {
    test('draft -> approved -> retired, with one event per step and a critical audit row for approve and retire', async () => {
      const d = await draft();
      expect(d).toMatchObject({ status: 'draft', created_by: admin.id });
      const a = await approve(d.id, { ownerWords: 'ok 11-25' });
      expect(a).toMatchObject({ status: 'approved', approved_by: owner.id, owner_words: 'ok 11-25' });
      expect(a.approved_at).toBeTruthy();
      const r = await Bank.retireFact(d.id, { reason: 'wrong area' }, admin, opts());
      expect(r).toMatchObject({ status: 'retired', retired_by: admin.id, retire_reason: 'wrong area' });
      expect(await events(d.id)).toEqual(['drafted', 'approved', 'retired']);
      const audits = await root('audit_log').where({ resource_type: 'company_fact', resource_id: d.id }).orderBy('created_at').select('action', 'actor_id', 'metadata');
      expect(audits.map((x) => x.action)).toEqual(['company_fact.approved', 'company_fact.retired']);
      expect(JSON.stringify(audits)).not.toContain('zone number');
    });

    test('illegal moves are refused', async () => {
      const d = await draft();
      await expect(Bank.retireFact(d.id, { reason: 'nope' }, admin, opts())).rejects.toMatchObject({ code: 'NOT_APPROVED' });
      await expect(Bank.restoreAsDraft(d.id, admin, opts())).rejects.toMatchObject({ code: 'NOT_RETIRED' });
      const a = await approve(d.id);
      await expect(approve(a.id)).rejects.toMatchObject({ code: 'NOT_A_DRAFT' });
      await expect(Bank.discardDraft(a.id, admin, opts())).rejects.toMatchObject({ code: 'NOT_A_DRAFT' });
      await Bank.retireFact(a.id, { reason: 'old' }, admin, opts());
      await expect(Bank.editFact(a.id, { factText: line() }, admin, opts())).rejects.toMatchObject({ code: 'RETIRED_USE_RESTORE' });
      await expect(Bank.retireFact(a.id, { reason: 'again' }, admin, opts())).rejects.toMatchObject({ code: 'NOT_APPROVED' });
      await expect(Bank.getFact(randomUUID(), opts())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    test('approve binds to the wording the owner reviewed: a changed or missing hash is refused and the draft stays', async () => {
      const d = await draft();
      const shown = d.text_sha256;
      await Bank.editFact(d.id, { factText: line(' reworded') }, admin, opts());
      await expect(approve(d.id, { textSha256: shown })).rejects.toMatchObject({ code: 'STALE_TEXT', status: 409 });
      await expect(Bank.approveFact(d.id, {}, owner, opts())).rejects.toMatchObject({ code: 'REVIEWED_TEXT_REQUIRED' });
      expect((await row(d.id)).status).toBe('draft');
      await expect(approve(d.id)).resolves.toMatchObject({ status: 'approved' });
    });

    test('a replacement whose original was retired meanwhile is refused (ORIGINAL_NOT_APPROVED) and stays a draft', async () => {
      const a = await live();
      const next = await Bank.editFact(a.id, { factText: line(' replacement') }, admin, opts());
      await Bank.retireFact(a.id, { reason: 'policy withdrawn' }, admin, opts());
      await expect(approve(next.id)).rejects.toMatchObject({ code: 'ORIGINAL_NOT_APPROVED', status: 409 });
      expect((await row(next.id)).status).toBe('draft');
    });

    test('a non-owner cannot approve: the draft stays a draft', async () => {
      const d = await draft();
      await expect(approve(d.id, {}, admin)).rejects.toMatchObject({ code: 'OWNER_ONLY' });
      expect((await row(d.id)).status).toBe('draft');
    });

    test('a retired line returns only as a NEW draft; the retired row and its history stay', async () => {
      const a = await live();
      await Bank.retireFact(a.id, { reason: 'paused' }, admin, opts());
      const back = await Bank.restoreAsDraft(a.id, admin, opts());
      expect(back.id).not.toBe(a.id);
      expect(back).toMatchObject({ status: 'draft', fact_text: a.fact_text });
      expect((await row(a.id)).status).toBe('retired');
      expect(await events(back.id)).toEqual(['restored_as_draft']);
      await approve(back.id);
      const again = await live(line());
      await Bank.retireFact(again.id, { reason: 'not needed' }, admin, opts());
      const second = await Bank.restoreAsDraft(again.id, admin, opts());
      await approve(second.id);
      await Bank.retireFact(second.id, { reason: 'not needed' }, admin, opts());
      const clash = await live(again.fact_text);
      await expect(Bank.restoreAsDraft(second.id, admin, opts())).rejects.toMatchObject({ code: 'DUPLICATE' });
      expect(clash.status).toBe('approved');
    });

    test('edit, restore and approve read through their own transaction, never a second pooled connection', async () => {
      // A handle that opens transactions but refuses any direct query: a validation read that borrowed another connection throws.
      const strict = Object.assign(() => { throw new Error('read outside the transaction'); }, { transaction: (work) => root.transaction(work) });
      const sopts = { dbi: strict };
      const d = await draft();
      const edited = await Bank.editFact(d.id, { factText: line(' via trx') }, admin, sopts);
      const a = await Bank.approveFact(d.id, { textSha256: edited.text_sha256 }, owner, sopts);
      const next = await Bank.editFact(a.id, { factText: line(' again') }, admin, sopts);
      expect(next.supersedes_id).toBe(a.id);
      await Bank.retireFact(a.id, { reason: 'not needed' }, admin, sopts);
      const back = await Bank.restoreAsDraft(a.id, admin, sopts);
      expect(back.status).toBe('draft');
    });

    test('discarding a draft deletes the row and keeps its history', async () => {
      const d = await draft();
      await Bank.discardDraft(d.id, admin, opts());
      expect(await row(d.id)).toBeUndefined();
      expect(await events(d.id)).toEqual(['drafted', 'discarded']);
    });
  });

  describe('hard blocks and warnings at approve time', () => {
    test("the owner's own wording \"safe to go in\" can be drafted but not approved", async () => {
      const d = await draft("Yes, it's safe to go in.");
      expect(d.check_result.blocks).toContain('banned_copy');
      await expect(approve(d.id)).rejects.toMatchObject({ code: 'BLOCKED', detail: { blocks: expect.arrayContaining(['banned_copy']) } });
      expect((await row(d.id)).status).toBe('draft');
    });

    test('a product name from products_catalog and a dollar amount block, the whole row staying a draft', async () => {
      const d = await draft('We apply Zorbex Pro 4L for $20.');
      await expect(approve(d.id)).rejects.toMatchObject({ detail: { blocks: expect.arrayContaining(['product_brand', 'dollar_amount']) } });
    });

    test('a duplicate of another approved line (case and punctuation aside) is blocked at approve', async () => {
      const a = await live();
      const d = await draft(a.fact_text.toUpperCase());
      await expect(approve(d.id)).rejects.toMatchObject({ detail: { blocks: ['duplicate_bank_line'] } });
    });

    test('warning words need warnings_acknowledged', async () => {
      const d = await draft('We can reschedule a visit from the customer portal.');
      await expect(approve(d.id)).rejects.toMatchObject({ code: 'WARNINGS_NOT_ACKNOWLEDGED', status: 409 });
      expect((await row(d.id)).status).toBe('draft');
      const a = await approve(d.id, { acknowledgeWarnings: true });
      expect(a).toMatchObject({ status: 'approved', warnings_acknowledged: true });
      expect(a.check_result.warnings[0].code).toBe('promise_words');
    });

    test('only a literal true acknowledges warnings: the string "false" does not', async () => {
      const d = await draft('We can reschedule a visit from the customer portal.');
      await expect(approve(d.id, { acknowledgeWarnings: 'false' })).rejects.toMatchObject({ code: 'WARNINGS_NOT_ACKNOWLEDGED' });
      await expect(approve(d.id, { acknowledgeWarnings: 1 })).rejects.toMatchObject({ code: 'WARNINGS_NOT_ACKNOWLEDGED' });
      expect((await row(d.id)).status).toBe('draft');
    });

    test('a standing rainfast or re-entry time is blocked, as it is for the code lines', async () => {
      const d = await draft('Our treatment is rainfast after two hours.');
      await expect(approve(d.id)).rejects.toMatchObject({ detail: { blocks: expect.arrayContaining(['banned_copy']) } });
    });

    test('a bank over 2,000 characters in all still approves: the SMS reply limit is not the bank limit', async () => {
      // Six lines of about 350 characters, each well inside its own 400.
      const long = (i) => `We service zone ${i} ${'and the neighbors beside it '.repeat(12)}on request.`.slice(0, 350).replace(/\s+\S*$/, '.');
      for (let i = 0; i < 6; i += 1) {
        const text = long(i + 100);
        expect(text.length).toBeGreaterThan(300);
        await live(text);
      }
      const total = (await root('company_facts').where({ status: 'approved' }).select('fact_text')).reduce((sum, r) => sum + r.fact_text.length, 0);
      expect(total).toBeGreaterThan(2000);
    });

    test('the bank holds at most 20 approved lines', async () => {
      for (let i = 0; i < Bank.MAX_ACTIVE_FACTS; i += 1) await live();
      const d = await draft();
      await expect(approve(d.id)).rejects.toMatchObject({ detail: { blocks: ['bank_full'] } });
    });
  });

  describe('approved text is immutable', () => {
    test('the service never rewrites an approved row: an edit is a NEW draft that supersedes it', async () => {
      const a = await live();
      const next = await Bank.editFact(a.id, { factText: line(' now') }, admin, opts());
      expect(next).toMatchObject({ status: 'draft', supersedes_id: a.id });
      expect((await row(a.id)).fact_text).toBe(a.fact_text);
      await expect(Bank.editFact(a.id, { factText: line() }, admin, opts())).rejects.toMatchObject({ code: 'EDIT_IN_PROGRESS' });
      await expect(Bank.editFact(a.id, { factText: a.fact_text }, admin, opts())).rejects.toMatchObject({ code: 'TEXT_UNCHANGED' });
    });

    test('the trigger refuses an UPDATE of fact_text or text_sha256 on an approved or retired row, whoever writes the SQL', async () => {
      const a = await live();
      const err = await refused((sp) => sp('company_facts').where({ id: a.id }).update({ fact_text: 'We changed it.' }));
      expect(err.message).toContain('fact_text of a approved row cannot change');
      await refused((sp) => sp('company_facts').where({ id: a.id }).update({ text_sha256: 'a'.repeat(64) }));
      await Bank.retireFact(a.id, { reason: 'not needed' }, admin, opts());
      await refused((sp) => sp('company_facts').where({ id: a.id }).update({ fact_text: 'We changed it.' }));
      expect((await row(a.id)).fact_text).toBe(a.fact_text);
    });

    test('the trigger refuses an illegal status move and a delete of a non-draft row; a draft stays editable and deletable', async () => {
      const a = await live();
      await refused((sp) => sp('company_facts').where({ id: a.id }).update({ status: 'draft' }));
      await refused((sp) => sp('company_facts').where({ id: a.id }).del());
      await Bank.retireFact(a.id, { reason: 'not needed' }, admin, opts());
      await refused((sp) => sp('company_facts').where({ id: a.id }).update({ status: 'approved' }));
      const d = await draft();
      await refused((sp) => sp('company_facts').where({ id: d.id }).update({ status: 'retired', retired_at: sp.fn.now(), retire_reason: 'skip' }));
      await root('company_facts').where({ id: d.id }).update({ fact_text: line(' edited') });
    });

    test('an in-place edit of a draft updates it, clears the acknowledgement and logs one event', async () => {
      const d = await draft('We can reschedule a visit from the customer portal.');
      const edited = await Bank.editFact(d.id, { factText: line(' plainly'), topic: 'Areas 2' }, admin, opts());
      expect(edited).toMatchObject({ id: d.id, topic: 'Areas 2', warnings_acknowledged: false });
      expect(edited.text_sha256).toBe(Bank._test.sha256(edited.fact_text));
      expect(await events(d.id)).toEqual(['drafted', 'edited']);
    });
  });

  describe('indexes and history', () => {
    test('one live copy of a line: a second draft is DUPLICATE, a discarded one can be added again', async () => {
      const text = line();
      const d = await draft(text);
      await expect(draft(text)).rejects.toMatchObject({ code: 'DUPLICATE', status: 409 });
      await Bank.discardDraft(d.id, admin, opts());
      await expect(draft(text)).resolves.toMatchObject({ status: 'draft' });
    });

    test('history is append-only', async () => {
      const d = await draft();
      const event = await root('company_fact_events').where({ fact_id: d.id }).first();
      await refused((sp) => sp('company_fact_events').where({ id: event.id }).update({ action: 'retired' }));
      await refused((sp) => sp('company_fact_events').where({ id: event.id }).del());
      await refused((sp) => sp('company_fact_events').insert({ fact_id: d.id, action: 'made_up' }));
    });
  });

  describe('edit of an approved line, in one transaction', () => {
    test('approving the new draft retires the old row with it, and the snapshot swaps the line', async () => {
      const a = await live();
      const next = await Bank.editFact(a.id, { factText: line(' better') }, admin, opts());
      const done = await approve(next.id);
      expect(done.status).toBe('approved');
      expect(await row(a.id)).toMatchObject({ status: 'retired', retire_reason: 'superseded', retired_by: owner.id });
      expect(await events(a.id)).toEqual(['drafted', 'approved', 'retired']);
      const audits = await root('audit_log').where({ resource_id: a.id, action: 'company_fact.retired' });
      expect(audits).toHaveLength(1);
      expect(Bank.getApprovedBankFacts().map((f) => f.id)).toEqual([next.id]);
    });

    test('a failure part-way rolls both rows back: the old line stays approved and the new one stays a draft', async () => {
      const a = await live();
      const next = await Bank.editFact(a.id, { factText: line(' unlucky') }, admin, opts());
      const real = jest.requireActual('../services/audit-log').recordAuditEvent;
      mockAudit.mockImplementationOnce((...args) => real(...args)).mockImplementationOnce(() => { throw Object.assign(new Error('audit down'), { code: 'XX000' }); });
      await expect(approve(next.id)).rejects.toThrow('audit down');
      expect((await row(a.id)).status).toBe('approved');
      expect((await row(next.id)).status).toBe('draft');
      expect(await events(a.id)).toEqual(['drafted', 'approved']);
    });
  });

  describe('snapshot on real rows', () => {
    test('loads approved rows only; a retire drops the line at once in this process', async () => {
      await draft(); // stays a draft
      const kept = await live();
      const gone = await live();
      await Bank.retireFact(gone.id, { reason: 'not needed' }, admin, opts());
      await Bank.refreshBankFacts(opts());
      expect(Bank.getApprovedBankFacts().map((f) => f.id)).toEqual([kept.id]);
      expect(Bank.renderBankFactsLines()).toBe(`- ${kept.fact_text}`);
      await Bank.retireFact(kept.id, { reason: 'not needed' }, admin, opts());
      expect(Bank.getApprovedBankFacts()).toEqual([]);
      expect(Bank.bankVersionHash()).toBe('');
    });

    test('an approved row written around the service is dropped, not served', async () => {
      const good = await live();
      const sha = Bank._test.sha256('Today only the setup visit is $99.');
      await root('company_facts').insert({
        topic: 'Bad', fact_text: 'Today only the setup visit is $99.', text_sha256: sha, status: 'approved', approved_at: root.fn.now(),
      });
      await Bank.refreshBankFacts(opts());
      expect(Bank.getApprovedBankFacts().map((f) => f.id)).toEqual([good.id]);
    });
  });
});
