const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const logger = require('../services/logger');
const { parse } = require('csv-parse/sync');

router.use(adminAuthenticate, requireTechOrAdmin);

const SHEET_ID = '1Ei60A40nWHg1uX3vD3D4FdrhCmDNV0Uspk1Xc5O_wx0';
function sheetURL(tab) {
  return `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tab)}`;
}

const ACTIVE_INGREDIENT_PLACEHOLDERS = new Set(['unknown - pending sds', 'unknown', 'pending sds']);
const EPA_REG_PLACEHOLDERS = new Set(['n/a', 'na', 'pending', 'pending sds']);

function normalizedLabelField(value) {
  return String(value || '').trim().toLowerCase();
}

function missingActiveIngredient(value) {
  const normalized = normalizedLabelField(value);
  return !normalized || ACTIVE_INGREDIENT_PLACEHOLDERS.has(normalized);
}

function missingEpaRegNumber(value) {
  const normalized = normalizedLabelField(value);
  return !normalized || EPA_REG_PLACEHOLDERS.has(normalized);
}

// POST /api/admin/import/sms — import SMS recordings from Google Sheet
router.post('/sms', async (req, res, next) => {
  try {
    const csvResp = await fetch(sheetURL('SMS RECORDINGS'));
    const csvText = await csvResp.text();

    const rows = parse(csvText, { columns: true, skip_empty_lines: true, relax_column_count: true });

    let imported = 0, skipped = 0;

    for (const row of rows) {
      const date = row['Date']?.trim();
      const phone = row['Customer Phone #']?.trim();
      const transcript = row['Transcript']?.trim();
      const wavesPhone = row['Waves Phone #']?.trim();
      const name = row['Name']?.trim();
      const notes = row['Notes']?.trim();
      const url = row['URL']?.trim();

      if (!date || !phone) { skipped++; continue; }

      // Normalize phone to +1XXXXXXXXXX
      const cleanPhone = phone.replace(/\D/g, '');
      const normalizedPhone = cleanPhone.length === 10 ? `+1${cleanPhone}` : cleanPhone.length === 11 ? `+${cleanPhone}` : phone;

      // Check for duplicate by phone + date
      const existing = await db('sms_log')
        .where('from_phone', normalizedPhone)
        .where('created_at', '>=', new Date(date))
        .where('created_at', '<', new Date(new Date(date).getTime() + 60000))
        .first();

      if (existing) { skipped++; continue; }

      // Try to match customer
      const customer = await db('customers')
        .where('phone', 'like', `%${cleanPhone.slice(-10)}`)
        .first();

      await db('sms_log').insert({
        customer_id: customer?.id || null,
        direction: 'inbound',
        from_phone: normalizedPhone,
        to_phone: wavesPhone ? (wavesPhone.replace(/\D/g, '').length === 10 ? `+1${wavesPhone.replace(/\D/g, '')}` : wavesPhone) : null,
        message_body: transcript || notes || '',
        status: 'received',
        message_type: 'imported',
        metadata: JSON.stringify({ source: 'google_sheet', name, url }),
        created_at: new Date(date),
      });
      imported++;
    }

    logger.info(`[import] SMS: imported ${imported}, skipped ${skipped}`);
    res.json({ success: true, imported, skipped, total: rows.length });
  } catch (err) { next(err); }
});

// POST /api/admin/import/calls — import call recordings from Google Sheet
router.post('/calls', async (req, res, next) => {
  try {
    const csvResp = await fetch(sheetURL('CALL RECORDINGS'));
    const csvText = await csvResp.text();

    // This sheet has messy headers with data embedded — parse carefully
    const rows = parse(csvText, { columns: false, skip_empty_lines: true, relax_column_count: true });

    // First row is header-ish but has data in it
    // Columns: Date, Customer Phone, Recording URL, Name, Transcript, Waves Phone, Notes
    let imported = 0, skipped = 0;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      // Extract date from first column — skip if not a valid date
      let dateStr = (row[0] || '').trim();
      // Clean header text from first row
      if (dateStr.startsWith('Date')) dateStr = dateStr.replace('Date', '').trim();
      if (!dateStr || dateStr.length < 8) { skipped++; continue; }

      // Try to parse date
      let parsedDate;
      try {
        parsedDate = new Date(dateStr);
        if (isNaN(parsedDate.getTime())) { skipped++; continue; }
      } catch { skipped++; continue; }

      let phone = (row[1] || '').trim();
      // Clean header text
      if (phone.startsWith('Customer Phone')) phone = phone.replace(/Customer Phone.*?\)/, '').trim();
      const cleanPhone = phone.replace(/[^\d]/g, '');
      if (cleanPhone.length < 10) { skipped++; continue; }
      const normalizedPhone = cleanPhone.length === 10 ? `+1${cleanPhone}` : `+${cleanPhone}`;

      let recordingUrl = (row[2] || '').trim();
      if (recordingUrl.startsWith('URL')) recordingUrl = recordingUrl.replace(/URL\s*/, '').trim();
      // Ensure it ends with .mp3
      if (recordingUrl && !recordingUrl.endsWith('.mp3')) recordingUrl += '.mp3';

      let name = (row[3] || '').trim();
      if (name.startsWith('Name')) name = name.replace('Name', '').trim();

      let transcript = (row[4] || '').trim();
      if (transcript.startsWith('Transcript')) transcript = transcript.replace('Transcript', '').trim();

      let wavesPhone = (row[5] || '').trim();
      if (wavesPhone.startsWith('Waves')) wavesPhone = wavesPhone.replace(/Waves Phone.*?#?\s*/, '').trim();

      // Check duplicate
      const existing = await db('call_log')
        .where('from_phone', normalizedPhone)
        .where('created_at', '>=', parsedDate)
        .where('created_at', '<', new Date(parsedDate.getTime() + 86400000))
        .first();

      if (existing) { skipped++; continue; }

      // Match customer
      const customer = await db('customers')
        .where('phone', 'like', `%${cleanPhone.slice(-10)}`)
        .first();

      // Normalize to E.164 so JOINs against lead_sources.twilio_phone_number
      // line up. Sheet rows historically held formats like '9413187612' or
      // '(941) 318-7612', which produced an "Unmapped — …" duplicate of
      // GBP — Lakewood Ranch in the dashboard's Calls by Source panel.
      const wavesDigits = (wavesPhone || '').replace(/\D/g, '');
      const wavesE164 = wavesDigits.length === 10
        ? `+1${wavesDigits}`
        : wavesDigits.length === 11
          ? `+${wavesDigits}`
          : wavesPhone || null;

      await db('call_log').insert({
        customer_id: customer?.id || null,
        direction: 'inbound',
        from_phone: normalizedPhone,
        to_phone: wavesE164,
        status: 'completed',
        answered_by: 'human',
        recording_url: recordingUrl || null,
        transcription: transcript || null,
        transcription_status: transcript ? 'completed' : null,
        notes: name || null,
        created_at: parsedDate,
      });
      imported++;
    }

    logger.info(`[import] Calls: imported ${imported}, skipped ${skipped}`);
    res.json({ success: true, imported, skipped, total: rows.length });
  } catch (err) { next(err); }
});

// POST /api/admin/import/pricing — import pricing data from CSV in Downloads
router.post('/pricing', async (req, res, next) => {
  try {
    let csvText;
    const fs = require('fs');
    const path = require('path');

    // Try bundled CSV first (deployed with the app)
    const bundledPath = path.join(__dirname, '..', 'data', 'pricing.csv');
    if (fs.existsSync(bundledPath)) {
      csvText = fs.readFileSync(bundledPath, 'utf8');
    }

    // Fallback: local dev path
    if (!csvText) {
      const localPath = '/Users/adambenetti/Downloads/Pricing - Sheet2 (2).csv';
      if (fs.existsSync(localPath)) {
        csvText = fs.readFileSync(localPath, 'utf8');
      }
    }

    // Fallback: read from the request body
    if (!csvText && req.body?.csvData) {
      csvText = req.body.csvData;
    }

    // Fallback: try Google Sheet
    if (!csvText) {
      try {
        const csvResp = await fetch('https://docs.google.com/spreadsheets/d/1GbZ8KGMdJr8_DsRsW5qsshZSJaiKivg8ZR9Fz09lnb0/gviz/tq?tqx=out:csv&gid=24910236');
        if (csvResp.ok) {
          const sheetText = await csvResp.text();
          if (sheetText && sheetText.split('\n')[0].includes('Product')) {
            csvText = sheetText;
          }
        }
      } catch (e) { /* ignore sheet fetch errors */ }
    }

    if (!csvText) return res.status(400).json({ error: 'No pricing data available' });

    const rows = parse(csvText, { columns: true, skip_empty_lines: true, relax_column_count: true });

    // Valid vendor names (not unit sizes)
    const validVendors = new Set(['siteone', 'amazon', 'solutions pest & lawn', 'domyown', 'forestry distributing', 'chemical warehouse', 'seed world', 'seed world usa', 'intermountain turf', 'keystone', 'keystone pest solutions', 'veseris', 'ewing outdoor supply', 'gci turf academy', 'diy pest control']);
    const unitSizes = new Set(['gal', 'oz', 'lb', 'qt', 'pt', 'fl oz', 'l', 'ml', 'g', 'stations', 'case']);

    // Valid categories
    const validCategories = new Set(['insecticide', 'herbicide', 'fertilizer', 'fungicide', 'micronutrient fertilizer', 'adjuvant', 'soil amendment / biostimulant', 'plant growth regulator', 'insect growth regulator', 'soil surfactant', 'termite monitoring', 'soil moisture management aid', 'termiticide / insecticide', 'rodent control', 'soils, mulch & amendments']);

    let imported = 0, skipped = 0, duplicates = 0;
    const seen = new Set();

    for (const row of rows) {
      const product = (row['Product'] || '').trim();
      const activeIngredient = (row['Active Ingredient / Descriptor'] || row['Active Ingredient'] || '').trim();
      const epaRegNumber = (row['EPA Reg #'] || row['EPA Reg'] || row['EPA Registration'] || row['EPA Registration Number'] || '').trim();
      let category = (row['Category'] || '').trim();
      const subcategory = (row['Subcategory'] || '').trim();
      const categorySection = (row['Category Section'] || '').trim();
      let sku = (row['SKU'] || '').trim();
      let vendor = (row['Vendor'] || '').trim();
      let size = (row['Size'] || '').trim();
      const sourceUrl = (row['Source URL'] || row['URL'] || '').trim();
      const priceStr = (row['Price'] || '').replace(/[$,]/g, '').trim();
      const unitPriceStr = (row['Unit Price'] || '').replace(/[$,]/g, '').trim();

      if (!product) { skipped++; continue; }

      // Skip TruGreen
      if (vendor.toLowerCase() === 'trugreen') { skipped++; continue; }

      // Fix vendor column containing unit sizes
      if (unitSizes.has(vendor.toLowerCase())) {
        size = size ? `${size} ${vendor}` : vendor;
        vendor = '';
      }

      // Fix category column containing ITM codes
      if (category.startsWith('ITM-')) {
        sku = category;
        category = subcategory || categorySection || 'Uncategorized';
      }

      // Validate category
      if (!validCategories.has(category.toLowerCase()) && !category.startsWith('ITM')) {
        if (categorySection && validCategories.has(categorySection.toLowerCase())) {
          category = categorySection;
        }
      }

      // Deduplicate by product name + vendor
      const dupeKey = `${product.toLowerCase()}|${vendor.toLowerCase()}`;
      if (seen.has(dupeKey)) { duplicates++; continue; }
      seen.add(dupeKey);

      // Strict numeric price, validated BEFORE any catalog mutation (codex
      // r19-push P1 + GH r3 P1; same contract as the price worker's
      // isNumericInput): parseFloat accepts numeric prefixes, so
      // "12.00 estimated" imported as 12, and a truthy malformed cell like
      // "N/A" created the product with needs_pricing=false while writing
      // no price at all.
      const cleanedPrice = String(priceStr || '').trim().replace(/^\$/, '');
      const importedPrice = /^-?\d+(\.\d+)?$/.test(cleanedPrice) ? Number(cleanedPrice) : NaN;
      const hasValidPrice = Number.isFinite(importedPrice) && importedPrice > 0;
      // Canonical unit size from the parsed pack (r20-push P1): without it
      // recalcBestPrice cannot scale the vendor price and tank-mix costing
      // cannot use the product at all.
      const adminInventoryRouteForSize = require('./admin-inventory');
      const importedSizeOz = adminInventoryRouteForSize.quantityToOz(size);

      // Find or create product in products_catalog
      let productRecord = await db('products_catalog').whereILike('name', product).first();
      if (!productRecord) {
        const insertData = {
          name: product,
          category: (category || 'Uncategorized').substring(0, 100),
          active_ingredient: activeIngredient || 'Unknown - pending SDS',
          epa_reg_number: epaRegNumber || 'N/A',
          formulation: 'unspecified',
          container_size: size || null,
          ...(importedSizeOz > 0 ? { unit_size_oz: importedSizeOz } : {}),
          needs_pricing: !hasValidPrice,
        };
        if (sku) insertData.sku = sku;
        // subcategory column may not exist yet — try with it, fall back without
        try {
          insertData.subcategory = subcategory || null;
          [productRecord] = await db('products_catalog').insert(insertData).returning('*');
        } catch (colErr) {
          delete insertData.subcategory;
          [productRecord] = await db('products_catalog').insert(insertData).returning('*');
        }
      } else {
        // Update if we have more info
        const upd = {};
        if ((!productRecord.category || productRecord.category === 'Uncategorized') && category) upd.category = (category).substring(0, 100);
        if (missingActiveIngredient(productRecord.active_ingredient) && activeIngredient) upd.active_ingredient = activeIngredient;
        if (missingEpaRegNumber(productRecord.epa_reg_number) && epaRegNumber) upd.epa_reg_number = epaRegNumber;
        if (!productRecord.sku && sku) upd.sku = sku;
        if (!productRecord.container_size && size) upd.container_size = size;
        if (!(parseFloat(productRecord.unit_size_oz) > 0) && importedSizeOz > 0) upd.unit_size_oz = importedSizeOz;
        if (Object.keys(upd).length > 0) await db('products_catalog').where({ id: productRecord.id }).update(upd);
      }

      // Add vendor pricing if vendor and a VALID price exist
      if (vendor && hasValidPrice) {
        const vendorRecord = await db('vendors').whereILike('name', vendor).first()
          || await db('vendors').whereILike('name', `%${vendor}%`).first();

        if (vendorRecord) {

          // Admin-initiated import = an approval (codex #3465 r9-push P1):
          // without the eligibility stamp the row sat at the pending
          // default while best_price was hand-written — the next canonical
          // recalculation then ignored the imported vendor entirely.
          const adminInventoryRoute = require('./admin-inventory');
          // Malformed prices never mutate (r11-push P1): "N/A"-style cells
          // parsed to 0 and the upsert then zeroed a valid vendor price
          // while stamping it approved. Only a finite positive price
          // imports.
          {
            // One transaction per line (r11-push P1): the vendor upsert and
            // the canonical recalculation commit together — a recalc
            // failure must not leave a changed vendor price beside a
            // catalog still pointing at the old winner. recalcBestPrice
            // takes the product advisory lock first on this connection.
            await db.transaction(async (trx) => {
              // Product advisory lock FIRST — the shared lock-order
              // contract (r12-push P1): upserting the vendor row before
              // recalc's lock acquisition inverts the order the approval
              // paths use and can deadlock against them.
              await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?))', ['inventory.best_price', String(productRecord.id)]);
              // Re-read INSIDE the lock (codex GH r3 P2): the pre-lock read
              // races a concurrent approval inserting the unique
              // (product_id, vendor_id) row — a stale null would make this
              // insert violate the unique constraint (or double-write).
              const lockedExisting = await trx('vendor_pricing')
                .where({ product_id: productRecord.id, vendor_id: vendorRecord.id })
                .first();
              if (!lockedExisting) {
                await trx('vendor_pricing').insert({
                  product_id: productRecord.id,
                  vendor_id: vendorRecord.id,
                  price: importedPrice,
                  quantity: size || null,
                  ...adminInventoryRoute.approvedPerOzFields(importedPrice, size || null),
                  vendor_product_url: sourceUrl || null,
                  vendor_sku: sku || null,
                  last_checked_at: new Date(),
                });
              } else {
                // Upsert (r10-push P1): an existing product/vendor row was
                // previously left untouched while the endpoint reported the
                // line imported — recalculation then re-read the OLD price.
                const quantity = size || lockedExisting.quantity || null;
                await trx('vendor_pricing').where({ id: lockedExisting.id }).update({
                  previous_price: lockedExisting.price,
                  price: importedPrice,
                  quantity,
                  ...adminInventoryRoute.approvedPerOzFields(importedPrice, quantity),
                  ...(sourceUrl ? { vendor_product_url: sourceUrl } : {}),
                  ...(sku ? { vendor_sku: sku } : {}),
                  last_checked_at: new Date(),
                  updated_at: new Date(),
                });
              }
              // Single best-price writer: the canonical recalculation
              // replaces the old raw-price comparison (which ignored pack
              // sizes and bypassed the backing/cache fields).
              await adminInventoryRoute.recalcBestPrice(productRecord.id, trx);
            });
          }
        }
      }

      imported++;
    }

    res.json({ success: true, imported, skipped, duplicates, total: rows.length });
  } catch (err) {
    console.error('[pricing-import] Error:', err.message, err.stack);
    next(err);
  }
});

module.exports = router;
