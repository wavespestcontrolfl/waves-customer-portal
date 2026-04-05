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

      await db('call_log').insert({
        customer_id: customer?.id || null,
        direction: 'inbound',
        from_phone: normalizedPhone,
        to_phone: wavesPhone || null,
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

      // Find or create product in products_catalog
      let productRecord = await db('products_catalog').whereILike('name', product).first();
      if (!productRecord) {
        const insertData = {
          name: product,
          category: (category || 'Uncategorized').substring(0, 100),
          active_ingredient: activeIngredient || null,
          container_size: size || null,
          needs_pricing: !priceStr,
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
        if (!productRecord.active_ingredient && activeIngredient) upd.active_ingredient = activeIngredient;
        if (!productRecord.sku && sku) upd.sku = sku;
        if (!productRecord.container_size && size) upd.container_size = size;
        if (Object.keys(upd).length > 0) await db('products_catalog').where({ id: productRecord.id }).update(upd);
      }

      // Add vendor pricing if vendor and price exist
      if (vendor && priceStr) {
        const vendorRecord = await db('vendors').whereILike('name', vendor).first()
          || await db('vendors').whereILike('name', `%${vendor}%`).first();

        if (vendorRecord) {
          const existing = await db('vendor_pricing')
            .where({ product_id: productRecord.id, vendor_id: vendorRecord.id }).first();

          if (!existing) {
            await db('vendor_pricing').insert({
              product_id: productRecord.id,
              vendor_id: vendorRecord.id,
              price: parseFloat(priceStr) || 0,
              quantity: size || null,
              vendor_product_url: sourceUrl || null,
              vendor_sku: sku || null,
              last_checked_at: new Date(),
            });
          }

          // Update best price on product
          const price = parseFloat(priceStr);
          if (price > 0 && (!productRecord.best_price || price < parseFloat(productRecord.best_price))) {
            await db('products_catalog').where({ id: productRecord.id }).update({
              best_price: price, best_vendor: vendorRecord.name, needs_pricing: false,
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
