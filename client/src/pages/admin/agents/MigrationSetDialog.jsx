import React, { useMemo, useState } from "react";
import { Button, Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui";
import PickModelDialog from "./PickModelDialog";
import { buildMigrationSet, discoveredEntry, modelLabel, modelsInUse } from "./modelDraft";

// Whole-model move, as a migration set rather than a mutation: pick the model
// to move off, pick the target (probed, like every pick), then see every env
// that resolves to the source grouped by what has to happen first —
// eligible / shadow / approval / blocked. Only eligible (and, on request,
// shadow) envs are drafted from here; approval and blocked lanes are changed
// one at a time on their own cards, so a bulk move never slips past a lane
// that needed a closer look.

const GROUPS = [
  { key: "eligible", label: "Eligible", help: "Verified by a deterministic check, unlocked, no customer content." },
  { key: "shadow", label: "Run shadow first", help: "A judge can score the new model before it takes over." },
  { key: "approval", label: "Change per lane", help: "Carries customer content or is unchecked after a switch — change these from their cards." },
  { key: "blocked", label: "Cannot move", help: "Locked, fixed in code, or the target cannot serve the lane." },
];

export default function MigrationSetDialog({ data, catalog, onClose, onDraft }) {
  const [fromId, setFromId] = useState(null);
  const [target, setTarget] = useState(null); // { id, label, provider, unverified }
  const [picking, setPicking] = useState(false);

  const inUse = useMemo(() => modelsInUse(data), [data]);
  // A target found through live search is not in the catalog yet — or is
  // there only as an id the server knows from an env override, with unknown
  // caps. Either way, without a real entry every env would be blocked
  // ("unknown model" / "no text support").
  const withTarget = useMemo(() => {
    const prior = target && catalog[target.id];
    if (!target || (prior && prior.caps?.length)) return catalog;
    return { ...catalog, [target.id]: discoveredEntry(target, prior || null, target.caps) };
  }, [catalog, target]);
  const set = useMemo(() => buildMigrationSet({ data, catalog: withTarget, fromId, toId: target?.id || null }), [data, withTarget, fromId, target]);

  // The target search spans every provider / modality the source's envs can
  // take, and the picker offers a model that fits ANY of the envs' distinct
  // requirements (`any`); per-env compatibility then sorts the rest into the
  // "Cannot move" group. `deep` is true when any env may take a deep-only
  // model (its ordinary siblings stay blocked); `cap` drives the live search
  // (vision when any env needs images) and `caps` is what a fresh find is
  // recorded as able to do — every vision model in the catalog also reads text.
  const accepts = useMemo(() => {
    if (!fromId) return null;
    const all = [...set.eligible, ...set.shadow, ...set.approval, ...set.blocked].map((e) => e.accepts).filter(Boolean);
    const providers = [...new Set(all.flatMap((a) => a.providers))];
    const caps = [...new Set(all.map((a) => a.cap))];
    const any = [...new Map(all.map((a) => [JSON.stringify([a.providers, a.cap, !!a.deep]), a])).values()];
    return {
      providers: providers.length ? providers : [catalog[fromId]?.provider].filter(Boolean),
      cap: caps.includes("vision") ? "vision" : caps[0] || "text",
      caps: caps.length ? caps : ["text"],
      deep: all.some((a) => a.deep),
      ...(any.length > 1 ? { any } : {}),
    };
  }, [fromId, set, catalog]);

  if (picking && accepts) {
    return (
      <PickModelDialog
        target={{ accepts, current: fromId, title: `Move everything on ${modelLabel(catalog, fromId)}`, subtitle: "Pick the model to move to. Every pick is checked with the provider first." }}
        catalog={catalog}
        onClose={() => setPicking(false)}
        onPick={(model) => {
          setTarget({ ...model, caps: accepts.caps });
          setPicking(false);
        }}
      />
    );
  }

  const envCount = (g) => set[g].length;
  const laneCount = (g) => new Set(set[g].flatMap((e) => e.lanes.map((l) => l.id))).size;
  const draft = (groups) => {
    const envs = groups.flatMap((g) => set[g].map((e) => e.env));
    if (envs.length) onDraft(envs, target);
    onClose();
  };

  return (
    <Dialog open onClose={onClose} size="md">
      <DialogHeader>
        <DialogTitle>Move a model</DialogTitle>
        <p className="m-0 mt-1 text-13 text-ink-secondary">
          {!fromId ? "Which model is moving?" : !target ? `Everything on ${modelLabel(catalog, fromId)} — now pick where it moves to.` : `${modelLabel(catalog, fromId)} → ${target.label || target.id}`}
        </p>
      </DialogHeader>
      <DialogBody className="flex flex-col gap-3">
        {!fromId ? (
          <ul className="m-0 flex list-none flex-col divide-y divide-zinc-200 border-hairline border-zinc-200 p-0">
            {inUse.map(([id, n]) => (
              <li key={id} className="flex items-center justify-between gap-2 px-3 py-2">
                <span className="text-14 text-zinc-900">
                  {modelLabel(catalog, id)} <span className="text-13 text-ink-tertiary u-nums">{n} lane{n === 1 ? "" : "s"}</span>
                </span>
                <Button size="sm" variant="secondary" onClick={() => setFromId(id)}>
                  Move
                </Button>
              </li>
            ))}
          </ul>
        ) : !target ? (
          <div className="flex flex-col gap-2">
            <Button size="sm" onClick={() => setPicking(true)} className="self-start">
              Pick the target model
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setFromId(null)} className="self-start">
              Back
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {target.unverified && (
              <div className="text-13 text-alert-fg" role="alert">
                {target.label || target.id} could not be checked with the provider on this server. Confirm the id is enabled for the prod account before applying.
              </div>
            )}
            {GROUPS.map((g) => (
              <section key={g.key} aria-labelledby={`migration-${g.key}`} className="flex flex-col gap-1">
                <h3 id={`migration-${g.key}`} className="m-0 text-14 font-medium text-zinc-900">
                  {g.label} <span className="text-13 font-normal text-ink-tertiary u-nums">{laneCount(g.key)} lane{laneCount(g.key) === 1 ? "" : "s"}</span>
                </h3>
                <p className="m-0 text-13 text-ink-secondary">{g.help}</p>
                {envCount(g.key) > 0 && (
                  <ul className="m-0 flex list-none flex-col divide-y divide-zinc-200 border-hairline border-zinc-200 p-0">
                    {set[g.key].map((e) => (
                      <li key={e.env} className="flex flex-col gap-0.5 px-3 py-2 text-13">
                        <span className="text-zinc-900">
                          {e.lanes.length === 1 ? e.lanes[0].name : `${e.lanes.length} lanes`}
                          {e.kind === "selector" && e.lanes.length > 1 ? " sharing one setting" : ""}
                        </span>
                        {e.lanes.length > 1 && <span className="text-ink-secondary">{e.lanes.slice(0, 4).map((l) => l.name).join(" · ")}{e.lanes.length > 4 ? ` · +${e.lanes.length - 4} more` : ""}</span>}
                        {e.reasons.length > 0 && <span className="text-ink-tertiary">{e.reasons.join(" · ")}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ))}
          </div>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
        {target && (
          <>
            <Button variant="secondary" onClick={() => draft(["eligible", "shadow"])} disabled={envCount("eligible") + envCount("shadow") === 0}>
              Draft eligible + shadow
            </Button>
            <Button onClick={() => draft(["eligible"])} disabled={envCount("eligible") === 0}>
              Draft eligible
            </Button>
          </>
        )}
      </DialogFooter>
    </Dialog>
  );
}
