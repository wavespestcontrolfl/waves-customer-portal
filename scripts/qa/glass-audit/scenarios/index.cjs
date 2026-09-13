'use strict';
// Scenario registry. Each module exports an array of scenarios:
// {
//   id, family, surface ('customer'|'admin'|'tech'|'server-html'), role,
//   route (canonical app route pattern), url (what the harness opens),
//   ready (text | 'css:<selector>' | async fn(page)),
//   handle ({method, path, query, body}) => { status?, body } | null   // API fixture
//   localStorage: {k: v}, sheet: {...}, extraWidths: bool, widths: [..], fonts: false (skip webfont gate for server-html),
//   states: [{ name, url?, ready?, handle?, setup(page)?, interactions?, reducedMotion?, widths? }],
//   interactions: [{ name, run(page, {width, mobile}), widths?, fullPage?, probe? }],
// }
const fs = require('node:fs');
const path = require('node:path');

function loadScenarios() {
  const dir = __dirname;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.cjs') && f !== 'index.cjs').sort();
  const out = [];
  for (const f of files) {
    const mod = require(path.join(dir, f));
    const list = Array.isArray(mod) ? mod : mod.scenarios;
    for (const s of list) out.push(s);
  }
  const ids = new Set();
  for (const s of out) { if (ids.has(s.id)) throw new Error(`duplicate scenario id ${s.id}`); ids.add(s.id); }
  return out;
}

module.exports = { loadScenarios };
