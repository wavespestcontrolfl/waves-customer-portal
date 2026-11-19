/**
 * Plain-markdown reader for the offer letter and the signed copy. Returns
 * React nodes only (no dangerouslySetInnerHTML): headings, bullet and
 * numbered lists, rules, paragraphs. Inline bold and links go through the
 * shared renderAnswerInline (https and /admin links only; anything else
 * stays literal text). Raw HTML in the text shows as text.
 */
import React from "react";
import { renderAnswerInline } from "../answerInline";

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const BULLET_RE = /^\s*[-*]\s+(.*)$/;
const NUMBER_RE = /^\s*\d+[.)]\s+(.*)$/;
const RULE_RE = /^\s*([-*_])(\s*\1){2,}\s*$/;

const INLINE = { strong: { className: "font-medium" } };

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
    const item = BULLET_RE.exec(line) || NUMBER_RE.exec(line);
    if (!line.trim() || RULE_RE.test(line) || heading) {
      flushPara();
      flushList();
      if (heading) blocks.push({ type: "h", level: heading[1].length, text: heading[2] });
      else if (line.trim()) blocks.push({ type: "hr" });
    } else if (item) {
      flushPara();
      const type = BULLET_RE.test(line) ? "ul" : "ol";
      if (list && list.type !== type) flushList();
      list = list || { type, items: [] };
      list.items.push(item[1]);
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
        {renderAnswerInline(block.text, INLINE)}
      </div>
    );
  }
  if (block.type === "p") {
    return <p className="text-14 text-zinc-800 mb-2 whitespace-pre-line">{renderAnswerInline(block.text, INLINE)}</p>;
  }
  const List = block.type === "ol" ? "ol" : "ul";
  return (
    <List className={`text-14 text-zinc-800 mb-2 pl-5 ${block.type === "ol" ? "list-decimal" : "list-disc"}`}>
      {block.items.map((item, i) => (
        <li key={i}>{renderAnswerInline(item, INLINE)}</li>
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
