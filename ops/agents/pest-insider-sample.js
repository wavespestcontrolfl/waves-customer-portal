/**
 * pest-insider-sample.js — READ-ONLY (live model calls unless --stub)
 *
 * Builds sample "Pest Insider" issues (server/services/pest-insider) for the
 * given send dates and writes the finished email to files. It sends nothing,
 * schedules nothing and writes no database rows: DATABASE_URL is removed from
 * the process before any portal module loads, so even the LLM call ledger has
 * nowhere to write.
 *
 *   node ops/agents/pest-insider-sample.js <outDir> [YYYY-MM-DD ...] [--max-runner | --api | --stub] [--demo-blocks]
 *
 *     <outDir>        where the files go (created if missing)
 *     dates           send dates (ET); default 2026-12-03 and 2026-12-17
 *     --max-runner    answer the model call on this Mac's Claude Max login through
 *                     ~/max-runner/claude-code-fetch.js (no API money; the OpenAI backup
 *                     leg is refused there by design)
 *     --api           use ANTHROPIC_API_KEY / OPENAI_API_KEY from the environment. That is
 *                     paid API spend, so the flag is explicit; get the owner's yes first
 *     --stub          no model: a fixed stand-in writer that restates the fact statement,
 *                     to check layout and the claim check offline
 *     --demo-blocks   fill the optional blocks (area line, tool, home) with synthetic text
 *
 * Dates run in order: each issue's fact and species count as "recent" for the
 * next one, the way the real schedule will.
 *
 * Per date it writes pest-insider-<date>.html (the body inside the newsletter
 * chrome, for opening in a browser) and pest-insider-<date>.txt, and prints
 * the subject, the chosen fact and species, and every sentence the claim check cut.
 * Exit code 1 when any issue did not build.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const positional = args.filter((a) => !a.startsWith('--'));
const [outDir, ...dateArgs] = positional;
const dates = dateArgs.length ? dateArgs : ['2026-12-03', '2026-12-17'];

if (!outDir || dates.some((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d))) {
  console.error('usage: node ops/agents/pest-insider-sample.js <outDir> [YYYY-MM-DD ...] [--max-runner | --api | --stub] [--demo-blocks]');
  process.exit(2);
}
const modes = ['--max-runner', '--api', '--stub'].filter((m) => flags.has(m));
if (modes.length !== 1) {
  console.error('choose exactly one of --max-runner (free, this Mac), --api (paid) or --stub (no model)');
  process.exit(2);
}

// No database for this process, so no ledger row and no other write is possible:
// 1. no credentials: every name knexfile.js can rebuild DATABASE_URL from is
//    removed, and WAVES_LOCAL_DEV=1 stops config/load-env.js from reloading
//    them from the checkout's .env;
// 2. no telemetry: GATE_LLM_DISPATCH_METRICS is forced off;
// 3. no client: server/models/db.js is replaced in the require cache by a stub
//    that throws on any use, before any portal module can load the real one.
for (const name of Object.keys(process.env)) {
  if (/^(DATABASE_|POSTGRES_|PG[A-Z]+$)/.test(name)) delete process.env[name];
}
process.env.WAVES_LOCAL_DEV = '1';
process.env.GATE_LLM_DISPATCH_METRICS = 'false';
const dbPath = require.resolve('../../server/models/db');
const noDb = new Proxy(function noDatabase() {}, {
  get(target, prop) {
    if (prop === 'then' || typeof prop === 'symbol') return undefined;
    throw new Error(`pest-insider-sample: no database in this process (db.${String(prop)})`);
  },
  apply() { throw new Error('pest-insider-sample: no database in this process'); },
});
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: noDb };

if (flags.has('--max-runner')) {
  // Must run before any portal module loads: the Anthropic SDK reads fetch at import.
  require(path.join(os.homedir(), 'max-runner', 'claude-code-fetch.js')).install();
  for (const name of Object.keys(process.env)) {
    if (/^(OPENAI|GEMINI|GOOGLE_AI|PERPLEXITY|XAI|GROQ|DEEPSEEK|MISTRAL|COHERE|OPENROUTER)[A-Z0-9_]*(KEY|KEYS|TOKEN)$/.test(name)) delete process.env[name];
  }
  process.env.ANTHROPIC_API_KEY = 'max-runner-claude-code';
}

const { buildIssue } = require('../../server/services/pest-insider');
const { wrapIssueHtml } = require('../../server/services/pest-insider/render');
const { RECENT_WINDOW } = require('../../server/services/pest-insider/plan');

// Stand-in writer for --stub: restates the statement, no model.
async function stubWrite({ leadFact, idItem }) {
  const sentences = [leadFact.statement, leadFact.quotes[0]].map((text) => ({ text, fact_id: leadFact.id }));
  return {
    ok: true,
    provider: 'stub',
    model: 'stub',
    draft: {
      subject: `🪲 ${leadFact.title}`,
      preview: `What's this? ${idItem.name}`,
      lead: { headline: leadFact.title, sentences },
      id_item: { text: idItem.fact },
    },
  };
}

// Synthetic text only: no real customer, address or product.
const DEMO = {
  areaLine: 'Sample line: crews are seeing more of this near the canals this week.',
  tool: { name: 'Sample garden hose nozzle', why: 'Sample line explaining why a crew keeps one in the truck.', url: 'https://www.example.com/sample-tool', disclosure: 'Sample disclosure line.' },
  home: { lastVisit: { date: '2026-11-04', areas: ['front beds', 'lanai'] }, nextVisit: { date: '2027-01-06', service: 'pest control' }, sinceDate: '2024-03-12', visitCount: 9 },
};

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const recent = { factIds: [], speciesSlugs: [] };
  let failed = 0;
  for (const sendDate of dates) {
    const result = await buildIssue({
      sendDate,
      recent: { factIds: recent.factIds.slice(-RECENT_WINDOW), speciesSlugs: recent.speciesSlugs.slice(-RECENT_WINDOW) },
      write: flags.has('--stub') ? stubWrite : undefined,
      ...(flags.has('--demo-blocks') ? DEMO : {}),
    });
    const d = result.diagnostics;
    console.log(`\n== ${sendDate}  fact ${d.factId}  species ${d.speciesSlug}  via ${d.provider || '-'}/${d.model || '-'}`);
    if (!result.ok) {
      failed += 1;
      console.log(`   NOT BUILT: ${result.reason}`);
    } else {
      const { issue } = result;
      console.log(`   subject: ${issue.subject}\n   preview: ${issue.preview}`);
      const base = path.join(outDir, `pest-insider-${sendDate}`);
      const html = wrapIssueHtml(issue, { unsubscribeUrl: '{{unsubscribe_url}}' });
      fs.writeFileSync(`${base}.html`, `<!-- subject: ${issue.subject.replace(/--/g, '- -')} -->\n${html}`);
      fs.writeFileSync(`${base}.txt`, `Subject: ${issue.subject}\nPreview: ${issue.preview}\n\n${issue.text_body}`);
      console.log(`   wrote ${base}.html and .txt`);
    }
    for (const c of d.cut) console.log(`   CUT (${c.reason}): ${c.text}`);
    if (d.fallbacks.length) console.log(`   fallbacks used: ${d.fallbacks.join(', ')}`);
    // Only a built issue counts toward the rotation, like a sent one will.
    if (result.ok) {
      recent.factIds.push(d.factId);
      recent.speciesSlugs.push(d.speciesSlug);
    }
  }
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
