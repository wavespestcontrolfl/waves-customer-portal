const { randomUUID } = require('node:crypto');
jest.setTimeout(60000);

// Same opt-in and isolation as staff-documents-postgres.test.js: explicit, worktree-owned QA DB only,
// every table lives in a private schema that this suite drops. Ordinary Jest runs skip it.
const enabled = process.env.WAVES_STAFF_DOCUMENT_TEST_DB === '1';
const describeDb = enabled ? describe : describe.skip;
if (enabled) {
  const expected = `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
  if (process.env.WAVES_LOCAL_DEV !== '1' || process.env.RAILWAY_DEPLOYMENT_ID || new URL(process.env.DATABASE_URL).pathname !== expected) throw new Error('Staff-document integration tests require this worktree’s private QA database.');
  process.env.GATE_STAFF_ONBOARDING_DOCS = 'true';
  process.env.GATE_CONTROLLED_STAFF_DOCUMENTS = 'true';
}
const schema = `qa_staff_onboarding_${randomUUID().replaceAll('-', '')}`;
const db = enabled ? require('knex')({ ...require('../knexfile').development, searchPath: [schema] }) : require('../models/db');
if (enabled) jest.doMock('../models/db', () => db);
const documents = require('../services/staff-documents');
const onboarding = require('../services/staff-onboarding');
const KEY = onboarding.VEHICLE_AGREEMENT_KEY;

describeDb('staff onboarding documents on PostgreSQL', () => {
  const run = randomUUID().slice(0, 8);
  const admin = { id: randomUUID(), role: 'admin' };
  const first = { id: randomUUID(), role: 'technician' };
  const second = { id: randomUUID(), role: 'technician' };
  const inactive = { id: randomUUID(), role: 'technician' };
  const prospective = { id: randomUUID(), role: 'technician' };
  const at = seconds => new Date(Date.now() + seconds * 1000);
  const reviewOn = () => at(30 * 86400).toISOString().slice(0, 10);
  const source = (title, fields = []) => ({ title, body: '## Terms {#terms}\nQA wording only.',
    metadata: { owner_role: 'Office Manager', review_on: reviewOn(), citations: [], fields } });
  const field = { id: 'signed-name', label: 'Signed name', type: 'text', required: true };
  const issue = async (id, versionId, effective) => {
    const preview = await documents.preview(id, versionId, effective, admin);
    return documents.publish(id, versionId, effective, preview.preview_hash, admin);
  };
  const titles = result => result.documents.map(item => item.title).sort();
  // A member signs the way the record screen does: a new record with no id, owner = self, complete.
  const sign = (tech, version) => documents.saveRecord(version.id, { content_hash: version.content_hash, owner_id: tech.id,
    due_at: at(86400), answers: { 'signed-name': 'QA Person' }, completed_steps: [], complete: true }, tech);
  const counts = async () => ({ records: (await db('staff_document_records').count('* as n').first()).n, audits: (await db('audit_log').count('* as n').first()).n });
  let form;
  let formV1;
  let policy;
  let policyV1;
  let adminOnly;

  beforeAll(async () => {
    const setup = require('knex')(require('../knexfile').development);
    try {
      await setup.raw('CREATE SCHEMA ??', [schema]);
      for (const table of ['technicians', 'company_documents', 'customer_contracts', 'audit_log']) {
        await setup.raw('CREATE TABLE ??.?? (LIKE public.?? INCLUDING ALL)', [schema, table, table]);
      }
      await require('../models/migrations/20260601000009_document_template_library').up(db);
      await require('../models/migrations/20260907000010_controlled_staff_documents').up(db);
      await require('../models/migrations/20261008120000_staff_document_onboarding_required').up(db);
    } finally { await setup.destroy(); }
    const people = [[admin, 'active'], [first, 'active'], [second, 'active'], [inactive, 'inactive'], [prospective, 'prospective']];
    await db('technicians').insert(people.map(([person, status], index) => ({ id: person.id, name: `QA Onboarding ${index}`,
      email: `qa-onboarding-${run}-${index}@example.invalid`, role: person.role, employment_status: status, active: status === 'active' })));
    const draft = async (key, kind, access, title, fields) => {
      const result = await documents.saveDraft({ key: `${key}`, kind, access, source: source(title, fields) }, admin);
      return { document: result.document, version: await issue(result.document.id, result.version.id, at(-10)) };
    };
    ({ document: form, version: formV1 } = await draft('vehicle-use-commuting-agreement', 'form', 'staff', `QA vehicle agreement ${run}`, [field]));
    ({ document: policy, version: policyV1 } = await draft(`qa-${run}-policy`, 'policy', 'staff', `QA policy ${run}`, []));
    ({ document: adminOnly } = await draft(`qa-${run}-admin`, 'policy', 'admin', `QA admin policy ${run}`, []));
  });
  afterAll(async () => {
    await db.raw('DROP SCHEMA ?? CASCADE', [schema]);
    await db.destroy();
  });

  test('the migration adds a false-by-default flag that only a staff document can carry, and reverses', async () => {
    expect(form.onboarding_required).toBe(false);
    await expect(db('document_templates').insert({ id: randomUUID(), template_key: `qa.${run}`, name: 'QA customer', audience: 'customer', onboarding_required: true }))
      .rejects.toThrow(/document_templates_onboarding_staff_only/);
    const migration = require('../models/migrations/20261008120000_staff_document_onboarding_required');
    await migration.down(db);
    expect(await db.schema.hasColumn('document_templates', 'onboarding_required')).toBe(false);
    await migration.up(db);
    await migration.up(db);
    expect(await db('document_templates').where({ id: form.id }).first('onboarding_required')).toEqual({ onboarding_required: false });
  });

  test('nothing is required until an admin marks a document, and the toggle is audited', async () => {
    expect((await onboarding.onboardingFor(first)).documents).toEqual([]);
    const marked = await documents.setOnboardingRequired(form.id, true, admin);
    expect(marked.onboarding_required).toBe(true);
    expect((await documents.setOnboardingRequired(form.id, true, admin)).onboarding_required).toBe(true);
    expect(await db('audit_log').where({ action: 'staff_document.onboarding_required' })).toHaveLength(1);
    await documents.setOnboardingRequired(form.id, false, admin);
    expect((await onboarding.onboardingFor(first)).documents).toEqual([]);
    await documents.setOnboardingRequired(form.id, true, admin);
  });

  test('a form is outstanding until COMPLETED; a policy until acknowledged; reads write nothing', async () => {
    await documents.setOnboardingRequired(policy.id, true, admin);
    const before = await counts();
    const mine = await onboarding.onboardingFor(first);
    expect(await onboarding.onboardingFor(first)).toEqual(mine);
    await onboarding.onboardingForTeam();
    expect(await counts()).toEqual(before);
    expect(titles(mine)).toEqual([`QA policy ${run}`, `QA vehicle agreement ${run}`]);
    expect(mine.counts).toEqual({ outstanding: 2, total: 2 });
    expect(mine.documents.find(item => item.kind === 'form')).toMatchObject({ document_id: form.id, version_id: formV1.id });
    expect(mine.documents.find(item => item.kind === 'form')).not.toHaveProperty('record_id');
    expect(mine.documents.find(item => item.kind === 'policy').due_at).toBeNull();

    // An open (saved, not completed) record does not clear the form.
    await documents.saveRecord(formV1.id, { content_hash: formV1.content_hash, owner_id: first.id, due_at: at(86400),
      answers: { 'signed-name': 'Draft' }, completed_steps: [], complete: false }, first);
    expect((await onboarding.onboardingFor(first)).counts.outstanding).toBe(2);

    await sign(first, formV1);
    expect(titles(await onboarding.onboardingFor(first))).toEqual([`QA policy ${run}`]);
    await documents.acknowledge(policyV1.id, { accepted: true, signed_name: 'QA Person', content_hash: policyV1.content_hash }, first);
    const done = await onboarding.onboardingFor(first);
    expect(done.documents).toEqual([]);
    expect(done.counts).toEqual({ outstanding: 0, total: 2 });
    expect(titles(await onboarding.onboardingFor(second))).toHaveLength(2);
  });

  test('the due date shown is 7 days after the later of the hire date and the version effective date', async () => {
    const item = (await onboarding.onboardingFor(second)).documents.find(entry => entry.kind === 'form');
    const hired = new Date((await db('technicians').where({ id: second.id }).first('created_at')).created_at).getTime();
    const effective = new Date(formV1.effective_at).getTime();
    expect(new Date(item.due_at).getTime()).toBe(Math.max(hired, effective) + 7 * 86400000);
  });

  test('an admin-only document reaches administrators only; staff are never offered it', async () => {
    await documents.setOnboardingRequired(adminOnly.id, true, admin);
    expect(titles(await onboarding.onboardingFor(admin))).toContain(`QA admin policy ${run}`);
    expect(titles(await onboarding.onboardingFor(second))).not.toContain(`QA admin policy ${run}`);
    const team = await onboarding.onboardingForTeam();
    const byId = Object.fromEntries(team.technicians.map(person => [person.technician_id, person]));
    expect(byId[admin.id].outstanding.map(item => item.title)).toContain(`QA admin policy ${run}`);
    expect(byId[second.id].outstanding.map(item => item.title)).not.toContain(`QA admin policy ${run}`);
    expect(byId[first.id].signed.map(item => item.title).sort()).toEqual([`QA policy ${run}`, `QA vehicle agreement ${run}`]);
    expect(byId[inactive.id]).toBeUndefined();
    expect(byId[prospective.id]).toBeUndefined();
    expect(await onboarding.onboardingFor({ id: inactive.id, role: 'technician' })).toMatchObject({ enabled: true, documents: [], counts: { outstanding: 0, total: 0 } });
    await documents.setOnboardingRequired(adminOnly.id, false, admin);
    expect(titles(await onboarding.onboardingFor(admin))).not.toContain(`QA admin policy ${run}`);
  });

  test('vehicle agreement rule: none, open record only, completed, and not before the version took effect', async () => {
    expect(await onboarding.hasCompletedIssuedRecord(db, second.id, KEY)).toBe(false);
    expect(await onboarding.hasCompletedIssuedRecord(db, first.id, KEY)).toBe(true);
    expect(await onboarding.hasCompletedIssuedRecord(db, first.id, 'staff.no-such-form')).toBe(false);
    await documents.saveRecord(formV1.id, { content_hash: formV1.content_hash, owner_id: second.id, due_at: at(86400),
      answers: { 'signed-name': 'Draft' }, completed_steps: [], complete: false }, second);
    expect(await onboarding.hasCompletedIssuedRecord(db, second.id, KEY)).toBe(false);
  });

  test('a new issued version is outstanding again with no code, yet an older signature still counts for pay', async () => {
    const latest = await db('document_template_versions').where({ template_id: form.id }).orderBy('version_number', 'desc').first();
    const draft = await documents.saveDraft({ id: form.id, base_version_id: latest.id, source: source(`QA vehicle agreement ${run}`, [field]) }, admin);
    const before = await counts();
    const formV2 = await issue(form.id, draft.version.id, at(-5));
    expect((await counts()).records).toBe(before.records);
    const mine = await onboarding.onboardingFor(first);
    expect(mine.documents).toEqual([expect.objectContaining({ document_id: form.id, version_id: formV2.id, kind: 'form' })]);
    expect(mine.counts).toEqual({ outstanding: 1, total: 2 });
    // Completed on the older issued version: still counts.
    expect(await onboarding.hasCompletedIssuedRecord(db, first.id, KEY)).toBe(true);
    // Signing the new version clears the card.
    await sign(first, formV2);
    expect((await onboarding.onboardingFor(first)).documents).toEqual([]);
    // A scheduled (future) version is neither outstanding yet nor a way to count a signature early.
    const future = await documents.saveDraft({ id: form.id, base_version_id: draft.version.id, source: source(`QA vehicle agreement ${run}`, [field]) }, admin);
    const formV3 = await issue(form.id, future.version.id, at(3600));
    expect((await onboarding.onboardingFor(first)).documents).toEqual([]);
    expect(formV3.effective_at).toBeTruthy();
    // Evaluated a year ago, no version had taken effect, so no signature counted.
    expect(await onboarding.hasCompletedIssuedRecord(db, first.id, KEY, new Date(Date.now() - 86400000 * 365))).toBe(false);
  });

  test('gate off: empty answers and no reads; the agreement rule does not depend on the gate', async () => {
    process.env.GATE_STAFF_ONBOARDING_DOCS = 'false';
    try {
      expect(await onboarding.onboardingFor(first)).toEqual({ enabled: false, documents: [], counts: { outstanding: 0, total: 0 } });
      expect(await onboarding.onboardingForTeam()).toEqual({ enabled: false, technicians: [] });
      expect(await onboarding.hasCompletedIssuedRecord(db, first.id, KEY)).toBe(true);
    } finally { process.env.GATE_STAFF_ONBOARDING_DOCS = 'true'; }
  });
});
