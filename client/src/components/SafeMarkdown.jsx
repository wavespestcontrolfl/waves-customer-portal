/**
 * Plain-markdown reader (offer letter, signed copy, applicant offer page).
 * Returns React nodes only (no dangerouslySetInnerHTML): headings, bullet and
 * numbered lists, rules, paragraphs, **bold** and [label](https://...) links.
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
          <a key={i} href={link[2]} target="_blank" rel="noopener noreferrer" className="underline">
            {link[1]}
          </a>
        );
      }
      return (
        <strong key={i} className="font-medium">
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

export function parseBlocks(markdown) {
  const blocks = [];
  let para = [];
  let list = null;
  const flushPara = () => {
    if (para.length) blocks.push({ type: "p", text: para.join("\n") });
    para = [];
  };
  const flushList = () => {
    if (list) blocks.push(list);
    list = null;
  };
  for (const line of String(markdown || "").replace(/\r/g, "").split("\n")) {
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

function Block({ block }) {
  if (block.type === "hr") return <hr className="border-hairline border-zinc-200 my-3" />;
  if (block.type === "h") {
    return (
      <div className="text-14 font-medium text-zinc-900 mt-3 mb-1" role="heading" aria-level={Math.min(block.level + 2, 6)}>
        {renderInline(block.text)}
      </div>
    );
  }
  if (block.type === "p") {
    return <p className="text-14 text-zinc-800 mb-2 whitespace-pre-line">{renderInline(block.text)}</p>;
  }
  const List = block.type === "ol" ? "ol" : "ul";
  return (
    <List className={`text-14 text-zinc-800 mb-2 pl-5 ${block.type === "ol" ? "list-decimal" : "list-disc"}`}>
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
