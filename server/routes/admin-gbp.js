const express = require('express');
const router = express.Router();
const db = require('../models/db');
const gbpService = require('../services/google-business');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const { WAVES_LOCATIONS } = require('../config/locations');
const logger = require('../services/logger');

router.use(adminAuthenticate, requireTechOrAdmin);

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || '';

// Places API (New) field mask for full location details
const PLACES_FIELD_MASK = [
  'displayName', 'formattedAddress', 'nationalPhoneNumber',
  'internationalPhoneNumber', 'websiteUri', 'regularOpeningHours',
  'currentOpeningHours', 'businessStatus', 'primaryType', 'types',
  'googleMapsUri', 'photos', 'reviews', 'rating', 'userRatingCount',
].join(',');

// =========================================================================
// Helper: serialize value for comparison / storage
// =========================================================================
function serialize(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === 'object') return JSON.stringify(val);
  return String(val);
}

// =========================================================================
// Helper: map Places API response to our column schema
// =========================================================================
function mapPlacesData(place) {
  // Parse regular hours from Places API format
  let regularHours = null;
  if (place.regularOpeningHours?.periods) {
    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    regularHours = {};
    for (const period of place.regularOpeningHours.periods) {
      const dayName = dayNames[period.open?.day] || 'unknown';
      regularHours[dayName] = {
        open: period.open ? `${String(period.open.hour).padStart(2, '0')}:${String(period.open.minute || 0).padStart(2, '0')}` : null,
        close: period.close ? `${String(period.close.hour).padStart(2, '0')}:${String(period.close.minute || 0).padStart(2, '0')}` : null,
      };
    }
  }

  // Map photo references
  const photos = (place.photos || []).map(p => ({
    name: p.name,
    widthPx: p.widthPx,
    heightPx: p.heightPx,
    authorAttributions: p.authorAttributions,
  }));

  return {
    business_name: place.displayName?.text || place.displayName || null,
    address: place.formattedAddress || null,
    phone: place.nationalPhoneNumber || null,
    website_url: place.websiteUri || null,
    primary_category: place.primaryType || null,
    additional_categories: (place.types || []).filter(t => t !== place.primaryType),
    regular_hours: regularHours,
    photos,
  };
}

// =========================================================================
// Helper: diff two records, return array of { field, oldVal, newVal }
// =========================================================================
const DIFFABLE_FIELDS = [
  'business_name', 'description', 'address', 'phone', 'website_url',
  'primary_category', 'additional_categories', 'regular_hours',
  'additional_phones', 'special_hours', 'services', 'attributes',
  'service_areas', 'hide_address', 'photos',
];

function diffRecords(stored, incoming) {
  const changes = [];
  for (const field of DIFFABLE_FIELDS) {
    if (!(field in incoming) || incoming[field] === undefined) continue;
    const oldVal = serialize(stored?.[field]);
    const newVal = serialize(incoming[field]);
    if (oldVal !== newVal) {
      changes.push({ field, oldVal, newVal });
    }
  }
  return changes;
}

// =========================================================================
// GET /locations — list all managed locations
// =========================================================================
router.get('/locations', async (req, res, next) => {
  try {
    const stored = await db('gbp_locations').select('*');
    const storedMap = {};
    for (const row of stored) storedMap[row.location_id] = row;

    const locations = WAVES_LOCATIONS.map(loc => ({
      ...loc,
      gbp: storedMap[loc.id] || null,
      hasCredentials: !!gbpService._getClient(loc.id),
    }));

    // Get pending update counts per location
    const pendingCounts = await db('gbp_updates')
      .where({ status: 'pending' })
      .select('location_id')
      .count('* as count')
      .groupBy('location_id');
    const pendingMap = {};
    for (const row of pendingCounts) pendingMap[row.location_id] = parseInt(row.count);

    for (const loc of locations) {
      loc.pendingUpdates = pendingMap[loc.id] || 0;
    }

    res.json({ locations });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// GET /locations/:id — single location details
// =========================================================================
router.get('/locations/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const configLoc = WAVES_LOCATIONS.find(l => l.id === id);
    if (!configLoc) return res.status(404).json({ error: 'Location not found' });

    const gbp = await db('gbp_locations').where({ location_id: id }).first();
    const recentUpdates = await db('gbp_updates')
      .where({ location_id: id })
      .orderBy('detected_at', 'desc')
      .limit(50);

    res.json({
      config: configLoc,
      gbp: gbp || null,
      recentUpdates,
      hasCredentials: !!gbpService._getClient(id),
    });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// POST /locations/:id/sync — pull from Google, diff, create update records
// =========================================================================
router.post('/locations/:id/sync', async (req, res, next) => {
  try {
    const { id } = req.params;
    const configLoc = WAVES_LOCATIONS.find(l => l.id === id);
    if (!configLoc) return res.status(404).json({ error: 'Location not found' });
    if (!configLoc.googlePlaceId) return res.status(400).json({ error: 'No Google Place ID configured for this location' });
    if (!GOOGLE_MAPS_API_KEY) return res.status(500).json({ error: 'GOOGLE_MAPS_API_KEY not configured' });

    // Fetch from Google Places API (New)
    const url = `https://places.googleapis.com/v1/places/${configLoc.googlePlaceId}`;
    const placesRes = await fetch(url, {
      headers: {
        'X-Goog-Api-Key': GOOGLE_MAPS_API_KEY,
        'X-Goog-FieldMask': PLACES_FIELD_MASK,
      },
    });

    if (!placesRes.ok) {
      const errText = await placesRes.text();
      logger.error(`[gbp-mgmt] Places API error for ${id}: ${placesRes.status} ${errText}`);
      return res.status(502).json({ error: `Google Places API error: ${placesRes.status}`, details: errText });
    }

    const placeData = await placesRes.json();
    const incoming = mapPlacesData(placeData);

    // Get stored record
    const stored = await db('gbp_locations').where({ location_id: id }).first();

    // Diff against stored
    const changes = diffRecords(stored, incoming);

    // Create update records for each detected change
    const updateRecords = [];
    for (const change of changes) {
      const record = {
        location_id: id,
        field_name: change.field,
        old_value: change.oldVal,
        new_value: change.newVal,
        source: 'google',
        status: 'pending',
      };
      const [inserted] = await db('gbp_updates').insert(record).returning('*');
      updateRecords.push(inserted);
    }

    // If no stored record yet, create one with the Google data
    if (!stored) {
      await db('gbp_locations').insert({
        location_id: id,
        ...incoming,
        additional_categories: JSON.stringify(incoming.additional_categories),
        regular_hours: incoming.regular_hours ? JSON.stringify(incoming.regular_hours) : null,
        photos: JSON.stringify(incoming.photos),
        last_synced_at: new Date(),
      });
    } else {
      // Update last_synced_at but don't overwrite fields — those go through approve flow
      await db('gbp_locations').where({ location_id: id }).update({
        last_synced_at: new Date(),
        updated_at: new Date(),
      });
    }

    logger.info(`[gbp-mgmt] Synced ${id}: ${changes.length} changes detected`);
    res.json({
      location_id: id,
      changesDetected: changes.length,
      updates: updateRecords,
      googleData: incoming,
    });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// PUT /locations/:id — update location fields locally
// =========================================================================
router.put('/locations/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const configLoc = WAVES_LOCATIONS.find(l => l.id === id);
    if (!configLoc) return res.status(404).json({ error: 'Location not found' });

    // Whitelist of updatable fields
    const allowed = [
      'business_name', 'description', 'address', 'phone', 'additional_phones',
      'website_url', 'primary_category', 'additional_categories', 'regular_hours',
      'special_hours', 'services', 'attributes', 'store_code', 'opening_date',
      'service_areas', 'hide_address', 'logo_url', 'cover_photo_url', 'photos',
    ];

    const updates = {};
    for (const field of allowed) {
      if (req.body[field] !== undefined) {
        updates[field] = typeof req.body[field] === 'object'
          ? JSON.stringify(req.body[field])
          : req.body[field];
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields provided' });
    }

    updates.updated_at = new Date();

    const existing = await db('gbp_locations').where({ location_id: id }).first();
    if (existing) {
      await db('gbp_locations').where({ location_id: id }).update(updates);
    } else {
      await db('gbp_locations').insert({ location_id: id, ...updates });
    }

    const updated = await db('gbp_locations').where({ location_id: id }).first();
    res.json({ location: updated });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// POST /locations/:id/push — push stored state to Google via GBP API
// =========================================================================
router.post('/locations/:id/push', async (req, res, next) => {
  try {
    const { id } = req.params;
    const configLoc = WAVES_LOCATIONS.find(l => l.id === id);
    if (!configLoc) return res.status(404).json({ error: 'Location not found' });
    if (!configLoc.googleLocationResourceName) {
      return res.status(400).json({ error: 'No GBP resource name configured for this location' });
    }

    const stored = await db('gbp_locations').where({ location_id: id }).first();
    if (!stored) return res.status(404).json({ error: 'No stored profile data — sync first' });

    const headers = await gbpService._getHeaders(id);
    const resourceName = configLoc.googleLocationResourceName;

    // Build GBP API update payload
    const updateBody = {};
    const updateMask = [];

    if (stored.business_name) {
      updateBody.title = stored.business_name;
      updateMask.push('title');
    }
    if (stored.phone) {
      updateBody.phoneNumbers = { primaryPhone: stored.phone };
      if (stored.additional_phones) {
        const addl = typeof stored.additional_phones === 'string'
          ? JSON.parse(stored.additional_phones) : stored.additional_phones;
        if (addl.length) updateBody.phoneNumbers.additionalPhones = addl;
      }
      updateMask.push('phoneNumbers');
    }
    if (stored.website_url) {
      updateBody.websiteUri = stored.website_url;
      updateMask.push('websiteUri');
    }
    if (stored.description) {
      updateBody.profile = { description: stored.description };
      updateMask.push('profile');
    }
    if (stored.regular_hours) {
      const hours = typeof stored.regular_hours === 'string'
        ? JSON.parse(stored.regular_hours) : stored.regular_hours;
      const dayMap = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
      const periods = [];
      for (const [day, times] of Object.entries(hours)) {
        if (!times || !times.open) continue;
        const [openH, openM] = times.open.split(':').map(Number);
        const [closeH, closeM] = (times.close || '17:00').split(':').map(Number);
        periods.push({
          openDay: day.toUpperCase(),
          openTime: { hours: openH, minutes: openM },
          closeDay: day.toUpperCase(),
          closeTime: { hours: closeH, minutes: closeM },
        });
      }
      updateBody.regularHours = { periods };
      updateMask.push('regularHours');
    }
    if (stored.special_hours) {
      const special = typeof stored.special_hours === 'string'
        ? JSON.parse(stored.special_hours) : stored.special_hours;
      if (special.length) {
        updateBody.specialHours = {
          specialHourPeriods: special.map(s => ({
            startDate: { year: parseInt(s.date.split('-')[0]), month: parseInt(s.date.split('-')[1]), day: parseInt(s.date.split('-')[2]) },
            openTime: s.closed ? undefined : { hours: parseInt((s.open || '08:00').split(':')[0]), minutes: parseInt((s.open || '08:00').split(':')[1]) },
            closeTime: s.closed ? undefined : { hours: parseInt((s.close || '17:00').split(':')[0]), minutes: parseInt((s.close || '17:00').split(':')[1]) },
            closed: !!s.closed,
          })),
        };
        updateMask.push('specialHours');
      }
    }
    if (stored.service_areas) {
      const areas = typeof stored.service_areas === 'string'
        ? JSON.parse(stored.service_areas) : stored.service_areas;
      if (areas.length) {
        updateBody.serviceArea = {
          businessType: 'CUSTOMER_AND_BUSINESS_LOCATION',
          places: { placeInfos: areas.map(a => ({ placeName: a.name || a, placeId: a.placeId })) },
        };
        updateMask.push('serviceArea');
      }
    }
    if (stored.hide_address !== null && stored.hide_address !== undefined) {
      updateBody.storefront_address = stored.hide_address ? undefined : { addressLines: [stored.address] };
    }

    if (updateMask.length === 0) {
      return res.status(400).json({ error: 'No fields to push' });
    }

    const apiUrl = `https://mybusiness.googleapis.com/v4/${resourceName}?updateMask=${updateMask.join(',')}`;
    const pushRes = await fetch(apiUrl, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(updateBody),
    });

    if (!pushRes.ok) {
      const errText = await pushRes.text();
      logger.error(`[gbp-mgmt] Push failed for ${id}: ${pushRes.status} ${errText}`);
      return res.status(502).json({ error: `GBP API error: ${pushRes.status}`, details: errText });
    }

    const result = await pushRes.json();

    await db('gbp_locations').where({ location_id: id }).update({
      last_synced_at: new Date(),
      updated_at: new Date(),
    });

    logger.info(`[gbp-mgmt] Pushed updates to Google for ${id}: ${updateMask.join(', ')}`);
    res.json({ success: true, updatedFields: updateMask, googleResponse: result });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// GET /updates — list pending/recent updates
// =========================================================================
router.get('/updates', async (req, res, next) => {
  try {
    const { status, location, field, page = 1, limit = 50 } = req.query;

    let query = db('gbp_updates').orderBy('detected_at', 'desc');

    if (status) query = query.where({ status });
    if (location) query = query.where({ location_id: location });
    if (field) query = query.where({ field_name: field });

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const updates = await query.limit(parseInt(limit)).offset(offset);

    const totalQuery = db('gbp_updates');
    if (status) totalQuery.where({ status });
    if (location) totalQuery.where({ location_id: location });
    if (field) totalQuery.where({ field_name: field });
    const [{ count: total }] = await totalQuery.count('* as count');

    res.json({ updates, total: parseInt(total), page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// POST /updates/:id/approve — accept new value into stored state
// =========================================================================
router.post('/updates/:id/approve', async (req, res, next) => {
  try {
    const { id } = req.params;
    const update = await db('gbp_updates').where({ id }).first();
    if (!update) return res.status(404).json({ error: 'Update not found' });
    if (update.status !== 'pending') return res.status(400).json({ error: `Update already ${update.status}` });

    // Apply the new value to the stored gbp_locations record
    const fieldValue = update.new_value;
    const updateData = { updated_at: new Date() };

    // For JSON fields, store as-is (it's already serialized text)
    const jsonFields = ['additional_phones', 'additional_categories', 'regular_hours',
      'special_hours', 'services', 'attributes', 'service_areas', 'photos'];

    if (jsonFields.includes(update.field_name)) {
      updateData[update.field_name] = fieldValue; // Already JSON string
    } else if (update.field_name === 'hide_address') {
      updateData[update.field_name] = fieldValue === 'true';
    } else {
      updateData[update.field_name] = fieldValue;
    }

    await db('gbp_locations').where({ location_id: update.location_id }).update(updateData);

    // Mark update as approved
    await db('gbp_updates').where({ id }).update({
      status: 'approved',
      reviewed_by: req.adminUser?.email || req.adminUser?.name || 'admin',
      reviewed_at: new Date(),
    });

    logger.info(`[gbp-mgmt] Approved update ${id}: ${update.field_name} for ${update.location_id}`);
    res.json({ success: true, update: await db('gbp_updates').where({ id }).first() });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// POST /updates/:id/reject — reject update, push old value back to Google
// =========================================================================
router.post('/updates/:id/reject', async (req, res, next) => {
  try {
    const { id } = req.params;
    const update = await db('gbp_updates').where({ id }).first();
    if (!update) return res.status(404).json({ error: 'Update not found' });
    if (update.status !== 'pending') return res.status(400).json({ error: `Update already ${update.status}` });

    // Mark as rejected
    await db('gbp_updates').where({ id }).update({
      status: 'rejected',
      reviewed_by: req.adminUser?.email || req.adminUser?.name || 'admin',
      reviewed_at: new Date(),
    });

    logger.info(`[gbp-mgmt] Rejected update ${id}: ${update.field_name} for ${update.location_id}`);
    res.json({ success: true, update: await db('gbp_updates').where({ id }).first() });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// POST /updates/bulk-reject — reject multiple updates
// =========================================================================
router.post('/updates/bulk-reject', async (req, res, next) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids array required' });
    }

    const reviewedBy = req.adminUser?.email || req.adminUser?.name || 'admin';

    const count = await db('gbp_updates')
      .whereIn('id', ids)
      .where({ status: 'pending' })
      .update({
        status: 'rejected',
        reviewed_by: reviewedBy,
        reviewed_at: new Date(),
      });

    logger.info(`[gbp-mgmt] Bulk rejected ${count} updates`);
    res.json({ success: true, rejectedCount: count });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// PUT /locations/:id/hours — update regular hours
// =========================================================================
router.put('/locations/:id/hours', async (req, res, next) => {
  try {
    const { id } = req.params;
    const configLoc = WAVES_LOCATIONS.find(l => l.id === id);
    if (!configLoc) return res.status(404).json({ error: 'Location not found' });

    const { hours } = req.body;
    if (!hours || typeof hours !== 'object') {
      return res.status(400).json({ error: 'hours object required (e.g. { monday: { open: "08:00", close: "17:00" } })' });
    }

    const existing = await db('gbp_locations').where({ location_id: id }).first();
    if (existing) {
      await db('gbp_locations').where({ location_id: id }).update({
        regular_hours: JSON.stringify(hours),
        updated_at: new Date(),
      });
    } else {
      await db('gbp_locations').insert({
        location_id: id,
        regular_hours: JSON.stringify(hours),
      });
    }

    const updated = await db('gbp_locations').where({ location_id: id }).first();
    res.json({ location: updated });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// PUT /locations/:id/special-hours — update special hours
// =========================================================================
router.put('/locations/:id/special-hours', async (req, res, next) => {
  try {
    const { id } = req.params;
    const configLoc = WAVES_LOCATIONS.find(l => l.id === id);
    if (!configLoc) return res.status(404).json({ error: 'Location not found' });

    const { specialHours } = req.body;
    if (!Array.isArray(specialHours)) {
      return res.status(400).json({ error: 'specialHours array required (e.g. [{ date: "2026-12-25", closed: true }])' });
    }

    const existing = await db('gbp_locations').where({ location_id: id }).first();
    if (existing) {
      await db('gbp_locations').where({ location_id: id }).update({
        special_hours: JSON.stringify(specialHours),
        updated_at: new Date(),
      });
    } else {
      await db('gbp_locations').insert({
        location_id: id,
        special_hours: JSON.stringify(specialHours),
      });
    }

    const updated = await db('gbp_locations').where({ location_id: id }).first();
    res.json({ location: updated });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// PUT /locations/:id/services — update services list
// =========================================================================
router.put('/locations/:id/services', async (req, res, next) => {
  try {
    const { id } = req.params;
    const configLoc = WAVES_LOCATIONS.find(l => l.id === id);
    if (!configLoc) return res.status(404).json({ error: 'Location not found' });

    const { services } = req.body;
    if (!Array.isArray(services)) {
      return res.status(400).json({ error: 'services array required' });
    }

    const existing = await db('gbp_locations').where({ location_id: id }).first();
    if (existing) {
      await db('gbp_locations').where({ location_id: id }).update({
        services: JSON.stringify(services),
        updated_at: new Date(),
      });
    } else {
      await db('gbp_locations').insert({
        location_id: id,
        services: JSON.stringify(services),
      });
    }

    const updated = await db('gbp_locations').where({ location_id: id }).first();
    res.json({ location: updated });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// GET /services/suggestions — Google's suggested services for a category
// =========================================================================
router.get('/services/suggestions', async (req, res, next) => {
  try {
    const { category } = req.query;
    if (!category) return res.status(400).json({ error: 'category query param required' });
    if (!GOOGLE_MAPS_API_KEY) return res.status(500).json({ error: 'GOOGLE_MAPS_API_KEY not configured' });

    // Use the GBP API to get service suggestions for a category
    // Fall back to a static list if no GBP API access
    const anyConfiguredLoc = WAVES_LOCATIONS.find(l => gbpService._getClient(l.id));
    if (!anyConfiguredLoc) {
      // Return common pest control services as fallback
      return res.json({
        services: [
          'General Pest Control', 'Termite Control', 'Rodent Control',
          'Mosquito Control', 'Bed Bug Treatment', 'Lawn Care',
          'Ant Control', 'Cockroach Control', 'Flea & Tick Treatment',
          'Wildlife Removal', 'Fumigation', 'Crawl Space Treatment',
        ],
        source: 'static',
      });
    }

    try {
      const headers = await gbpService._getHeaders(anyConfiguredLoc.id);
      const url = `https://mybusinessbusinessinformation.googleapis.com/v1/categories?filter=${encodeURIComponent(category)}&languageCode=en&regionCode=US&view=FULL`;
      const catRes = await fetch(url, { headers });
      if (catRes.ok) {
        const data = await catRes.json();
        const services = (data.categories || []).flatMap(c =>
          (c.serviceTypes || []).map(s => s.displayName || s.serviceTypeId)
        );
        return res.json({ services, source: 'google', category });
      }
    } catch (apiErr) {
      logger.warn(`[gbp-mgmt] Service suggestions API failed: ${apiErr.message}`);
    }

    // Fallback
    res.json({
      services: ['General Pest Control', 'Termite Inspection', 'Rodent Control', 'Mosquito Treatment', 'Lawn Care'],
      source: 'fallback',
    });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// GET /notifications — get notification preferences
// =========================================================================
router.get('/notifications', async (req, res, next) => {
  try {
    const email = req.adminUser?.email || req.query.email;
    if (!email) return res.status(400).json({ error: 'Email required' });

    let prefs = await db('gbp_notification_prefs').where({ user_email: email }).first();
    if (!prefs) {
      // Return defaults
      prefs = { user_email: email, frequency: 'daily', field_filters: [], enabled: true, last_sent_at: null };
    }
    res.json({ preferences: prefs });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// PUT /notifications — update notification preferences
// =========================================================================
router.put('/notifications', async (req, res, next) => {
  try {
    const email = req.adminUser?.email || req.body.email;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const { frequency, field_filters, enabled } = req.body;

    const existing = await db('gbp_notification_prefs').where({ user_email: email }).first();
    const data = {};
    if (frequency !== undefined) data.frequency = frequency;
    if (field_filters !== undefined) data.field_filters = JSON.stringify(field_filters);
    if (enabled !== undefined) data.enabled = enabled;

    if (existing) {
      await db('gbp_notification_prefs').where({ user_email: email }).update(data);
    } else {
      await db('gbp_notification_prefs').insert({ user_email: email, ...data });
    }

    const updated = await db('gbp_notification_prefs').where({ user_email: email }).first();
    res.json({ preferences: updated });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// POST /locations/bulk-edit — edit a field across multiple locations
// =========================================================================
router.post('/locations/bulk-edit', async (req, res, next) => {
  try {
    const { locationIds, field, value } = req.body;

    if (!Array.isArray(locationIds) || locationIds.length === 0) {
      return res.status(400).json({ error: 'locationIds array required' });
    }
    if (!field) return res.status(400).json({ error: 'field name required' });

    const allowed = [
      'business_name', 'description', 'phone', 'website_url', 'regular_hours',
      'special_hours', 'services', 'attributes', 'service_areas', 'hide_address',
    ];
    if (!allowed.includes(field)) {
      return res.status(400).json({ error: `Field "${field}" not allowed for bulk edit. Allowed: ${allowed.join(', ')}` });
    }

    const results = [];
    for (const locId of locationIds) {
      const configLoc = WAVES_LOCATIONS.find(l => l.id === locId);
      if (!configLoc) {
        results.push({ location_id: locId, success: false, error: 'Location not found' });
        continue;
      }

      const serialized = typeof value === 'object' ? JSON.stringify(value) : value;
      const existing = await db('gbp_locations').where({ location_id: locId }).first();

      if (existing) {
        await db('gbp_locations').where({ location_id: locId }).update({
          [field]: serialized,
          updated_at: new Date(),
        });
      } else {
        await db('gbp_locations').insert({
          location_id: locId,
          [field]: serialized,
        });
      }

      results.push({ location_id: locId, success: true });
    }

    logger.info(`[gbp-mgmt] Bulk edited "${field}" for ${locationIds.length} locations`);
    res.json({ results, field, locationCount: locationIds.length });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
