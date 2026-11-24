/**
 * Migration 20261124130000 (owner-approved copy, no gate): the live new_lead drip email names the
 * four offices, books an assessment instead of offering a free inspection / "swing by", and drops
 * the "No up-sells at the door" line. Compare-and-swap on the exact production values of 2026-11-24;
 * runs against a small in-memory knex stand-in. Synthetic data only.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn(async () => {}) }));

const { recordAuditEvent } = require('../services/audit-log');
const migration = require('../models/migrations/20261124130000_new_lead_drip_copy_offices_assessment');

const { STEP_SWAPS } = migration._private;
const html = STEP_SWAPS.find((s) => s.field === 'html_body');
const text = STEP_SWAPS.find((s) => s.field === 'text_body');

function makeDb(tables) {
  const run = (name, q) => {
    const hit = tables[name].filter((r) => q.filters.every(([k, v]) => r[k] === v));
    if (q.patch) { hit.forEach((r) => Object.assign(r, q.patch)); return hit.length; }
    return hit;
  };
  const db = (name) => {
    const q = { filters: [] };
    const api = {
      where(obj) { q.filters.push(...Object.entries(obj)); return api; },
      select() { return api; },
      update(patch) { q.patch = patch; return api; },
      then(res, rej) { return Promise.resolve().then(() => run(name, q)).then(res, rej); },
    };
    return api;
  };
  db.fn = { now: () => 'NOW' };
  db.schema = { hasTable: async (name) => name in tables };
  db.transaction = async (cb) => cb(db);
  return db;
}

function seed() {
  return {
    audit_log: [],
    automation_steps: [
      { id: 's-0', template_key: 'new_lead', step_order: 0, subject: 'Subject kept', preview_text: 'Preview kept', html_body: html.before, text_body: text.before },
      { id: 's-1', template_key: 'new_lead', step_order: 1, subject: 'Later', preview_text: 'Later', html_body: html.before, text_body: text.before },
      { id: 's-other', template_key: 'estimate_sent', step_order: 0, subject: 'x', preview_text: 'y', html_body: html.before, text_body: text.before },
    ],
  };
}

const copyAudits = () => recordAuditEvent.mock.calls.map(([e]) => e).filter((e) => e.action === 'automation_copy_updated');

beforeEach(() => { jest.clearAllMocks(); jest.spyOn(console, 'log').mockImplementation(() => {}); });
afterEach(() => jest.restoreAllMocks());

describe('new_lead drip email words', () => {
  test('html: the offices sentence, the up-sells row gone, an assessment instead of a free inspection; the rest byte for byte', () => {
    expect(html.after).toContain('<p>We\'re a family-owned pest control and lawn care company with offices in Lakewood Ranch, Parrish, Sarasota, and Venice. Our trucks run Manatee, Sarasota, and Charlotte counties — and our techs are the ones you\'ll actually see at your door.</p>');
    expect(html.after).toContain('<p>If you\'d like a quote, just reply to this email with your address and a good time, and we\'ll book your assessment. Or give us a call at <a href="tel:+19412975749">(941) 297-5749</a>.</p>');
    expect(html.after).not.toMatch(/up-sells|free inspection|swing by|based right here/i);
    const oldLines = html.before.split('\n');
    const newLines = html.after.split('\n');
    expect(newLines.filter((l) => !oldLines.includes(l))).toHaveLength(2);
    expect(oldLines.filter((l) => !newLines.includes(l))).toEqual([
      "<p>We're a family-owned pest control and lawn care company based right here in Lakewood Ranch. Our trucks run Manatee, Sarasota, and Charlotte counties — and our techs are the ones you'll actually see at your door.</p>",
      "  <li><strong>No up-sells at the door.</strong> Quotes come from the office, not from whoever's at your house.</li>",
      "<p>If you'd like a quote or a free inspection, just reply to this email with your address and a good time for us to swing by. Or give us a call at <a href=\"tel:+19412975749\">(941) 297-5749</a>.</p>",
    ]);
    expect(html.after.match(/\{\{\w+\}\}/g)).toEqual(html.before.match(/\{\{\w+\}\}/g));
  });

  test('text: the exact new body, with the same newline placement and the same variables', () => {
    expect(text.after).toBe("Hi {{first_name}} — thanks for your interest in Waves. We're a family-owned pest control + lawn care company with offices in Lakewood Ranch, Parrish, Sarasota, and Venice, serving Manatee, Sarasota, and Charlotte counties. No commitment contracts. Free re-services between visits on recurring plans. {{consultation_booking_text}}\nReply with your address and a good time and we'll book your assessment, or call (941) 297-5749. — The Waves Pest Control team");
    expect(text.after.match(/\{\{\w+\}\}/g)).toEqual(text.before.match(/\{\{\w+\}\}/g));
    expect(text.after).not.toMatch(/upsell|swing by|inspection/i);
  });

  test('up rewrites step 0 only, leaves subject, preview, later steps and other templates alone, and audits each field', async () => {
    const tables = seed();
    await migration.up(makeDb(tables));
    expect(tables.automation_steps[0]).toMatchObject({ html_body: html.after, text_body: text.after, updated_at: 'NOW', subject: 'Subject kept', preview_text: 'Preview kept' });
    expect(tables.automation_steps[1]).toMatchObject({ html_body: html.before, text_body: text.before });
    expect(tables.automation_steps[2]).toMatchObject({ html_body: html.before, text_body: text.before });
    const audits = copyAudits();
    expect(audits.map((e) => e.metadata.field).sort()).toEqual(['html_body', 'text_body']);
    expect(audits[0]).toMatchObject({ resource_type: 'automation_steps', resource_id: 's-0', actor_type: 'system', critical: true });
    expect(audits[0].metadata).toMatchObject({ migration: '20261124130000_new_lead_drip_copy_offices_assessment', template_key: 'new_lead' });
  });

  test('the audit action fits audit_log.action (96 characters)', async () => {
    await migration.up(makeDb(seed()));
    expect(recordAuditEvent).toHaveBeenCalled();
    for (const [e] of recordAuditEvent.mock.calls) expect(e.action.length).toBeLessThanOrEqual(96);
  });

  test('a field an administrator has edited stays as it is, with no audit row; the other field still updates', async () => {
    const tables = seed();
    tables.automation_steps[0].html_body = `${html.before}\n<p>Admin line</p>`;
    await migration.up(makeDb(tables));
    expect(tables.automation_steps[0].html_body).toBe(`${html.before}\n<p>Admin line</p>`);
    expect(tables.automation_steps[0].text_body).toBe(text.after);
    expect(copyAudits().map((e) => e.metadata.field)).toEqual(['text_body']);
  });

  test('a second run changes nothing and audits nothing', async () => {
    const tables = seed();
    const db = makeDb(tables);
    await migration.up(db);
    const snapshot = JSON.stringify(tables);
    recordAuditEvent.mockClear();
    await migration.up(db);
    expect(JSON.stringify(tables)).toBe(snapshot);
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });

  test('a database without audit_log still swaps the copy; one without automation_steps does nothing', async () => {
    const noAudit = seed();
    delete noAudit.audit_log;
    await migration.up(makeDb(noAudit));
    expect(noAudit.automation_steps[0].html_body).toBe(html.after);
    expect(recordAuditEvent).not.toHaveBeenCalled();
    await expect(migration.up(makeDb({}))).resolves.toBeUndefined();
  });

  test('down is a no-op: it changes no row and writes no audit row', async () => {
    const tables = seed();
    const db = makeDb(tables);
    await migration.up(db);
    const snapshot = JSON.stringify(tables);
    recordAuditEvent.mockClear();
    await migration.down(db);
    expect(JSON.stringify(tables)).toBe(snapshot);
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });
});
