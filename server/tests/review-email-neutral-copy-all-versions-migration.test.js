/**
 * 20261001150000_review_email_neutral_copy_all_versions — draft / archived
 * versions of review_request_email lose the old copy too, so publishing one
 * later can't bring it back. Pins: the active version is left to
 * 20261001120000, exact-match only, compare-and-swap on the value read, an
 * audit event per changed row, idempotent, documented no-op down.
 */
const mockRecordAuditEvent = jest.fn(async () => {});
jest.mock('../services/audit-log', () => ({ recordAuditEvent: (...a) => mockRecordAuditEvent(...a) }));
const migration = require('../models/migrations/20261001150000_review_email_neutral_copy_all_versions');

const OLD_PREVIEW = 'If we earned it, a 15-second Google review would mean the world to our small family business.';
const OLD_CLOSING = "It genuinely makes our day — and helps other local families decide who to trust with their home. If anything fell short, just reply to this email and we'll make it right.";

// blocks behaves like a jsonb column: rows hold it PARSED (as pg returns it),
// and the CAS predicate compares it as JSON.
const asJson = (v) => JSON.stringify(typeof v === 'string' ? JSON.parse(v) : v);
function createKnex(tables, { interfere } = {}) {
  const knex = jest.fn((table) => {
    const preds = [];
    const q = {
      where(a, b) {
        if (typeof a === 'object') Object.entries(a).forEach(([k, v]) => preds.push((r) => r[k] === v));
        else preds.push((r) => r[a] === b);
        return q;
      },
      whereRaw(sql, [json]) {
        expect(sql).toBe('blocks = ?::jsonb');
        expect(typeof json).toBe('string');
        preds.push((r) => asJson(r.blocks) === json);
        return q;
      },
      async first() { return tables[table].find((r) => preds.every((p) => p(r))); },
      async select() { return tables[table].filter((r) => preds.every((p) => p(r))).map((r) => ({ ...r })); },
      async update(patch) {
        if (interfere) interfere(tables);
        const rows = tables[table].filter((r) => preds.every((p) => p(r)));
        rows.forEach((r) => Object.assign(r, patch, patch.blocks ? { blocks: JSON.parse(patch.blocks) } : {}));
        return rows.length;
      },
    };
    return q;
  });
  knex.schema = { hasTable: jest.fn(async () => true) };
  return knex;
}

const SEEDED_INTRO = "We're a small, family-owned pest and lawn company here in Southwest Florida, and word of mouth is how neighbors find us. If your recent service hit the mark, would you take 15 seconds to share a quick review?";
const oldBlocks = ([
  { type: 'paragraph', content: SEEDED_INTRO },
  { type: 'cta', label: 'Leave a quick review', url_variable: 'review_url' },
  { type: 'paragraph', content: OLD_CLOSING },
]);
const seeded = () => ({
  email_templates: [{ id: 't1', template_key: 'review_request_email', active_version_id: 'v-active' }],
  email_template_versions: [
    { id: 'v-active', template_id: 't1', preview_text: OLD_PREVIEW, blocks: oldBlocks },
    { id: 'v-draft', template_id: 't1', preview_text: OLD_PREVIEW, blocks: oldBlocks },
  ],
});

beforeEach(() => mockRecordAuditEvent.mockClear());

test('every version is neutralized, the active one included (it may carry copy 120000 does not match)', async () => {
  const tables = seeded();
  await migration.up(createKnex(tables));
  const [active, draft] = tables.email_template_versions;
  expect(active.preview_text).toBe('A 15-second Google review helps our small family business a lot.');
  expect(active.blocks[0].content).toBe('{{intro_paragraph}}');
  expect(draft.preview_text).toBe('A 15-second Google review helps our small family business a lot.');
  const blocks = draft.blocks;
  expect(blocks[0].content).toBe('{{intro_paragraph}}'); // the old seeded intro, too
  expect(blocks[1].label).toBe('Leave a Google review');
  expect(blocks[2].content).not.toMatch(/fell short|just reply/);
  expect(mockRecordAuditEvent).toHaveBeenCalledTimes(2);
  expect(mockRecordAuditEvent.mock.calls[1][0]).toMatchObject({ resource_type: 'email_template_versions', resource_id: 'v-draft' });
});

test('compare-and-swap on blocks too: an admin edit to the blocks between read and write survives', async () => {
  const tables = seeded();
  tables.email_template_versions[1].preview_text = 'Admin preview.'; // only blocks need changing
  let edited = false;
  await migration.up(createKnex(tables, {
    interfere: (t) => { if (!edited) { edited = true; t.email_template_versions[1].blocks = [{ type: 'paragraph', content: 'Admin blocks.' }]; } },
  }));
  expect(tables.email_template_versions[1].blocks).toEqual([{ type: 'paragraph', content: 'Admin blocks.' }]);
  // Only the active version (untouched by the interfering edit) changed and was audited.
  expect(mockRecordAuditEvent).toHaveBeenCalledTimes(1);
  expect(mockRecordAuditEvent.mock.calls[0][0].resource_id).toBe('v-active');
});

test('compare-and-swap: an admin edit landing between the read and the write is not overwritten', async () => {
  const tables = seeded();
  let edited = false;
  await migration.up(createKnex(tables, {
    interfere: (t) => { if (!edited) { edited = true; t.email_template_versions[1].preview_text = 'Admin wording.'; } },
  }));
  expect(tables.email_template_versions[1].preview_text).toBe('Admin wording.');
  // Only the active version (untouched by the interfering edit) changed and was audited.
  expect(mockRecordAuditEvent).toHaveBeenCalledTimes(1);
  expect(mockRecordAuditEvent.mock.calls[0][0].resource_id).toBe('v-active');
});

test('idempotent, and down() is a no-op', async () => {
  const tables = seeded();
  await migration.up(createKnex(tables));
  const once = JSON.stringify(tables);
  await migration.up(createKnex(tables));
  await migration.down(createKnex(tables));
  expect(JSON.stringify(tables)).toBe(once);
  expect(mockRecordAuditEvent).toHaveBeenCalledTimes(2);
});
