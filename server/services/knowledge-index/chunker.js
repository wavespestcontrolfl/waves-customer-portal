/**
 * Deterministic document chunker for the knowledge index.
 *
 * Splits on markdown headings first (a chunk should not straddle sections),
 * merges small neighbors, and hard-splits oversized sections at paragraph
 * boundaries. Pure — no DB, no LLM — so ingest hashes are stable across runs.
 */

const MAX_CHARS = 3000;
const MIN_CHARS = 200;

function splitOnHeadings(content) {
  const lines = String(content || '').split('\n');
  const sections = [];
  let current = [];
  for (const line of lines) {
    if (/^#{1,3}\s/.test(line) && current.length) {
      sections.push(current.join('\n'));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length) sections.push(current.join('\n'));
  return sections;
}

function hardSplit(text, maxChars) {
  const out = [];
  const paragraphs = text.split(/\n\n+/);
  let buf = '';
  for (const p of paragraphs) {
    if (buf && (buf.length + p.length + 2) > maxChars) {
      out.push(buf);
      buf = p;
    } else {
      buf = buf ? `${buf}\n\n${p}` : p;
    }
    // A single paragraph beyond maxChars (pasted lists, minified text) is
    // sliced flat — better an ugly boundary than an unembeddable chunk.
    while (buf.length > maxChars) {
      out.push(buf.slice(0, maxChars));
      buf = buf.slice(maxChars);
    }
  }
  if (buf.trim()) out.push(buf);
  return out;
}

/**
 * chunkDocument({ title, content }) → [{ chunkIndex, text }]
 * Every chunk text is prefixed with the document title so a chunk embeds
 * (and full-text matches) with its subject attached — the Cerebras
 * "thread topic prepended as context" pattern.
 */
function chunkDocument({ title, content }, { maxChars = MAX_CHARS, minChars = MIN_CHARS } = {}) {
  const body = String(content || '').trim();
  if (!body) return [];

  const merged = [];
  for (const section of splitOnHeadings(body)) {
    const last = merged[merged.length - 1];
    if (last !== undefined && (last.length < minChars || section.length < minChars) && (last.length + section.length + 2) <= maxChars) {
      merged[merged.length - 1] = `${last}\n\n${section}`;
    } else {
      merged.push(section);
    }
  }

  const pieces = merged.flatMap((section) => (section.length > maxChars ? hardSplit(section, maxChars) : [section]));

  const prefix = title ? `${title}\n\n` : '';
  return pieces
    .map((text) => text.trim())
    .filter(Boolean)
    .map((text, chunkIndex) => ({ chunkIndex, text: `${prefix}${text}` }));
}

module.exports = { chunkDocument, MAX_CHARS, MIN_CHARS };
