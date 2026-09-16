const { decodeHTML } = require('entities');

// Resource limits for lexical screening, independent of the presentation
// policy's word budget. Check raw input before decoding or matching it.
const COPY_LIMITS = Object.freeze({ bytes: 8192, tokens: 512, formatPasses: 8 });
const failure = (reason) => ({ ok: false, text: null, reason });

function exceedsSize(text) {
  return text.length > COPY_LIMITS.bytes
    || Buffer.byteLength(text, 'utf8') > COPY_LIMITS.bytes;
}

function normalizeEmailReplyCopy(text = '') {
  if (typeof text !== 'string') return failure('copy_type');
  if (exceedsSize(text)) return failure('copy_size');
  if ((text.match(/\S+/g) || []).length > COPY_LIMITS.tokens) return failure('copy_tokens');

  let copy = decodeHTML(text).normalize('NFKC')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/\\(?:\r\n?|\n)/g, ' ')
    .replace(/\\([-!"#$%&'()*+,.\/:;<=>?@[\]^_`{|}~\\])/g, '$1')
    .replace(/\s+/g, ' ');
  // Compatibility normalization can expand characters or introduce spaces.
  if (exceedsSize(copy)) return failure('copy_size');
  if ((copy.match(/\S+/g) || []).length > COPY_LIMITS.tokens) return failure('copy_tokens');

  for (let pass = 0; pass < COPY_LIMITS.formatPasses; pass += 1) {
    const next = copy
      .replace(/(?<!`)(`+)(?!`)([^`]+?)\1(?!`)/g, '$2')
      .replace(/(\*\*\*|___|\*\*|__|\*|_)([^\s*_](?:[^\r\n]*?[^\s*_])?)\1/g, '$2');
    if (next === copy) return { ok: true, text: copy };
    copy = next;
  }
  // Never return a partially normalized success when nesting exhausts work.
  return failure('copy_format_depth');
}

module.exports = { normalizeEmailReplyCopy, COPY_LIMITS };
