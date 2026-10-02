import React, { useEffect, useId, useRef, useState } from "react";

// A Waves blog post for the customer (GATE_REPORT_BLOG_POST, owner "ok go"
// 2026-10-01): search the live Waves blog the way Quick Links searches links,
// and pick one post. The pick goes on the customer's report as "From the
// Waves blog". Optional. `search(query)` answers { posts: [{ id, title, url }] }
// (GET /admin/dispatch/:serviceId/blog-posts?q=); `value` is the picked post.

const SEARCH_DELAY_MS = 250;
const MIN_QUERY_CHARS = 2;

// "pest-control/get-rid-of-ghost-ants-in-sarasota/" from the live URL.
export function blogPostPath(url) {
  try {
    return new URL(url).pathname.replace(/^\/+/, "");
  } catch {
    return "";
  }
}

export default function BlogPostPicker({ search, value = null, onChange, disabled = false, tokens = {} }) {
  const inputId = useId();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [status, setStatus] = useState("idle");
  const sequence = useRef(0);
  const ink = tokens.ink || "#111";
  const muted = tokens.muted || "#525252";
  const border = tokens.border || "#E5E5E5";
  const card = tokens.card || "#fff";

  // Only the latest search may land; a short query clears the list.
  useEffect(() => {
    const q = query.trim();
    const current = ++sequence.current;
    if (q.length < MIN_QUERY_CHARS) {
      setResults([]);
      setStatus("idle");
      return undefined;
    }
    setStatus("searching");
    const timer = setTimeout(() => {
      Promise.resolve()
        .then(() => search(q))
        .then((data) => {
          if (current !== sequence.current) return;
          setResults(Array.isArray(data?.posts) ? data.posts : []);
          setStatus("done");
        })
        .catch(() => {
          if (current !== sequence.current) return;
          setResults([]);
          setStatus("failed");
        });
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [query, search]);

  const rowStyle = (picked) => ({
    display: "block",
    width: "100%",
    textAlign: "left",
    padding: "10px 12px",
    marginTop: 6,
    borderRadius: 10,
    border: `1px solid ${picked ? ink : border}`,
    background: card,
    color: ink,
    font: "inherit",
    fontSize: 14,
    cursor: disabled ? "default" : "pointer",
  });

  return (
    <div style={{ fontFamily: tokens.font, color: ink }} data-testid="blog-post-picker">
      {value ? (
        <div style={{ ...rowStyle(true), cursor: "default" }}>
          <div style={{ fontWeight: 500, lineHeight: 1.35 }}>{value.title}</div>
          <div style={{ fontSize: 14, color: muted, overflowWrap: "anywhere" }}>Picked · {blogPostPath(value.url)}</div>
          <button
            type="button"
            onClick={() => onChange(null)}
            disabled={disabled}
            style={{ marginTop: 8, padding: "6px 12px", borderRadius: 999, border: `1px solid ${border}`, background: card, color: ink, fontSize: 14, cursor: disabled ? "default" : "pointer" }}
          >
            Remove
          </button>
        </div>
      ) : (
        <>
          <input
            id={inputId}
            type="search"
            aria-label="Search the Waves blog"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search the Waves blog, e.g. ghost ants"
            disabled={disabled}
            style={{ ...(tokens.inputStyle || {}), width: "100%", boxSizing: "border-box" }}
          />
          {status === "searching" && <p style={{ margin: "6px 0 0", fontSize: 14, color: muted }}>Searching…</p>}
          {status === "failed" && <p style={{ margin: "6px 0 0", fontSize: 14, color: muted }}>The blog search didn’t answer. Try again.</p>}
          {status === "done" && !results.length && <p style={{ margin: "6px 0 0", fontSize: 14, color: muted }}>No live posts match.</p>}
          {results.map((post) => (
            <button key={post.id} type="button" disabled={disabled} onClick={() => onChange(post)} style={rowStyle(false)}>
              <span style={{ display: "block", fontWeight: 500, lineHeight: 1.35 }}>{post.title}</span>
              <span style={{ display: "block", fontSize: 14, color: muted, overflowWrap: "anywhere" }}>{blogPostPath(post.url)}</span>
            </button>
          ))}
        </>
      )}
    </div>
  );
}
