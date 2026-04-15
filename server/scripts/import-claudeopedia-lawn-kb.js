/**
 * Import the Claudeopedia Lawn Care KB tarball into the knowledge_base table.
 *
 * Usage:
 *   node server/scripts/import-claudeopedia-lawn-kb.js <path-to-tar.gz>
 *
 * Each .md file in the tarball is parsed for YAML front matter
 * (title, category, tags, summary, backlinks) and upserted by slug
 * (derived from the file path, e.g. turf/track-a-st-augustine-sun).
 * Existing entries with the same slug are updated.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const db = require('../models/db');

function parseFrontMatter(raw) {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw };
  const metaBlock = match[1];
  const body = match[2];
  const meta = {};
  const lines = metaBlock.split('\n');
  let currentKey = null;
  const arrays = {};
  for (const line of lines) {
    if (/^\s*-\s/.test(line) && currentKey) {
      const val = line.replace(/^\s*-\s*/, '').replace(/^["']|["']$/g, '').trim();
      arrays[currentKey] = arrays[currentKey] || [];
      arrays[currentKey].push(val);
      continue;
    }
    const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
    if (m) {
      currentKey = m[1];
      let val = m[2].trim();
      if (val === '') continue;
      if (val.startsWith('[') && val.endsWith(']')) {
        meta[currentKey] = val.slice(1, -1).split(',')
          .map(s => s.trim().replace(/^["']|["']$/g, ''))
          .filter(Boolean);
      } else {
        meta[currentKey] = val.replace(/^["']|["']$/g, '');
      }
    }
  }
  for (const [k, v] of Object.entries(arrays)) meta[k] = v;
  return { meta, body };
}

async function run() {
  const tarPath = process.argv[2];
  if (!tarPath || !fs.existsSync(tarPath)) {
    console.error('Usage: node import-claudeopedia-lawn-kb.js <path-to-tar.gz>');
    process.exit(1);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeopedia-'));
  execSync(`tar -xzf "${tarPath}" -C "${tmp}"`);

  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile() && entry.name.endsWith('.md')) files.push(p);
    }
  };
  walk(tmp);

  console.log(`Found ${files.length} markdown files.`);

  let created = 0, updated = 0, skipped = 0;

  for (const file of files) {
    const raw = fs.readFileSync(file, 'utf8');
    const { meta, body } = parseFrontMatter(raw);

    const relPath = file.split('/kb/')[1]; // e.g. "turf/track-a-st-augustine-sun.md"
    if (!relPath) { skipped++; continue; }
    const kbPath = `kb/lawn-care/${relPath}`;
    const category = meta.category || relPath.split('/')[0] || 'general';
    const content = body.trim();
    const wordCount = content.split(/\s+/).filter(Boolean).length;

    const row = {
      path: kbPath,
      title: meta.title || relPath.replace(/\.md$/, ''),
      category,
      content,
      summary: meta.summary || null,
      tags: JSON.stringify(meta.tags || []),
      backlinks: JSON.stringify(meta.backlinks || []),
      source_documents: JSON.stringify([{ source: 'claudeopedia-lawn-care-kb', file: relPath }]),
      word_count: wordCount,
      last_compiled: new Date(),
      last_verified: new Date(),
      active: true,
      updated_at: new Date(),
    };

    const existing = await db('knowledge_base').where({ path: kbPath }).first();
    if (existing) {
      await db('knowledge_base').where({ id: existing.id }).update({
        ...row,
        version: (existing.version || 1) + 1,
      });
      updated++;
      console.log(`  updated: ${kbPath}`);
    } else {
      await db('knowledge_base').insert({ ...row, version: 1, created_at: new Date() });
      created++;
      console.log(`  created: ${kbPath}`);
    }
  }

  console.log(`\nDone. created=${created} updated=${updated} skipped=${skipped}`);
  await db.destroy();
}

run().catch(err => { console.error(err); process.exit(1); });
