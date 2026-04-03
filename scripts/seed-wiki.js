// scripts/seed-wiki.js
// Reads all wiki/**/*.md files and upserts into knowledge_base table
// Run: node scripts/seed-wiki.js

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const knex = require('knex');
const knexConfig = require('../server/knexfile');

const db = knex(knexConfig[process.env.NODE_ENV || 'development']);

function walkDir(dir, fileList = []) {
  if (!fs.existsSync(dir)) return fileList;
  fs.readdirSync(dir).forEach((file) => {
    const fullPath = path.join(dir, file);
    if (fs.statSync(fullPath).isDirectory()) {
      walkDir(fullPath, fileList);
    } else if (file.endsWith('.md') && !file.startsWith('_')) {
      fileList.push(fullPath);
    }
  });
  return fileList;
}

function inferCategory(filePath) {
  const parts = filePath.split(path.sep);
  const wikiIdx = parts.indexOf('wiki');
  return wikiIdx >= 0 ? parts[wikiIdx + 1] : 'general';
}

function extractSummary(content) {
  // Look for bolded Summary line: **Summary:** ...
  const match = content.match(/\*\*Summary:\*\*\s*(.+)/);
  if (match) return match[1].trim();
  // Fallback: first non-heading paragraph
  const lines = content.split('\n').filter((l) => l.trim() && !l.startsWith('#') && !l.startsWith('**'));
  return lines[0]?.trim()?.substring(0, 200) || '';
}

function extractTags(content) {
  const match = content.match(/\*\*Tags:\*\*\s*(.+)/);
  if (!match) return [];
  return match[1].split(',').map((t) => t.trim().toLowerCase());
}

async function seedWiki() {
  const wikiDir = path.join(__dirname, '../wiki');
  const files = walkDir(wikiDir);

  if (!files.length) {
    console.log('No wiki files found at', wikiDir);
    process.exit(0);
  }

  console.log(`Seeding ${files.length} wiki articles...`);

  for (const filePath of files) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const relativePath = 'wiki/' + path.relative(wikiDir, filePath).replace(/\\/g, '/');
    const title = content.match(/^#\s+(.+)/m)?.[1]?.trim() || path.basename(filePath, '.md');
    const category = inferCategory(filePath);
    const summary = extractSummary(content);
    const tags = extractTags(content);

    const existing = await db('knowledge_base').where('path', relativePath).first();

    if (existing) {
      await db('knowledge_base').where('path', relativePath).update({
        title, category, content, summary,
        tags: JSON.stringify(tags),
        word_count: content.split(/\s+/).length,
        last_compiled: new Date(),
        version: existing.version + 1,
        updated_at: new Date(),
      });
      console.log(`  updated: ${relativePath}`);
    } else {
      await db('knowledge_base').insert({
        path: relativePath,
        title, category, content, summary,
        tags: JSON.stringify(tags),
        word_count: content.split(/\s+/).length,
        last_compiled: new Date(),
        active: true,
      });
      console.log(`  created: ${relativePath}`);
    }
  }

  console.log('\nWiki seeded successfully.');
  await db.destroy();
}

seedWiki().catch((err) => {
  console.error(err);
  process.exit(1);
});
