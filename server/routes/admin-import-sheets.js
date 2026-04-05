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

module.exports = router;
