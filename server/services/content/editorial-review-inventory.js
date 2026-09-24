'use strict';

const { LIMITS } = require('./editorial-review-contracts');

const TEMPLATE_TOKEN_RE = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g;
const DECORATIVE_HEADING_RE = /^(?:table of contents|contents|related (?:articles|guides|posts)|more (?:articles|guides|resources)|resources|sources|references|share this|about the author|get help|contact(?: us)?|ready to (?:start|book)|next steps?)(?:\s*[:!?])?$/i;
const CTA_PARAGRAPH_RE = /^(?:(?:call|contact)\s+(?:us|today|now|for|to)\b|(?:book|schedule)\s+(?:now|today|an?|your|online|service)\b|request\s+(?:an?|your)\b|get (?:a |your )?(?:quote|estimate)\b|learn more\b|read more\b|share this\b|subscribe\b)/i;
const NAV_PARAGRAPH_RE = /^(?:[-*+]\s*)?(?:\[[^\]]+\]\([^)]+\)(?:\s*[|·,]\s*)?){1,}$/;
const FACTUAL_QUESTION_RE = /(?:\$|%|\b\d+(?:[.,]\d+)?\b|["“][^"”]{3,}["”]|\baccording to\b)/i;

function splitFrontmatter(document) {
  const text = String(document || '');
  const match = /^(---\r?\n[\s\S]*?\r?\n---)([\s\S]*)$/.exec(text);
  return match ? { frontmatter: match[1], body: match[2] } : { frontmatter: '', body: text };
}

function decorativeRanges(body) {
  const headings = [...String(body || '').matchAll(/^#{2,6}\s+(.+?)\s*$/gm)]
    .map((match) => ({ heading: match[1], offset: match.index }));
  return headings.map((item, index) => ({ start: item.offset, end: headings[index + 1]?.offset ?? body.length, decorative: DECORATIVE_HEADING_RE.test(item.heading) }));
}

function isNavigationParagraph(text) {
  if (NAV_PARAGRAPH_RE.test(text)) return true;
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.length > 0 && lines.every((line) => /^(?:[-*+]\s*)?\[[^\]]+\]\([^)]+\)\s*$/.test(line));
}

function mdxInnerProse(raw, startingFence = null) {
  let fenceMarker = startingFence;
  const visible = [];
  for (const line of String(raw || '').match(/[^\r\n]*(?:\r?\n|$)/g) || []) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]?.[0];
    if (marker) { fenceMarker = fenceMarker === marker ? null : (fenceMarker || marker); continue; }
    if (!fenceMarker) visible.push(line);
  }
  let text = visible.join('').trim();
  if (/^<[A-Z][A-Za-z0-9_.]*(?:\s[^<>]*?)?\/?>$/.test(text)) return { text: '', fenceMarker };
  text = text.replace(/^<[A-Z][A-Za-z0-9_.]*(?:\s[^<>]*?)?>\s*/, '');
  text = text.replace(/\s*<\/[A-Z][A-Za-z0-9_.]*\s*>$/, '');
  return { text: text.trim(), fenceMarker };
}

function proseParagraphs(body) {
  const chunks = [];
  const ranges = decorativeRanges(body);
  let offset = 0;
  let fenceMarker = null;
  for (const match of String(body || '').matchAll(/[^\r\n](?:[\s\S]*?[^\r\n])?(?=(?:\r?\n){2,}|$)/g)) {
    const raw = match[0];
    offset = match.index || offset;
    const segments = [];
    let segmentStart = 0;
    for (const heading of raw.matchAll(/^#{1,6}\s+[^\r\n]+(?:\r?\n|$)/gm)) {
      if (heading.index > segmentStart) segments.push({ raw: raw.slice(segmentStart, heading.index), offset: offset + segmentStart });
      segmentStart = heading.index + heading[0].length;
    }
    if (segmentStart < raw.length) segments.push({ raw: raw.slice(segmentStart), offset: offset + segmentStart });
    for (const segment of segments) {
      const prose = mdxInnerProse(segment.raw, fenceMarker);
      let { text } = prose;
      fenceMarker = prose.fenceMarker;
      while (text && CTA_PARAGRAPH_RE.test(text)) {
        const firstSentence = /^[\s\S]*?(?:[.!?](?:\s+|$)|\r?\n)/.exec(text);
        text = firstSentence ? text.slice(firstSentence[0].length).trim() : '';
      }
      if (text && !/^(?:import|export)\s/.test(text) && !/^<!--/.test(text)) {
        const inDecorativeSection = ranges.some((range) => range.decorative && segment.offset > range.start && segment.offset < range.end);
        if (!inDecorativeSection && !isNavigationParagraph(text)) chunks.push({ id: `P${chunks.length + 1}`, text, offset: segment.offset });
      }
    }
    offset += raw.length;
  }
  return chunks;
}

function sectionInventory(body, paragraphs, title) {
  const allHeadings = [];
  for (const match of String(body || '').matchAll(/^(#{2,6})\s+(.+?)\s*$/gm)) {
    allHeadings.push({ heading: match[2], offset: match.index });
  }
  const headings = allHeadings.filter((item) => !DECORATIVE_HEADING_RE.test(item.heading));
  const sections = [];
  const firstHeadingOffset = allHeadings[0]?.offset ?? body.length;
  const intro = paragraphs.find((paragraph) => paragraph.offset < firstHeadingOffset);
  if (intro) sections.push({ heading: title || 'Introduction', lead: intro.text });
  for (const item of headings) {
    const end = allHeadings.find((heading) => heading.offset > item.offset)?.offset ?? body.length;
    const lead = paragraphs.find((p) => p.offset > item.offset && p.offset < end)?.text || '';
    sections.push({ heading: item.heading, lead });
  }
  if (!sections.length && paragraphs[0]) sections.push({ heading: title || 'Introduction', lead: paragraphs[0].text });
  return sections.map((section, index) => ({ id: `S${index + 1}`, ...section }));
}

function sentenceCandidates(paragraphs) {
  const candidates = [];
  for (const paragraph of paragraphs) {
    const sentences = [];
    for (const { segment } of new Intl.Segmenter('en', { granularity: 'sentence' }).segment(paragraph.text)) {
      const last = sentences.length - 1;
      if (last >= 0 && /\b(?:Dr|Mr|Mrs|Ms|Prof|Sr|Jr|St)\.\s*$/.test(sentences[last])) sentences[last] += segment;
      else sentences.push(segment);
    }
    for (const raw of sentences) {
      const passage = raw.trim();
      const words = passage.match(/[A-Za-z0-9][A-Za-z0-9'’-]*/g) || [];
      if (words.length < 2 || (passage.endsWith('?') && !FACTUAL_QUESTION_RE.test(passage)) || CTA_PARAGRAPH_RE.test(passage)) continue;
      candidates.push({ id: `C${candidates.length + 1}`, passage, paragraphId: paragraph.id });
    }
  }
  return candidates;
}

function templateTokens(document) {
  const found = [];
  for (const match of String(document || '').matchAll(TEMPLATE_TOKEN_RE)) found.push({ raw: match[0], name: match[1] });
  return found;
}

function analyzeDocument(document, title) {
  const { body } = splitFrontmatter(document);
  const passages = proseParagraphs(body);
  return {
    sections: sectionInventory(body, passages, title),
    passages,
    claims: sentenceCandidates(passages),
    tokens: templateTokens(document),
  };
}

function inventoryLimitError(analysis) {
  if (analysis.sections.length > LIMITS.sections) return `section inventory exceeds ${LIMITS.sections}`;
  if (analysis.passages.length > LIMITS.passages) return `passage inventory exceeds ${LIMITS.passages}`;
  if (analysis.claims.length > LIMITS.claims) return `claim inventory exceeds ${LIMITS.claims}`;
  return null;
}

function structuralArtifacts(body) {
  const collect = (regex) => [...String(body || '').matchAll(regex)].map((match) => match[0]).sort();
  return {
    imports: importExportBlocks(body),
    mdxTags: [...String(body || '').matchAll(/<[A-Z][A-Za-z0-9_.]*(?:\s[^<>]*?)?\/?>|<\/[A-Z][A-Za-z0-9_.]*\s*>/gs)].map((match) => match[0]),
    images: collect(/!\[[^\]\n]*\]\([^\n)]+\)|<img\b[^>]*>/gi),
    anchors: collect(/\{#[A-Za-z][\w:.-]*\}|<a\b[^>]*(?:id|name)=["'][^"']+["'][^>]*>/gi),
    tokens: collect(/\{\{\s*[A-Za-z][A-Za-z0-9_]*\s*\}\}/g),
  };
}

function importExportBlocks(body) {
  const lines = String(body || '').split(/(?<=\n)/);
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^(?:import|export)\b/.test(lines[index])) continue;
    let block = lines[index];
    while (!/;\s*(?:\r?\n)?$/.test(block) && index + 1 < lines.length && lines[index + 1].trim()) {
      index += 1;
      block += lines[index];
    }
    blocks.push(block);
  }
  return blocks.sort();
}

function sameArray(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function repairViolation(originalBody, revisedBody) {
  if (typeof revisedBody !== 'string' || !revisedBody.trim()) return 'empty_body';
  if (/^\s*---\r?\n/.test(revisedBody)) return 'frontmatter_in_body';
  const before = structuralArtifacts(originalBody);
  const after = structuralArtifacts(revisedBody);
  for (const key of Object.keys(before)) if (!sameArray(before[key], after[key])) return `${key}_changed`;
  return null;
}

module.exports = {
  analyzeDocument,
  importExportBlocks,
  inventoryLimitError,
  proseParagraphs,
  repairViolation,
  splitFrontmatter,
  structuralArtifacts,
};
