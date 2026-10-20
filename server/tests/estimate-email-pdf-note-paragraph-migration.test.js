// Non-database half of the 20261019210000 migration check: the block transform.
// The published-version behavior is proved by the opt-in PostgreSQL suite beside it.
const migration = require('../models/migrations/20261019210000_estimate_email_pdf_note_paragraph');
const first = require('../models/migrations/20261019200000_estimate_email_pdf_note');

const { retypeNoteBlocks, isNoteBlock } = migration._private;
const SMALL = { type: 'small_note', content: '{{estimate_pdf_note}}' };

describe('estimate email PDF note paragraph migration: the block transform', () => {
  test('turns the note small_note into a paragraph and touches nothing else', () => {
    const blocks = [
      { type: 'paragraph', content: 'Hi {{first_name}}' },
      { type: 'cta', label: 'View', url_variable: 'estimate_url' },
      SMALL,
      { type: 'small_note', content: 'Admin closing line.' },
      { type: 'signature', content: '— The Waves Team' },
    ];
    const snapshot = structuredClone(blocks);
    const out = retypeNoteBlocks(blocks);
    expect(out.changed).toBe(true);
    expect(out.blocks[2]).toEqual({ type: 'paragraph', content: '{{estimate_pdf_note}}' });
    expect(out.blocks.filter((_, i) => i !== 2)).toEqual(snapshot.filter((_, i) => i !== 2));
    expect(out.blocks).toHaveLength(blocks.length);
    expect(blocks).toEqual(snapshot);
  });

  test('keeps any other fields on the note block', () => {
    expect(retypeNoteBlocks([{ ...SMALL, extra: 'kept' }]).blocks[0]).toEqual({ type: 'paragraph', content: '{{estimate_pdf_note}}', extra: 'kept' });
  });

  test('an already-paragraph note, or no note, is unchanged', () => {
    expect(retypeNoteBlocks([{ type: 'paragraph', content: '{{estimate_pdf_note}}' }]).changed).toBe(false);
    expect(retypeNoteBlocks([{ type: 'paragraph', content: 'Hi' }, { type: 'small_note', content: 'Other' }]).changed).toBe(false);
    expect(retypeNoteBlocks([]).changed).toBe(false);
  });

  test('only a block whose content is exactly the variable counts', () => {
    expect(isNoteBlock(SMALL)).toBe(true);
    expect(isNoteBlock({ type: 'small_note', content: 'See {{estimate_pdf_note}} here' })).toBe(false);
    expect(isNoteBlock({ type: 'small_note', content: ' {{estimate_pdf_note}}' })).toBe(false);
    expect(retypeNoteBlocks([{ type: 'small_note', content: 'See {{estimate_pdf_note}} here' }]).changed).toBe(false);
    expect(isNoteBlock(null)).toBe(false);
  });

  test('is idempotent', () => {
    const once = retypeNoteBlocks([SMALL]).blocks;
    expect(retypeNoteBlocks(once)).toEqual({ blocks: once, changed: false });
  });

  test('it consumes exactly what 20261019200000 produces', () => {
    const inserted = first._private.insertPdfNote([{ type: 'paragraph', content: 'Hi' }, { type: 'cta', label: 'View', url_variable: 'estimate_url' }, { type: 'signature' }]);
    const out = retypeNoteBlocks(inserted);
    expect(out.changed).toBe(true);
    expect(out.blocks[2]).toEqual({ type: 'paragraph', content: '{{estimate_pdf_note}}' });
  });

  test('is a data-only migration with a no-op down', async () => {
    await expect(migration.down()).resolves.toBeUndefined();
    expect(Object.keys(migration).sort()).toEqual(['_private', 'down', 'up']);
  });
});
