/**
 * Seed 002 — Import blog content calendar from CSV
 *
 * Run: node scripts/seeds/002_blog_posts.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const fs = require('fs');
const path = require('path');
const knex = require('knex');
const db = knex({
  client: 'pg',
  connection: process.env.DATABASE_URL,
  pool: { min: 1, max: 3 },
});

const CSV_PATH = path.join(__dirname, '..', '..', '..', 'BLOG - Sheet1 (1).csv');

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

function parseDate(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + ' 2026');
  if (isNaN(d.getTime())) {
    // Try as-is
    const d2 = new Date(dateStr);
    return isNaN(d2.getTime()) ? null : d2.toISOString().split('T')[0];
  }
  return d.toISOString().split('T')[0];
}

async function seed() {
  console.log('Importing blog posts from CSV...');

  const csvFile = fs.existsSync(CSV_PATH) ? CSV_PATH : path.join(process.env.HOME, 'Downloads', 'BLOG - Sheet1 (1).csv');

  if (!fs.existsSync(csvFile)) {
    console.error('CSV file not found at:', csvFile);
    process.exit(1);
  }

  const content = fs.readFileSync(csvFile, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());
  const headers = parseCSVLine(lines[0]);

  console.log('Headers:', headers);

  const dateIdx = headers.indexOf('Date');
  const titleIdx = headers.indexOf('Title (Revised)');
  const keywordIdx = headers.indexOf('Keyword');
  const tagIdx = headers.indexOf('Tag');
  const slugIdx = headers.indexOf('Slug');
  const metaIdx = headers.indexOf('Meta Description (Revised)');
  const cityIdx = headers.indexOf('City');
  const statusIdx = headers.indexOf('Status');

  let imported = 0;
  let skipped = 0;

  for (let i = 1; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i]);
    if (fields.length < 5) continue;

    const title = fields[titleIdx];
    if (!title) continue;

    // Check for existing
    const existing = await db('blog_posts').where('title', title).first();
    if (existing) { skipped++; continue; }

    const publishDate = parseDate(fields[dateIdx]);

    await db('blog_posts').insert({
      publish_date: publishDate,
      title: title,
      keyword: fields[keywordIdx] || null,
      tag: fields[tagIdx] || null,
      slug: fields[slugIdx] || null,
      meta_description: fields[metaIdx] || null,
      city: fields[cityIdx] || null,
      status: (fields[statusIdx] || 'Queued').toLowerCase() === 'queued' ? 'queued' : (fields[statusIdx] || 'queued').toLowerCase(),
      source: 'calendar',
    });
    imported++;
  }

  console.log(`Done: ${imported} imported, ${skipped} skipped (already exist)`);
  process.exit(0);
}

seed().catch(err => { console.error(err); process.exit(1); });
