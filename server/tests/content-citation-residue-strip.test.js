/**
 * Contract for the deterministic citation-residue strip (2026-08-04).
 *
 * Since 2026-07-27 the managed-agent writer emits <cite> wrappers on most
 * first drafts despite the prompt ban, which burned the run's single
 * autonomous redraft on markup the guardrail itself declares has no
 * legitimate published form — 3 straight zero-post days (08-02→08-04).
 *
 * The contract has three edges that must not drift:
 *   1. Unambiguous artifacts strip losslessly (wrapper inner text kept,
 *      pure tokens deleted) and the stripped copy passes the gate.
 *   2. Ambiguous forms (bare index=N, markdown footnotes) are NOT
 *      stripped and still trip the gate — deletion there loses content.
 *   3. emit_draft applies the strip to body AND publishable frontmatter
 *      strings, records the fact, and never silently no-ops.
 */

jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../models/db', () => jest.fn());

const { stripCitationResidue, _internals } = require('../services/content/content-guardrails');
const { citationResidueFinding } = _internals;

describe('stripCitationResidue', () => {
  it('unwraps <cite> keeping the inner prose (attribution IS the content)', () => {
    const { text, changed } = stripCitationResidue(
      'Per <cite index="12">UF/IFAS entomologists</cite>, German roaches breed indoors.',
    );
    expect(text).toBe('Per UF/IFAS entomologists, German roaches breed indoors.');
    expect(changed).toBe(true);
    expect(citationResidueFinding(text)).toBeNull();
  });

  it('unwraps multiline and attribute-less cite wrappers', () => {
    const { text } = stripCitationResidue('A <cite>first\nsecond</cite> B <cite data-x="1">third</cite> C');
    expect(text).toBe('A first\nsecond B third C');
  });

  it('removes stray unpaired cite tags', () => {
    const { text } = stripCitationResidue('Roaches </cite> thrive <cite index="3"> in mulch.');
    expect(text).toBe('Roaches  thrive  in mulch.');
    expect(citationResidueFinding(text)).toBeNull();
  });

  it('deletes pure model-tooling tokens outright', () => {
    const { text } = stripCitationResidue(
      'Bait works.citeturn0search0 See【4†source】 also :contentReference[oaicite:2]{index=2} here.',
    );
    expect(text).toBe('Bait works. See also  here.');
    expect(citationResidueFinding(text)).toBeNull();
  });

  it('deletes private-use-area citation glyphs', () => {
    const dirty = `Sod webworms feed at night.\uE200citeturn0search3\uE201`;
    const { text, changed } = stripCitationResidue(dirty);
    expect(text).toBe('Sod webworms feed at night.');
    expect(changed).toBe(true);
    expect(citationResidueFinding(text)).toBeNull();
  });

  it('does NOT touch ambiguous forms — they stay for the gate', () => {
    for (const ambiguous of [
      'The board lists index="4" as the column key.',
      'Chinch bugs kill grass.[^1]\n\n[^1]: IFAS bulletin.',
    ]) {
      const { text, changed } = stripCitationResidue(ambiguous);
      expect(text).toBe(ambiguous);
      expect(changed).toBe(false);
      expect(citationResidueFinding(text)).not.toBeNull();
    }
  });

  it('reports changed=false on clean prose', () => {
    const clean = 'Per UF/IFAS, sod webworm damage peaks in late summer.';
    expect(stripCitationResidue(clean)).toEqual({ text: clean, changed: false });
  });

  it('handles a ">" inside a quoted cite attribute (codex r1)', () => {
    const { text } = stripCitationResidue('Per <cite title="UF > IFAS">UF/IFAS</cite>, bait works.');
    expect(text).toBe('Per UF/IFAS, bait works.');
    expect(citationResidueFinding(text)).toBeNull();
  });

  it('stays in sync with the detector on case and bare oaicite remnants (codex r1)', () => {
    const { text } = stripCitationResidue('Bait works.CITETURN0SEARCH0 See oaicite here.');
    expect(text).toBe('Bait works. See  here.');
    expect(citationResidueFinding(text)).toBeNull();
  });
});

describe('emit_draft strips at capture', () => {
  const { executeBriefTool, getDraft, clearDraft } = require('../services/content/agents/brief-driven-tools');
  const SESSION = 'test-session-cite-strip';
  afterEach(() => clearDraft(SESSION));

  it('sanitizes body and publishable frontmatter strings and records the strip', async () => {
    const res = await executeBriefTool('emit_draft', {
      frontmatter: {
        title: 'Roach ID guide <cite index="1">IFAS</cite>',
        meta_description: 'Plain description.',
        domains: ['wavespestcontrol.com'],
        hero_image: { src: '/img/roach.webp', alt: 'German roach <cite>IFAS photo</cite>' },
      },
      body: 'German roaches breed indoors.citeturn0search1 Palmetto bugs do not.',
      claims_ledger: [],
    }, { sessionId: SESSION });
    expect(res.ok).toBe(true);

    const draft = getDraft(SESSION);
    expect(draft.body).toBe('German roaches breed indoors. Palmetto bugs do not.');
    expect(draft.frontmatter.title).toBe('Roach ID guide IFAS');
    expect(draft.frontmatter.meta_description).toBe('Plain description.');
    expect(draft.frontmatter.domains).toEqual(['wavespestcontrol.com']);
    // Nested publishable strings (hero_image.alt joins publishableText on
    // new-page drafts) strip too — codex r1.
    expect(draft.frontmatter.hero_image).toEqual({ src: '/img/roach.webp', alt: 'German roach IFAS photo' });
    expect(draft.citation_residue_stripped).toBe(true);
    expect(res.body_chars).toBe(draft.body.length);
  });

  it('records citation_residue_stripped=false on a clean draft', async () => {
    const res = await executeBriefTool('emit_draft', {
      frontmatter: { title: 'Clean title' },
      body: 'Clean body.',
    }, { sessionId: SESSION });
    expect(res.ok).toBe(true);
    expect(getDraft(SESSION).citation_residue_stripped).toBe(false);
  });
});
