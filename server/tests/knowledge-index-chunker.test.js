const { chunkDocument } = require('../services/knowledge-index/chunker');

describe('knowledge-index chunker', () => {
  test('empty content produces no chunks', () => {
    expect(chunkDocument({ title: 'T', content: '' })).toEqual([]);
    expect(chunkDocument({ title: 'T', content: '   \n ' })).toEqual([]);
  });

  test('short document is a single chunk prefixed with the title', () => {
    const chunks = chunkDocument({ title: 'Chinch bugs', content: 'Treat with bifenthrin.' });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({ chunkIndex: 0, text: 'Chinch bugs\n\nTreat with bifenthrin.' });
  });

  test('splits on markdown headings and keeps sections whole', () => {
    const content = [
      '# Identification', 'x'.repeat(2000),
      '# Treatment', 'y'.repeat(2000),
    ].join('\n');
    const chunks = chunkDocument({ title: 'Doc', content });
    expect(chunks).toHaveLength(2);
    expect(chunks[0].text).toContain('# Identification');
    expect(chunks[1].text).toContain('# Treatment');
    expect(chunks[1].text).not.toContain('Identification\n');
  });

  test('merges small neighboring sections under one chunk', () => {
    const content = '# A\nshort a\n# B\nshort b\n# C\nshort c';
    const chunks = chunkDocument({ title: 'Doc', content });
    expect(chunks).toHaveLength(1);
  });

  test('hard-splits an oversized single paragraph and never exceeds maxChars', () => {
    const content = 'z'.repeat(10000);
    const chunks = chunkDocument({ title: 'Doc', content }, { maxChars: 3000 });
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(3000 + 'Doc\n\n'.length);
    expect(chunks.map((c) => c.chunkIndex)).toEqual(chunks.map((_, i) => i));
    // no content lost
    const joined = chunks.map((c) => c.text.replace(/^Doc\n\n/, '')).join('');
    expect(joined.length).toBe(10000);
  });

  test('deterministic: identical input yields identical chunks', () => {
    const doc = { title: 'Doc', content: `# A\n${'a'.repeat(500)}\n\n# B\n${'b'.repeat(4000)}` };
    expect(chunkDocument(doc)).toEqual(chunkDocument(doc));
  });
});
