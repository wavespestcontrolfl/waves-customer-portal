import { Badge, Checkbox } from "../../../../components/ui";
import { WARNING_REASONS, blockReason } from "./factCopy";

// The recorded check of one fact: hard blocks (cannot be approved) and warnings (the owner must tick "I checked this").
// `warnings` may come from the saved check or from a refused approve (the server's fresh read).
export default function FactChecks({ check, warnings, canTick, ticked, onTick }) {
  const blocks = check?.blocks || [];
  const found = warnings || check?.warnings || [];
  if (!check && !found.length) return <p className="text-ui-caption text-ink-secondary">Not checked yet.</p>;
  return (
    <div className="space-y-2" data-testid="fact-checks">
      {blocks.length > 0 && (
        <div>
          <Badge tone="alert">Can't be approved yet</Badge>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-ui-body text-alert-fg">
            {blocks.map((code) => <li key={code}>{blockReason(code)}</li>)}
          </ul>
        </div>
      )}
      {found.length > 0 && (
        <div>
          <Badge tone="warn">Check before approving</Badge>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-ui-body text-ink-primary">
            {found.map((w) => (
              <li key={w.code}>
                {WARNING_REASONS[w.code] || "Needs a second look"}
                {w.words?.length ? `: ${w.words.join(", ")}` : ""}
              </li>
            ))}
          </ul>
          {canTick
            ? <Checkbox id={`ack-${found.map((w) => w.code).join("-")}`} className="mt-2" label="I checked this" checked={ticked} onChange={(event) => onTick(event.target.checked)} />
            : <p className="mt-1 text-ui-caption text-ink-secondary">The owner ticks "I checked this" before approving.</p>}
        </div>
      )}
      {!blocks.length && !found.length && <p className="text-ui-caption text-ink-secondary">Passed the checks.</p>}
    </div>
  );
}
