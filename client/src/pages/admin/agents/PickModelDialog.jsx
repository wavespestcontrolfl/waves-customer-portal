import React, { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { Button, Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle, Input } from "../../../components/ui";
import { adminFetch } from "../../../utils/admin-fetch";
import { UNPIN, modelLabel } from "./modelDraft";

export const PROVIDER_LABEL = { anthropic: "Anthropic", openai: "OpenAI", gemini: "Gemini", perplexity: "Perplexity", unknown: "—" };

const UNAVAILABLE_REASON = {
  no_key: "no API key on this server",
  cap_not_searchable: "this modality is not searchable",
  http_401: "API key rejected",
  http_403: "API key rejected",
  http_400: "API key rejected",
  timeout: "timed out",
  fetch_failed: "unreachable",
};

// Which catalog models a leg / selector may take: same provider, the modality
// it needs, and requires:'deep' (Fable) only where every call site goes
// through llm/deep.js. Empty caps means the server only knows the id (an
// audio / embedding / image model the registry resolves to today, not a
// picker option) — never "fits anything". `accepts.any` lists the distinct
// requirements of a migration set's envs: a model that fits ANY of them is
// offered, and the per-env check decides which envs can move.
export const fits = (m, a) => a.providers.includes(m.provider) && m.caps.includes(a.cap) && (!m.requires || (m.requires === "deep" && !!a.deep));
export function optionsFor(catalog, accepts, exclude) {
  const alternatives = accepts.any || [accepts];
  return Object.entries(catalog)
    .filter(([id, m]) => id !== exclude && alternatives.some((a) => fits(m, a)))
    .map(([id, m]) => ({ id, label: m.label, provider: m.provider, status: m.status, requiresDeep: m.requires === "deep" }));
}

// Search-first picker. Empty box: the models this lane can run today, then
// the newest ids per provider (live). Typing searches the providers. Every
// pick is probed with the provider's retrieve endpoint first (no tokens): a
// definite "unknown" / "not enabled" refuses it; a check that cannot run
// (no key, key rejected — local dev) drafts it flagged unverified.
// target = { accepts, current, title, subtitle, canUnpin, unpinLabel }.
export default function PickModelDialog({ target, catalog, onClose, onPick }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState(null);
  const [newest, setNewest] = useState(null);
  const [unavailable, setUnavailable] = useState([]);
  const [capUnverified, setCapUnverified] = useState(false);
  const [searching, setSearching] = useState(false);
  const [probing, setProbing] = useState(null);
  const [problem, setProblem] = useState(null);
  const requestRef = useRef(0);
  // A probe that resolves after Cancel / Escape must not draft anything.
  // Reset on (re)mount: StrictMode runs the cleanup once during development
  // and would otherwise leave the guard tripped for the dialog's whole life.
  const closedRef = useRef(false);
  useEffect(() => {
    closedRef.current = false;
    return () => { closedRef.current = true; };
  }, []);

  const suggestions = useMemo(() => optionsFor(catalog, target.accepts, target.current), [catalog, target]);
  // A lane the runtime allowlist-checks against MODEL_CATALOG (never a bare
  // pass-through) must never be offered a live-discovered id: it would draft
  // an env value the call site rejects after the restart the owner thought
  // would apply it (see model-switchboard.js's E(...,{catalogOnly:true})).
  // Search stays local to the models already known here — no live search.
  const catalogOnly = !!target.accepts?.catalogOnly;
  const catalogMatches = useMemo(() => {
    if (!catalogOnly) return suggestions;
    const query = q.trim().toLowerCase();
    if (!query) return suggestions;
    return suggestions.filter((m) => (m.label || m.id).toLowerCase().includes(query));
  }, [catalogOnly, suggestions, q]);

  useEffect(() => {
    if (catalogOnly) return undefined;
    const query = q.trim();
    const browse = query.length < 2;
    if (browse) setResults(null);
    const id = ++requestRef.current;
    const timer = setTimeout(async () => {
      setSearching(true);
      setProblem(null);
      try {
        const out = await adminFetch(
          `/admin/agents/models/search?q=${encodeURIComponent(browse ? "" : query)}&providers=${encodeURIComponent(target.accepts.providers.join(","))}&cap=${encodeURIComponent(target.accepts.cap)}`,
        );
        if (id !== requestRef.current) return;
        if (browse) setNewest(out.newest || []);
        else setResults(out.results || []);
        setUnavailable(out.unavailable || []);
        setCapUnverified(!!out.capUnverified);
      } catch (e) {
        if (id === requestRef.current) setProblem(e?.message || "Search failed");
      } finally {
        if (id === requestRef.current) setSearching(false);
      }
    }, browse ? 0 : 300);
    return () => clearTimeout(timer);
  }, [q, target, catalogOnly]);

  const deepBlocked = (m) => m.requiresDeep && !target.accepts.deep;

  const choose = async (model) => {
    setProbing(model.id);
    setProblem(null);
    try {
      const verdict = await adminFetch("/admin/agents/models/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: model.provider, id: model.id }),
      });
      if (closedRef.current) return;
      const unverifiable = verdict && !verdict.ok && ["no_key", "http_401"].includes(verdict.reason);
      if (verdict?.ok || unverifiable) onPick({ ...model, unverified: !!unverifiable });
      else setProblem(`${model.label || model.id}: ${verdict?.reason === "not_entitled" ? "this account is not enabled for it" : verdict?.reason === "not_found" ? "the provider does not know this id" : `check failed (${verdict?.reason || "unknown"})`}`);
    } catch (e) {
      if (!closedRef.current) setProblem(e?.message || "Check failed");
    } finally {
      if (!closedRef.current) setProbing(null);
    }
  };

  const typed = q.trim().length >= 2;

  return (
    <Dialog open onClose={onClose} size="md">
      <DialogHeader>
        <DialogTitle>{target.title}</DialogTitle>
        {target.subtitle && <p className="m-0 mt-1 text-13 text-ink-secondary">{target.subtitle}</p>}
        <p className="m-0 mt-1 text-13 text-ink-tertiary">Now: {modelLabel(catalog, target.current)}</p>
      </DialogHeader>
      <DialogBody className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-11 u-label text-ink-secondary">
          {catalogOnly ? "Filter" : "Search"} {target.accepts.providers.map((p) => PROVIDER_LABEL[p] || p).join(" and ")}
          <span className="relative block">
            <Search size={14} strokeWidth={2} aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-tertiary" />
            <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="fable 5.1, opus 5, gemini 3.8…" className="pl-8" />
          </span>
        </label>
        {problem && (
          <div className="text-13 text-alert-fg" role="alert">
            {problem}
          </div>
        )}
        {catalogOnly ? (
          <>
            <div className="text-13 text-ink-secondary">
              This lane only runs models already known to this server — the runtime checks a pin against the same list, so live provider search is off here.
            </div>
            <CatalogOnlyResults q={q} target={target} matches={catalogMatches} probing={probing} choose={choose} deepBlocked={deepBlocked} onPick={onPick} />
          </>
        ) : (
          <LiveSearchPanel
            q={q}
            target={target}
            typed={typed}
            searching={searching}
            results={results}
            newest={newest}
            suggestions={suggestions}
            unavailable={unavailable}
            capUnverified={capUnverified}
            probing={probing}
            choose={choose}
            deepBlocked={deepBlocked}
            onPick={onPick}
          />
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

// catalogOnly mode: search is a local filter over `matches` (already
// restricted to the catalog by `optionsFor` — see the accepts.catalogOnly
// check in PickModelDialog). No live search, so no "unavailable" / newest UI.
function CatalogOnlyResults({ q, target, matches, probing, choose, deepBlocked, onPick }) {
  return (
    <div className="flex flex-col gap-3">
      {target.canUnpin && (
        <Button size="sm" variant="secondary" onClick={() => onPick({ id: UNPIN, label: "Unpinned", provider: null })} className="self-start">
          {target.unpinLabel}
        </Button>
      )}
      {matches.length > 0 ? (
        <ResultList items={matches} probing={probing} onChoose={choose} deepBlocked={deepBlocked} />
      ) : (
        <div className="text-13 text-ink-secondary">No model matches "{q.trim()}".</div>
      )}
    </div>
  );
}

// Live provider search: browse (this lane's catalog models, then the newest
// per provider) or, once typed, the search results.
function LiveSearchPanel({ q, target, typed, searching, results, newest, suggestions, unavailable, capUnverified, probing, choose, deepBlocked, onPick }) {
  // Live results already in the suggestions list are not repeated.
  const known = new Set(suggestions.map((s) => s.id));
  return (
    <>
      {unavailable.length > 0 && (
        <div className="text-13 text-ink-secondary">
          Not searched live: {unavailable.map((u) => `${PROVIDER_LABEL[u.provider] || u.provider} (${UNAVAILABLE_REASON[u.reason] || u.reason})`).join(", ")}.
        </div>
      )}
      {capUnverified && (results?.length > 0 || newest?.some((g) => g.items.length > 0)) && (
        <div className="text-13 text-alert-fg" role="alert">
          This lane needs image input. Provider lists do not say whether a model accepts images, so only pick one you know does.
        </div>
      )}
      {typed ? (
        searching && !results ? (
          <div className="text-13 text-ink-secondary" role="status">
            Searching…
          </div>
        ) : results && results.length === 0 ? (
          <div className="text-13 text-ink-secondary">No model matches "{q.trim()}".</div>
        ) : results ? (
          <ResultList items={results} probing={probing} onChoose={choose} deepBlocked={deepBlocked} />
        ) : null
      ) : (
        <div className="flex flex-col gap-3">
          {target.canUnpin && (
            <Button size="sm" variant="secondary" onClick={() => onPick({ id: UNPIN, label: "Unpinned", provider: null })} className="self-start">
              {target.unpinLabel}
            </Button>
          )}
          {suggestions.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="text-11 uppercase tracking-label text-ink-secondary">Can run this lane</span>
              <ResultList items={suggestions} probing={probing} onChoose={choose} deepBlocked={deepBlocked} />
            </div>
          )}
          {newest &&
            newest.map((group) => {
              const items = group.items.filter((m) => !known.has(m.id) && m.id !== target.current);
              if (!items.length) return null;
              return (
                <div key={group.provider} className="flex flex-col gap-1">
                  <span className="text-11 uppercase tracking-label text-ink-secondary">Newest from {PROVIDER_LABEL[group.provider] || group.provider}</span>
                  <ResultList items={items} probing={probing} onChoose={choose} deepBlocked={deepBlocked} />
                </div>
              );
            })}
          {searching && !newest && (
            <div className="text-13 text-ink-tertiary" role="status">
              Loading the newest models…
            </div>
          )}
        </div>
      )}
    </>
  );
}

function ResultList({ items, probing, onChoose, deepBlocked }) {
  return (
    <ul className="m-0 flex list-none flex-col divide-y divide-zinc-200 border-hairline border-zinc-200 p-0">
      {items.map((m) => {
        const blocked = deepBlocked(m) || m.status === "unavailable";
        return (
          <li key={`${m.provider}:${m.id}`} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
            <span className="flex flex-col">
              <span className="text-13 text-zinc-900">{m.label || m.id}</span>
              <span className="text-11 text-ink-tertiary u-nums">
                {PROVIDER_LABEL[m.provider] || m.provider}
                {m.createdAt ? ` · ${m.createdAt.slice(0, 10)}` : ""}
                {m.status === "unavailable" ? " · no adapter yet" : ""}
              </span>
              {deepBlocked(m) && <span className="text-11 text-ink-secondary">Only deep-audit lanes can run this model.</span>}
            </span>
            <Button size="sm" variant="secondary" onClick={() => onChoose(m)} disabled={!!probing || blocked}>
              {probing === m.id ? "Checking…" : "Use"}
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
