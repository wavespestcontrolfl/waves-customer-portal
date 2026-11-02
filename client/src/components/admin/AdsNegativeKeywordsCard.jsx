import { useCallback, useEffect, useRef, useState } from "react";
import { useInRouterContext, useSearchParams } from "react-router-dom";
import {
  ActionFeedback,
  Badge,
  Button,
  Card,
  Field,
  Input,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from "../ui";
import { formatETDateTime } from "../../lib/timezone";

// Ads -> Advisor: "Blocked search words". The owner's word list goes to Google
// Ads on its own; the advisor's new words wait here (and in the bell) for one
// Add or Decline each; every block can be undone. The server routes ship behind
// GATE_ADS_NEGATIVES; while they are off GET /admin/ads/negatives answers 404
// and this card renders nothing.

const API_BASE = import.meta.env.VITE_API_URL || "/api";
const BASE_PATH = `${API_BASE}/admin/ads/negatives`;

// Returns { ok, status, body } and never throws (status 0 = no answer).
async function request(path, { method = "GET", body } = {}) {
  try {
    const res = await fetch(`${BASE_PATH}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const parsed = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, body: parsed };
  } catch {
    return { ok: false, status: 0, body: null };
  }
}

const SOURCE_LABEL = { owner_list: "Your list", advisor: "Advisor", manual: "Manual" };
const STATE_LABEL = { active: "Blocked", declined: "Declined", removed: "Undone", failed: "Not sent" };

const money = (n) => `$${Number(n || 0).toFixed(2)}`;
const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const whenET = (value) =>
  value
    ? formatETDateTime(value, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : "—";

// An undone row shows when it was undone; any other row when it was decided or sent.
const historyDate = (row) =>
  row.state === "removed"
    ? row.removedAt || row.decidedAt || row.pushedAt
    : row.decidedAt || row.pushedAt || row.removedAt;

function failText(res, fallback) {
  return (res.body && res.body.message) || fallback;
}

function metricsLine(metrics) {
  if (!metrics) return "";
  const parts = [
    count(Number(metrics.clicks || 0), "click", "clicks"),
    money(metrics.cost),
    count(Number(metrics.conversions || 0), "conversion", "conversions"),
  ];
  if (metrics.term) parts.push(`from “${metrics.term}”`);
  return parts.join(" · ");
}

function wordState(word) {
  const rows = word.campaigns || [];
  const failed = rows.find((c) => c.state === "failed");
  if (failed) {
    return {
      tone: "alert",
      label: `Not sent: ${
        failed.lastError === "converted"
          ? "a search with it converted in 90 days"
          : "Google did not take it"
      }`,
    };
  }
  if (rows.length === 0 || rows.some((c) => c.state !== "active")) {
    return { tone: "warn", label: "Waiting" };
  }
  return { tone: "strong", label: "In Google" };
}

function PendingItem({ item, highlighted, itemRef, busy, message, onDecide }) {
  const line = metricsLine(item.metrics);
  return (
    <div
      ref={itemRef}
      data-testid={`pending-${item.id}`}
      className={`flex flex-col [gap:8px] [padding:12px] rounded-sm border ${
        highlighted ? "ring-2 ring-zinc-900 border-zinc-900" : "border-zinc-200"
      }`}
    >
      <div className="flex flex-wrap items-center [gap:8px]">
        <div className="text-ui-body font-medium text-zinc-900">{`“${item.text}”`}</div>
        {item.campaignName && <Badge tone="neutral">{item.campaignName}</Badge>}
      </div>
      {item.reason && <div className="text-ui-body text-ink-secondary">{item.reason}</div>}
      {line && <div className="text-ui-body text-zinc-900">{line}</div>}
      <div className="flex flex-wrap items-center [gap:8px]">
        <Button
          disabled={busy}
          aria-label={`Add “${item.text}”`}
          onClick={() => onDecide(item, "add")}
        >
          Add
        </Button>
        <Button
          variant="secondary"
          disabled={busy}
          aria-label={`Decline “${item.text}”`}
          onClick={() => onDecide(item, "decline")}
        >
          Decline
        </Button>
        {message && <ActionFeedback error>{message}</ActionFeedback>}
      </div>
    </div>
  );
}

function NegativeKeywordsCard({ highlightId }) {
  const [phase, setPhase] = useState("loading"); // loading | off | error | ready
  const [data, setData] = useState(null);
  // Every action in flight, by key: each control stays disabled until its own request and reload finish,
  // whatever else starts or ends meanwhile.
  const [busyKeys, setBusyKeys] = useState(() => new Set());
  const isBusy = (key) => busyKeys.has(key);
  // The same keys, read and written synchronously: a second click that lands before the re-render (the button
  // still enabled) starts nothing.
  const inFlight = useRef(new Set());
  const setBusy = (key, on) => {
    if (on) inFlight.current.add(key);
    else inFlight.current.delete(key);
    setBusyKeys((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  };
  const [messages, setMessages] = useState({});
  const [wordText, setWordText] = useState("");
  const [wordError, setWordError] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const itemRefs = useRef({});
  const scrolledFor = useRef(null);

  // Reads can overlap (two words decided at once each reload the card) and answer out of order: only the newest
  // read may set the card, so an older answer never brings back a word another action already settled.
  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    const res = await request("");
    if (seq !== loadSeq.current) return;
    if (res.status === 404) {
      setPhase("off");
      return;
    }
    if (!res.ok || !res.body) {
      setPhase("error");
      return;
    }
    setData({
      words: res.body.words || [],
      pending: res.body.pending || [],
      log: res.body.log || [],
    });
    setPhase("ready");
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Scroll the linked bell item into view once, after the list has loaded.
  useEffect(() => {
    if (!highlightId || !data || scrolledFor.current === highlightId) return;
    const el = itemRefs.current[highlightId];
    if (!el) return;
    scrolledFor.current = highlightId;
    if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center" });
  }, [highlightId, data]);

  const setMessage = (id, text) =>
    setMessages((m) => {
      const next = { ...m };
      if (text) next[id] = text;
      else delete next[id];
      return next;
    });

  // Runs one request: marks the key busy, shows a failure message under `id`,
  // reloads the card, and returns the response.
  async function run(key, id, path, body, fallback, { reloadOnFail = false } = {}) {
    if (inFlight.current.has(key)) return null;
    setBusy(key, true);
    setMessage(id, "");
    try {
      const res = await request(path, { method: "POST", body });
      if (!res.ok) setMessage(id, failText(res, fallback));
      if (res.ok || reloadOnFail) await load();
      return res;
    } finally {
      setBusy(key, false);
    }
  }

  const decide = (item, decision) =>
    run(item.id, item.id, `/${item.id}/decide`, { decision }, "Could not save that. Try again.", {
      reloadOnFail: true,
    });

  const undo = (row) =>
    run(row.id, row.id, `/${row.id}/undo`, undefined, "Could not undo that. Try again.");

  async function removeWord(word) {
    await run(`word-${word.id}`, `word-${word.id}`, `/words/${word.id}/remove`, undefined, "Could not remove that word. Try again.");
  }

  async function addWord(event) {
    event.preventDefault();
    const text = wordText.trim();
    if (!text || inFlight.current.has("new-word")) return;
    setBusy("new-word", true);
    setWordError("");
    try {
      const res = await request("/words", { method: "POST", body: { text } });
      if (res.ok) {
        setWordText("");
        await load();
      } else {
        setWordError(failText(res, "Could not add that word. Try again."));
      }
    } finally {
      setBusy("new-word", false);
    }
  }

  if (phase === "off" || phase === "loading") return null;
  if (phase === "error") {
    return (
      <Card className="p-6" aria-label="Blocked search words">
        <ActionFeedback error>Could not load the blocked search words.</ActionFeedback>
      </Card>
    );
  }

  const { words, pending, log } = data;
  const shownIds = new Set([...pending.map((p) => p.id), ...log.map((l) => l.id), ...words.map((w) => `word-${w.id}`)]);
  const strayMessages = Object.entries(messages).filter(([id]) => !shownIds.has(id));

  return (
    <Card className="p-6" aria-label="Blocked search words">
      <div className="flex flex-col [gap:16px]">
        <div className="text-ui-body font-medium text-zinc-900">Blocked search words</div>
        <div className="text-ui-body text-ink-secondary">
          Ads stop showing for searches that contain these words. You can undo any block.
        </div>

        {strayMessages.map(([id, text]) => (
          <ActionFeedback key={id} error>
            {text}
          </ActionFeedback>
        ))}

        <section aria-label="Waiting for you" className="flex flex-col [gap:8px]">
          <div className="text-ui-body font-medium text-zinc-900">Waiting for you</div>
          {pending.length === 0 ? (
            <div className="text-ui-body text-ink-secondary">Nothing is waiting.</div>
          ) : (
            pending.map((item) => (
              <PendingItem
                key={item.id}
                item={item}
                highlighted={String(item.id) === String(highlightId || "")}
                itemRef={(el) => {
                  if (el) itemRefs.current[item.id] = el;
                  else delete itemRefs.current[item.id];
                }}
                busy={isBusy(item.id)}
                message={messages[item.id]}
                onDecide={decide}
              />
            ))
          )}
        </section>

        <section aria-label="Your word list" className="flex flex-col [gap:8px]">
          <div className="text-ui-body font-medium text-zinc-900">Your word list</div>
          {words.length === 0 ? (
            <div className="text-ui-body text-ink-secondary">No words on your list yet.</div>
          ) : (
            <ul className="flex flex-wrap [gap:8px] list-none [margin:0] [padding:0]">
              {words.map((word) => {
                const state = wordState(word);
                const key = `word-${word.id}`;
                return (
                  <li
                    key={word.id}
                    className="flex flex-wrap items-center [gap:8px] rounded-sm border border-zinc-200 [padding:4px_4px_4px_12px]"
                  >
                    <span className="text-ui-body text-zinc-900">{word.text}</span>
                    <Badge tone={state.tone}>{state.label}</Badge>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={isBusy(key)}
                      aria-label={`Remove “${word.text}”`}
                      onClick={() => removeWord(word)}
                    >
                      Remove
                    </Button>
                    {messages[key] && <ActionFeedback error>{messages[key]}</ActionFeedback>}
                  </li>
                );
              })}
            </ul>
          )}
          <form onSubmit={addWord} className="flex flex-wrap items-end [gap:8px]">
            <Field label="Add a word" error={wordError} className="[min-width:200px]">
              <Input
                value={wordText}
                onChange={(e) => setWordText(e.target.value)}
                disabled={isBusy("new-word")}
                maxLength={80}
              />
            </Field>
            <Button type="submit" disabled={isBusy("new-word") || !wordText.trim()}>
              Add
            </Button>
          </form>
        </section>

        <section aria-label="History" className="flex flex-col [gap:8px]">
          <div className="flex flex-wrap items-center [gap:8px]">
            <div className="text-ui-body font-medium text-zinc-900">History</div>
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={showHistory}
              onClick={() => setShowHistory((v) => !v)}
            >
              {showHistory ? "Hide history" : "Show history"}
            </Button>
          </div>
          {showHistory &&
            (log.length === 0 ? (
              <div className="text-ui-body text-ink-secondary">Nothing here yet.</div>
            ) : (
              <Table aria-label="Blocked word history">
                <THead>
                  <TR>
                    <TH>Word</TH>
                    <TH>Campaign</TH>
                    <TH>From</TH>
                    <TH>Result</TH>
                    <TH>Date</TH>
                    <TH>
                      <span className="sr-only">Undo</span>
                    </TH>
                  </TR>
                </THead>
                <TBody>
                  {log.map((row) => (
                    <TR key={row.id}>
                      <TD>{row.text}</TD>
                      <TD>{row.campaignName}</TD>
                      <TD>{SOURCE_LABEL[row.source] || "Other"}</TD>
                      <TD>{STATE_LABEL[row.state] || "Other"}</TD>
                      <TD>{whenET(historyDate(row))}</TD>
                      <TD>
                        {row.canUndo && (
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={isBusy(row.id)}
                            aria-label={`Undo “${row.text}”`}
                            onClick={() => undo(row)}
                          >
                            Undo
                          </Button>
                        )}
                        {messages[row.id] && <ActionFeedback error>{messages[row.id]}</ActionFeedback>}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            ))}
        </section>
      </div>
    </Card>
  );
}

// useSearchParams needs a router. The page always has one; a bare render of the
// Advisor tab (some tests) does not, and then there is nothing to highlight.
function WithRouter() {
  const [params] = useSearchParams();
  return <NegativeKeywordsCard highlightId={params.get("negative")} />;
}

export default function AdsNegativeKeywordsCard() {
  const inRouter = useInRouterContext();
  return inRouter ? <WithRouter /> : <NegativeKeywordsCard highlightId={null} />;
}
