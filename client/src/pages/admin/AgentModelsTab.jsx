import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Copy, RefreshCw, Search } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Select,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  cn,
} from "../../components/ui";
import { adminFetch } from "../../utils/admin-fetch";

// Agents → Models: which model every AI lane runs on right now, resolved on
// the server against the live registry (GET /admin/agents/models →
// server/services/model-switchboard.js), and a composer for the change.
//
// Honest about the mechanism that exists today: every registry selector is a
// module-load const, so a switch IS a Railway env change followed by the
// restart Railway does on save. This tab never writes anything itself — it
// composes the exact env lines and shows the blast radius (which lanes move,
// which are locked, what the list-rate delta is) before the owner pastes them.
//
// Models not in the catalog (released yesterday) come from "Find a model…":
// GET /admin/agents/models/search hits the providers' live list endpoints and
// POST /admin/agents/models/probe confirms the account can see the id before
// it is drafted.

const FILTERS = [
  { key: "all", label: "All" },
  { key: "changed", label: "Changing" },
  { key: "pinned", label: "Env-pinned" },
  { key: "fanout", label: "Multi-model" },
  { key: "locked", label: "Locked" },
];

// Draft value meaning "delete this env var in Railway" — a pinned leg then
// falls back to its selector / code default (`process.env.PIN || …`).
const UNPIN = "__unpin__";
// Picker option that opens the live search instead of drafting a value.
const FIND = "__find__";

const PROVIDER_LABEL = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  gemini: "Gemini",
  perplexity: "Perplexity",
  unknown: "—",
};

const UNAVAILABLE_REASON = {
  no_key: "no API key on this server",
  cap_not_searchable: "this modality is not searchable",
  http_401: "API key rejected",
  http_403: "API key rejected",
  http_400: "API key rejected",
  timeout: "timed out",
  fetch_failed: "unreachable",
};

function fmtRate(rate) {
  if (!rate) return null;
  return `$${rate.in} in / $${rate.out} out per 1M`;
}

function modelLabel(catalog, id) {
  if (!id) return "—";
  return catalog[id]?.label || id;
}

// One model chip: label + provider, monochrome (admin stays zinc).
function ModelChip({ catalog, id }) {
  if (!id) return <span className="text-ink-tertiary">—</span>;
  const m = catalog[id];
  return (
    <span className="inline-flex flex-wrap items-baseline gap-1.5">
      <span className="text-13 text-zinc-900">{m?.label || id}</span>
      <span className="text-11 uppercase tracking-label text-ink-tertiary">{PROVIDER_LABEL[m?.provider] || m?.provider || ""}</span>
      {m?.discovered && <Badge className="whitespace-nowrap">new · not rated</Badge>}
    </span>
  );
}

function Leg({ leg, catalog, effective }) {
  if (!leg) return <span className="text-ink-tertiary">—</span>;
  const nowId = effective ?? leg.model;
  const changed = nowId !== leg.model;
  return (
    <div className="flex flex-col gap-0.5">
      <ModelChip catalog={catalog} id={nowId} />
      {changed ? (
        <span className="text-11 text-ink-secondary">was {modelLabel(catalog, leg.model)}</span>
      ) : (
        leg.via && <span className="text-11 text-ink-tertiary u-nums">{leg.via}</span>
      )}
    </div>
  );
}

function DisclosureButton({ open, onClick, label }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={open}
      aria-label={label}
      className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-sm text-ink-secondary hover:bg-zinc-100 hover:text-zinc-900 u-focus-ring"
    >
      {open ? <ChevronUp size={15} strokeWidth={2} /> : <ChevronDown size={15} strokeWidth={2} />}
    </button>
  );
}

// Options a picker offers for a leg/selector: catalog models the provider and
// modality can run, plus the live-search entry.
function ModelOptions({ catalog, accepts, exclude }) {
  const options = Object.entries(catalog).filter(
    ([id, m]) => id !== exclude && accepts.providers.includes(m.provider) && (m.caps.length === 0 || m.caps.includes(accepts.cap)),
  );
  return (
    <>
      {options.map(([id, m]) => (
        <option key={id} value={id} disabled={m.status === "unavailable"}>
          {m.label}
          {m.status === "unavailable" ? " · no adapter" : m.status === "legacy" ? " · legacy" : m.discovered ? " · new" : ""}
        </option>
      ))}
      <option value={FIND}>Find a model… (live provider search)</option>
    </>
  );
}

export default function AgentModelsTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState("all");
  // Draft = what the owner has picked but not yet copied out. Keyed by the
  // env var the change would set, so a selector and a lane pin never collide.
  const [draft, setDraft] = useState({});
  const [review, setReview] = useState(false);
  const [copied, setCopied] = useState(false);
  const [openSelectors, setOpenSelectors] = useState({});
  const [openLanes, setOpenLanes] = useState({});
  // Models found through live search, merged into the catalog for labels.
  const [discovered, setDiscovered] = useState({});
  // Live search dialog: which env var / accepts it is drafting for.
  const [find, setFind] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await adminFetch("/admin/agents/models");
      setData(next);
    } catch (e) {
      setError(e?.message || "Failed to load the model registry");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const catalog = useMemo(() => ({ ...(data?.models || {}), ...discovered }), [data, discovered]);
  const selectorByKey = useMemo(() => {
    const out = {};
    (data?.selectors || []).forEach((s) => {
      out[s.key] = s;
    });
    return out;
  }, [data]);

  // Effective model for a leg after the draft: a lane pin wins over its
  // selector, exactly as `process.env.PIN || MODELS.TIER` does at boot.
  const effectiveLeg = useCallback(
    (lane, leg) => {
      if (!leg) return null;
      if (leg.pinEnv && draft[leg.pinEnv] === UNPIN) {
        // Unpinned: the selector's (possibly also drafted) value wins again.
        const selEnv = leg.selector && selectorByKey[leg.selector]?.env;
        return (selEnv && draft[selEnv]) || leg.unpinnedModel;
      }
      if (leg.pinEnv && draft[leg.pinEnv]) return draft[leg.pinEnv];
      if (leg.pinEnv && leg.pinned) return leg.model; // pinned today; only the pin moves it
      if (leg.selector && draft[selectorByKey[leg.selector]?.env]) return draft[selectorByKey[leg.selector].env];
      return leg.model;
    },
    [draft, selectorByKey],
  );

  const laneChanged = useCallback(
    (lane) => effectiveLeg(lane, lane.primary) !== lane.primary.model || (lane.fallback && effectiveLeg(lane, lane.fallback) !== lane.fallback.model),
    [effectiveLeg],
  );

  // One change per env var, computed from the COMPLETE draft: a leg pinned
  // in the draft stops following its selector, an unpinned one starts again,
  // and a pin is dropped as redundant only against the post-draft selector
  // value (pinning today's model while the selector moves is a real change).
  // Several lanes can read the same pin env (the photo lanes share
  // GEMINI_VISION_MODEL), so pins aggregate by env and count every lane.
  const changes = useMemo(() => {
    if (!data) return [];
    const pinnedAfterDraft = (leg) => (leg.pinEnv && draft[leg.pinEnv] ? draft[leg.pinEnv] !== UNPIN : !!leg.pinned);
    const baseAfterDraft = (leg) => {
      const selEnv = leg.selector && selectorByKey[leg.selector]?.env;
      return (selEnv && draft[selEnv]) || leg.unpinnedModel || leg.model;
    };
    const byEnv = new Map();
    for (const s of data.selectors) {
      const next = draft[s.env];
      if (next && next !== s.current) {
        const follows = (leg) => leg && leg.selector === s.key && !pinnedAfterDraft(leg);
        const lanes = data.lanes.filter((l) => follows(l.primary) || follows(l.fallback)).length;
        byEnv.set(s.env, { env: s.env, from: s.current, to: next, label: `${s.key} selector`, lanes, restart: true });
      }
    }
    for (const l of data.lanes) {
      for (const leg of [l.primary, l.fallback]) {
        const env = leg?.pinEnv;
        const next = env && draft[env];
        if (!next || byEnv.has(env)) continue;
        const unpin = next === UNPIN;
        const sharing = data.lanes.filter((x) => x.primary.pinEnv === env || x.fallback?.pinEnv === env);
        const legOf = (x) => (x.primary.pinEnv === env ? x.primary : x.fallback);
        // Unpinning a shared env can land its lanes on different models (a
        // selector-backed leg vs one with its own literal default).
        const destinations = unpin ? [...new Set(sharing.map((x) => baseAfterDraft(legOf(x))))] : [next];
        if (unpin && destinations.length === 1 && destinations[0] === leg.model) continue;
        if (!unpin && sharing.every((x) => next === baseAfterDraft(legOf(x)) && !legOf(x).pinned)) continue;
        const label = sharing.length > 1 ? `${env} (${sharing.map((x) => x.name).join(", ")})` : `${l.name}${leg === l.fallback ? " · fallback" : ""}`;
        byEnv.set(env, { env, from: leg.model, to: destinations[0], destinations, unpin, label, lanes: sharing.length, restart: sharing.some((x) => x.applies !== "live") });
      }
    }
    return [...byEnv.values()];
  }, [data, draft, selectorByKey]);

  const destLabel = (c) => (c.destinations || [c.to]).map((id) => modelLabel(catalog, id)).join(" / ");
  // Unpins are deletions: Railway has no "unset" syntax, so the line is an
  // instruction rather than an assignment.
  const envBlock = changes.map((c) => (c.unpin ? `# delete ${c.env}  (unpin → ${destLabel(c)})` : `${c.env}=${c.to}`)).join("\n");
  const restartCount = changes.filter((c) => c.restart).length;
  const affectedLanes = data ? data.lanes.filter(laneChanged).length : 0;

  const setDraftValue = (env, value) => {
    setDraft((prev) => {
      const next = { ...prev };
      if (value) next[env] = value;
      else delete next[env];
      return next;
    });
  };

  // A picker change: FIND opens the search for that env, anything else drafts.
  const onPick = (env, accepts, currentLabel) => (e) => {
    const v = e.target.value;
    if (v === FIND) {
      setFind({ env, accepts, currentLabel });
      return;
    }
    setDraftValue(env, v);
  };

  const onFound = (env, model) => {
    setDiscovered((prev) => ({
      ...prev,
      [model.id]: { label: model.label || model.id, provider: model.provider, caps: [], rate: null, status: "current", discovered: true },
    }));
    setDraftValue(env, model.id);
    setFind(null);
  };

  const copyEnv = async () => {
    try {
      await navigator.clipboard.writeText(envBlock);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // clipboard blocked — the block is still on screen to select manually
    }
  };

  const visibleLanes = useMemo(() => {
    if (!data) return [];
    return data.lanes.filter((l) => {
      if (filter === "changed") return laneChanged(l);
      if (filter === "pinned") return l.primary.pinned || (l.fallback && l.fallback.pinned);
      if (filter === "fanout") return l.fanout;
      if (filter === "locked") return !!l.lock;
      return true;
    });
  }, [data, filter, laneChanged]);

  if (loading && !data) {
    return (
      <Card className="p-5 text-13 text-ink-secondary" role="status">
        Loading the model registry…
      </Card>
    );
  }
  if (error) {
    return (
      <Card className="p-5 text-13 text-alert-fg" role="alert">
        {error}
      </Card>
    );
  }
  if (!data) return null;

  const overriddenCount = data.selectors.filter((s) => s.overridden).length;
  const toggle = (setter, key) => setter((prev) => ({ ...prev, [key]: !prev[key] }));

  return (
    <div className="flex flex-col gap-4 pb-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="m-0 max-w-[70ch] text-13 text-ink-secondary">
          <span className="font-medium text-zinc-900 u-nums">{data.lanes.length}</span> AI lanes over{" "}
          <span className="font-medium text-zinc-900 u-nums">{data.selectors.length}</span> registry selectors ·{" "}
          <span className="u-nums">{overriddenCount}</span> overridden by env today. Every selector is read once at boot, so a
          switch is a Railway env change plus the restart Railway performs on save. Nothing here sends anything to a customer.
        </p>
        <Button size="sm" variant="secondary" onClick={load} disabled={loading} className="gap-2">
          <RefreshCw size={13} strokeWidth={2} className={loading ? "animate-spin" : undefined} aria-hidden />
          {loading ? "Refreshing" : "Refresh"}
        </Button>
      </div>

      {/* Registry selectors — the knobs that actually exist */}
      <section aria-labelledby="models-selectors-heading" className="flex flex-col gap-2">
        <div>
          <h2 id="models-selectors-heading" className="m-0 text-14 font-medium text-zinc-900">
            Registry selectors
          </h2>
          <p className="m-0 text-12 text-ink-secondary">
            Change a selector and every lane that follows it moves. The picker only offers models the selector's provider and
            modality can actually run; "Find a model…" searches the providers live for anything newer.
          </p>
        </div>
        <Card className="overflow-hidden">
          <Table className="min-w-[880px]">
            <THead>
              <TR>
                <TH>Selector</TH>
                <TH>Env var</TH>
                <TH>Runs on now</TH>
                <TH>Source</TH>
                <TH>Lanes</TH>
                <TH>Change to</TH>
              </TR>
            </THead>
            <TBody>
              {data.selectors.map((s) => {
                const next = draft[s.env];
                const changed = next && next !== s.current;
                const primaryLanes = data.lanes.filter((l) => l.primary.selector === s.key && !l.primary.pinned);
                const fallbackLanes = data.lanes.filter((l) => l.fallback?.selector === s.key && !l.fallback.pinned);
                const total = primaryLanes.length + fallbackLanes.length;
                const open = !!openSelectors[s.key];
                return (
                  <React.Fragment key={s.key}>
                    <TR className={cn(changed && "bg-zinc-50")}>
                      <TD>
                        <div className="flex flex-col">
                          <span className="font-medium text-zinc-900">{s.key}</span>
                          <span className="text-11 text-ink-tertiary">{s.description}</span>
                        </div>
                      </TD>
                      <TD className="u-nums text-12 text-ink-secondary">{s.env}</TD>
                      <TD>
                        <div className="flex flex-col gap-0.5">
                          <ModelChip catalog={catalog} id={changed ? next : s.current} />
                          {changed && <span className="text-11 text-ink-secondary">was {modelLabel(catalog, s.current)}</span>}
                        </div>
                      </TD>
                      <TD>
                        {s.overridden ? (
                          <Badge tone="strong" className="whitespace-nowrap">
                            env override
                          </Badge>
                        ) : (
                          <Badge className="whitespace-nowrap">code default</Badge>
                        )}
                      </TD>
                      <TD>
                        {total > 0 ? (
                          <button
                            type="button"
                            onClick={() => toggle(setOpenSelectors, s.key)}
                            aria-expanded={open}
                            className="inline-flex items-center gap-1 rounded-sm px-1 text-13 text-zinc-900 underline-offset-2 hover:underline u-focus-ring"
                          >
                            <span className="u-nums">{total}</span>
                            <span className="text-12 text-ink-secondary">
                              {primaryLanes.length} primary{fallbackLanes.length ? ` · ${fallbackLanes.length} fallback` : ""}
                            </span>
                            {open ? <ChevronUp size={13} strokeWidth={2} aria-hidden /> : <ChevronDown size={13} strokeWidth={2} aria-hidden />}
                          </button>
                        ) : (
                          <span className="text-12 text-ink-tertiary">none</span>
                        )}
                      </TD>
                      <TD>
                        {s.lock ? (
                          <span className="text-12 text-ink-secondary">{s.lock.label}</span>
                        ) : (
                          <Select
                            size="sm"
                            aria-label={`Change ${s.key}`}
                            value={next || ""}
                            onChange={onPick(s.env, s.accepts, modelLabel(catalog, s.current))}
                            className="w-56"
                          >
                            <option value="">Keep {modelLabel(catalog, s.current)}</option>
                            <ModelOptions catalog={catalog} accepts={s.accepts} exclude={s.current} />
                          </Select>
                        )}
                      </TD>
                    </TR>
                    {open && (
                      <TR className="bg-zinc-50 hover:bg-zinc-50">
                        <TD colSpan={6} className="py-2 pl-6">
                          <div className="flex flex-col gap-1 text-12">
                            {primaryLanes.length > 0 && (
                              <div>
                                <span className="text-11 uppercase tracking-label text-ink-tertiary">Primary · </span>
                                <span className="text-zinc-900">{primaryLanes.map((l) => l.name).join(" · ")}</span>
                              </div>
                            )}
                            {fallbackLanes.length > 0 && (
                              <div>
                                <span className="text-11 uppercase tracking-label text-ink-tertiary">Fallback · </span>
                                <span className="text-zinc-900">{fallbackLanes.map((l) => l.name).join(" · ")}</span>
                              </div>
                            )}
                          </div>
                        </TD>
                      </TR>
                    )}
                  </React.Fragment>
                );
              })}
            </TBody>
          </Table>
        </Card>
      </section>

      {/* Lanes — what actually calls a model */}
      <section aria-labelledby="models-lanes-heading" className="flex flex-col gap-2">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 id="models-lanes-heading" className="m-0 text-14 font-medium text-zinc-900">
              Lanes
            </h2>
            <p className="m-0 text-12 text-ink-secondary">
              Grouped by the kind of work, so a lane running a heavier model than its job needs stands out. A lane with its own
              env pin can move without touching its selector. Expand a lane for its file and how it reaches the model.
            </p>
          </div>
          <div className="flex flex-wrap gap-1" role="group" aria-label="Lane filter">
            {FILTERS.map((f) => (
              <Button
                key={f.key}
                size="sm"
                variant={filter === f.key ? "primary" : "secondary"}
                onClick={() => setFilter(f.key)}
                aria-pressed={filter === f.key}
              >
                {f.label}
              </Button>
            ))}
          </div>
        </div>
        <Card className="overflow-hidden">
          <Table className="min-w-[1040px]">
            <THead>
              <TR>
                <TH>Lane</TH>
                <TH>Primary</TH>
                <TH>Fallback</TH>
                <TH>Applies</TH>
                <TH>Pin</TH>
              </TR>
            </THead>
            <TBody>
              {data.policies.map((p) => {
                const lanes = visibleLanes.filter((l) => l.policy === p.key);
                if (!lanes.length) return null;
                return (
                  <React.Fragment key={p.key}>
                    <TR className="bg-zinc-50 hover:bg-zinc-50">
                      <TD colSpan={5} className="py-2">
                        <span className="text-13 font-medium text-zinc-900">{p.label}</span>
                        <span className="ml-2 text-12 text-ink-secondary">
                          {p.description} · <span className="u-nums">{lanes.length}</span>
                        </span>
                      </TD>
                    </TR>
                    {lanes.map((l) => {
                      const changed = laneChanged(l);
                      const open = !!openLanes[l.id];
                      // A picker per leg that has its own env pin — the photo lanes
                      // carry theirs on the Gemini fallback leg, not the primary.
                      const pinLegs = [
                        { leg: l.primary, which: "primary" },
                        { leg: l.fallback, which: "fallback" },
                      ].filter((x) => x.leg?.pinEnv);
                      return (
                        <React.Fragment key={l.id}>
                          <TR className={cn(changed && "bg-zinc-50")}>
                            <TD>
                              <div className="flex items-start gap-1">
                                <DisclosureButton open={open} onClick={() => toggle(setOpenLanes, l.id)} label={`${open ? "Hide" : "Show"} details for ${l.name}`} />
                                <span className="flex flex-wrap items-center gap-1.5 pt-1.5 text-13 text-zinc-900">
                                  {l.name}
                                  {l.fanout && <Badge>fan-out</Badge>}
                                  {l.lock && <Badge>{l.lock.label}</Badge>}
                                </span>
                              </div>
                            </TD>
                            <TD>
                              <Leg leg={l.primary} catalog={catalog} effective={effectiveLeg(l, l.primary)} />
                            </TD>
                            <TD>
                              <Leg leg={l.fallback} catalog={catalog} effective={effectiveLeg(l, l.fallback)} />
                            </TD>
                            <TD>
                              {l.applies === "live" ? <Badge tone="strong">Next request</Badge> : <Badge>Restart</Badge>}
                            </TD>
                            <TD>
                              {pinLegs.length > 0 && !l.lock ? (
                                <div className="flex flex-col gap-1">
                                  {pinLegs.map(({ leg, which }) => (
                                    <label key={leg.pinEnv} className="flex flex-col gap-0.5">
                                      {pinLegs.length > 1 && (
                                        <span className="text-11 uppercase tracking-label text-ink-tertiary">{which}</span>
                                      )}
                                      <Select
                                        size="sm"
                                        aria-label={`Pin ${l.name}${which === "fallback" ? " fallback" : ""}`}
                                        value={draft[leg.pinEnv] || ""}
                                        onChange={onPick(leg.pinEnv, leg.accepts, modelLabel(catalog, leg.model))}
                                        className="w-52"
                                      >
                                        <option value="">
                                          {leg.pinned ? `Pinned: ${modelLabel(catalog, leg.model)}` : `Follow ${leg.selector || "default"}`}
                                        </option>
                                        {leg.pinned && (
                                          <option value={UNPIN}>
                                            Unpin · follow {leg.selector || "code default"} ({modelLabel(catalog, leg.unpinnedModel)})
                                          </option>
                                        )}
                                        <ModelOptions catalog={catalog} accepts={leg.accepts} exclude={leg.model} />
                                      </Select>
                                    </label>
                                  ))}
                                </div>
                              ) : (
                                <span className="text-12 text-ink-tertiary">
                                  {l.lock ? l.lock.detail || "not switchable here" : l.primary.selector ? `follows ${l.primary.selector}` : "—"}
                                </span>
                              )}
                            </TD>
                          </TR>
                          {open && (
                            <TR className="bg-zinc-50 hover:bg-zinc-50">
                              <TD colSpan={5} className="py-2 pl-11">
                                <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-12">
                                  <dt className="text-11 uppercase tracking-label text-ink-tertiary">File</dt>
                                  <dd className="m-0 text-zinc-900 u-nums">{l.file}</dd>
                                  <dt className="text-11 uppercase tracking-label text-ink-tertiary">Primary via</dt>
                                  <dd className="m-0 text-zinc-900 u-nums">{l.primary.via}</dd>
                                  {l.fallback && (
                                    <>
                                      <dt className="text-11 uppercase tracking-label text-ink-tertiary">Fallback via</dt>
                                      <dd className="m-0 text-zinc-900 u-nums">{l.fallback.via}</dd>
                                    </>
                                  )}
                                  {l.note && (
                                    <>
                                      <dt className="text-11 uppercase tracking-label text-ink-tertiary">Notes</dt>
                                      <dd className="m-0 text-ink-secondary">{l.note}</dd>
                                    </>
                                  )}
                                  {l.lock && (
                                    <>
                                      <dt className="text-11 uppercase tracking-label text-ink-tertiary">Lock</dt>
                                      <dd className="m-0 text-ink-secondary">
                                        {l.lock.label}
                                        {l.lock.detail ? ` — ${l.lock.detail}` : ""}
                                      </dd>
                                    </>
                                  )}
                                </dl>
                              </TD>
                            </TR>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </React.Fragment>
                );
              })}
              {visibleLanes.length === 0 && (
                <TR>
                  <TD colSpan={5} className="py-5 text-13 text-ink-secondary">
                    No lanes match this filter.
                  </TD>
                </TR>
              )}
            </TBody>
          </Table>
        </Card>
      </section>

      {/* Pending changes bar — sticky inside the content column (not viewport-
          fixed): the admin sidebar and the mobile tab bar own the viewport
          edges, so a fixed bar slid under both. */}
      {changes.length > 0 && (
        <div
          className="sticky bottom-0 z-30 -mx-1 border-t border-hairline border-zinc-200 bg-white/95 px-4 py-3"
          style={{ paddingBottom: "max(12px, env(safe-area-inset-bottom, 0px))" }}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-13 text-zinc-900">
              <span className="font-medium u-nums">{changes.length}</span> env change{changes.length === 1 ? "" : "s"} ·{" "}
              <span className="u-nums">{affectedLanes}</span> lane{affectedLanes === 1 ? "" : "s"} move
              {restartCount > 0 ? ` · ${restartCount} after restart` : ""}
            </span>
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" onClick={() => setDraft({})}>
                Discard
              </Button>
              <Button size="sm" onClick={() => setReview(true)}>
                Review changes
              </Button>
            </div>
          </div>
        </div>
      )}

      <Dialog open={review} onClose={() => setReview(false)} size="md">
        <DialogHeader>
          <DialogTitle>Railway env changes</DialogTitle>
          <p className="m-0 mt-1 text-12 text-ink-secondary">
            Paste into Railway → portal service → Variables. Railway restarts the service on save; every lane below picks up
            its new model then. Fallbacks stay in place, so a bad model id degrades to the backup instead of failing.
          </p>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {changes.map((c) => {
              const fromRate = fmtRate(catalog[c.from]?.rate);
              const toRate = fmtRate(catalog[c.to]?.rate);
              return (
                <li key={c.env} className="flex flex-col gap-0.5 text-13">
                  <span className="text-zinc-900">
                    <span className="font-medium">{c.label}</span>: {modelLabel(catalog, c.from)} → {destLabel(c)}
                    {c.unpin ? " · delete the variable" : ""}
                    {c.destinations?.length > 1 ? " · differs by lane" : ""}
                    {c.lanes > 1 ? ` · ${c.lanes} lanes` : ""}
                    {c.restart ? "" : " · next request"}
                  </span>
                  {(fromRate || toRate) && (
                    <span className="text-11 text-ink-secondary u-nums">
                      List rate: {fromRate || "—"} → {toRate || "—"}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          <pre className="m-0 overflow-x-auto rounded-sm border-hairline border-zinc-200 bg-zinc-50 p-3 text-12 text-zinc-900 u-nums">
            {envBlock}
          </pre>
          <p className="m-0 text-11 text-ink-tertiary">
            List rates are published per-1M-token prices as of {data.ratesAsOf}; they are not volume-weighted and exclude
            cached input, images and audio.
          </p>
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={() => setReview(false)}>
            Close
          </Button>
          <Button onClick={copyEnv} className="gap-2">
            <Copy size={13} strokeWidth={2} aria-hidden />
            {copied ? "Copied" : "Copy env lines"}
          </Button>
        </DialogFooter>
      </Dialog>

      {find && <FindModelDialog target={find} onClose={() => setFind(null)} onPick={(model) => onFound(find.env, model)} />}
    </div>
  );
}

// Live provider search. Results are filtered to the target's provider(s) by
// the server; picking one probes the retrieve endpoint first so a listed but
// not-enabled id is caught here, not after a Railway restart.
function FindModelDialog({ target, onClose, onPick }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState(null);
  const [unavailable, setUnavailable] = useState([]);
  const [capUnverified, setCapUnverified] = useState(false);
  const [searching, setSearching] = useState(false);
  const [probing, setProbing] = useState(null);
  const [problem, setProblem] = useState(null);
  const requestRef = useRef(0);

  useEffect(() => {
    const query = q.trim();
    if (query.length < 2) {
      setResults(null);
      return undefined;
    }
    const id = ++requestRef.current;
    const timer = setTimeout(async () => {
      setSearching(true);
      setProblem(null);
      try {
        const out = await adminFetch(
          `/admin/agents/models/search?q=${encodeURIComponent(query)}&providers=${encodeURIComponent(target.accepts.providers.join(","))}&cap=${encodeURIComponent(target.accepts.cap)}`,
        );
        if (id !== requestRef.current) return;
        setResults(out.results || []);
        setUnavailable(out.unavailable || []);
        setCapUnverified(!!out.capUnverified);
      } catch (e) {
        if (id === requestRef.current) setProblem(e?.message || "Search failed");
      } finally {
        if (id === requestRef.current) setSearching(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [q, target]);

  const choose = async (model) => {
    setProbing(model.id);
    setProblem(null);
    try {
      const verdict = await adminFetch("/admin/agents/models/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: model.provider, id: model.id }),
      });
      if (verdict?.ok) onPick(model);
      else setProblem(`${model.id}: ${verdict?.reason === "not_entitled" ? "listed, but this account is not enabled for it" : verdict?.reason === "not_found" ? "the provider does not know this id" : `check failed (${verdict?.reason || "unknown"})`}`);
    } catch (e) {
      setProblem(e?.message || "Check failed");
    } finally {
      setProbing(null);
    }
  };

  return (
    <Dialog open onClose={onClose} size="md">
      <DialogHeader>
        <DialogTitle>Find a model</DialogTitle>
        <p className="m-0 mt-1 text-12 text-ink-secondary">
          Searches {target.accepts.providers.map((p) => PROVIDER_LABEL[p] || p).join(" and ")} live, so a model released today
          is here. Replaces {target.currentLabel} for {target.env}.
        </p>
      </DialogHeader>
      <DialogBody className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-11 u-label text-ink-secondary">
          Model name or id
          <span className="relative block">
            <Search size={14} strokeWidth={2} aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-tertiary" />
            <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="fable 5.1, astra, opus 5…" className="pl-8" />
          </span>
        </label>
        {problem && (
          <div className="text-12 text-alert-fg" role="alert">
            {problem}
          </div>
        )}
        {unavailable.length > 0 && (
          <div className="text-12 text-ink-secondary">
            Not searched: {unavailable.map((u) => `${PROVIDER_LABEL[u.provider] || u.provider} (${UNAVAILABLE_REASON[u.reason] || u.reason})`).join(", ")}.
          </div>
        )}
        {capUnverified && results?.length > 0 && (
          <div className="text-12 text-alert-fg" role="alert">
            This selector needs image input. Provider lists don't say whether a model accepts images, so only pick one you know
            does — a text-only model here breaks the photo lanes after restart.
          </div>
        )}
        {searching && !results ? (
          <div className="text-13 text-ink-secondary" role="status">
            Searching…
          </div>
        ) : results && results.length === 0 ? (
          <div className="text-13 text-ink-secondary">No model matches "{q.trim()}".</div>
        ) : results ? (
          <ul className="m-0 flex list-none flex-col divide-y divide-zinc-200 border-hairline border-zinc-200 p-0">
            {results.map((m) => (
              <li key={`${m.provider}:${m.id}`} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <span className="flex flex-col">
                  <span className="text-13 text-zinc-900">{m.label}</span>
                  <span className="text-11 text-ink-tertiary u-nums">
                    {m.id} · {PROVIDER_LABEL[m.provider] || m.provider}
                    {m.createdAt ? ` · ${m.createdAt.slice(0, 10)}` : ""}
                  </span>
                </span>
                <Button size="sm" variant="secondary" onClick={() => choose(m)} disabled={!!probing}>
                  {probing === m.id ? "Checking…" : "Use"}
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="text-12 text-ink-tertiary">Type at least two characters.</div>
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
