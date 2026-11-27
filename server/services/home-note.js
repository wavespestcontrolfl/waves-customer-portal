/**
 * "About this home": ONE short lasting staff note per customer (owner 2026-11-26), read at the top of every visit on the
 * technician's Visit Brief and written by any technician assigned to a visit for that customer, or an admin.
 *
 * Staff-only free text. This file is the ONLY reader and writer of home_notes (a customer merge joins two notes in
 * customer-dedupe.js): the note never goes into a customer payload, a report, a token page, an email, a text or a model
 * call, and its body is never logged or audited (the audit row records who changed it, not what it says).
 * home-note-isolation.test.js keeps the table out of every other file.
 *
 * Keyed by customer alone, like property_preferences: a customer with several homes shares one note.
 *
 * Stale guard: a save carries the revision the editor last saw (`expectedRevision`, 0 or null = "no note yet"). When the
 * stored row differs, nothing is written and the answer is 409 with the current note, so two phones never overwrite
 * each other unseen.
 */
const db = require('../models/db');
const { recordAuditEvent } = require('./audit-log');

const MAX_LENGTH = 1000;

const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || null;

async function shapeNote(row, conn) {
  if (!row) return null;
  let name = null;
  if (row.updated_by_id) {
    const tech = await conn('technicians').where({ id: row.updated_by_id }).first('name');
    name = firstName(tech && tech.name);
  }
  return {
    body: row.body, revision: row.revision, updatedAt: new Date(row.updated_at).toISOString(), updatedByFirstName: name,
  };
}

const currentRow = (conn, customerId, { lock = false } = {}) => {
  const q = conn('home_notes').where('home_notes.customer_id', customerId);
  if (lock) q.forUpdate();
  return q.first('home_notes.*');
};

// { status: 200, note, editable }: `row` is a visit row or { customer_id }; no customer = nothing to hang a note on.
async function readHomeNote(row, { conn = db } = {}) {
  const customerId = row && row.customer_id;
  if (!customerId) return { status: 200, note: null, editable: false };
  return { status: 200, note: await shapeNote(await currentRow(conn, customerId), conn), editable: true, customerId };
}

// A database error can carry the bound values (the note's text) in its message; only the operation and the code go on.
const sanitized = (err) => Object.assign(new Error(`home note save failed (${(err && err.code) || 'unknown'})`), { code: 'home_note_save_failed' });

const refusal = (status, error, extra = {}) => ({ status, error, ...extra });

async function writeRow(trx, customerId, current, body, actor) {
  const stamp = {
    body, updated_by_type: actor.type, updated_by_id: actor.id || null, updated_at: new Date(),
  };
  if (current) {
    await trx('home_notes').where({ id: current.id }).update({ ...stamp, revision: trx.raw('revision + 1') });
    return current.id;
  }
  const [inserted] = await trx('home_notes').insert({ customer_id: customerId, ...stamp }).returning('id');
  return inserted.id || inserted;
}

/**
 * Save (or, with an empty body, delete) the customer's note. `actor` = { type: 'technician' | 'admin', id, ip, userAgent }.
 * Returns { status: 200, note } | { status: 400 | 409 | 422, error, note? }. Never throws for those refusals.
 */
async function saveHomeNote(row, { body, expectedRevision = null, expectedCustomerId = null, actor }, { conn = db } = {}) {
  const text = typeof body === 'string' ? body.trim() : null;
  if (text === null) return refusal(400, 'The note must be text.');
  if (text.length > MAX_LENGTH) return refusal(400, `The note can be at most ${MAX_LENGTH} characters.`, { code: 'too_long' });
  const customerId = row && row.customer_id;
  if (!customerId) return refusal(422, 'This visit has no customer, so there is no note to keep.');
  // The editor was opened for one customer's note; a merge or undo can move the visit to another while it stays open, and
  // two empty notes would otherwise look "unchanged" to the time check.
  if (String(expectedCustomerId || '') !== String(customerId)) {
    return refusal(409, 'This visit now belongs to another customer. Reload it.', { code: 'customer_changed' });
  }
  const changed = async (current, handle = conn) => refusal(409, 'Someone else changed this note.', { code: 'note_changed', note: await shapeNote(current, handle) });
  const run = async (trx) => {
    // A merged-away (archived) customer takes no note: the lock also holds a merge off until this save commits.
    const live = await trx('customers').where({ id: customerId }).whereNull('deleted_at').forShare().first('id');
    if (!live) return refusal(404, 'Customer not found');
    const current = await currentRow(trx, customerId, { lock: true });
    // 0 or null = the editor saw no note; anything else must be the stored revision.
    if ((current ? current.revision : 0) !== (expectedRevision || 0)) return changed(current, trx);
    if (!text && !current) return { status: 200, note: null };
    let noteId = current && current.id;
    if (!text) await trx('home_notes').where({ id: current.id }).del();
    else noteId = await writeRow(trx, customerId, current, text, actor);
    // Who and what kind of change only: the body never goes to the audit log.
    await recordAuditEvent({
      trx,
      critical: true,
      actor_type: actor.type,
      actor_id: actor.id || null,
      action: text ? (current ? 'home_note.update' : 'home_note.create') : 'home_note.delete',
      resource_type: 'home_notes',
      resource_id: noteId,
      metadata: { customer_id: customerId, length: text.length },
      ip_address: actor.ip || null,
      user_agent: actor.userAgent || null,
    });
    return { status: 200, note: text ? await shapeNote(await currentRow(trx, customerId), trx) : null };
  };
  try {
    // A nested call (the route holds the visit row locked in its own transaction) runs in a savepoint.
    return await conn.transaction(run);
  } catch (err) {
    // Two first saves for a new customer race on the unique key: the loser sees the winner's note.
    if (!(err && err.code === '23505')) throw sanitized(err);
    return changed(await currentRow(conn, customerId));
  }
}

// The PUT body as the service takes it: only a string body and a string time are passed on.
const saveInput = (req) => {
  const b = req.body || {};
  return {
    body: b.body,
    expectedRevision: Number.isInteger(b.expectedRevision) ? b.expectedRevision : null,
    expectedCustomerId: typeof b.expectedCustomerId === 'string' ? b.expectedCustomerId : null,
  };
};

// Who is saving: the staff login and its role (an admin's own login is a technicians row too).
const homeNoteActor = (req) => ({
  type: req.techRole === 'admin' ? 'admin' : 'technician',
  id: req.technicianId || null,
  ip: req.ip,
  userAgent: req.get('user-agent') || null,
});

const sendHomeNote = (res, out) => {
  const { status, ...rest } = out;
  return res.status(status).json(rest);
};

// Saving is a staff write: one bucket per login (rate-limit-key.js), like the other staff note writes.
const homeNoteLimiter = require('express-rate-limit')({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: require('../middleware/rate-limit-key').rateLimitKey,
  message: { error: 'Too many note saves. Wait a few minutes.' },
});

module.exports = {
  MAX_LENGTH, readHomeNote, saveHomeNote, saveInput, homeNoteActor, sendHomeNote, homeNoteLimiter,
};
