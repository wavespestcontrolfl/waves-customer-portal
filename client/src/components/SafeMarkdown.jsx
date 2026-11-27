/**
 * Plain-markdown reader (offer letter, signed copy, applicant offer page).
 * Returns React nodes only (no dangerouslySetInnerHTML): headings, bullet and
 * numbered lists, pipe tables, rules, paragraphs, **bold** and [label](https://...) links.
 * Any other link target stays literal text, and raw HTML shows as text.
 * A trailing heading anchor ` {#anchor}` is dropped. No app-specific imports.
 */
import React from "react";

const INLINE_TOKEN_RE = /(\[[^\]\n]+\]\(https:\/\/[^)\s]+\)|\*\*[^*]+\*\*)/g;
const LINK_TOKEN_RE = /^\[([^\]\n]+)\]\((https:\/\/[^)\s]+)\)$/;
const ANCHOR_RE = /\s+\{#[^}]*\}\s*$/;

function renderInline(text) {
  return String(text)
    .split(INLINE_TOKEN_RE)
    .map((part, i) => {
      if (i % 2 === 0) return part;
      const link = LINK_TOKEN_RE.exec(part);
      if (link) {
        return (
          <a key={i} href={link[2]} target="_blank" rel="noopener noreferrer" className="underline text-[#04395E] decoration-[#F0A500] underline-offset-2">
            {link[1]}
          </a>
        );
      }
      return (
        <strong key={i} className="font-semibold text-[#04395E]">
          {part.slice(2, -2)}
        </strong>
      );
    });
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const BULLET_RE = /^\s*[-*]\s+(.*)$/;
// A numbered item keeps its own number (up to 9 digits, as in CommonMark).
const NUMBER_RE = /^\s*(\d{1,9})[.)]\s+(.*)$/;
const RULE_RE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const TABLE_SEP_RE = /^\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?$/;
const MAX_TABLE_COLS = 12;
const MAX_TABLE_ROWS = 200;
const MAX_TABLE_CELLS = 1000;

function splitTableCells(line) {
  const trimmed = line.trim();
  const inner = trimmed.startsWith("|") ? trimmed.slice(1) : trimmed;
  const cells = [];
  let current = "";
  let endedWithUnescapedPipe = false;
  for (let i = 0; i < inner.length; i += 1) {
    if (inner[i] === "\\" && inner[i + 1] === "|") {
      current += "|";
      endedWithUnescapedPipe = false;
      i += 1;
    } else if (inner[i] === "|") {
      cells.push(current.trim());
      current = "";
      endedWithUnescapedPipe = true;
    } else {
      current += inner[i];
      endedWithUnescapedPipe = false;
    }
  }
  if (!endedWithUnescapedPipe) cells.push(current.trim());
  return cells;
}

function tryParseTable(lines, startIndex, remainingCells) {
  if (startIndex + 1 >= lines.length) return null;
  if (!lines[startIndex].includes("|") || !TABLE_SEP_RE.test(lines[startIndex + 1].trim())) return null;
  const headers = splitTableCells(lines[startIndex]);
  if (headers.length < 2 || headers.length > MAX_TABLE_COLS) return null;
  const rows = [];
  let cursor = startIndex + 2;
  while (cursor < lines.length && lines[cursor].includes("|") && lines[cursor].trim()) {
    if (rows.length >= MAX_TABLE_ROWS) return null;
    rows.push(splitTableCells(lines[cursor]));
    cursor += 1;
  }
  const cells = headers.length * (rows.length + 1);
  if (cells > remainingCells) return null;
  return { headers, rows, cells, nextIndex: cursor };
}

export function parseBlocks(markdown) {
  const blocks = [];
  const lines = String(markdown || "").replace(/\r/g, "").split("\n");
  let para = [];
  let list = null;
  let renderedCells = 0;
  const flushPara = () => {
    if (para.length) blocks.push({ type: "p", text: para.join("\n") });
    para = [];
  };
  const flushList = () => {
    if (list) blocks.push(list);
    list = null;
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const table = tryParseTable(lines, i, MAX_TABLE_CELLS - renderedCells);
    if (table) {
      flushPara();
      flushList();
      blocks.push({ type: "table", headers: table.headers, rows: table.rows });
      renderedCells += table.cells;
      i = table.nextIndex - 1;
      continue;
    }
    const heading = HEADING_RE.exec(line);
    const bullet = BULLET_RE.exec(line);
    const numbered = bullet ? null : NUMBER_RE.exec(line);
    if (!line.trim() || RULE_RE.test(line) || heading) {
      flushPara();
      flushList();
      if (heading) blocks.push({ type: "h", level: heading[1].length, text: heading[2].replace(ANCHOR_RE, "") });
      else if (line.trim()) blocks.push({ type: "hr" });
    } else if (bullet || numbered) {
      flushPara();
      const type = bullet ? "ul" : "ol";
      if (list && list.type !== type) flushList();
      list = list || { type, items: [] };
      // "1. Hours", a blank line, then "2. Pay" are two lists; each item shows its own number, so Pay still reads 2.
      list.items.push(bullet ? { text: bullet[1] } : { text: numbered[2], number: Number(numbered[1]) });
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();
  return blocks;
}

function TableBlock({ block }) {
  return (
    <div className="my-3 overflow-x-auto rounded-md border border-[#D5DEE5]">
      <table className="w-full border-collapse text-14 text-[#1E293B]">
        <thead>
          <tr className="bg-[#F1F7FA] border-b-2 border-[#04395E]">
            {block.headers.map((header, idx) => (
              <th key={idx} className="px-3 py-2 text-left font-bold text-[#04395E]">
                {renderInline(header)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, rowIdx) => (
            <tr key={rowIdx} className="border-b border-[#D5DEE5] last:border-b-0">
              {block.headers.map((_, colIdx) => (
                <td key={colIdx} className="px-3 py-2 align-top">
                  {renderInline(row[colIdx] ?? "")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Block({ block }) {
  if (block.type === "hr") return <hr className="border-hairline border-[#D5DEE5] my-4" />;
  if (block.type === "table") return <TableBlock block={block} />;
  if (block.type === "h") {
    return (
      <div className="text-[16px] font-bold text-[#04395E] mt-4 mb-1.5 border-b border-[#D5DEE5] pb-1" role="heading" aria-level={Math.min(block.level + 2, 6)}>
        {renderInline(block.text)}
      </div>
    );
  }
  if (block.type === "p") {
    return <p className="text-[15px] leading-relaxed text-[#1E293B] mb-2.5 whitespace-pre-line">{renderInline(block.text)}</p>;
  }
  const List = block.type === "ol" ? "ol" : "ul";
  return (
    <List className={`text-[15px] leading-relaxed text-[#1E293B] mb-2.5 pl-5 space-y-1 ${block.type === "ol" ? "list-decimal" : "list-disc"}`}>
      {block.items.map((item, i) => (
        <li key={i} value={item.number}>
          {renderInline(item.text)}
        </li>
      ))}
    </List>
  );
}

export default function SafeMarkdown({ markdown, className = "" }) {
  const blocks = parseBlocks(markdown);
  return (
    <div className={className}>
      {blocks.map((block, i) => (
        <Block key={i} block={block} />
      ))}
    </div>
  );
}
