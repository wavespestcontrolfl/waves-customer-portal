import React from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { Badge, Button, Card, cn } from "../../../components/ui";
import { UNPIN, modelLabel } from "./modelDraft";

// One AI lane on the Models tab: what it does, the model it runs on now and
// its backup, what would catch a regression after a switch, and the Change
// button. Nothing about env variables or file paths lives on the card — the
// owner thinks in lanes and models; the env lines appear only in the review
// dialog's copy block.

export const CONTINUITY = {
  judged: { label: "Judged", tone: "strong", help: "A judge or replay eval scores this lane against human truth, so a switch is checked." },
  verified: { label: "Verified", tone: "neutral", help: "A deterministic checker gates the output; bad output is rejected, not sent." },
  unchecked: { label: "Unchecked", tone: "neutral", help: "Nothing catches a regression after a switch except you." },
};

// The model's name only (owner: no provider / id text under the name).
export function ModelChip({ catalog, id }) {
  if (!id) return <span className="text-ink-tertiary">—</span>;
  const m = catalog[id];
  return (
    <span className="inline-flex flex-wrap items-baseline gap-1.5">
      <span className="text-zinc-900">{m?.label || id}</span>
      {m?.discovered && <Badge className="whitespace-nowrap">new</Badge>}
    </span>
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

function DiscardButton({ onClick, label }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} className="inline-flex h-8 w-8 items-center justify-center rounded-sm text-ink-secondary hover:bg-zinc-100 hover:text-zinc-900 u-focus-ring">
      <X size={14} strokeWidth={2} />
    </button>
  );
}

export default function LaneModelCard({ lane, catalog, draft, effectiveLeg, envForLeg, open, onToggle, onPick, onDiscard }) {
  const l = lane;
  const cont = CONTINUITY[l.continuity] || CONTINUITY.unchecked;
  const primaryEnv = envForLeg(l.primary);
  const primaryDraft = primaryEnv && draft[primaryEnv];
  const primaryNow = effectiveLeg(l.primary);
  const changed = [l.primary, l.fallback, l.retry, ...(l.also || [])].filter(Boolean).some((leg) => effectiveLeg(leg) !== leg.model);
  const extraLegs = [
    { leg: l.fallback, which: "backup" },
    { leg: l.retry, which: "retry" },
    ...(l.also || []).map((a) => ({ leg: a, which: "parallel arm" })),
  ].filter((x) => x.leg);

  return (
    <Card className={cn("flex flex-col gap-2 p-4", changed && "bg-zinc-50")}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-1.5 text-14 font-medium text-zinc-900">
            {l.name}
            {l.lock && <Badge>{l.lock.label}</Badge>}
          </span>
          {l.describe && <span className="text-14 text-ink-secondary">{l.describe}</span>}
        </div>
        <Badge tone={cont.tone} title={cont.help} className="whitespace-nowrap">
          {cont.label}
        </Badge>
      </div>

      <div className="flex flex-col gap-0.5 text-14">
        <span className="text-ink-secondary">
          Runs on <ModelChip catalog={catalog} id={primaryNow} />
          {primaryNow !== l.primary.model && <span className="text-13 text-ink-tertiary"> · was {modelLabel(catalog, l.primary.model)}</span>}
        </span>
        <span className="text-ink-secondary">
          {l.fallback ? (
            <>
              Backup <ModelChip catalog={catalog} id={effectiveLeg(l.fallback)} />
              {l.retry && (
                <>
                  {" "}then <ModelChip catalog={catalog} id={effectiveLeg(l.retry)} />
                </>
              )}
            </>
          ) : (
            <span className="text-ink-tertiary">No backup</span>
          )}
          {l.also?.map((a) => (
            <span key={a.pinEnv || a.model}>
              {" "}· also runs <ModelChip catalog={catalog} id={effectiveLeg(a)} />
            </span>
          ))}
        </span>
      </div>

      <div className="mt-auto flex items-center justify-between gap-2 pt-1">
        <span className="inline-flex items-center gap-1">
          {l.lock ? (
            <span className="text-13 text-ink-tertiary">{l.lock.detail || "not switchable here"}</span>
          ) : !primaryEnv ? (
            <span className="text-13 text-ink-tertiary">fixed in code</span>
          ) : primaryDraft ? (
            <>
              <Button size="sm" variant="secondary" onClick={() => onPick(l, l.primary, "primary")}>
                {primaryDraft === UNPIN ? "Unpinned" : modelLabel(catalog, primaryDraft)}
              </Button>
              <DiscardButton onClick={() => onDiscard(primaryEnv)} label={`Discard change to ${l.name}`} />
            </>
          ) : (
            <Button size="sm" variant="secondary" onClick={() => onPick(l, l.primary, "primary")} className="gap-1.5">
              <Search size={12} strokeWidth={2} aria-hidden />
              Change
            </Button>
          )}
        </span>
        <DisclosureButton open={open} onClick={onToggle} label={`${open ? "Hide" : "Show"} details for ${l.name}`} />
      </div>

      {open && (
        <div className="flex flex-col gap-3 border-t border-hairline border-zinc-200 pt-3 text-13">
          {extraLegs.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {extraLegs.map(({ leg, which }) => {
                const env = envForLeg(leg);
                const d = env && draft[env];
                return (
                  <div key={`${which}:${leg.pinEnv || leg.model}`} className="flex items-center gap-2 rounded-sm border-hairline border-zinc-200 bg-white px-3 py-2">
                    <span className="text-11 uppercase tracking-label text-ink-tertiary">{which}</span>
                    <ModelChip catalog={catalog} id={effectiveLeg(leg)} />
                    {env && !l.lock ? (
                      <Button size="sm" variant="secondary" onClick={() => onPick(l, leg, which)}>
                        {d ? (d === UNPIN ? "Unpinned" : "Changed") : "Change"}
                      </Button>
                    ) : (
                      <span className="text-11 text-ink-tertiary">fixed</span>
                    )}
                    {d && <DiscardButton onClick={() => onDiscard(env)} label={`Discard change to ${l.name} ${which}`} />}
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
      )}
    </Card>
  );
}
