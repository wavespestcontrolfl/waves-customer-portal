const db = require('../models/db');
const Joi = require('joi');
const { recordAuditEvent } = require('./audit-log');
const { sourceSchema, policySchema, validate, reject, hash, renderSource, checkRelease } = require('./staff-document-source');

const ACKNOWLEDGMENT = 'I have read this policy version and acknowledge receipt. I intend my typed name to serve as my electronic signature for this acknowledgment.';
const sourceOf = version => ({ title: version.title, body: version.body, metadata: version.staff_metadata });
const isAdmin = actor => actor.role === 'admin';

async function audit(trx, actor, action, resourceId, metadata = {}) {
  await recordAuditEvent({ actor_type: isAdmin(actor) ? 'admin' : 'technician', actor_id: actor.id,
    action: `staff_document.${action}`, resource_type: 'staff_document', resource_id: resourceId,
    metadata, critical: true, trx });
}

async function lockLibrary(trx) {
  // Shared with policy fan-out so no concurrent issuance misses a policy change.
  await trx.raw('SELECT pg_advisory_xact_lock(73108, 1)');
}

async function policyAt(conn, at) {
  return conn('policy_values').where('effective_at', '<=', at).orderBy('effective_at', 'desc').first();
}

async function loadDocument(conn, id, actor) {
  const document = await conn('document_templates').where({ id, audience: 'staff' }).first();
  if (!document || (!isAdmin(actor) && document.staff_access !== 'staff')) reject('Document not found', 404);
  return document;
}

async function activeOwner(conn, id) {
  if (!id || !await conn('technicians').where({ id, employment_status: 'active' }).first('id')) reject('Choose an active staff member as owner.');
}

async function insertVersion(trx, document, source, actor) {
  const row = await trx('document_template_versions').where({ template_id: document.id }).max('version_number as last').first();
  const [version] = await trx('document_template_versions').insert({
    template_id: document.id, version_number: Number(row.last || 0) + 1,
    title: source.title, body: source.body, staff_metadata: JSON.stringify(source.metadata), created_by: actor.id,
  }).returning('*');
  return version;
}

function previewOf(version, policy) {
  const rendered = renderSource(sourceOf(version), policy?.values);
  const policyId = rendered.used_variables.length ? policy?.id || null : null;
  return { rendered, preview_hash: hash({ version_id: version.id, policy_values_id: policyId, rendered }) };
}

async function preview(id, versionId, at, actor) {
  await loadDocument(db, id, actor);
  const version = await db('document_template_versions').where({ id: versionId, template_id: id }).first();
  if (!version) reject('Version not found', 404);
  if (version.published_at) reject('Issued versions already have immutable wording.', 409);
  return { ...previewOf(version, await policyAt(db, at)), effective_at: new Date(at).toISOString() };
}

async function issueVersion(trx, document, version, policy, at, actor) {
  const source = sourceOf(version);
  const rendered = renderSource(source, policy?.values);
  checkRelease(source, rendered, at);
  const snapshot = { ...rendered, kind: document.staff_kind,
    version_number: version.version_number, effective_at: new Date(at).toISOString(),
    policy_values: rendered.used_variables.length ? policy.values : null,
    acknowledgment_statement: document.staff_kind === 'policy' ? ACKNOWLEDGMENT : null };
  const [issued] = await trx('document_template_versions').where({ id: version.id }).whereNull('content_snapshot').update({
    content_snapshot: JSON.stringify(snapshot), content_hash: hash(snapshot), effective_at: at,
    published_at: trx.fn.now(), approved_by: actor.id, policy_values_id: rendered.used_variables.length ? policy.id : null,
  }).returning('*');
  if (!issued) reject('This version has already been issued.', 409);
  await trx('document_templates').where({ id: document.id }).update({ status: 'active', updated_at: trx.fn.now(), updated_by: actor.id });
  await audit(trx, actor, 'issued', document.id, { version_id: issued.id, hash: issued.content_hash, policy_values_id: issued.policy_values_id });
  return issued;
}

async function saveDraft(input, actor) {
  const source = validate(sourceSchema, input.source);
  renderSource(source, null);
  return db.transaction(async trx => {
    await lockLibrary(trx);
    let document;
    if (input.id) {
      document = await loadDocument(trx, input.id, actor);
      const latest = await trx('document_template_versions').where({ template_id: document.id }).orderBy('version_number', 'desc').first('id');
      if (latest.id !== input.base_version_id) reject('The document changed. Reload before saving.', 409);
    } else {
      if (!['policy', 'procedure', 'form'].includes(input.kind) || !['staff', 'admin'].includes(input.access)) reject('Choose a document type and access scope.');
      if (!/^[a-z][a-z0-9-]{2,79}$/.test(input.key || '')) reject('Use a stable lowercase document key.');
      if (input.legacy_company_document_id && !await trx('company_documents').where({ id: input.legacy_company_document_id, technician_id: null }).first('id')) reject('Company attachment not found.');
      [document] = await trx('document_templates').insert({
        template_key: `staff.${input.key}`, name: source.title, category: 'staff', document_type: input.kind,
        audience: 'staff', staff_kind: input.kind, staff_access: input.access, status: 'draft',
        requires_signature: input.kind === 'policy', created_by: actor.id, updated_by: actor.id,
        legacy_company_document_id: input.legacy_company_document_id || null,
      }).returning('*');
    }
    if (document.staff_kind !== 'form' && source.metadata.fields.length) reject('Record fields belong to forms. Procedures use clause checklists.');
    const version = await insertVersion(trx, document, source, actor);
    await audit(trx, actor, 'draft_created', document.id, { version_id: version.id });
    return { document, version };
  });
}

async function publish(id, versionId, at, previewHash, actor) {
  return db.transaction(async trx => {
    await lockLibrary(trx);
    const document = await loadDocument(trx, id, actor);
    const version = await trx('document_template_versions').where({ id: versionId, template_id: id }).first();
    if (!version) reject('Version not found', 404);
    if (version.content_snapshot) reject('Issued versions are immutable. Create a revision.', 409);
    const latest = await trx('document_template_versions').where({ template_id: id }).orderBy('version_number', 'desc').first('id');
    if (latest.id !== version.id) reject('Only the latest draft can be issued.', 409);
    const issued = await trx('document_template_versions').where({ template_id: id }).whereNotNull('published_at').orderBy('effective_at', 'desc').first();
    if (issued && new Date(at) <= new Date(issued.effective_at)) reject('Effective date must follow the previous issued version.', 409);
    // Future policy changes have already prepared a replacement. Do not insert
    // another version before them and silently make that replacement stale.
    const usesPolicy = renderSource(sourceOf(version), null).used_variables.length > 0;
    if (usesPolicy && await trx('policy_values').where('effective_at', '>', at).first('id')) reject('Choose an effective date on or after the scheduled policy revision.', 409);
    const policy = await policyAt(trx, at);
    if (previewOf(version, policy).preview_hash !== previewHash) reject('The wording changed since preview. Refresh the wording and review it again.', 409);
    return issueVersion(trx, document, version, policy, at, actor);
  });
}

async function updatePolicy(input, at, actor) {
  const values = validate(policySchema, input.values);
  if (values.paid_holidays.some(name => values.unpaid_holidays.includes(name))) reject('A holiday cannot be both paid and unpaid.');
  return db.transaction(async trx => {
    await lockLibrary(trx);
    const previous = await trx('policy_values').orderBy('revision', 'desc').first();
    if ((previous?.id || null) !== input.base_revision_id) reject('Policy values changed. Reload before issuing.', 409);
    if (previous && new Date(at) <= new Date(previous.effective_at)) reject('Effective date must follow the previous policy revision.');
    const [policy] = await trx('policy_values').insert({ revision: (previous?.revision || 0) + 1,
      values: JSON.stringify(values), effective_at: at, content_hash: hash(values), approved_by: actor.id }).returning('*');
    const documents = await trx('document_templates').where({ audience: 'staff' }).orderBy('id');
    const revised = [];
    for (const document of documents) {
      const issued = await trx('document_template_versions').where({ template_id: document.id }).whereNotNull('published_at').orderBy('effective_at', 'desc');
      const version = issued.find(item => new Date(item.effective_at) <= new Date(at));
      const scheduled = issued.filter(item => new Date(item.effective_at) >= new Date(at));
      // A scheduled unbound replacement must not hide the current bindings,
      // nor may an intervening bound version retain stale future values.
      if (![version, ...scheduled].some(item => item?.content_snapshot.used_variables.length)) continue;
      if (scheduled.length) reject(`Policy change must follow the scheduled version of ${document.name}.`, 409);
      const draft = await insertVersion(trx, document, sourceOf(version), actor);
      revised.push(await issueVersion(trx, document, draft, policy, at, actor));
    }
    await audit(trx, actor, 'policy_values_issued', policy.id, { previous_id: previous?.id || null, hash: policy.content_hash, versions: revised.map(v => v.id) });
    return { policy, revised_version_ids: revised.map(v => v.id) };
  });
}

async function list(actor, { at = new Date(), search = '', asOf = false } = {}) {
  if (!isAdmin(actor) && new Date(at) > new Date()) at = new Date();
  const documents = await db('document_templates').where({ audience: 'staff' }).modify(q => {
    if (!isAdmin(actor)) q.where('staff_access', 'staff');
  }).orderBy('name');
  if (!documents.length) return [];
  const versions = await db('document_template_versions').whereIn('template_id', documents.map(document => document.id))
    .distinctOn('template_id').orderBy('template_id').modify(q => {
      if (!isAdmin(actor) || asOf) q.whereNotNull('published_at').where('effective_at', '<=', at).orderBy('effective_at', 'desc');
    }).orderBy('version_number', 'desc');
  const byTemplate = new Map(versions.map(version => [version.template_id, version]));
  const result = [];
  for (const document of documents) {
    const version = byTemplate.get(document.id);
    if (!version) continue;
    const title = version.content_snapshot?.title || version.title;
    if (search && !`${title} ${version.content_snapshot?.body || version.body}`.toLowerCase().includes(search.toLowerCase())) continue;
    result.push({ ...document, version_id: version.id, title, version_number: version.version_number,
      effective_at: version.effective_at, review_on: version.staff_metadata.review_on, owner_role: version.staff_metadata.owner_role,
      issued: !!version.published_at });
  }
  return result;
}

async function detail(id, actor, versionId = null, at = null) {
  const document = await loadDocument(db, id, actor);
  const versions = await db('document_template_versions').where({ template_id: id }).modify(q => {
    if (!isAdmin(actor)) q.whereNotNull('published_at').where('effective_at', '<=', new Date());
  }).orderBy('version_number', 'desc');
  const inForceAt = at || new Date();
  const version = versionId ? versions.find(v => v.id === versionId) : versions.find(v => v.effective_at && new Date(v.effective_at) <= new Date(inForceAt)) || (isAdmin(actor) && !at ? versions[0] : null);
  if (!version) reject('Version not found', 404);
  const policy = await policyAt(db, version.effective_at || new Date());
  const rendered = version.content_snapshot || renderSource(sourceOf(version), policy?.values);
  const acknowledgments = await db('staff_document_acknowledgments').where({ version_id: version.id }).modify(q => { if (!isAdmin(actor)) q.where('technician_id', actor.id); });
  const records = await db('staff_document_records').where({ version_id: version.id }).modify(q => { if (!isAdmin(actor)) q.where('owner_id', actor.id); }).orderBy('created_at', 'desc');
  const currentVersion = versions.find(v => v.published_at && new Date(v.effective_at) <= new Date());
  return { document, version, rendered, current_version_id: currentVersion?.id || null,
    versions: versions.map(v => ({ id: v.id, number: v.version_number, effective_at: v.effective_at, hash: v.content_hash, issued: !!v.published_at })), acknowledgments, records };
}

async function recordableVersion(trx, id, actor, kind) {
  await lockLibrary(trx);
  const now = new Date();
  const version = await trx('document_template_versions').where({ id }).whereNotNull('published_at').where('effective_at', '<=', now).first();
  if (!version) reject('Version not found', 404);
  const document = await loadDocument(trx, version.template_id, actor);
  const current = await trx('document_template_versions').where({ template_id: version.template_id })
    .whereNotNull('published_at').where('effective_at', '<=', now).orderBy('effective_at', 'desc').first('id');
  if (current.id !== version.id) reject('This version has been superseded. Open the current version to sign or record work.', 409);
  if (kind === 'acknowledgment' && document.staff_kind !== 'policy') reject('Only policies require acknowledgment.');
  if (kind === 'record' && document.staff_kind === 'policy') reject('Policies use acknowledgments.');
  return version;
}

async function acknowledge(versionId, input, actor) {
  if (input.accepted !== true || typeof input.signed_name !== 'string' || !input.signed_name.trim() || input.signed_name.length > 180) reject('Enter your name and confirm the acknowledgment.');
  return db.transaction(async trx => {
    const version = await recordableVersion(trx, versionId, actor, 'acknowledgment');
    if (input.content_hash !== version.content_hash) reject('The displayed hash does not match this version.', 409);
    const [row] = await trx('staff_document_acknowledgments').insert({ version_id: version.id, technician_id: actor.id,
      content_hash: version.content_hash, signed_name: input.signed_name.trim(), statement: version.content_snapshot.acknowledgment_statement,
    }).onConflict(['version_id', 'technician_id']).ignore().returning('*');
    if (row) await audit(trx, actor, 'acknowledged', version.template_id, { acknowledgment_id: row.id, version_id: version.id, hash: version.content_hash });
    return row || trx('staff_document_acknowledgments').where({ version_id: version.id, technician_id: actor.id }).first();
  });
}

function recordAnswers(version, input) {
  const fields = version.staff_metadata.fields;
  const types = { text: Joi.string().max(8000).allow(''), textarea: Joi.string().max(8000).allow(''),
    date: Joi.string().isoDate().pattern(/^\d{4}-\d{2}-\d{2}$/).allow(''), checkbox: Joi.boolean() };
  const shape = {};
  for (const field of fields) {
    let rule = types[field.type].label(field.label);
    if (input.complete && field.required) rule = field.type === 'checkbox' ? rule.valid(true).required() : rule.invalid('').trim().required();
    shape[field.id] = rule;
  }
  const answers = validate(Joi.object(shape).required(), input.answers);
  const ids = version.content_snapshot.sections.map(section => section.id);
  const steps = validate(Joi.array().items(Joi.string().valid(...ids)).unique().required(), input.completed_steps);
  if (input.complete && version.content_snapshot.kind === 'procedure' && steps.length !== ids.length) reject('Complete every procedure step.');
  return { answers: JSON.stringify(answers), completed_steps: JSON.stringify(steps) };
}

async function saveRecord(versionId, input, actor) {
  return db.transaction(async trx => {
    const version = await recordableVersion(trx, versionId, actor, 'record');
    if (input.content_hash !== version.content_hash) reject('The displayed hash does not match this version.', 409);
    await activeOwner(trx, input.owner_id);
    if (!isAdmin(actor) && input.owner_id !== actor.id) reject('Only an admin may assign a record to another staff member.', 403);
    if (input.complete && input.owner_id !== actor.id) reject('Only the assigned owner may complete this record.', 403);
    const values = { ...recordAnswers(version, input), owner_id: input.owner_id, due_at: input.due_at,
      updated_at: trx.fn.now(), completed_at: input.complete ? trx.fn.now() : null };
    let row;
    if (input.id) {
      const existing = await trx('staff_document_records').where({ id: input.id, version_id: versionId }).forUpdate().first();
      if (!existing || (!isAdmin(actor) && existing.owner_id !== actor.id)) reject('Record not found', 404);
      if (existing.completed_at) reject('Completed records are immutable.', 409);
      if (new Date(existing.updated_at).toISOString() !== input.base_updated_at) reject('Record changed. Reload before saving.', 409);
      [row] = await trx('staff_document_records').where({ id: existing.id }).update(values).returning('*');
    } else {
      [row] = await trx('staff_document_records').insert({ ...values, version_id: versionId, content_hash: version.content_hash, created_by: actor.id }).returning('*');
    }
    await audit(trx, actor, input.complete ? 'record_completed' : 'record_saved', version.template_id, { record_id: row.id, version_id: version.id, owner_id: row.owner_id, due_at: row.due_at });
    return row;
  });
}

module.exports = { saveDraft, preview, publish, updatePolicy, list, detail, acknowledge, saveRecord, recordAnswers, ACKNOWLEDGMENT };
