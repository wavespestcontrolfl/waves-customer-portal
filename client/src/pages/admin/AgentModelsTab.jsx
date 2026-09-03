import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Copy, RefreshCw, Search, X } from "lucide-react";
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
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  cn,
} from "../../components/ui";
import { adminFetch } from "../../utils/admin-fetch";

// Agents → Models: one table of every AI lane, grouped by product area, each
// with a plain-English line, the model it runs on now, its backup, and what
// would catch a regression after a switch (continuity). Data comes resolved
// from the server (GET /admin/agents/models → server/services/model-switchboard.js).
//
// Honest about today's mechanism: every registry selector is a module-load
// const, so a switch IS a Railway env change followed by the restart Railway
// does on save. The tab never writes; it composes the exact env lines and
// shows the blast radius before the owner pastes them.
//
// Picking is search-first: the picker opens a dialog that lists the models the
// lane can run, the newest ids per provider (live from the providers), and a
// search box. Every pick is probed against the provider before it is drafted.

const FILTERS = [
  { key: "all", label: "All" },
  { key: "changed", label: "Changing" },
  { key: "nobackup", label: "No backup" },
  { key: "unchecked", label: "Unchecked" },
  { key: "locked", label: "Locked" },
];

// Draft value meaning "delete this env var in Railway" — a pinned leg then
// falls back to its selector / code default (`process.env.PIN || …`).
const UNPIN = "__unpin__";

const PROVIDER_LABEL = { anthropic: "Anthropic", openai: "OpenAI", gemini: "Gemini", perplexity: "Perplexity", unknown: "—" };

const UNAVAILABLE_REASON = {
  no_key: "no API key on this server",
  cap_not_searchable: "this modality is not searchable",
  http_401: "API key rejected",
  http_403: "API key rejected",
  http_400: "API key rejected",
  timeout: "timed out",
  fetch_failed: "unreachable",
};

const CONTINUITY = {
  judged: { label: "Judged", tone: "strong", help: "A judge or replay eval scores this lane against human truth, so a switch is checked." },
  verified: { label: "Verified", tone: "neutral", help: "A deterministic checker gates the output; bad output is rejected, not sent." },
  unchecked: { label: "Unchecked", tone: "neutral", help: "Nothing catches a regression after a switch except you." },
};

function modelLabel(catalog, id) {
  if (!id) return "—";
  return catalog[id]?.label || id;
}

// The model's name only (owner: no provider / id text under the name).
function ModelChip({ catalog, id }) {
  if (!id) return <span className="text-ink-tertiary">—</span>;
  const m = catalog[id];
  return (
    <span className="inline-flex flex-wrap items-baseline gap-1.5">
      <span className="text-13 text-zinc-900">{m?.label || id}</span>
      {m?.discovered && <Badge className="whitespace-nowrap">new</Badge>}
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
      {changed && <span className="text-11 text-ink-secondary">was {modelLabel(catalog, leg.model)}</span>}
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

// Which catalog models a leg / selector may take: same provider, the modality
// it needs, and requires:'deep' (Fable) only where every call site goes
// through llm/deep.js.
function optionsFor(catalog, accepts, exclude) {
  return Object.entries(catalog)
    .filter(
      ([id, m]) =>
        id !== exclude &&
        accepts.providers.includes(m.provider) &&
        (m.caps.length === 0 || m.caps.includes(accepts.cap)) &&
        (!m.requires || (m.requires === "deep" && accepts.deep)),
    )
    .map(([id, m]) => ({ id, label: m.label, provider: m.provider, status: m.status, requiresDeep: m.requires === "deep" }));
}

// Every leg a lane runs or falls back to: primary, fallback, the fallback's
// retry, and any parallel arms.
const legsOf = (lane) => [lane.primary, lane.fallback, lane.retry, ...(lane.also || [])].filter(Boolean);

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
  const [openLanes, setOpenLanes] = useState({});
  // Models found through live search, merged into the catalog for labels.
  const [discovered, setDiscovered] = useState({});
  // Picker dialog target: { envs, accepts, title, subtitle, current, canUnpin, unpinLabel }.
  const [find, setFind] = useState(null);
  const [pickProblem, setPickProblem] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await adminFetch("/admin/agents/models"));
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
  const selectorByKey = useMemo(() => Object.fromEntries((data?.selectors || []).map((s) => [s.key, s])), [data]);

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
      if (leg.pinEnv && draft[leg.pinEnv] === UNPIN) return (leg.selector && selectorDraft(leg.selector)) || leg.unpinnedModel;
      if (leg.pinEnv && draft[leg.pinEnv]) return draft[leg.pinEnv];
      if (leg.pinEnv && leg.pinned) return leg.model;
      return (leg.selector && selectorDraft(leg.selector)) || leg.model;
    },
    [draft, selectorDraft],
  );

  const laneChanged = useCallback((lane) => legsOf(lane).some((leg) => effectiveLeg(lane, leg) !== leg.model), [effectiveLeg]);

  // Where a leg's model actually comes from: its own env pin, else the shared
  // selector it follows (a change there moves every lane on that selector).
  const envForLeg = (leg) => leg.pinEnv || (leg.selector && selectorByKey[leg.selector]?.env) || null;
  const siblingsOf = (lane, leg) => {
    if (leg.pinEnv || !leg.selector) return [];
    return data.lanes.filter((l) => l.id !== lane.id && legsOf(l).some((g) => g.selector === leg.selector && !g.pinned)).map((l) => l.name);
  };

  // One change per env var, computed from the COMPLETE draft: selectors
  // (with derived aliases and locked holds), then pins aggregated by env.
  const changes = useMemo(() => {
    if (!data) return [];
    const pinnedAfterDraft = (leg) => (leg.pinEnv && draft[leg.pinEnv] ? draft[leg.pinEnv] !== UNPIN : !!leg.pinned);
    const baseAfterDraft = (leg) => (leg.selector && selectorDraft(leg.selector)) || leg.unpinnedModel || leg.model;
    const byEnv = new Map();
    for (const s of data.selectors) {
      const next = draft[s.env];
      if (!next || next === s.current) continue;
      // Followers = this selector plus any unlocked selector that derives from
      // it and is not set or drafted on its own. A LOCKED derived selector is
      // held at its current model with a pin line of its own.
      const derived = data.selectors.filter((d) => d.derived && d.derivesFrom === s.key && !draft[d.env]);
      const held = derived.filter((d) => d.lock);
      const moving = derived.filter((d) => !d.lock);
      const keys = [s.key, ...moving.map((d) => d.key)];
      const follows = (leg) => leg && keys.includes(leg.selector) && !pinnedAfterDraft(leg);
      const following = data.lanes.filter((l) => legsOf(l).some(follows));
      byEnv.set(s.env, {
        env: s.env,
        from: s.current,
        to: next,
        label: `${s.key} selector${moving.length ? ` (+ ${moving.map((d) => d.key).join(", ")}, unset so it follows)` : ""}`,
        lanes: following.length,
        laneNames: following.map((l) => l.name),
        lockedLanes: following.filter((l) => l.lock).map((l) => l.name),
        uncheckedLanes: following.filter((l) => l.continuity === "unchecked").length,
        restart: true,
      });
      for (const d of held) {
        byEnv.set(d.env, { env: d.env, from: d.current, to: d.current, hold: true, label: `${d.key} held at its current model (locked; it would otherwise follow ${s.key})`, lanes: 0, restart: true });
      }
    }
    for (const l of data.lanes) {
      for (const leg of legsOf(l)) {
        const env = leg?.pinEnv;
        const next = env && draft[env];
        if (!next || byEnv.has(env)) continue;
        const unpin = next === UNPIN;
        const sharing = data.lanes.filter((x) => legsOf(x).some((g) => g.pinEnv === env));
        const legOf = (x) => legsOf(x).find((g) => g.pinEnv === env);
        // Unpinning a shared env can land its lanes on different models.
        const destinations = unpin ? [...new Set(sharing.map((x) => baseAfterDraft(legOf(x))))] : [next];
        if (!unpin && sharing.every((x) => next === baseAfterDraft(legOf(x)) && !legOf(x).pinned)) continue;
        const label = sharing.length > 1 ? `${env} (${sharing.map((x) => x.name).join(", ")})` : `${l.name}${leg === l.primary ? "" : " · backup"}`;
        byEnv.set(env, {
          env,
          from: leg.model,
          to: destinations[0],
          destinations,
          unpin,
          label,
          lanes: sharing.length,
          laneNames: sharing.map((x) => x.name),
          uncheckedLanes: sharing.filter((x) => x.continuity === "unchecked").length,
          // Timing comes from the leg the env feeds (a live fallback pin
          // applies on the next request even if the primary is boot-time).
          restart: sharing.some((x) => !legOf(x).live),
        });
      }
    }
    return [...byEnv.values()];
  }, [data, draft, selectorDraft]);

  const destLabel = (c) => (c.destinations || [c.to]).map((id) => modelLabel(catalog, id)).join(" / ");
  // Unpins are deletions: Railway has no "unset" syntax, so the line is an
  // instruction rather than an assignment.
  const envBlock = changes.map((c) => (c.unpin ? `# delete ${c.env}  (unpin → ${destLabel(c)})` : `${c.env}=${c.to}`)).join("\n");
  const restartCount = changes.filter((c) => c.restart && !c.hold).length;
  const affectedLanes = data ? data.lanes.filter(laneChanged).length : 0;
  const uncheckedMoving = data ? data.lanes.filter((l) => laneChanged(l) && l.continuity === "unchecked").length : 0;

  // Inbound-content lanes that a change lands on Gemini (the adapter folds the
  // system prompt into the user turn — no instruction boundary yet).
  const geminiInboundLanes = useMemo(() => {
    if (!data) return [];
    return data.lanes
      .filter((l) => l.inbound && laneChanged(l))
      .filter((l) => legsOf(l).some((leg) => { const id = effectiveLeg(l, leg); return id && id !== leg.model && catalog[id]?.provider === "gemini"; }))
      .map((l) => l.name);
  }, [data, laneChanged, effectiveLeg, catalog]);

  const setDraftValue = (env, value) => {
    setDraft((prev) => {
      const next = { ...prev };
      if (value) next[env] = value;
      else delete next[env];
      return next;
    });
  };

  // Open the picker for a leg. The dialog probes the pick before it lands.
  const openPicker = (lane, leg, which) => {
    const env = envForLeg(leg);
    if (!env) return;
    const siblings = siblingsOf(lane, leg);
    setFind({
      envs: [env],
      accepts: leg.accepts,
      current: leg.model,
      title: which === "primary" ? lane.name : `${lane.name} · ${which}`,
      subtitle: siblings.length
        ? `This lane shares its model with ${siblings.length} other${siblings.length === 1 ? "" : "s"} (${siblings.slice(0, 4).join(", ")}${siblings.length > 4 ? ", …" : ""}). A change moves all of them.`
        : lane.describe,
      canUnpin: !!leg.pinned,
      unpinLabel: leg.pinned ? `Unpin · follow ${leg.selector || "code default"} (${modelLabel(catalog, leg.unpinnedModel)})` : null,
    });
  };

  // Whole-model upgrade from the "Running now" chips: every unlocked selector on it.
  const openModelPicker = (id) => {
    const sels = data.selectors.filter((s) => s.current === id && !s.lock);
    if (!sels.length) return;
    const caps = new Set(sels.map((s) => s.accepts.cap));
    setFind({
      envs: sels.map((s) => s.env),
      accepts: { providers: [catalog[id]?.provider], cap: caps.has("vision") ? "vision" : [...caps][0], deep: sels.every((s) => s.accepts.deep) },
      current: id,
      title: `Everything on ${modelLabel(catalog, id)}`,
      subtitle: `Moves every lane that runs ${modelLabel(catalog, id)} (through ${sels.map((s) => s.key).join(", ")}).`,
    });
  };

  const onFound = (envs, model) => {
    setPickProblem(null);
    if (model.id !== UNPIN) {
      setDiscovered((prev) => ({
        ...prev,
        // Keep whatever the catalog knew (caps, deep-only); a live-search
        // find is offered only for the modality it was found for.
        [model.id]: {
          ...(prev[model.id] || catalog[model.id] || {}),
          label: model.label || model.id,
          provider: model.provider,
          caps: catalog[model.id]?.caps?.length ? catalog[model.id].caps : [find?.accepts?.cap || "text"],
          status: "current",
          discovered: !catalog[model.id] || !!catalog[model.id].discovered,
          ...((model.requiresDeep || catalog[model.id]?.requires === "deep") ? { requires: "deep" } : {}),
        },
      }));
    }
    if (model.unverified) setPickProblem(`${model.label || model.id} drafted UNVERIFIED: the provider check could not run on this server. Confirm the id is enabled for the prod account before applying.`);
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
      if (filter === "changed") return laneChanged(l);
      if (filter === "nobackup") return !l.fallback;
      if (filter === "unchecked") return l.continuity === "unchecked";
      if (filter === "locked") return !!l.lock;
      return true;
    });
  }, [data, filter, laneChanged]);

  const modelsInUse = useMemo(() => {
    if (!data) return [];
    const counts = new Map();
    for (const l of data.lanes) {
      counts.set(l.primary.model, (counts.get(l.primary.model) || 0) + 1);
      for (const a of l.also || []) counts.set(a.model, (counts.get(a.model) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [data]);

  if (loading && !data) {
    return (
      <Card className="p-5 text-13 text-ink-secondary" role="status">
        Loading…
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

  const noBackup = data.lanes.filter((l) => !l.fallback).length;
  const unchecked = data.lanes.filter((l) => l.continuity === "unchecked").length;
  const toggle = (setter, key) => setter((prev) => ({ ...prev, [key]: !prev[key] }));

  return (
    <div className="flex flex-col gap-4 pb-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-2">
          <p className="m-0 text-13 text-ink-secondary">
            <span className="font-medium text-zinc-900 u-nums">{data.lanes.length}</span> AI lanes ·{" "}
            <span className="u-nums">{noBackup}</span> with no backup ·{" "}
            <span className="u-nums">{unchecked}</span> unchecked after a switch. Changes apply after Railway restarts; nothing here
            sends anything to a customer.
          </p>
          <div className="flex flex-wrap items-center gap-1" aria-label="Models in use">
            <span className="text-11 uppercase tracking-label text-ink-tertiary">Running now</span>
            {modelsInUse.map(([id, n]) => {
              const upgradable = data.selectors.some((s) => s.current === id && !s.lock);
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => openModelPicker(id)}
                  disabled={!upgradable}
                  title={upgradable ? `Change everything on ${modelLabel(catalog, id)}` : "Changed per lane"}
                  className={cn(
                    "inline-flex items-baseline gap-1 rounded-sm border-hairline border-zinc-300 bg-white px-2 py-0.5 text-12 text-zinc-900 u-focus-ring",
                    upgradable ? "hover:bg-zinc-50" : "cursor-default text-ink-secondary",
                  )}
                >
                  {modelLabel(catalog, id)} <span className="text-11 text-ink-tertiary u-nums">{n}</span>
                </button>
              );
            })}
          </div>
        </div>
        <Button size="sm" variant="secondary" onClick={load} disabled={loading} className="gap-2">
          <RefreshCw size={13} strokeWidth={2} className={loading ? "animate-spin" : undefined} aria-hidden />
          {loading ? "Refreshing" : "Refresh"}
        </Button>
      </div>
      {pickProblem && (
        <div className="text-12 text-alert-fg" role="alert">
          {pickProblem}
        </div>
      )}

      <section aria-labelledby="models-lanes-heading" className="flex flex-col gap-2">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <h2 id="models-lanes-heading" className="m-0 text-14 font-medium text-zinc-900">
            Lanes
          </h2>
          <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Lane filter">
            {FILTERS.map((f) => (
              <Button key={f.key} size="sm" variant={filter === f.key ? "primary" : "secondary"} onClick={() => setFilter(f.key)} aria-pressed={filter === f.key}>
                {f.label}
              </Button>
            ))}
          </div>
        </div>
        <Card className="overflow-hidden">
          <Table className="min-w-[960px]">
            <THead>
              <TR>
                <TH>Lane</TH>
                <TH>Model</TH>
                <TH>Backup</TH>
                <TH>Continuity</TH>
                <TH>Change</TH>
              </TR>
            </THead>
            <TBody>
              {data.areas.map((area) => {
                const lanes = visibleLanes.filter((l) => l.area === area.key);
                if (!lanes.length) return null;
                return (
                  <React.Fragment key={area.key}>
                    <TR className="bg-zinc-50 hover:bg-zinc-50">
                      <TD colSpan={5} className="py-2">
                        <span className="text-13 font-medium text-zinc-900">{area.label}</span>
                        <span className="ml-2 text-12 text-ink-secondary">
                          {area.description} · <span className="u-nums">{lanes.length}</span>
                        </span>
                      </TD>
                    </TR>
                    {lanes.map((l) => {
                      const changed = laneChanged(l);
                      const open = !!openLanes[l.id];
                      const cont = CONTINUITY[l.continuity] || CONTINUITY.unchecked;
                      const primaryEnv = envForLeg(l.primary);
                      const primaryDraft = primaryEnv && draft[primaryEnv];
                      const extraLegs = [
                        { leg: l.fallback, which: "backup" },
                        { leg: l.retry, which: "retry" },
                        ...(l.also || []).map((a) => ({ leg: a, which: "parallel arm" })),
                      ].filter((x) => x.leg);
                      return (
                        <React.Fragment key={l.id}>
                          <TR className={cn(changed && "bg-zinc-50")}>
                            <TD>
                              <div className="flex items-start gap-1">
                                <DisclosureButton open={open} onClick={() => toggle(setOpenLanes, l.id)} label={`${open ? "Hide" : "Show"} details for ${l.name}`} />
                                <div className="flex flex-col gap-0.5 pt-1">
                                  <span className="flex flex-wrap items-center gap-1.5 text-13 text-zinc-900">
                                    {l.name}
                                    {l.lock && <Badge>{l.lock.label}</Badge>}
                                  </span>
                                  {l.describe && <span className="text-12 text-ink-secondary">{l.describe}</span>}
                                </div>
                              </div>
                            </TD>
                            <TD>
                              <Leg leg={l.primary} catalog={catalog} effective={effectiveLeg(l, l.primary)} />
                            </TD>
                            <TD>
                              <div className="flex flex-col gap-1">
                                <Leg leg={l.fallback} catalog={catalog} effective={effectiveLeg(l, l.fallback)} />
                                {l.retry && (
                                  <span className="text-11 text-ink-secondary">
                                    then <ModelChip catalog={catalog} id={effectiveLeg(l, l.retry)} />
                                  </span>
                                )}
                                {l.also?.map((a) => (
                                  <span key={a.pinEnv || a.model} className="text-11 text-ink-secondary">
                                    also runs <ModelChip catalog={catalog} id={effectiveLeg(l, a)} />
                                  </span>
                                ))}
                              </div>
                            </TD>
                            <TD>
                              <Badge tone={cont.tone} title={cont.help}>
                                {cont.label}
                              </Badge>
                            </TD>
                            <TD>
                              {l.lock ? (
                                <span className="text-12 text-ink-tertiary">{l.lock.detail || "not switchable here"}</span>
                              ) : !primaryEnv ? (
                                <span className="text-12 text-ink-tertiary">fixed in code</span>
                              ) : primaryDraft ? (
                                <span className="inline-flex items-center gap-1">
                                  <Button size="sm" variant="secondary" onClick={() => openPicker(l, l.primary, "primary")}>
                                    {primaryDraft === UNPIN ? "Unpinned" : modelLabel(catalog, primaryDraft)}
                                  </Button>
                                  <button
                                    type="button"
                                    onClick={() => setDraftValue(primaryEnv, "")}
                                    aria-label={`Discard change to ${l.name}`}
                                    className="inline-flex h-8 w-8 items-center justify-center rounded-sm text-ink-secondary hover:bg-zinc-100 hover:text-zinc-900 u-focus-ring"
                                  >
                                    <X size={14} strokeWidth={2} />
                                  </button>
                                </span>
                              ) : (
                                <Button size="sm" variant="secondary" onClick={() => openPicker(l, l.primary, "primary")} className="gap-1.5">
                                  <Search size={12} strokeWidth={2} aria-hidden />
                                  Change
                                </Button>
                              )}
                            </TD>
                          </TR>
                          {open && (
                            <TR className="bg-zinc-50 hover:bg-zinc-50">
                              <TD colSpan={5} className="py-3 pl-11">
                                <div className="flex flex-col gap-3 text-12">
                                  {extraLegs.length > 0 && (
                                    <div className="flex flex-wrap gap-2">
                                      {extraLegs.map(({ leg, which }) => {
                                        const env = envForLeg(leg);
                                        const d = env && draft[env];
                                        return (
                                          <div key={`${which}:${leg.pinEnv || leg.model}`} className="flex items-center gap-2 rounded-sm border-hairline border-zinc-200 bg-white px-3 py-2">
                                            <span className="text-11 uppercase tracking-label text-ink-tertiary">{which}</span>
                                            <ModelChip catalog={catalog} id={effectiveLeg(l, leg)} />
                                            {env && !l.lock ? (
                                              <Button size="sm" variant="secondary" onClick={() => openPicker(l, leg, which)}>
                                                {d ? (d === UNPIN ? "Unpinned" : "Changed") : "Change"}
                                              </Button>
                                            ) : (
                                              <span className="text-11 text-ink-tertiary">fixed</span>
                                            )}
                                            {d && (
                                              <button type="button" onClick={() => setDraftValue(env, "")} aria-label={`Discard change to ${l.name} ${which}`} className="inline-flex h-8 w-8 items-center justify-center rounded-sm text-ink-secondary hover:bg-zinc-100 u-focus-ring">
                                                <X size={14} strokeWidth={2} />
                                              </button>
                                            )}
                                          </div>
                                        );
                                      })}
                                    </div>
                                  )}
                                  <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
                                    <dt className="text-11 uppercase tracking-label text-ink-tertiary">Continuity</dt>
                                    <dd className="m-0 text-ink-secondary">{cont.help}</dd>
                                    <dt className="text-11 uppercase tracking-label text-ink-tertiary">Applies</dt>
                                    <dd className="m-0 text-ink-secondary">{l.applies === "live" ? "next request" : "after the Railway restart"}</dd>
                                    <dt className="text-11 uppercase tracking-label text-ink-tertiary">Where</dt>
                                    <dd className="m-0 text-zinc-900 u-nums">{l.file}</dd>
                                    <dt className="text-11 uppercase tracking-label text-ink-tertiary">Model via</dt>
                                    <dd className="m-0 text-zinc-900 u-nums">{l.primary.via}</dd>
                                    {l.fallback && (
                                      <>
                                        <dt className="text-11 uppercase tracking-label text-ink-tertiary">Backup via</dt>
                                        <dd className="m-0 text-zinc-900 u-nums">{l.fallback.via}</dd>
                                      </>
                                    )}
                                    {l.note && (
                                      <>
                                        <dt className="text-11 uppercase tracking-label text-ink-tertiary">Notes</dt>
                                        <dd className="m-0 text-ink-secondary">{l.note}</dd>
                                      </>
                                    )}
                                    {l.inbound && (
                                      <>
                                        <dt className="text-11 uppercase tracking-label text-ink-tertiary">Content</dt>
                                        <dd className="m-0 text-ink-secondary">Prompt carries customer or third-party content.</dd>
                                      </>
                                    )}
                                  </dl>
                                </div>
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

      {/* Pending changes bar — sticky inside the content column (the admin
          sidebar and mobile tab bar own the viewport edges). */}
      {changes.length > 0 && (
        <div className="sticky bottom-0 z-30 -mx-1 border-t border-hairline border-zinc-200 bg-white/95 px-4 py-3" style={{ paddingBottom: "max(12px, env(safe-area-inset-bottom, 0px))" }}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-13 text-zinc-900">
              <span className="font-medium u-nums">{affectedLanes}</span> lane{affectedLanes === 1 ? "" : "s"} move
              {restartCount > 0 ? " after restart" : ""}
              {uncheckedMoving > 0 ? ` · ${uncheckedMoving} unchecked` : ""}
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
          <DialogTitle>Apply these changes</DialogTitle>
          <p className="m-0 mt-1 text-12 text-ink-secondary">
            Paste into Railway → portal service → Variables. Railway restarts the service on save; every lane below picks up its
            new model then. Backups stay in place, so a bad model id degrades to the backup instead of failing.
          </p>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {changes.map((c) => (
              <li key={c.env} className="flex flex-col gap-0.5 text-13">
                <span className="text-zinc-900">
                  <span className="font-medium">{c.label}</span>: {c.hold ? `stays ${modelLabel(catalog, c.from)}` : `${modelLabel(catalog, c.from)} → ${destLabel(c)}`}
                  {c.unpin ? " · delete the variable" : ""}
                  {c.destinations?.length > 1 ? " · differs by lane" : ""}
                  {c.lanes > 1 ? ` · ${c.lanes} lanes` : ""}
                  {c.restart ? "" : " · next request"}
                </span>
                {c.laneNames?.length > 1 && <span className="text-11 text-ink-secondary">{c.laneNames.join(" · ")}</span>}
                {c.uncheckedLanes > 0 && (
                  <span className="text-11 text-alert-fg">
                    {c.uncheckedLanes} of these lanes {c.uncheckedLanes === 1 ? "is" : "are"} unchecked: nothing will catch a regression except you.
                  </span>
                )}
                {c.lockedLanes?.length > 0 && (
                  <span className="text-11 text-alert-fg">Also moves locked lanes that follow this selector by design: {c.lockedLanes.join(", ")}.</span>
                )}
              </li>
            ))}
          </ul>
          {geminiInboundLanes.length > 0 && (
            <div className="text-12 text-alert-fg" role="alert">
              Moves inbound customer content onto Gemini: {geminiInboundLanes.join(", ")}. The Gemini adapter has no system-instruction
              boundary yet, so this widens the prompt-injection surface until that is fixed.
            </div>
          )}
          <pre className="m-0 overflow-x-auto rounded-sm border-hairline border-zinc-200 bg-zinc-50 p-3 text-12 text-zinc-900 u-nums">{envBlock}</pre>
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

      {find && <PickModelDialog target={find} catalog={catalog} onClose={() => setFind(null)} onPick={(model) => onFound(find.envs, model)} />}
    </div>
  );
}

// Search-first picker. Empty box: the models this lane can run today, then
// the newest ids per provider (live). Typing searches the providers. Every
// pick is probed with the provider's retrieve endpoint first (no tokens): a
// definite "unknown" / "not enabled" refuses it; a check that cannot run
// (no key, key rejected — local dev) drafts it flagged unverified.
function PickModelDialog({ target, catalog, onClose, onPick }) {
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

  useEffect(() => {
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
  // Live results already in the suggestions list are not repeated.
  const known = new Set(suggestions.map((s) => s.id));

  return (
    <Dialog open onClose={onClose} size="md">
      <DialogHeader>
        <DialogTitle>{target.title}</DialogTitle>
        {target.subtitle && <p className="m-0 mt-1 text-12 text-ink-secondary">{target.subtitle}</p>}
        <p className="m-0 mt-1 text-12 text-ink-tertiary">Now: {modelLabel(catalog, target.current)}</p>
      </DialogHeader>
      <DialogBody className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-11 u-label text-ink-secondary">
          Search {target.accepts.providers.map((p) => PROVIDER_LABEL[p] || p).join(" and ")}
          <span className="relative block">
            <Search size={14} strokeWidth={2} aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-tertiary" />
            <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="fable 5.1, opus 5, gemini 3.8…" className="pl-8" />
          </span>
        </label>
        {problem && (
          <div className="text-12 text-alert-fg" role="alert">
            {problem}
          </div>
        )}
        {unavailable.length > 0 && (
          <div className="text-12 text-ink-secondary">
            Not searched live: {unavailable.map((u) => `${PROVIDER_LABEL[u.provider] || u.provider} (${UNAVAILABLE_REASON[u.reason] || u.reason})`).join(", ")}.
          </div>
        )}
        {capUnverified && (results?.length > 0 || newest?.some((g) => g.items.length > 0)) && (
          <div className="text-12 text-alert-fg" role="alert">
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
              <div className="text-12 text-ink-tertiary" role="status">
                Loading the newest models…
              </div>
            )}
          </div>
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
