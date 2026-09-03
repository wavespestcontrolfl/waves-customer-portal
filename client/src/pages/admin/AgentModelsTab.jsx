import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRightLeft, Copy } from "lucide-react";
import { Button, Card, Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui";
import { adminFetch } from "../../utils/admin-fetch";
import { useHubParams } from "./agents/hubParams";
import LaneModelCard from "./agents/LaneModelCard";
import MigrationSetDialog from "./agents/MigrationSetDialog";
import PickModelDialog from "./agents/PickModelDialog";
import { UNPIN, computeChanges, destinationLabel, discoveredEntry, effectiveLegFor, envBlockOf, envForLeg as envForLegIn, legsOf, modelLabel, movesOnEnv, selectorDraftFor, selectorUnpinnedModel } from "./agents/modelDraft";

// Agents → Models: one card per AI lane, grouped by product area (the area
// strip in the hub header filters them), each with a plain-English line, the
// model it runs on now, its backup, and what would catch a regression after
// a switch (continuity). Data comes resolved from the server
// (GET /admin/agents/models → server/services/model-switchboard.js).
//
// Honest about today's mechanism: every registry selector is a module-load
// const, so a switch IS a Railway env change followed by the restart Railway
// does on save. The tab never writes; it composes the exact env lines and
// shows the blast radius before the owner pastes them. Env vocabulary appears
// only inside the review dialog's copy block — never on a card.
//
// Picking is search-first (agents/PickModelDialog.jsx); every pick is probed
// against the provider before it is drafted. A whole-model move goes through
// the migration set (agents/MigrationSetDialog.jsx), never a bulk mutation.

const FILTERS = [
  { key: "all", label: "All" },
  { key: "changed", label: "Changing" },
  { key: "nobackup", label: "No backup" },
  { key: "unchecked", label: "Unchecked" },
  { key: "locked", label: "Locked" },
];

export default function AgentModelsTab({ setRefreshHandler }) {
  const { area } = useHubParams();
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
  const [migrating, setMigrating] = useState(false);
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

  // The hub header's Refresh pill drives this tab (same handle AgentOpsPage
  // exposes); re-register on each loading transition so it can show busy.
  useEffect(() => {
    setRefreshHandler?.(load, loading);
    return () => setRefreshHandler?.(null);
  }, [setRefreshHandler, load, loading]);

  const catalog = useMemo(() => ({ ...(data?.models || {}), ...discovered }), [data, discovered]);
  const selectorByKey = useMemo(() => Object.fromEntries((data?.selectors || []).map((s) => [s.key, s])), [data]);
  const selectorDraft = useMemo(() => selectorDraftFor(selectorByKey, draft), [selectorByKey, draft]);
  const effectiveLeg = useMemo(() => effectiveLegFor(draft, selectorDraft), [draft, selectorDraft]);
  const envForLeg = useCallback((leg) => envForLegIn(leg, selectorByKey), [selectorByKey]);
  const laneChanged = useCallback((lane) => legsOf(lane).some((leg) => effectiveLeg(leg) !== leg.model), [effectiveLeg]);
  const siblingsOf = (lane, leg) => {
    if (leg.pinEnv || !leg.selector) return [];
    return data.lanes.filter((l) => l.id !== lane.id && movesOnEnv(l) && legsOf(l).some((g) => g.selector === leg.selector && !g.pinned)).map((l) => l.name);
  };

  const changes = useMemo(() => computeChanges({ data, draft, selectorDraft }), [data, draft, selectorDraft]);
  const envBlock = envBlockOf(changes, catalog);
  const restartCount = changes.filter((c) => c.restart && !c.hold).length;
  const affectedLanes = data ? data.lanes.filter(laneChanged).length : 0;
  const uncheckedMoving = data ? data.lanes.filter((l) => laneChanged(l) && l.continuity === "unchecked").length : 0;
  // Moving lanes with nothing to degrade to: a model that passes the probe can
  // still reject the lane's request shape, and these fail rather than fall back.
  const noBackupMoving = data ? data.lanes.filter((l) => laneChanged(l) && !l.fallback).map((l) => l.name) : [];

  // Inbound-content lanes that a change lands on Gemini (the adapter folds the
  // system prompt into the user turn — no instruction boundary yet).
  const geminiInboundLanes = useMemo(() => {
    if (!data) return [];
    return data.lanes
      .filter((l) => l.inbound && laneChanged(l))
      .filter((l) => legsOf(l).some((leg) => { const id = effectiveLeg(leg); return id && id !== leg.model && catalog[id]?.provider === "gemini"; }))
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
    // Unpin = delete the env var. For a lane pin that returns the leg to its
    // selector / code default; for a leg on an OVERRIDDEN selector it returns
    // the whole selector to the registry default (every follower moves).
    const selector = !leg.pinEnv && leg.selector ? selectorByKey[leg.selector] : null;
    const selectorUnpin = selector?.overridden ? selectorUnpinnedModel(selector, selectorByKey) : null;
    setFind({
      envs: [env],
      accepts: leg.accepts,
      current: leg.model,
      title: which === "primary" ? lane.name : `${lane.name} · ${which}`,
      subtitle: siblings.length
        ? `This lane shares its model with ${siblings.length} other${siblings.length === 1 ? "" : "s"}. A change moves all of them.`
        : lane.describe,
      canUnpin: !!leg.pinned || !!selectorUnpin,
      unpinLabel: leg.pinned
        ? `Unpin · follow ${leg.selector || "code default"} (${modelLabel(catalog, leg.unpinnedModel)})`
        : selectorUnpin
          ? `Remove the ${leg.selector} override · back to ${selector.derivesFrom ? `following ${selector.derivesFrom}` : "the registry default"} (${modelLabel(catalog, selectorUnpin)})`
          : null,
    });
  };

  const onFound = (envs, model) => {
    setPickProblem(null);
    if (model.id !== UNPIN) {
      setDiscovered((prev) => ({ ...prev, [model.id]: discoveredEntry(model, prev[model.id] || catalog[model.id], model.cap || find?.accepts?.cap) }));
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

  const areaKnown = !!data?.areas?.some((a) => a.key === area);
  const visibleLanes = useMemo(() => {
    if (!data) return [];
    return data.lanes.filter((l) => {
      if (areaKnown && l.area !== area) return false;
      if (filter === "changed") return laneChanged(l);
      if (filter === "nobackup") return !l.fallback;
      if (filter === "unchecked") return l.continuity === "unchecked";
      if (filter === "locked") return !!l.lock;
      return true;
    });
  }, [data, area, areaKnown, filter, laneChanged]);

  if (loading && !data) {
    return (
      <Card className="p-5 text-14 text-ink-secondary" role="status">
        Loading…
      </Card>
    );
  }
  // A failed load must leave a way back: Retry here, and when a refresh fails
  // the data already on screen stays usable under the notice.
  const errorNotice = error && (
    <Card className="flex flex-wrap items-center justify-between gap-3 p-4 text-14 text-alert-fg" role="alert">
      <span>{error}</span>
      <Button size="sm" variant="secondary" onClick={load} disabled={loading}>
        {loading ? "Retrying…" : "Retry"}
      </Button>
    </Card>
  );
  if (!data) return errorNotice || null;

  const noBackup = data.lanes.filter((l) => !l.fallback).length;
  const unchecked = data.lanes.filter((l) => l.continuity === "unchecked").length;
  const toggle = (setter, key) => setter((prev) => ({ ...prev, [key]: !prev[key] }));
  const areas = areaKnown ? data.areas.filter((a) => a.key === area) : data.areas;

  return (
    <div className="flex flex-col gap-4 pb-6">
      {errorNotice}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="m-0 text-14 text-ink-secondary">
          <span className="font-medium text-zinc-900 u-nums">{data.lanes.length}</span> AI lanes ·{" "}
          <span className="u-nums">{noBackup}</span> with no backup ·{" "}
          <span className="u-nums">{unchecked}</span> unchecked after a switch. Changes apply after Railway restarts; nothing here
          sends anything to a customer.
        </p>
        <Button size="sm" variant="secondary" onClick={() => setMigrating(true)} className="gap-2">
          <ArrowRightLeft size={13} strokeWidth={2} aria-hidden />
          Move a model…
        </Button>
      </div>
      {pickProblem && (
        <div className="text-14 text-alert-fg" role="alert">
          {pickProblem}
        </div>
      )}

      <section aria-labelledby="models-lanes-heading" className="flex flex-col gap-3">
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
        {areas.map((a) => {
          const lanes = visibleLanes.filter((l) => l.area === a.key);
          if (!lanes.length) return null;
          return (
            <section key={a.key} aria-labelledby={`models-area-${a.key}`} className="flex flex-col gap-2">
              <div className="flex flex-wrap items-baseline gap-2">
                <h3 id={`models-area-${a.key}`} className="m-0 text-14 font-medium text-zinc-900">
                  {a.label}
                </h3>
                <span className="text-13 text-ink-secondary">
                  {a.description} · <span className="u-nums">{lanes.length}</span>
                </span>
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                {lanes.map((l) => (
                  <LaneModelCard
                    key={l.id}
                    lane={l}
                    catalog={catalog}
                    draft={draft}
                    effectiveLeg={effectiveLeg}
                    envForLeg={envForLeg}
                    open={!!openLanes[l.id]}
                    onToggle={() => toggle(setOpenLanes, l.id)}
                    onPick={openPicker}
                    onDiscard={(env) => setDraftValue(env, "")}
                  />
                ))}
              </div>
            </section>
          );
        })}
        {visibleLanes.length === 0 && (
          <Card className="p-5 text-14 text-ink-secondary">No lanes match this filter.</Card>
        )}
      </section>

      {/* Pending changes bar — sticky inside the content column (the admin
          sidebar and mobile tab bar own the viewport edges). */}
      {changes.length > 0 && (
        <div className="sticky bottom-0 z-30 -mx-1 border-t border-hairline border-zinc-200 bg-white/95 px-4 py-3" style={{ paddingBottom: "max(12px, env(safe-area-inset-bottom, 0px))" }}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-14 text-zinc-900">
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
          <p className="m-0 mt-1 text-13 text-ink-secondary">
            Paste into Railway → portal service → Variables. Railway restarts the service on save; every lane below picks up its
            new model then.
            {noBackupMoving.length === 0
              ? " Every moving lane keeps its backup, so a bad model id degrades to the backup instead of failing."
              : ""}
          </p>
          {noBackupMoving.length > 0 && (
            <div className="mt-2 text-13 text-alert-fg" role="alert">
              No backup for {noBackupMoving.join(", ")}: if the new model rejects this lane's requests, the lane fails instead of degrading.
            </div>
          )}
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {changes.map((c) => (
              <li key={c.env} className="flex flex-col gap-0.5 text-13">
                <span className="text-zinc-900">
                  <span className="font-medium">{c.label}</span>: {c.hold ? `stays ${modelLabel(catalog, c.from)}` : `${modelLabel(catalog, c.from)} → ${destinationLabel(c, catalog)}`}
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
            <div className="text-13 text-alert-fg" role="alert">
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
      {migrating && <MigrationSetDialog data={data} catalog={catalog} onClose={() => setMigrating(false)} onDraft={(envs, model) => onFound(envs, model)} />}
    </div>
  );
}
