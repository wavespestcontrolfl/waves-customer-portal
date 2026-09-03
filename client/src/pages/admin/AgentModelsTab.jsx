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
  { key: "nobackup", label: "No backup" },
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
  // requires:'deep' (Fable) is offered only where every call site goes
  // through llm/deep.js — the DEEP / EXTREME selectors and pins on their lanes.
  const options = Object.entries(catalog).filter(
    ([id, m]) =>
      id !== exclude &&
      accepts.providers.includes(m.provider) &&
      (m.caps.length === 0 || m.caps.includes(accepts.cap)) &&
      (!m.requires || (m.requires === "deep" && accepts.deep)),
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
  const [openModels, setOpenModels] = useState({});
  // Lanes-table filter by model id (set by a Models-in-use row's lane count).
  const [laneModel, setLaneModel] = useState(null);
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

  // A selector's drafted value, following registry aliases: a selector that
  // derives from another (OPENAI_SMS_DRAFT ← OPENAI_FAST while unset) moves
  // with its parent's draft unless drafted itself.
  const selectorDraft = useCallback(
    (key) => {
      const s = selectorByKey[key];
      if (!s) return undefined;
      if (draft[s.env]) return draft[s.env];
      if (s.derived && s.derivesFrom) return selectorDraft(s.derivesFrom);
      return undefined;
    },
    [draft, selectorByKey],
  );

  // Effective model for a leg after the draft: a lane pin wins over its
  // selector, exactly as `process.env.PIN || MODELS.TIER` does at boot.
  const effectiveLeg = useCallback(
    (lane, leg) => {
      if (!leg) return null;
      if (leg.pinEnv && draft[leg.pinEnv] === UNPIN) {
        // Unpinned: the selector's (possibly also drafted) value wins again.
        return (leg.selector && selectorDraft(leg.selector)) || leg.unpinnedModel;
      }
      if (leg.pinEnv && draft[leg.pinEnv]) return draft[leg.pinEnv];
      if (leg.pinEnv && leg.pinned) return leg.model; // pinned today; only the pin moves it
      const viaSelector = leg.selector && selectorDraft(leg.selector);
      if (viaSelector) return viaSelector;
      return leg.model;
    },
    [draft, selectorDraft],
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
    const baseAfterDraft = (leg) => (leg.selector && selectorDraft(leg.selector)) || leg.unpinnedModel || leg.model;
    const byEnv = new Map();
    for (const s of data.selectors) {
      const next = draft[s.env];
      if (next && next !== s.current) {
        // Followers = this selector plus any selector that derives from it and
        // is not set or drafted on its own (the registry alias).
        const keys = [s.key, ...data.selectors.filter((d) => d.derived && d.derivesFrom === s.key && !draft[d.env]).map((d) => d.key)];
        const follows = (leg) => leg && keys.includes(leg.selector) && !pinnedAfterDraft(leg);
        const following = data.lanes.filter((l) => follows(l.primary) || follows(l.fallback));
        const lockedLanes = following.filter((l) => l.lock).map((l) => l.name);
        const derivedKeys = keys.slice(1);
        byEnv.set(s.env, {
          env: s.env,
          from: s.current,
          to: next,
          label: `${s.key} selector${derivedKeys.length ? ` (+ ${derivedKeys.join(", ")}, unset so it follows)` : ""}`,
          lanes: following.length,
          lockedLanes,
          restart: true,
        });
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
        // An unpin is always a change (the Railway variable goes away) even
        // when the model it lands on is the one it was pinned to.
        if (!unpin && sharing.every((x) => next === baseAfterDraft(legOf(x)) && !legOf(x).pinned)) continue;
        const label = sharing.length > 1 ? `${env} (${sharing.map((x) => x.name).join(", ")})` : `${l.name}${leg === l.fallback ? " · fallback" : ""}`;
        byEnv.set(env, { env, from: leg.model, to: destinations[0], destinations, unpin, label, lanes: sharing.length, restart: sharing.some((x) => x.applies !== "live") });
      }
    }
    return [...byEnv.values()];
  }, [data, draft, selectorByKey]);

  // One row per model actually running: the selectors resolving to it and
  // how many lanes run it as primary / fallback (pins and literals included).
  const modelsInUse = useMemo(() => {
    if (!data) return [];
    const rows = new Map();
    const row = (id) => {
      if (!rows.has(id)) rows.set(id, { id, selectors: [], primaryLanes: 0, fallbackLanes: 0 });
      return rows.get(id);
    };
    for (const s of data.selectors) row(s.current).selectors.push(s);
    for (const l of data.lanes) {
      const r = row(l.primary.model);
      r.primaryLanes += 1;
      // What catches this model's lanes if its provider is down: the set of
      // fallback models across its primary lanes, plus how many have none.
      r.backups = r.backups || new Map();
      if (l.fallback?.model) {
        r.backups.set(l.fallback.model, (r.backups.get(l.fallback.model) || 0) + 1);
        row(l.fallback.model).fallbackLanes += 1;
      } else {
        r.noBackup = (r.noBackup || 0) + 1;
      }
    }
    const providerOrder = { anthropic: 0, openai: 1, gemini: 2 };
    return [...rows.values()].sort(
      (a, b) =>
        (providerOrder[catalog[a.id]?.provider] ?? 9) - (providerOrder[catalog[b.id]?.provider] ?? 9) ||
        b.primaryLanes - a.primaryLanes ||
        a.id.localeCompare(b.id),
    );
  }, [data, catalog]);

  // What a whole-model switch may offer: the provider is shared (one id, one
  // provider); the modality is the union its selectors need; Fable only when
  // every selector is on the deep path. Locked selectors are left out.
  const modelAccepts = (m) => {
    const open = m.selectors.filter((s) => !s.lock);
    if (!open.length) return null;
    const caps = new Set(open.map((s) => s.accepts.cap));
    return {
      providers: [catalog[m.id]?.provider],
      cap: caps.has("vision") ? "vision" : [...caps][0],
      deep: open.every((s) => s.accepts.deep),
      envs: open.map((s) => s.env),
    };
  };

  const destLabel = (c) => (c.destinations || [c.to]).map((id) => modelLabel(catalog, id)).join(" / ");

  // Inbound-content lanes that a change lands on Gemini. The Gemini adapter
  // (llm/call.js) folds the system prompt into the user turn, so customer or
  // third-party text on it has no instruction boundary — say so before copy.
  const geminiInboundLanes = useMemo(() => {
    if (!data) return [];
    return data.lanes
      .filter((l) => l.inbound && laneChanged(l))
      .filter((l) => [effectiveLeg(l, l.primary), effectiveLeg(l, l.fallback)].some((id) => id && catalog[id]?.provider === "gemini" && ![l.primary.model, l.fallback?.model].includes(id)))
      .map((l) => l.name);
  }, [data, laneChanged, effectiveLeg, catalog]);
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

  // A picker change: FIND opens the search for the env(s), anything else
  // drafts. A Models-in-use row drafts every selector on that model at once.
  const onPick = (envs, accepts, currentLabel) => (e) => {
    const v = e.target.value;
    const list = Array.isArray(envs) ? envs : [envs];
    if (v === FIND) {
      setFind({ envs: list, accepts, currentLabel });
      return;
    }
    list.forEach((env) => setDraftValue(env, v));
  };

  const onFound = (envs, model) => {
    setDiscovered((prev) => ({
      ...prev,
      // Offered only for the modality it was found for; a text-selector find
      // must not surface in a vision picker later in the session.
      [model.id]: { label: model.label || model.id, provider: model.provider, caps: [find?.accepts?.cap || "text"], status: "current", discovered: true },
    }));
    envs.forEach((env) => setDraftValue(env, model.id));
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
      if (laneModel && l.primary.model !== laneModel && l.fallback?.model !== laneModel) return false;
      if (filter === "changed") return laneChanged(l);
      if (filter === "pinned") return l.primary.pinned || (l.fallback && l.fallback.pinned);
      if (filter === "fanout") return l.fanout;
      if (filter === "locked") return !!l.lock;
      if (filter === "nobackup") return !l.fallback;
      return true;
    });
  }, [data, filter, laneChanged, laneModel]);

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
          <span className="font-medium text-zinc-900 u-nums">{data.lanes.length}</span> AI lanes on{" "}
          <span className="font-medium text-zinc-900 u-nums">{modelsInUse.length}</span> models through{" "}
          <span className="u-nums">{data.selectors.length}</span> registry selectors ·{" "}
          <span className="u-nums">{overriddenCount}</span> overridden by env today ·{" "}
          <span className="u-nums">{data.lanes.filter((l) => !l.fallback).length}</span> lanes have no backup model. Every selector is read once at boot, so a
          switch is a Railway env change plus the restart Railway performs on save. Nothing here sends anything to a customer.
        </p>
        <Button size="sm" variant="secondary" onClick={load} disabled={loading} className="gap-2">
          <RefreshCw size={13} strokeWidth={2} className={loading ? "animate-spin" : undefined} aria-hidden />
          {loading ? "Refreshing" : "Refresh"}
        </Button>
      </div>

      {/* Models in use — one row per model actually running */}
      <section aria-labelledby="models-in-use-heading" className="flex flex-col gap-2">
        <div>
          <h2 id="models-in-use-heading" className="m-0 text-14 font-medium text-zinc-900">
            Models in use
          </h2>
          <p className="m-0 text-12 text-ink-secondary">
            Every model something runs on right now. "Change to" moves every selector on that model at once; expand a row to
            move one selector on its own. "Find a model…" searches the providers live for anything newer.
          </p>
        </div>
        <Card className="overflow-hidden">
          <Table className="min-w-[880px]">
            <THead>
              <TR>
                <TH>Model</TH>
                <TH>Selectors</TH>
                <TH align="right">Lanes</TH>
                <TH>Backup if this provider is down</TH>
                <TH>Change to</TH>
              </TR>
            </THead>
            <TBody>
              {modelsInUse.map((m) => {
                const info = catalog[m.id];
                const accepts = modelAccepts(m);
                const open = !!openModels[m.id];
                const envs = accepts?.envs || [];
                const drafts = envs.map((env) => draft[env]).filter(Boolean);
                const allSame = drafts.length === envs.length && drafts.every((v) => v === drafts[0]);
                const rowValue = allSame && drafts[0] && drafts[0] !== m.id ? drafts[0] : "";
                const mixed = drafts.length > 0 && !allSame;
                const lockedOnly = m.selectors.length > 0 && m.selectors.every((s) => s.lock);
                const total = m.primaryLanes + m.fallbackLanes;
                return (
                  <React.Fragment key={m.id}>
                    <TR className={cn((rowValue || mixed) && "bg-zinc-50")}>
                      <TD>
                        <div className="flex items-start gap-1">
                          <DisclosureButton open={open} onClick={() => toggle(setOpenModels, m.id)} label={`${open ? "Hide" : "Show"} selectors for ${modelLabel(catalog, m.id)}`} />
                          <div className="flex flex-col gap-0.5 pt-1.5">
                            <ModelChip catalog={catalog} id={m.id} />
                            <span className="text-11 text-ink-tertiary u-nums">
                              {m.id}
                              {info?.status === "legacy" ? " · legacy" : ""}
                            </span>
                          </div>
                        </div>
                      </TD>
                      <TD>
                        {m.selectors.length ? (
                          <span className="flex flex-wrap gap-1">
                            {m.selectors.map((s) => (
                              <Badge key={s.key} tone={s.overridden ? "strong" : "neutral"} title={s.overridden ? `${s.env} set in Railway` : `${s.env} · code default`}>
                                {s.key}
                              </Badge>
                            ))}
                          </span>
                        ) : (
                          <span className="text-12 text-ink-tertiary">lane pins / code defaults only</span>
                        )}
                      </TD>
                      <TD align="right">
                        {total > 0 ? (
                          <button
                            type="button"
                            onClick={() => {
                              setLaneModel(laneModel === m.id ? null : m.id);
                              document.getElementById("models-lanes-heading")?.scrollIntoView({ block: "start" });
                            }}
                            aria-pressed={laneModel === m.id}
                            className={cn("inline-flex items-baseline gap-1 rounded-sm px-1 text-13 text-zinc-900 underline-offset-2 hover:underline u-focus-ring", laneModel === m.id && "bg-zinc-900 text-white hover:no-underline")}
                            title="Show these lanes below"
                          >
                            <span className="u-nums">{m.primaryLanes}</span>
                            {m.fallbackLanes > 0 && <span className={cn("text-11", laneModel === m.id ? "text-zinc-300" : "text-ink-tertiary")}>+{m.fallbackLanes} fallback</span>}
                          </button>
                        ) : (
                          <span className="text-12 text-ink-tertiary">0</span>
                        )}
                      </TD>
                      <TD>
                        {m.primaryLanes === 0 ? (
                          <span className="text-12 text-ink-tertiary">—</span>
                        ) : (
                          <div className="flex flex-col gap-0.5 text-12">
                            {[...(m.backups || new Map()).entries()]
                              .sort((a, b) => b[1] - a[1])
                              .map(([id, n]) => {
                                const sameProvider = catalog[id]?.provider === catalog[m.id]?.provider;
                                return (
                                  <span key={id} className="text-zinc-900">
                                    {modelLabel(catalog, id)} <span className="text-ink-tertiary u-nums">· {n}</span>
                                    {sameProvider && (
                                      <span className="ml-1 text-11 text-alert-fg" title="Same provider — an outage takes both legs down">same provider</span>
                                    )}
                                  </span>
                                );
                              })}
                            {m.noBackup > 0 && (
                              <span className="text-alert-fg">
                                none <span className="u-nums">· {m.noBackup}</span> lane{m.noBackup === 1 ? "" : "s"}
                              </span>
                            )}
                          </div>
                        )}
                      </TD>
                      <TD>
                        {lockedOnly ? (
                          <span className="text-12 text-ink-secondary">{m.selectors[0].lock.label}</span>
                        ) : accepts ? (
                          <div className="flex flex-col gap-0.5">
                            <Select
                              size="sm"
                              aria-label={`Change every selector on ${modelLabel(catalog, m.id)}`}
                              value={rowValue}
                              onChange={onPick(envs, accepts, modelLabel(catalog, m.id))}
                              className="w-56"
                            >
                              <option value="">{mixed ? "Mixed — see selectors" : `Keep ${modelLabel(catalog, m.id)}`}</option>
                              <ModelOptions catalog={catalog} accepts={accepts} exclude={m.id} />
                            </Select>
                            {rowValue && (
                              <span className="text-11 text-ink-secondary">
                                {envs.length} selector{envs.length === 1 ? "" : "s"} move
                                {m.selectors.length > envs.length ? ` · ${m.selectors.length - envs.length} locked stay` : ""}
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="text-12 text-ink-tertiary">pinned by lane — change it on the lane</span>
                        )}
                      </TD>
                    </TR>
                    {open && (
                      <TR className="bg-zinc-50 hover:bg-zinc-50">
                        <TD colSpan={5} className="py-2 pl-11">
                          {m.selectors.length === 0 ? (
                            <span className="text-12 text-ink-secondary">No registry selector resolves here; the lanes below reach it through their own env pin or a code default.</span>
                          ) : (
                            <ul className="m-0 flex list-none flex-col gap-2 p-0">
                              {m.selectors.map((s) => {
                                const next = draft[s.env];
                                const changed = next && next !== s.current;
                                return (
                                  <li key={s.key} className="grid grid-cols-[minmax(160px,1fr)_minmax(200px,1fr)_auto_minmax(220px,auto)] items-center gap-3 text-12">
                                    <span className="flex flex-col">
                                      <span className="font-medium text-zinc-900">{s.key}</span>
                                      <span className="text-11 text-ink-tertiary">{s.description}</span>
                                    </span>
                                    <span className="u-nums text-ink-secondary">
                                      {s.env}
                                      <span className="ml-2">
                                        {s.overridden ? <Badge tone="strong">env override</Badge> : <Badge>code default</Badge>}
                                      </span>
                                    </span>
                                    <span className="u-nums text-ink-secondary">{s.laneCount} primary</span>
                                    {s.lock ? (
                                      <span className="text-ink-secondary">{s.lock.label}</span>
                                    ) : (
                                      <span className="flex flex-col gap-0.5">
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
                                        {changed && <span className="text-11 text-ink-secondary">→ {modelLabel(catalog, next)}</span>}
                                      </span>
                                    )}
                                  </li>
                                );
                              })}
                            </ul>
                          )}
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
          <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Lane filter">
            {laneModel && (
              <Button size="sm" variant="primary" onClick={() => setLaneModel(null)} aria-label={`Clear model filter ${modelLabel(catalog, laneModel)}`}>
                {modelLabel(catalog, laneModel)} ×
              </Button>
            )}
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
                                  {l.inbound && <Badge title="Prompt carries customer or third-party content">inbound</Badge>}
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
              return (
                <li key={c.env} className="flex flex-col gap-0.5 text-13">
                  <span className="text-zinc-900">
                    <span className="font-medium">{c.label}</span>: {modelLabel(catalog, c.from)} → {destLabel(c)}
                    {c.unpin ? " · delete the variable" : ""}
                    {c.destinations?.length > 1 ? " · differs by lane" : ""}
                    {c.lanes > 1 ? ` · ${c.lanes} lanes` : ""}
                    {c.restart ? "" : " · next request"}
                  </span>
                  {c.lockedLanes?.length > 0 && (
                    <span className="text-11 text-alert-fg">
                      Also moves locked lanes that follow this selector by design: {c.lockedLanes.join(", ")}.
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          {geminiInboundLanes.length > 0 && (
            <div className="text-12 text-alert-fg" role="alert">
              Moves inbound customer content onto Gemini: {geminiInboundLanes.join(", ")}. The Gemini adapter has no
              system-instruction boundary yet (llm/call.js folds it into the user turn), so this widens the prompt-injection
              surface until that is fixed.
            </div>
          )}
          <pre className="m-0 overflow-x-auto rounded-sm border-hairline border-zinc-200 bg-zinc-50 p-3 text-12 text-zinc-900 u-nums">
            {envBlock}
          </pre>
          <p className="m-0 text-11 text-ink-tertiary">
            Cost impact is not shown yet: provider APIs publish no prices, so a weekly pull into a price table is the next
            PR.
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

      {find && <FindModelDialog target={find} onClose={() => setFind(null)} onPick={(model) => onFound(find.envs, model)} />}
    </div>
  );
}

// Live provider search. Results are filtered to the target's provider(s) by
// the server; picking one probes the retrieve endpoint first so a listed but
// not-enabled id is caught here, not after a Railway restart.
function FindModelDialog({ target, onClose, onPick }) {
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
  const closedRef = useRef(false);
  useEffect(() => () => { closedRef.current = true; }, []);

  useEffect(() => {
    const query = q.trim();
    // Empty box → the newest ids per provider (a release whose id doesn't
    // carry its name still shows by date); two+ characters → a search.
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
  }, [q, target]);

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
      if (verdict?.ok) onPick(model);
      else setProblem(`${model.id}: ${verdict?.reason === "not_entitled" ? "listed, but this account is not enabled for it" : verdict?.reason === "not_found" ? "the provider does not know this id" : `check failed (${verdict?.reason || "unknown"})`}`);
    } catch (e) {
      if (!closedRef.current) setProblem(e?.message || "Check failed");
    } finally {
      if (!closedRef.current) setProbing(null);
    }
  };

  return (
    <Dialog open onClose={onClose} size="md">
      <DialogHeader>
        <DialogTitle>Find a model</DialogTitle>
        <p className="m-0 mt-1 text-12 text-ink-secondary">
          Searches {target.accepts.providers.map((p) => PROVIDER_LABEL[p] || p).join(" and ")} live, so a model released today
          is here. Replaces {target.currentLabel} for {target.envs.join(", ")}.
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
        {capUnverified && (results?.length > 0 || newest?.some((g) => g.items.length > 0)) && (
          <div className="text-12 text-alert-fg" role="alert">
            This selector needs image input. Provider lists don't say whether a model accepts images, so only pick one you know
            does — a text-only model here breaks the photo lanes after restart.
          </div>
        )}
        {q.trim().length >= 2 ? (
          searching && !results ? (
            <div className="text-13 text-ink-secondary" role="status">
              Searching…
            </div>
          ) : results && results.length === 0 ? (
            <div className="text-13 text-ink-secondary">No model matches "{q.trim()}".</div>
          ) : results ? (
            <ResultList items={results} probing={probing} onChoose={choose} deepBlocked={deepBlocked} />
          ) : null
        ) : newest && newest.length > 0 ? (
          <div className="flex flex-col gap-3">
            {newest.map((group) => (
              <div key={group.provider} className="flex flex-col gap-1">
                <span className="text-11 uppercase tracking-label text-ink-secondary">
                  Newest listed by {PROVIDER_LABEL[group.provider] || group.provider}
                </span>
                <ResultList items={group.items} probing={probing} onChoose={choose} deepBlocked={deepBlocked} />
              </div>
            ))}
          </div>
        ) : searching ? (
          <div className="text-13 text-ink-secondary" role="status">
            Loading the newest models…
          </div>
        ) : (
          <div className="text-12 text-ink-tertiary">Type a name or id, or pick from the newest below once they load.</div>
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

function ResultList({ items, probing, onChoose, deepBlocked }) {
  return (
    <ul className="m-0 flex list-none flex-col divide-y divide-zinc-200 border-hairline border-zinc-200 p-0">
      {items.map((m) => {
        const blocked = deepBlocked(m);
        return (
          <li key={`${m.provider}:${m.id}`} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
            <span className="flex flex-col">
              <span className="text-13 text-zinc-900">{m.label}</span>
              <span className="text-11 text-ink-tertiary u-nums">
                {m.id} · {PROVIDER_LABEL[m.provider] || m.provider}
                {m.createdAt ? ` · ${m.createdAt.slice(0, 10)}` : ""}
              </span>
              {blocked && (
                <span className="text-11 text-ink-secondary">Only DEEP / EXTREME selectors can run this model (llm/deep.js path).</span>
              )}
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
