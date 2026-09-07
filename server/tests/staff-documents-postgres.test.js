const { randomUUID } = require('node:crypto');
jest.setTimeout(30000);

// Explicit, worktree-owned Railway QA DB only. Ordinary Jest runs skip this suite.
const enabled = process.env.WAVES_STAFF_DOCUMENT_TEST_DB === '1';
const describeDb = enabled ? describe : describe.skip;
if (enabled) {
  const expected = `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
  if (process.env.WAVES_LOCAL_DEV !== '1' || process.env.RAILWAY_DEPLOYMENT_ID || new URL(process.env.DATABASE_URL).pathname !== expected) throw new Error('Staff-document integration tests require this worktree’s private QA database.');
}
const schema = `qa_staff_roles_${randomUUID().replaceAll('-', '')}`;
const db = enabled ? require('knex')({ ...require('../knexfile').development, searchPath: [schema] }) : require('../models/db');
if (enabled) jest.doMock('../models/db', () => db);
const documents = require('../services/staff-documents');
const { hash } = require('../services/staff-document-source');

describeDb('controlled staff documents on PostgreSQL', () => {
  const admin = { id: randomUUID(), role: 'admin' };
  const tech = { id: randomUUID(), role: 'technician' };
  const other = { id: randomUUID(), role: 'technician' };
  const run = randomUUID().slice(0, 8);
  const at = seconds => new Date(Date.now() + seconds * 1000);
  const issue = async (id, versionId, effective, actor) => {
    const preview = await documents.preview(id, versionId, effective, actor);
    return documents.publish(id, versionId, effective, preview.preview_hash, actor);
  };
  const reviewOn = () => at(30 * 86400).toISOString().slice(0, 10);
  const source = (body = '## PTO {#pto-accrual}\n{{policy.pto_accrual}}') => ({ title: `QA ${run}`, body,
    metadata: { owner_role: 'Office Manager', review_on: reviewOn(), citations: [], fields: [] } });
  let policy;
  let handbook;
  let offer;
  let first;
  let ack;
  let procedure;
  let record;
  let previousHash;
  const values = hours => ({ pay_frequency: 'weekly', pay_schedule: 'QA fixture only', pto_accrual: [{ after_years: 0, hours_per_year: hours }], paid_holidays: [], unpaid_holidays: [], equipment_deduction_terms: 'QA fixture only; no deductions authorized.' });

  beforeAll(async () => {
    const setup = require('knex')(require('../knexfile').development);
    try {
      await setup.raw('CREATE SCHEMA ??', [schema]);
      // Empty structural copies only: no account data or prior issued fixtures.
      for (const table of ['technicians', 'company_documents', 'customer_contracts', 'audit_log']) {
        await setup.raw('CREATE TABLE ??.?? (LIKE public.?? INCLUDING ALL)', [schema, table, table]);
      }
      await require('../models/migrations/20260601000009_document_template_library').up(db);
      await require('../models/migrations/20260907000010_controlled_staff_documents').up(db);
    } finally { await setup.destroy(); }
    await db('technicians').insert([admin, tech, other].map((actor, index) => ({ id: actor.id, name: `QA Document ${index}`, email: `qa-doc-${run}-${index}@example.invalid`, role: actor.role, employment_status: 'active', active: true })));
    const previous = await db('policy_values').orderBy('revision', 'desc').first();
    if (previous && new Date(previous.effective_at) >= at(-15)) throw new Error('Wait 15 seconds before re-running this preserved-history fixture.');
    policy = (await documents.updatePolicy({ base_revision_id: previous?.id || null, values: values(40) }, at(-15), admin)).policy;
  });
  afterAll(async () => { await db.destroy(); });

  test('the final migration applies and reverses on an empty isolated schema', async () => {
    const schema = `qa_staff_migration_${run}`;
    await db.raw('CREATE SCHEMA ??', [schema]);
    const sandbox = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 1 } });
    try {
      await sandbox.schema.createTable('technicians', t => t.uuid('id').primary());
      await sandbox.schema.createTable('company_documents', t => t.uuid('id').primary());
      await sandbox.schema.createTable('document_templates', t => { t.uuid('id').primary(); t.string('audience').notNullable().defaultTo('customer'); });
      await sandbox.schema.createTable('document_template_versions', t => t.uuid('id').primary());
      const migration = require('../models/migrations/20260907000010_controlled_staff_documents');
      await migration.up(sandbox);
      expect(await sandbox.schema.hasTable('staff_document_acknowledgments')).toBe(true);
      await expect(sandbox('document_templates').insert({ id: randomUUID(), audience: 'staff' })).rejects.toThrow(/staff_document_kind/);
      await migration.down(sandbox);
      expect(await sandbox.schema.hasTable('policy_values')).toBe(false);
    } finally {
      await sandbox.destroy();
      await db.raw('DROP SCHEMA ?? CASCADE', [schema]);
    }
  });

  test('drafts are hidden from technicians and unresolved values block issuance', async () => {
    const draft = await documents.saveDraft({ key: `qa-${run}-blocked`, kind: 'policy', access: 'staff', source: source('## Authority {#authority}\n[DECISION: choose approver]') }, admin);
    await expect(documents.detail(draft.document.id, tech)).rejects.toMatchObject({ status: 404 });
    await expect(issue(draft.document.id, draft.version.id, at(-14), admin)).rejects.toThrow(/Resolve/);
    expect((await db('document_template_versions').where({ id: draft.version.id }).first()).content_hash).toBeNull();
  });
  test('policies issue a canonical immutable snapshot with the approved data', async () => {
    handbook = await documents.saveDraft({ key: `qa-${run}-handbook`, kind: 'policy', access: 'staff', source: source() }, admin);
    offer = await documents.saveDraft({ key: `qa-${run}-offer`, kind: 'policy', access: 'staff', source: source() }, admin);
    first = await issue(handbook.document.id, handbook.version.id, at(-13), admin);
    await issue(offer.document.id, offer.version.id, at(-13), admin);
    expect(first.content_hash).toBe(hash(first.content_snapshot));
    expect(first.content_snapshot.body).toContain('40 hours');
    expect(first.content_snapshot.metadata.owner_role).toBe('Office Manager');
    expect(first.content_snapshot).not.toHaveProperty('owner_name');
    expect(first.approved_by).toBe(admin.id);
    await expect(documents.detail(handbook.document.id, admin, null, at(-30))).rejects.toMatchObject({ status: 404 });
    previousHash = first.content_hash;
    await expect(db('document_template_versions').where({ id: first.id }).update({ body: 'tampered' })).rejects.toThrow(/immutable/);
    await expect(db('document_template_versions').where({ id: first.id }).del()).rejects.toThrow(/immutable/);
    await expect(db('policy_values').where({ id: policy.id }).update({ values: '{}' })).rejects.toThrow(/immutable/);
  });
  test('acknowledgments reject wrong hashes and concurrent attempts are idempotent', async () => {
    await expect(documents.acknowledge(first.id, { content_hash: '0'.repeat(64), signed_name: 'QA Technician', accepted: true }, tech)).rejects.toMatchObject({ status: 409 });
    const result = await Promise.all([1, 2].map(() => documents.acknowledge(first.id, { content_hash: first.content_hash, signed_name: 'QA Technician', accepted: true }, tech)));
    expect(result[0].id).toBe(result[1].id); ack = result[0];
    expect(ack.technician_id).toBe(tech.id);
    await expect(db('staff_document_acknowledgments').where({ id: ack.id }).update({ signed_name: 'Changed' })).rejects.toThrow(/immutable/);
  });
  test('one policy update revises every bound document and preserves old evidence', async () => {
    const result = await documents.updatePolicy({ base_revision_id: policy.id, values: values(80) }, at(-10), admin);
    policy = result.policy;
    expect(result.revised_version_ids).toEqual(expect.arrayContaining([
      (await documents.detail(handbook.document.id, tech)).version.id,
      (await documents.detail(offer.document.id, tech)).version.id,
    ]));
    expect((await documents.detail(handbook.document.id, tech)).rendered.body).toContain('80 hours');
    expect((await documents.detail(offer.document.id, tech)).rendered.body).toContain('80 hours');
    const historical = await documents.detail(handbook.document.id, tech, first.id);
    expect(historical.version.content_hash).toBe(previousHash);
    expect(historical.rendered.body).toContain('40 hours');
    expect(historical.acknowledgments[0].id).toBe(ack.id);
    const inForce = await documents.list(admin, { at: first.effective_at, asOf: true });
    expect(inForce.find(item => item.id === handbook.document.id).version_id).toBe(first.id);
  });
  test('stale base revisions and re-publication cannot silently overwrite history', async () => {
    await expect(documents.updatePolicy({ base_revision_id: null, values: values(90) }, at(-9), admin)).rejects.toMatchObject({ status: 409 });
    await expect(issue(handbook.document.id, first.id, at(-9), admin)).rejects.toMatchObject({ status: 409 });
    await expect(documents.saveDraft({ id: handbook.document.id, base_version_id: first.id, source: source() }, admin)).rejects.toMatchObject({ status: 409 });
  });
  test('one failed document review rolls back the entire policy change', async () => {
    const shortReview = source(); shortReview.metadata.review_on = at(86400).toISOString().slice(0, 10);
    const guarded = await documents.saveDraft({ key: `qa-${run}-review`, kind: 'policy', access: 'staff', source: shortReview }, admin);
    await issue(guarded.document.id, guarded.version.id, at(-8), admin);
    const before = await db('document_template_versions').count('* as n').first();
    await expect(documents.updatePolicy({ base_revision_id: policy.id, values: values(90) }, at(2 * 86400), admin)).rejects.toThrow(/review/i);
    expect((await db('policy_values').orderBy('revision', 'desc').first()).id).toBe(policy.id);
    expect((await db('document_template_versions').count('* as n').first()).n).toBe(before.n);
  });
  test('admin-only documents are hidden from staff', async () => {
    const restricted = await documents.saveDraft({ key: `qa-${run}-restricted`, kind: 'form', access: 'admin', source: source('## Facts {#facts}\nRecord verified facts.') }, admin);
    await issue(restricted.document.id, restricted.version.id, at(-7), admin);
    await expect(documents.detail(restricted.document.id, tech)).rejects.toMatchObject({ status: 404 });
    expect((await documents.list(tech)).some(item => item.id === restricted.document.id)).toBe(false);
  });
  test('procedure records enforce ownership and step completion', async () => {
    procedure = await documents.saveDraft({ key: `qa-${run}-procedure`, kind: 'procedure', access: 'staff', source: source('## First {#first}\nVerify facts.\n\n## Second {#second}\nRecord handover.') }, admin);
    procedure.version = await issue(procedure.document.id, procedure.version.id, at(-6), admin);
    const payload = { content_hash: procedure.version.content_hash, owner_id: tech.id, due_at: at(60), answers: {}, completed_steps: ['first'], complete: false };
    await expect(documents.saveRecord(procedure.version.id, { ...payload, owner_id: other.id }, tech)).rejects.toMatchObject({ status: 403 });
    await expect(documents.saveRecord(procedure.version.id, { ...payload, complete: true }, tech)).rejects.toThrow(/every procedure step/);
    record = await documents.saveRecord(procedure.version.id, payload, tech);
    expect((await documents.detail(procedure.document.id, other)).records).toHaveLength(0);
    await expect(documents.saveRecord(procedure.version.id, { ...payload, id: record.id, base_updated_at: record.updated_at.toISOString() }, other)).rejects.toMatchObject({ status: 403 });
  });
  test('completed records and their source-version identity cannot be edited', async () => {
    const payload = { id: record.id, base_updated_at: record.updated_at.toISOString(), content_hash: procedure.version.content_hash, owner_id: tech.id, due_at: at(60), answers: {}, completed_steps: ['first', 'second'], complete: true };
    const completed = await documents.saveRecord(procedure.version.id, payload, tech);
    expect(completed.content_hash).toBe(procedure.version.content_hash);
    expect(completed.completed_at).toBeInstanceOf(Date);
    await expect(documents.saveRecord(procedure.version.id, payload, tech)).rejects.toMatchObject({ status: 409 });
    await expect(db('staff_document_records').where({ id: completed.id }).update({ answers: '{}' })).rejects.toThrow(/immutable/);
    await expect(db('staff_document_records').where({ id: completed.id }).del()).rejects.toThrow(/immutable/);
  });

  test('a future policy change does not block an unrelated procedure revision', async () => {
    policy = (await documents.updatePolicy({ base_revision_id: policy.id, values: values(90) }, at(60), admin)).policy;
    const next = await documents.saveDraft({ id: procedure.document.id, base_version_id: procedure.version.id, source: source('## First {#first}\nUpdated synthetic procedure.\n\n## Second {#second}\nRecord handover.') }, admin);
    const issued = await issue(procedure.document.id, next.version.id, at(-1), admin);
    expect(issued.content_snapshot.body).toContain('Updated synthetic procedure');
  });
  test('superseded versions reject new evidence but retain historical reads', async () => {
    await expect(documents.acknowledge(first.id, { content_hash: first.content_hash, signed_name: 'QA Other', accepted: true }, other)).rejects.toMatchObject({ status: 409 });
    await expect(documents.saveRecord(procedure.version.id, { content_hash: procedure.version.content_hash, owner_id: tech.id, due_at: at(60), answers: {}, completed_steps: [], complete: false }, tech)).rejects.toMatchObject({ status: 409 });
    const history = await documents.detail(procedure.document.id, tech, procedure.version.id);
    expect(history.records[0].id).toBe(record.id);
    expect(history.current_version_id).not.toBe(procedure.version.id);
    expect((await documents.detail(handbook.document.id, tech, first.id)).acknowledgments[0].id).toBe(ack.id);
  });
  test('reassignment removes former-creator access and preserves current-owner access', async () => {
    const current = (await documents.detail(procedure.document.id, tech)).version;
    const payload = { content_hash: current.content_hash, owner_id: tech.id, due_at: at(60), answers: {}, completed_steps: [], complete: false };
    const created = await documents.saveRecord(current.id, payload, tech);
    await documents.saveRecord(current.id, { ...payload, id: created.id, base_updated_at: created.updated_at.toISOString(), owner_id: other.id }, admin);
    expect((await documents.detail(procedure.document.id, tech)).records.some(r => r.id === created.id)).toBe(false);
    expect((await documents.detail(procedure.document.id, other)).records.some(r => r.id === created.id)).toBe(true);
    await expect(documents.saveRecord(current.id, { ...payload, id: created.id, base_updated_at: created.updated_at.toISOString() }, tech)).rejects.toMatchObject({ status: 404 });
  });
  test('future issuance uses exactly the policy wording reviewed for that effective time', async () => {
    const draft = await documents.saveDraft({ key: `qa-${run}-future`, kind: 'policy', access: 'staff', source: source() }, admin);
    expect((await documents.detail(draft.document.id, admin)).rendered.body).toContain('80 hours');
    const effective = at(90);
    const preview = await documents.preview(draft.document.id, draft.version.id, effective, admin);
    expect(preview.rendered.body).toContain('90 hours');
    const issued = await documents.publish(draft.document.id, draft.version.id, effective, preview.preview_hash, admin);
    expect(issued.content_snapshot.body).toBe(preview.rendered.body);
    await expect(documents.acknowledge(issued.id, { content_hash: issued.content_hash, signed_name: 'QA Other', accepted: true }, other)).rejects.toMatchObject({ status: 404 });
  });
  test('a policy revision after preview requires renewed review before issuance', async () => {
    const draft = await documents.saveDraft({ key: `qa-${run}-stale-preview`, kind: 'policy', access: 'staff', source: source() }, admin);
    const effective = at(180);
    const preview = await documents.preview(draft.document.id, draft.version.id, effective, admin);
    policy = (await documents.updatePolicy({ base_revision_id: policy.id, values: values(100) }, at(120), admin)).policy;
    await expect(documents.publish(draft.document.id, draft.version.id, effective, preview.preview_hash, admin)).rejects.toMatchObject({ status: 409 });
    expect((await db('document_template_versions').where({ id: draft.version.id }).first()).content_hash).toBeNull();
    const refreshed = await documents.preview(draft.document.id, draft.version.id, effective, admin);
    expect(refreshed.rendered.body).toContain('100 hours');
    expect((await documents.publish(draft.document.id, draft.version.id, effective, refreshed.preview_hash, admin)).content_snapshot.body).toBe(refreshed.rendered.body);
  });

});
