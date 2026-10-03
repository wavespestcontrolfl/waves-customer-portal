import React, { useCallback, useEffect, useId, useRef, useState } from "react";

// A Waves blog post for the customer (GATE_REPORT_BLOG_POST, owner "ok go"
// 2026-10-01): search the live Waves blog the way Quick Links searches links,
// and pick one post. The pick goes on the customer's report as "From the
// Waves blog". Optional. `search(query)` answers { posts: [{ id, title, url,
// exact }], suggest } (GET /admin/dispatch/:serviceId/blog-posts?q=); `value`
// is the picked post. When no post holds every word of the search, the
// picker says so, shows the closest posts, and (with the server's `suggest`
// on) offers to suggest a post on it: `suggest(phrase)` answers { status:
// 'queued' | 'already_queued' } (POST .../blog-suggestions; owner mockup
// approval 2026-10-03, straight into the autonomous blog queue).

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

// The search behind the completion form's picker and the tech sheet's blog
// section: only the latest search may land; a short query clears the list.
// status is idle, searching, done or failed.
export function useBlogPostSearch(search) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [status, setStatus] = useState("idle");
  // Whether the server takes a suggested post for this search (its gate).
  const [canSuggest, setCanSuggest] = useState(false);
  const sequence = useRef(0);
  useEffect(() => {
    const q = query.trim();
    const current = ++sequence.current;
    if (q.length < MIN_QUERY_CHARS) {
      setResults([]);
      setCanSuggest(false);
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
          setCanSuggest(data?.suggest === true);
          setStatus("done");
        })
        .catch(() => {
          if (current !== sequence.current) return;
          setResults([]);
          setCanSuggest(false);
          setStatus("failed");
        });
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [query, search]);
  // The posts that hold every word; with none, the results are the closest.
  const exact = results.filter((post) => post.exact === true);
  return { query, setQuery, results, status, covered: exact.length > 0, shown: exact.length ? exact : results, canSuggest };
}

// One tap suggests the search as a new post. The answer stands while the
// search text stays the same: idle, sending, queued, already (someone
// suggested it before), refused (the server will not take the phrase) or
// failed.
export function useBlogSuggestion(suggest, query) {
  const phrase = String(query || "").trim();
  const [state, setState] = useState({ phrase: null, status: "idle" });
  const send = useCallback(() => {
    if (typeof suggest !== "function" || !phrase) return;
    setState({ phrase, status: "sending" });
    const settle = (status) => setState((prev) => (prev.phrase === phrase ? { phrase, status } : prev));
    Promise.resolve()
      .then(() => suggest(phrase))
      .then((data) => settle(data?.status === "queued" ? "queued" : data?.status === "already_queued" ? "already" : "failed"))
      .catch((err) => settle(err?.status === 422 ? "refused" : "failed"));
  }, [suggest, phrase]);
  return { status: state.phrase === phrase ? state.status : "idle", send };
}

// What the picker says about a suggestion, by its status.
export const SUGGESTION_COPY = {
  idle: { button: (phrase) => `Suggest a post about “${phrase}”`, note: "It goes straight into the blog queue and is written and published automatically." },
  sending: { button: () => "Suggesting…", note: "It goes straight into the blog queue and is written and published automatically." },
  queued: { button: (phrase) => `Suggested: “${phrase}”`, note: "In the blog queue. It will be written and published automatically." },
  already: { button: () => "Already in the blog queue", note: "Someone suggested it already. It will be written and published automatically." },
  failed: { button: (phrase) => `Suggest a post about “${phrase}”`, note: "That didn’t go through. Try again." },
  refused: { button: () => "Can’t suggest this one", note: "Name the topic only, with no names, addresses or phone numbers." },
};

// The search's status lines: searching, failed, nothing found, or (no post
// holds every word) that no post covers the search yet, above the closest.
function SearchStatusLines({ status, results, uncovered, phrase, ink, muted }) {
  const line = (text, color = muted) => <p style={{ margin: "6px 0 0", fontSize: 14, color }}>{text}</p>;
  if (status === "searching") return line("Searching…");
  if (status === "failed") return line("The blog search didn’t answer. Try again.");
  if (status !== "done") return null;
  if (!uncovered) return results.length ? null : line("No live posts match.");
  return (
    <>
      {line(`No post covers “${phrase}” yet.`, ink)}
      {results.length > 0 && (
        <p style={{ margin: "8px 0 0", fontSize: 12, letterSpacing: "0.04em", textTransform: "uppercase", color: muted }}>Closest posts</p>
      )}
    </>
  );
}

// "Suggest a post about …" and, after the tap, what became of it.
function SuggestBlock({ phrase, suggestion, disabled, buttonStyle, muted }) {
  const done = suggestion.status === "queued" || suggestion.status === "already";
  // A refused phrase is refused again: only a new search starts over.
  const settled = done || suggestion.status === "refused";
  const copy = SUGGESTION_COPY[suggestion.status];
  return (
    <>
      <button
        type="button"
        onClick={suggestion.send}
        disabled={disabled || settled || suggestion.status === "sending"}
        aria-live="polite"
        style={{ ...buttonStyle, marginTop: 8, borderStyle: done ? "solid" : "dashed", fontWeight: 500, cursor: disabled || settled ? "default" : "pointer" }}
      >
        {copy.button(phrase)}
      </button>
      <p style={{ margin: "6px 0 0", fontSize: 14, color: muted }}>{copy.note}</p>
    </>
  );
}

export default function BlogPostPicker({ search, suggest = null, value = null, onChange, disabled = false, tokens = {} }) {
  const inputId = useId();
  const { query, setQuery, results, status, covered, shown, canSuggest } = useBlogPostSearch(search);
  const suggestion = useBlogSuggestion(suggest, query);
  const phrase = query.trim();
  // No post holds every word: say so, show the closest, offer a suggestion.
  const uncovered = status === "done" && !covered && canSuggest && typeof suggest === "function";
  const ink = tokens.ink || "#111";
  const muted = tokens.muted || "#525252";
  const border = tokens.border || "#E5E5E5";
  const card = tokens.card || "#fff";

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
          <SearchStatusLines status={status} results={results} uncovered={uncovered} phrase={phrase} ink={ink} muted={muted} />
          {(status === "done" ? shown : results).map((post) => (
            <button key={post.id} type="button" disabled={disabled} onClick={() => onChange(post)} style={rowStyle(false)}>
              <span style={{ display: "block", fontWeight: 500, lineHeight: 1.35 }}>{post.title}</span>
              <span style={{ display: "block", fontSize: 14, color: muted, overflowWrap: "anywhere" }}>{blogPostPath(post.url)}</span>
            </button>
          ))}
          {uncovered && (
            <SuggestBlock phrase={phrase} suggestion={suggestion} disabled={disabled} buttonStyle={{ ...rowStyle(false), borderColor: ink }} muted={muted} />
          )}
        </>
      )}
    </div>
  );
}
