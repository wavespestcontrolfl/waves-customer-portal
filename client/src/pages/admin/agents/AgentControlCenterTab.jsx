import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { adminFetch } from "../../../utils/admin-fetch";
import { useHubParams } from "./hubParams";
import WindowPresets, { windowLabel } from "./WindowPresets";
import StatusStrip from "./StatusStrip";
import LaneCard from "./LaneCard";

// Agents → Overview → Control center (agent-control PR B). One read —
// GET /admin/agents/control/lanes?area&window&status — gives the status
// counts for the scope, the lane rows, and the basis the numbers rest on
// (which recorders are on, whether a prior window exists). The window and
// status filters live in the URL (hubParams) beside the hub's ?area=, so a
// deep link reproduces the view. Rendered only when the hub probe reports
// the ledger phase (GATE_AGENT_CONTROL_READ); otherwise the hub keeps the
// old Overview. Read-only: nothing here acts on a lane.

export default function AgentControlCenterTab({ areas = [], setRefreshHandler }) {
  const { area, window: windowKey, status, set: setHubParams } = useHubParams();
  const areaKnown = areas.some((a) => a.key === area);
  // The scope is the query the read is made with. A payload only renders
  // under the controls that asked for it: after a filter change the previous
  // scope's lanes and counts must not sit, mislabelled, beneath the new
  // controls while the read is in flight — or for good, if it fails.
  const scopeKey = useMemo(() => {
    const qs = new URLSearchParams({ window: windowKey, status });
    if (areaKnown) qs.set("area", area);
    return qs.toString();
  }, [area, areaKnown, windowKey, status]);
  const [resolved, setResolved] = useState(null); // { scope, payload }
  const data = resolved?.scope === scopeKey ? resolved.payload : null;
  // A quick run of filter clicks starts several reads; only the newest may
  // land (an older, slower response would paint the wrong scope).
  const requestSeq = useRef(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    const seq = (requestSeq.current += 1);
    setLoading(true);
    setError(null);
    try {
      const next = await adminFetch(`/admin/agents/control/lanes?${scopeKey}`);
      if (seq !== requestSeq.current) return;
      setResolved({ scope: scopeKey, payload: next });
    } catch (e) {
      if (seq !== requestSeq.current) return;
      setError(e?.message || "Failed to load the control center");
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [scopeKey]);

  useEffect(() => {
    load();
  }, [load]);

  // The hub header's Refresh pill drives this tab (the same handle the old
  // Overview and the Models tab expose).
  useEffect(() => {
    setRefreshHandler?.(load, loading);
    return () => setRefreshHandler?.(null);
  }, [setRefreshHandler, load, loading]);

  // "Runs →" on a card: the Runs tab. It carries no lane / window params
  // yet — the Runs tab does not read them until C1 wires the run index, and
  // a link must not promise a filter the destination ignores.
  const runsHref = "/admin/agents?tab=activity";

  const grouped = useMemo(() => {
    const lanes = data?.lanes || [];
    const scope = areaKnown ? areas.filter((a) => a.key === area) : areas;
    return scope.map((a) => ({ area: a, lanes: lanes.filter((l) => l.area === a.key) })).filter((g) => g.lanes.length > 0);
  }, [data, areas, area, areaKnown]);

  const attentionLanes = useMemo(() => (data?.lanes || []).filter((l) => l.status === "attention"), [data]);

  const errorNotice = error && (
    <div className="text-14 text-alert-fg" role="alert">
      {error}
    </div>
  );
  // The controls stay up while a scope loads (a second click must not wait
  // for the first read); the counts and lanes below them come only from the
  // payload read for this scope — the chips carry no number until then.
  const controls = (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <StatusStrip value={status} counts={data?.counts} onChange={(next) => setHubParams({ status: next })} />
      <WindowPresets value={windowKey} onChange={(next) => setHubParams({ window: next })} />
    </div>
  );
  if (!data) {
    return (
      <div className="flex flex-col gap-4 px-3 md:px-0 pb-6">
        {controls}
        {loading ? (
          <div className="py-6 text-14 text-ink-secondary" role="status">
            Loading…
          </div>
        ) : (
          errorNotice
        )}
      </div>
    );
  }

  const basis = data.basis || {};
  const notes = [];
  if (basis.ledgerRecording === false) notes.push("The call ledger is not recording (GATE_LLM_CALL_LEDGER is off) — these are rows already written.");
  if (basis.chainRecording === false) notes.push("The chain recorder is off (GATE_LLM_DISPATCH_METRICS) — fallback rates are not available.");
  if (basis.priorAvailable === false) notes.push("No prior window to compare with: the ledger keeps 30 days.");

  return (
    <div className="flex flex-col gap-4 px-3 md:px-0 pb-6">
      {errorNotice}
      {controls}
      <p className="m-0 text-13 text-ink-secondary">
        <span className="font-medium text-zinc-900 u-nums">{data.counts?.all ?? 0}</span> lanes{areaKnown ? ` in ${areas.find((a) => a.key === area)?.label}` : ""} · {windowLabel(windowKey)}.
        {notes.length > 0 ? ` ${notes.join(" ")}` : ""}
      </p>

      {status === "attention" && attentionLanes.length > 0 ? (
        <section aria-labelledby="control-attention-heading" className="flex flex-col gap-2">
          <h3 id="control-attention-heading" className="m-0 text-14 font-medium text-zinc-900">
            Needs attention
          </h3>
          <ul className="m-0 list-none p-0 flex flex-col divide-y divide-zinc-200 border-hairline border-zinc-200 rounded-md bg-surface-card">
            {attentionLanes.map((l) => (
              <li key={l.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2 text-13">
                <span className="font-medium text-zinc-900">{l.name}</span>
                <span className="text-ink-secondary">{(l.attentionReasons || []).map((r) => r.detail).join(" · ")}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {grouped.length === 0 ? (
        <p className="m-0 text-14 text-ink-secondary">No lanes match this filter.</p>
      ) : (
        grouped.map(({ area: a, lanes }) => (
          <section key={a.key} aria-labelledby={`control-area-${a.key}`} className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between gap-2">
              <h3 id={`control-area-${a.key}`} className="m-0 text-14 font-medium text-zinc-900">
                {a.label}
              </h3>
              <span className="text-12 text-ink-tertiary u-nums">{lanes.length}</span>
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              {lanes.map((l) => (
                <LaneCard key={l.id} lane={l} basis={basis} runsHref={runsHref} />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
