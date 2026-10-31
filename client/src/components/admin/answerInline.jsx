/**
 * Inline text in an Ask answer: bold and Markdown links, [label](target).
 * client/src/components/admin/answerInline.jsx
 *
 * One renderer for every Ask bar: the palette (GlobalCommandPalette), the
 * page bar (IntelligenceBarShell) and the field bar (TechIntelligenceBar).
 * The server asks the model to lead with a record link: an /admin path opens
 * in the app (a plain click also calls onNavigate, so a bar can close); an
 * https link opens in a new tab. Any other target (http:, javascript:, data:,
 * mailto:, //host, a backslash) stays as the literal text, and so does a link
 * whose label names any other web address (an answer can quote
 * customer-written text).
 */
import { Link } from "react-router-dom";

const INLINE_TOKEN_RE = /(\[[^\]\n]+\]\([^)\s]+\)|\*\*[^*]+\*\*)/g;
const LINK_TOKEN_RE = /^\[([^\]\n]+)\]\(([^)\s]+)\)$/;
const HOST_TOKEN_RE = /(?:[a-z0-9-]+\.)+[a-z]{2,}/gi;
const CODE_TOKEN_RE = /(`[^`]+`)/g;
const LINK_STYLE = { color: "inherit", textDecoration: "underline" };

function answerLinkTarget(label, target) {
  if (target.includes("\\")) return null;
  if (/^\/admin(?:[/?#]|$)/i.test(target)) return { to: target };
  let url;
  try { url = new URL(target); } catch { return null; }
  if (url.protocol !== "https:") return null;
  if ((label.match(HOST_TOKEN_RE) || []).some((host) => host.toLowerCase() !== url.hostname)) return null;
  return { href: url.href };
}

// `strong` and `code` are the props each bar gives its <strong> and <code>
// elements. Without `code`, backticks stay as typed (the palette and the
// field bar never rendered code spans).
export function renderAnswerInline(text, options = {}) {
  const { onNavigate, strong, code } = options;
  return text.split(INLINE_TOKEN_RE).map((part, i) => {
    if (i % 2 === 0) {
      if (!code || !part.includes("`")) return part;
      return part.split(CODE_TOKEN_RE).map((piece, j) =>
        j % 2 ? <code key={`${i}-${j}`} {...code}>{piece.slice(1, -1)}</code> : piece);
    }
    const link = part.match(LINK_TOKEN_RE);
    if (!link) return <strong key={i} {...strong}>{renderAnswerInline(part.slice(2, -2), options)}</strong>;
    const target = answerLinkTarget(link[1], link[2]);
    if (!target) return part;
    const label = renderAnswerInline(link[1], options);
    return target.to ? (
      <Link key={i} to={target.to} style={LINK_STYLE}
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
          onNavigate?.();
        }}>
        {label}
      </Link>
    ) : (
      <a key={i} href={target.href} target="_blank" rel="noopener noreferrer" style={LINK_STYLE}>
        {label}
      </a>
    );
  });
}
