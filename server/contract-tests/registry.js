/**
 * Contract-test registry — auto-discovers every tool across:
 *   - Intelligence Bar  (server/services/intelligence-bar/*-tools.js)
 *   - Managed Agents    (server/services/{bi,lead-response,retention}-agent-config.js)
 *   - Lead Response exec (server/services/lead-response-tools.js)
 *   - Manual overrides  (server/contract-tests/overrides/manual-contracts.js)
 *
 * Returns an array of records:
 *   { name, surface, module, sourcePath, schema, execute, manualContract, sideEffects, sonnetBacked }
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', 'services');
const OVERRIDES = (() => {
  try { return require('./overrides/manual-contracts'); }
  catch { return {}; }
})();

const SONNET_BACKED = new Set([
  'run_price_lookup',
  'draft_sms_reply',
  'draft_review_reply',
]);

function safeRequire(p) {
  try { return require(p); } catch (e) { return { __error: e }; }
}

function collectIntelligenceBar() {
  const dir = path.join(ROOT, 'intelligence-bar');
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter(f => f.endsWith('-tools.js') || f === 'tools.js');
  const out = [];
  for (const file of files) {
    const full = path.join(dir, file);
    const mod = safeRequire(full);
    if (mod.__error) { console.warn(`[registry] ${file} failed to load: ${mod.__error.message}`); continue; }
    const toolsArr = mod.TOOLS || mod.DASHBOARD_TOOLS || mod.SEO_TOOLS || mod.SCHEDULE_TOOLS ||
                     mod.PROCUREMENT_TOOLS || mod.REVENUE_TOOLS || mod.REVIEW_TOOLS ||
                     mod.COMMS_TOOLS || mod.TAX_TOOLS || mod.LEADS_TOOLS || mod.TECH_TOOLS ||
                     mod.BANKING_TOOLS || mod.EMAIL_TOOLS ||
                     Object.values(mod).find(v => Array.isArray(v) && v[0]?.input_schema);
    const execFn = mod.executeTool || mod.executeDashboardTool || mod.executeSEOTool ||
                   mod.executeScheduleTool || mod.executeProcurementTool ||
                   mod.executeRevenueTool || mod.executeReviewTool ||
                   mod.executeCommsTool || mod.executeTaxTool || mod.executeLeadsTool ||
                   mod.executeTechTool || mod.executeBankingTool || mod.executeEmailTool ||
                   Object.entries(mod).find(([k, v]) => typeof v === 'function' && /^execute/i.test(k))?.[1];
    if (!toolsArr || !Array.isArray(toolsArr)) continue;
    for (const t of toolsArr) {
      if (!t?.name) continue;
      out.push(buildRecord(t, {
        surface: 'intelligence-bar',
        module: file,
        sourcePath: full,
        execute: execFn ? (input) => execFn(t.name, input) : null,
      }));
    }
  }
  return out;
}

function collectManagedAgents() {
  const configs = [
    { file: 'bi-agent-config.js',           surface: 'bi-agent' },
    { file: 'lead-response-agent-config.js', surface: 'lead-response-agent' },
    { file: 'retention-agent-config.js',     surface: 'retention-agent' },
  ];
  const out = [];
  for (const c of configs) {
    const full = path.join(ROOT, c.file);
    if (!fs.existsSync(full)) continue;
    const mod = safeRequire(full);
    if (mod.__error) { console.warn(`[registry] ${c.file} failed: ${mod.__error.message}`); continue; }
    const cfg = Object.values(mod).find(v => v && typeof v === 'object' && Array.isArray(v.tools));
    if (!cfg) continue;
    for (const t of cfg.tools) {
      if (!t?.name) continue;
      out.push(buildRecord(t, {
        surface: c.surface,
        module: c.file,
        sourcePath: full,
        execute: null, // managed agents execute via Anthropic API, not local fn
      }));
    }
  }
  return out;
}

function collectLeadResponseTools() {
  const file = path.join(ROOT, 'lead-response-tools.js');
  if (!fs.existsSync(file)) return [];
  const mod = safeRequire(file);
  if (mod.__error) return [];
  const cfgFile = path.join(ROOT, 'lead-response-agent-config.js');
  const cfgMod = safeRequire(cfgFile);
  const cfg = cfgMod && Object.values(cfgMod).find(v => v && Array.isArray(v.tools));
  if (!cfg || !mod.executeLeadTool) return [];
  // Point existing managed-agent entries at the local executor so execute-smoke can run them.
  return cfg.tools.filter(t => t?.name).map(t => buildRecord(t, {
    surface: 'lead-response-agent',
    module: 'lead-response-tools.js',
    sourcePath: file,
    execute: (input) => mod.executeLeadTool(t.name, input),
    overrideSurface: true,
  }));
}

function buildRecord(tool, ctx) {
  const override = OVERRIDES[tool.name] || null;
  const inlineContract = tool._contracts || null;
  return {
    name: tool.name,
    surface: ctx.surface,
    module: ctx.module,
    sourcePath: ctx.sourcePath,
    schema: tool.input_schema || { type: 'object' },
    execute: ctx.execute,
    manualContract: override || inlineContract,
    sideEffects: !!(override?.sideEffects || tool._sideEffects),
    sonnetBacked: SONNET_BACKED.has(tool.name),
  };
}

async function discover() {
  const ib = collectIntelligenceBar();
  const agents = collectManagedAgents();
  const lead = collectLeadResponseTools();

  // De-dup (lead-response-tools replaces the managed-agent stub for the same tool name)
  const byKey = new Map();
  const upsert = r => {
    const key = `${r.surface}:${r.name}`;
    if (r.execute) byKey.set(key, r);
    else if (!byKey.has(key)) byKey.set(key, r);
  };
  [...ib, ...agents, ...lead].forEach(upsert);

  // Apply pure-manual overrides (tools registered only in overrides)
  for (const [name, contract] of Object.entries(OVERRIDES)) {
    if (!contract?.registerManually) continue;
    const key = `manual:${name}`;
    if (byKey.has(key)) continue;
    byKey.set(key, {
      name,
      surface: 'manual',
      module: 'manual-contracts.js',
      sourcePath: path.join(__dirname, 'overrides', 'manual-contracts.js'),
      schema: contract.schema || { type: 'object' },
      execute: null,
      manualContract: contract,
      sideEffects: !!contract.sideEffects,
      sonnetBacked: false,
    });
  }

  return [...byKey.values()].sort((a, b) => a.surface.localeCompare(b.surface) || a.name.localeCompare(b.name));
}

module.exports = { discover };
