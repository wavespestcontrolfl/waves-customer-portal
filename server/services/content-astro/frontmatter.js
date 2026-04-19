/**
 * frontmatter.js — minimal YAML frontmatter read/write.
 *
 * Scope: what the admin → Astro publish pipeline needs. No full YAML spec.
 *   - parse: scalars (string/number/bool), inline arrays, block arrays,
 *     nested objects, quoted + unquoted strings.
 *   - stringify: same shapes going back out, formatted to match the Astro
 *     content conventions already in the repo.
 *
 * If we ever hit a shape this can't handle, install `yaml` and swap —
 * the function signatures are stable.
 */

function parse(source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(source);
  if (!match) return { data: {}, content: source };
  const [, fm, content] = match;
  return { data: parseYaml(fm), content };
}

function stringify(data, content = '') {
  const body = content.startsWith('\n') ? content : '\n' + content;
  return `---\n${toYaml(data)}---${body}`;
}

// ── YAML parse (subset) ────────────────────────────────────────────

function parseYaml(text) {
  const lines = text.split(/\r?\n/).filter((l) => !/^\s*#/.test(l));
  const { value } = parseBlock(lines, 0, 0);
  return value || {};
}

function parseBlock(lines, startIdx, indent) {
  const obj = {};
  let i = startIdx;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      i++;
      continue;
    }
    const leadingSpaces = line.match(/^ */)[0].length;
    if (leadingSpaces < indent) break;
    if (leadingSpaces > indent) {
      i++;
      continue;
    }

    const trimmed = line.slice(leadingSpaces);
    const colon = trimmed.indexOf(':');
    if (colon === -1) {
      i++;
      continue;
    }
    const key = trimmed.slice(0, colon).trim();
    const rest = trimmed.slice(colon + 1).trim();

    if (rest === '') {
      // Value on following lines — either block array (`- item`) or nested object.
      const next = lines[i + 1] || '';
      const nextIndent = next.match(/^ */)[0].length;
      if (/^\s*-\s/.test(next) && nextIndent > indent) {
        const { value, nextIdx } = parseArray(lines, i + 1, nextIndent);
        obj[key] = value;
        i = nextIdx;
      } else if (nextIndent > indent) {
        const { value, nextIdx } = parseBlock(lines, i + 1, nextIndent);
        obj[key] = value;
        i = nextIdx;
      } else {
        obj[key] = null;
        i++;
      }
    } else if (rest.startsWith('[')) {
      obj[key] = parseInlineArray(rest);
      i++;
    } else if (rest.startsWith('{')) {
      obj[key] = parseInlineObject(rest);
      i++;
    } else {
      obj[key] = parseScalar(rest);
      i++;
    }
  }
  return { value: obj, nextIdx: i };
}

function parseArray(lines, startIdx, indent) {
  const arr = [];
  let i = startIdx;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      i++;
      continue;
    }
    const leadingSpaces = line.match(/^ */)[0].length;
    if (leadingSpaces < indent) break;
    if (leadingSpaces > indent) {
      i++;
      continue;
    }
    const trimmed = line.slice(leadingSpaces);
    if (!trimmed.startsWith('- ')) break;
    const itemText = trimmed.slice(2).trim();
    if (itemText === '' || itemText.endsWith(':')) {
      // Object item — parse nested block.
      const rebuilt = itemText ? [' '.repeat(indent + 2) + itemText] : [];
      let j = i + 1;
      while (j < lines.length) {
        const lj = lines[j];
        if (lj.trim() === '') { j++; continue; }
        const lead = lj.match(/^ */)[0].length;
        if (lead <= indent) break;
        rebuilt.push(lj);
        j++;
      }
      const { value } = parseBlock(rebuilt, 0, indent + 2);
      arr.push(value);
      i = j;
    } else if (itemText.includes(': ')) {
      // Inline object item
      const obj = {};
      const colon = itemText.indexOf(': ');
      obj[itemText.slice(0, colon).trim()] = parseScalar(itemText.slice(colon + 2).trim());
      // Continuation keys on subsequent indented lines
      let j = i + 1;
      while (j < lines.length) {
        const lj = lines[j];
        if (lj.trim() === '') { j++; continue; }
        const lead = lj.match(/^ */)[0].length;
        if (lead <= indent) break;
        const tj = lj.slice(lead);
        const cj = tj.indexOf(':');
        if (cj !== -1) obj[tj.slice(0, cj).trim()] = parseScalar(tj.slice(cj + 1).trim());
        j++;
      }
      arr.push(obj);
      i = j;
    } else {
      arr.push(parseScalar(itemText));
      i++;
    }
  }
  return { value: arr, nextIdx: i };
}

function parseInlineArray(text) {
  const inner = text.trim().replace(/^\[/, '').replace(/\]$/, '');
  if (inner.trim() === '') return [];
  return splitCsv(inner).map((s) => parseScalar(s.trim()));
}

function parseInlineObject(text) {
  const inner = text.trim().replace(/^\{/, '').replace(/\}$/, '');
  const obj = {};
  for (const part of splitCsv(inner)) {
    const colon = part.indexOf(':');
    if (colon === -1) continue;
    obj[part.slice(0, colon).trim()] = parseScalar(part.slice(colon + 1).trim());
  }
  return obj;
}

function splitCsv(text) {
  const parts = [];
  let buf = '';
  let depth = 0;
  let q = null;
  for (const ch of text) {
    if (q) {
      buf += ch;
      if (ch === q) q = null;
      continue;
    }
    if (ch === '"' || ch === "'") { q = ch; buf += ch; continue; }
    if (ch === '[' || ch === '{') depth++;
    if (ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(buf);
      buf = '';
    } else {
      buf += ch;
    }
  }
  if (buf.trim()) parts.push(buf);
  return parts;
}

function parseScalar(text) {
  if (text === '' || text === '~' || text === 'null') return null;
  if (text === 'true') return true;
  if (text === 'false') return false;
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1).replace(/\\"/g, '"');
  }
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  return text;
}

// ── YAML stringify (subset) ────────────────────────────────────────

function toYaml(data, indent = 0) {
  const pad = ' '.repeat(indent);
  let out = '';
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (value === null) {
      out += `${pad}${key}:\n`;
    } else if (Array.isArray(value)) {
      if (value.length === 0) {
        out += `${pad}${key}: []\n`;
      } else if (value.every((v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) {
        out += `${pad}${key}:\n`;
        for (const item of value) out += `${pad}  - ${scalar(item)}\n`;
      } else {
        out += `${pad}${key}:\n`;
        for (const item of value) {
          if (typeof item === 'object' && item !== null) {
            const entries = Object.entries(item);
            const [firstKey, firstVal] = entries[0];
            out += `${pad}  - ${firstKey}: ${scalar(firstVal)}\n`;
            for (let k = 1; k < entries.length; k++) {
              const [kk, vv] = entries[k];
              out += `${pad}    ${kk}: ${scalar(vv)}\n`;
            }
          } else {
            out += `${pad}  - ${scalar(item)}\n`;
          }
        }
      }
    } else if (typeof value === 'object') {
      out += `${pad}${key}:\n`;
      out += toYaml(value, indent + 2);
    } else {
      out += `${pad}${key}: ${scalar(value)}\n`;
    }
  }
  return out;
}

function scalar(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  const s = String(v);
  // Quote when the string contains chars that would confuse the parser, or
  // starts with a token that YAML would coerce (true/false/number/bracket).
  if (
    s === '' ||
    /[:#\-?&*!|>'"%@`]/.test(s.charAt(0)) ||
    /[:\n]/.test(s) ||
    /^(true|false|null|~|-?\d)/.test(s) ||
    /^[\[\{]/.test(s)
  ) {
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return s;
}

module.exports = { parse, stringify };
