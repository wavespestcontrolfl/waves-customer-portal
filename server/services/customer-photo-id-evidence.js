const db = require('../models/db');
const PhotoService = require('./photos');
const logger = require('./logger');
const { applyPropertyPredicate } = require('./account-properties');

const PHOTO_ID_TABLES = {
  pest: { table: 'pest_identifications', photos: 'pest_identification_photos', fk: 'identification_id', order: 'photo_index' },
  lawn: { table: 'lawn_diagnostics', photos: 'lawn_diagnostic_photos', fk: 'diagnostic_id', order: 'photo_index' },
  tree_shrub: { table: 'tree_shrub_assessments', photos: 'tree_shrub_assessment_photos', fk: 'assessment_id', order: 'photo_order' },
};

// Callers must establish ownership and property scope before reading photos.
async function customerPhotoRows(type, id) {
  const config = PHOTO_ID_TABLES[type];
  return db(config.photos).where({ [config.fk]: id, customer_visible: true })
    .orderBy(config.order, 'asc').select('id', 's3_key', 'mime_type');
}

async function customerPhotoViews(type, id) {
  const rows = await customerPhotoRows(type, id);
  return Promise.all(rows.map(async (photo) => ({
    id: photo.id,
    mime_type: photo.mime_type,
    url: photo.s3_key
      ? await PhotoService.getViewUrl(photo.s3_key, PhotoService.CUSTOMER_DWELL_TTL_SECONDS).catch(() => {
        logger.warn(`[photo-id] preview signing failed for photo ${photo.id}`);
        return null;
      })
      : null,
  })));
}

// A source reference never grants access on its own. Recheck the active
// customer's property selection on the request write, not just the prior read.
async function requestPhotoIdEvidence(req, source, scope) {
  const config = PHOTO_ID_TABLES[source.type];
  const query = db(config.table).where({ id: source.id, customer_id: req.customer.id, mode: 'customer' });
  applyPropertyPredicate(query, scope, config.table);
  const row = await query.first('id');
  if (!row) return { status: 404, error: 'Photo ID not found.' };
  const rows = await customerPhotoRows(source.type, source.id);
  const selected = source.photoIds.map((id) => rows.find((photo) => photo.id === id));
  if (selected.some((photo) => !photo || !photo.s3_key)) {
    return { status: 409, error: 'A saved photo is unavailable. Reopen your Photo ID or attach a new photo.' };
  }
  try {
    const photos = await Promise.all(selected.map(async (photo) => {
      const { data, mimeType } = await PhotoService.getPhotoBase64(photo.s3_key);
      return `data:${mimeType};base64,${data}`;
    }));
    return { photos };
  } catch {
    logger.warn(`[photo-id] saved photo read failed for submission ${source.id}`);
    return { status: 503, error: 'We could not load your saved photos. Please try again.' };
  }
}

module.exports = { customerPhotoViews, requestPhotoIdEvidence };
