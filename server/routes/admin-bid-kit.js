const express = require('express');
const Joi = require('joi');
const multer = require('multer');
const logger = require('../services/logger');
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const { bidKitLive } = require('../config/feature-gates');
const store = require('../services/bid-kit-store');
const files = require('../services/bid-kit-files');
const expiry = require('../services/bid-kit-expiry');
const catalog = require('../../shared/bid-kit-catalog.cjs');
const { validCalendarDate } = require('../utils/datetime-et');

// Bid kit (GATE_BID_KIT, dark). Staff-only. The papers and facts every government bid asks for, each with its private
// file, limits, source, dates and the owner's sign-off. Nothing here is public and nothing is sent to anyone.
// A file is never returned as a key or a stored address: only GET /:id/file, a signed link good for 5 minutes.
const router = express.Router();
router.use(adminAuthenticate, requireAdmin);
// Gate off = the whole surface answers 404, exactly as if it were not mounted.
router.use((req, res, next) => (bidKitLive() ? next() : res.status(404).json({ error: 'Not found' })));
// Private records: nothing is cached by the browser or a proxy.
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Any /:id that is not a UUID is a 404 before a handler (or an upload) runs.
router.param('id', (req, res, next, id) => (UUID.test(id) ? next() : res.status(404).json({ error: 'Not found' })));
const CHANGED = 'This item changed since you opened it. Reload and check it again.';
const TAX_ID_REFUSED = catalog.TAX_ID_REFUSED;

const text = (max) => Joi.string().trim().max(max).allow('', null);
const day = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).allow('', null);
const dollars = Joi.number().strict().integer().min(0).max(catalog.MAX_LIMIT_DOLLARS).allow(null);

const limitsSchema = Joi.object({
  ...Object.fromEntries(catalog.LIMIT_DOLLAR_KEYS.map((key) => [key, dollars])),
  workersComp: Joi.string().valid(...catalog.WORKERS_COMP_VALUES).allow(null),
}).unknown(false).allow(null);

const detailsSchema = Joi.object({
  entity: text(200), contactRole: text(120), phone: text(40), email: text(200), contractPeriod: text(120), scope: text(1000),
  annualValue: Joi.alternatives(text(40), Joi.number().strict().min(0).max(catalog.MAX_LIMIT_DOLLARS)),
  publicOrPrivate: Joi.string().valid(...catalog.PUBLIC_OR_PRIVATE, '').allow(null),
}).unknown(false).allow(null);

const fields = {
  label: Joi.string().trim().min(1).max(200),
  value: text(2000),
  limits: limitsSchema,
  details: detailsSchema,
  source_document: text(500),
  checked_on: day,
  expires_on: day,
  permission_on: day,
  notes: text(4000),
};
const createSchema = Joi.object({
  kind: Joi.string().valid(...catalog.KINDS).required(),
  item_key: Joi.string().trim().max(48).required(),
  ...fields,
}).unknown(false);
const patchSchema = Joi.object({ expected_updated_at: Joi.string().isoDate().required(), ...fields }).unknown(false);
const attestSchema = Joi.object({ expected_updated_at: Joi.string().isoDate().required() }).unknown(false);

const badRequest = (res, error) => res.status(400).json({ error: `Invalid ${error.details[0].path.join('.') || 'request'}` });

// Empty strings become null; an empty limits or details object is no limits or details.
function cleanObject(value) {
  if (value == null) return null;
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === null || entry === '' || entry === undefined) continue;
    out[key] = typeof entry === 'string' ? entry.trim() : entry;
  }
  return Object.keys(out).length ? out : null;
}

// The column values a request carries, or the refusal. Dates are real calendar days; no field may hold a tax ID.
function toColumns(body, kind) {
  const out = {};
  for (const key of ['label', 'value', 'source_document', 'notes']) {
    if (body[key] === undefined) continue;
    out[key] = body[key] === null || body[key] === '' ? null : body[key].trim();
  }
  if (out.label === null) return { refused: 'label is required' };
  for (const key of ['checked_on', 'expires_on', 'permission_on']) {
    if (body[key] === undefined) continue;
    if (body[key] === null || body[key] === '') { out[key] = null; continue; }
    if (!validCalendarDate(body[key])) return { refused: `${key} is not a real date` };
    out[key] = body[key];
  }
  if (body.limits !== undefined) out.limits = cleanObject(body.limits);
  if (body.details !== undefined) {
    if (body.details !== null && kind !== 'reference') return { refused: 'details belong to references only' };
    out.details = cleanObject(body.details);
  }
  if (catalog.containsTaxId([out.label, out.value, out.source_document, out.notes, out.details])) return { refused: TAX_ID_REFUSED };
  return { columns: out };
}

// jsonb columns go in as text so pg never reads a plain object as an array.
const forWrite = (columns) => {
  const out = { ...columns };
  if ('limits' in out) out.limits = out.limits === null ? null : JSON.stringify(out.limits);
  if ('details' in out) out.details = out.details === null ? null : JSON.stringify(out.details);
  return out;
};

// What the page sees: the row without any file key, the file's name and size, and the computed status.
function present(row, today) {
  const { has_file: hasFile, ...rest } = row;
  return {
    ...rest,
    file: hasFile ? { name: row.file_name, contentType: row.file_content_type, size: row.file_size } : null,
    status: catalog.itemStatus(row, { today }),
  };
}
// The row as the status rule reads it (a file counts as there).
const statusRow = (row) => ({ ...row, has_file: row.has_file === true });

const sameInstant = (a, b) => new Date(a).getTime() === new Date(b).getTime();

async function activity(req, action, row, changed) {
  await store.logActivity(req.technicianId, action,
    `${row.label} (${row.item_key}) ${action.replace('bid_kit_', '').replace('_', ' ')}${changed && changed.length ? `: ${changed.join(', ')}` : ''}`,
    { bid_kit_item_id: row.id, item_key: row.item_key, ...(changed && changed.length ? { fields: changed } : {}) });
}

router.get('/', async (req, res, next) => {
  try {
    const today = catalog.etToday();
    const rows = await store.listItems({ all: req.query.all === '1' });
    const live = rows.filter((row) => !row.archived_at).map(statusRow);
    res.json({
      today,
      catalog: catalog.catalogSections(),
      items: rows.map((row) => present(statusRow(row), today)),
      summary: catalog.summarize(catalog.buildChecklist(live, { today })),
    });
  } catch (err) {
    next(err);
  }
});

// What the owner copies from while filling an agency form by hand: fact values, and the numbers and expiry dates of the
// papers. Archived rows are left out. No file, no file key and no link is ever part of it.
router.get('/facts-sheet', async (req, res, next) => {
  try {
    const today = catalog.etToday();
    const rows = (await store.listItems()).map(statusRow);
    const status = (row) => catalog.itemStatus(row, { today });
    const factOrder = catalog.ITEMS.filter((item) => item.kind === 'fact');
    const factRows = (item) => rows.filter((row) => row.kind === 'fact' && row.item_key === item.key);
    const toFact = (row, item) => ({ key: item.key, label: row.label || item.label, value: row.value || null, status: status(row), signedOff: !!row.attested_at, checkedOn: row.checked_on || null });
    const facts = [
      ...factOrder.flatMap((item) => (factRows(item).length ? factRows(item).map((row) => toFact(row, item)) : [{ key: item.key, label: item.label, value: null, status: catalog.STATUS.MISSING, signedOff: false, checkedOn: null }])),
      ...rows.filter((row) => row.kind === 'fact' && row.item_key === catalog.CUSTOM_KEY).map((row) => toFact(row, { key: catalog.CUSTOM_KEY, label: row.label })),
    ];
    const documents = rows
      .filter((row) => row.kind === 'document' && (row.value || row.expires_on))
      .map((row) => ({
        key: row.item_key,
        label: row.label,
        number: row.value || null,
        expiresOn: row.expires_on || null,
        status: status(row),
        signedOff: !!row.attested_at,
      }));
    res.json({ today, facts, documents });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { error, value } = createSchema.validate(req.body || {});
    if (error) return badRequest(res, error);
    const isCustom = value.item_key === catalog.CUSTOM_KEY;
    const item = catalog.catalogItem(value.item_key);
    if (!isCustom && (!item || item.kind !== value.kind)) return res.status(400).json({ error: 'Invalid item_key' });
    if (isCustom && !value.label) return res.status(400).json({ error: 'A custom item needs a label' });
    const built = toColumns({ ...value, label: value.label || item.label }, value.kind);
    if (built.refused) return res.status(400).json({ error: built.refused });
    const outcome = await store.createItem(
      { kind: value.kind, item_key: value.item_key, ...forWrite(built.columns) },
      { unique: !isCustom && !item.many },
    );
    if (outcome.duplicate) return res.status(409).json({ error: 'This item already exists. Edit it instead.' });
    await activity(req, 'bid_kit_created', outcome.item);
    return res.status(201).json({ item: present(statusRow(outcome.item), catalog.etToday()) });
  } catch (err) {
    return next(err);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const { error, value } = patchSchema.validate(req.body || {});
    if (error) return badRequest(res, error);
    const { expected_updated_at: expected, ...rest } = value;
    if (!Object.keys(rest).length) return res.status(400).json({ error: 'Nothing to change' });
    const outcome = await store.updateItem(req.params.id, (row) => {
      if (!sameInstant(row.updated_at, expected)) return { error: { status: 409, message: CHANGED } };
      const built = toColumns(rest, row.kind);
      if (built.refused) return { error: { status: 400, message: built.refused } };
      const columns = built.columns;
      // A change to anything the sign-off covered clears the sign-off in this same update.
      const patch = { ...forWrite(columns) };
      if (catalog.changesSubstance(row, columns)) { patch.attested_by = null; patch.attested_at = null; }
      return { patch };
    });
    if (outcome.notFound) return res.status(404).json({ error: 'Not found' });
    if (outcome.error) return res.status(outcome.error.status).json({ error: outcome.error.message });
    await activity(req, 'bid_kit_updated', outcome.item, Object.keys(rest));
    await expiry.syncExpiryBell(statusRow(outcome.item));
    return res.json({ item: present(statusRow(outcome.item), catalog.etToday()) });
  } catch (err) {
    return next(err);
  }
});

// The owner's sign-off on the version they looked at. Refused (400) while the item is missing, expired or has no expiry date.
router.post('/:id/attest', async (req, res, next) => {
  try {
    const { error, value } = attestSchema.validate(req.body || {});
    if (error) return badRequest(res, error);
    const today = catalog.etToday();
    const outcome = await store.updateItem(req.params.id, (row) => {
      if (!sameInstant(row.updated_at, value.expected_updated_at)) return { error: { status: 409, message: CHANGED } };
      const status = catalog.itemStatus(statusRow(row), { today });
      if (catalog.SIGN_OFF_REFUSAL[status]) return { error: { status: 400, message: catalog.SIGN_OFF_REFUSAL[status] } };
      return { patch: { attested_by: req.technicianId, attested_at: new Date() } };
    });
    if (outcome.notFound) return res.status(404).json({ error: 'Not found' });
    if (outcome.error) return res.status(outcome.error.status).json({ error: outcome.error.message });
    await activity(req, 'bid_kit_attested', outcome.item);
    return res.json({ item: present(statusRow(outcome.item), today) });
  } catch (err) {
    return next(err);
  }
});

// multer stops reading one byte past the cap; the exact 15 MB rule is files.validateFile's (a file of exactly 15 MB passes).
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: files.MAX_FILE_BYTES + 1, files: 1 } });
function receiveFile(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'The file is larger than 15 MB' });
    if (err.code === 'LIMIT_UNEXPECTED_FILE' || err.code === 'LIMIT_FILE_COUNT') return res.status(400).json({ error: 'Send one file in the "file" field' });
    return next(err);
  });
}

router.post('/:id/file', receiveFile, async (req, res, next) => {
  let stored = null;
  try {
    if (!req.file) return res.status(400).json({ error: 'No file was sent' });
    // A file replaces what the page showed, so it is fenced on the version the page loaded, like a save or a sign-off.
    const { error, value } = attestSchema.validate({ expected_updated_at: req.body?.expected_updated_at });
    if (error) return badRequest(res, error);
    const existing = await store.getItem(req.params.id);
    if (!existing || existing.archived_at) return res.status(404).json({ error: 'Not found' });
    // The cheap check first (nothing is stored for a stale page); the same fence runs again under the row lock.
    if (!sameInstant(existing.updated_at, value.expected_updated_at)) return res.status(409).json({ error: CHANGED });
    stored = await files.putFile(req.params.id, req.file);
    const outcome = await store.replaceFile(req.params.id, stored, value.expected_updated_at);
    if (outcome.notFound || outcome.conflict) {
      await files.deleteFile(stored.key);
      return outcome.conflict ? res.status(409).json({ error: CHANGED }) : res.status(404).json({ error: 'Not found' });
    }
    // The row now points at the new file; the old private object has nothing pointing at it.
    if (outcome.oldKey) await files.deleteFile(outcome.oldKey);
    await activity(req, 'bid_kit_file_uploaded', outcome.item, ['file']);
    await expiry.syncExpiryBell(statusRow(outcome.item));
    return res.json({ item: present(statusRow(outcome.item), catalog.etToday()) });
  } catch (err) {
    if (stored) await files.deleteFile(stored.key);
    if (err instanceof files.FileError) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
});

router.get('/:id/file', async (req, res, next) => {
  try {
    const info = await store.fileInfo(req.params.id);
    if (!info || !info.key) return res.status(404).json({ error: 'Not found' });
    const url = await files.signedUrl(info);
    return res.json({ url, file_name: info.fileName, expires_in: files.SIGNED_URL_SECONDS });
  } catch (err) {
    if (err instanceof files.FileError) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    // An archive is fenced like every other write: it needs the version the page loaded (query or JSON body), and a row that
    // changed since is a 409 with nothing archived and no bell closed.
    const { error, value } = attestSchema.validate({ expected_updated_at: req.query.expected_updated_at ?? req.body?.expected_updated_at });
    if (error) return badRequest(res, error);
    const outcome = await store.archiveItem(req.params.id, value.expected_updated_at);
    if (outcome.notFound) return res.status(404).json({ error: 'Not found' });
    if (outcome.conflict) return res.status(409).json({ error: CHANGED });
    const row = outcome.item;
    await activity(req, 'bid_kit_archived', row);
    await expiry.syncExpiryBell(statusRow(row));
    logger.info(`[bid-kit] item archived (${row.item_key})`);
    return res.json({ success: true, item: present(statusRow(row), catalog.etToday()) });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
