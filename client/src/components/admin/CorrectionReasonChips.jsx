import { Button } from "../ui";
import { CORRECTION_REASONS } from "../../constants/correctionReasons";

// One-tap reason for a correction (AI acceleration scope idea D): five chips,
// at most one selected, tap again to clear. Shared by the Agent Review cards
// and the Typed review tab so both write the same closed set.
export default function CorrectionReasonChips({ value = null, onChange, disabled = false, label = "Why?" }) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-2">
      <span className="text-14 text-ink-secondary">{label}</span>
      {CORRECTION_REASONS.map((reason) => {
        const selected = value === reason.value;
        return (
          <Button
            key={reason.value}
            type="button"
            size="sm"
            variant={selected ? "primary" : "secondary"}
            aria-pressed={selected}
            disabled={disabled}
            onClick={() => onChange(selected ? null : reason.value)}
          >
            {reason.label}
          </Button>
        );
      })}
    </div>
  );
}
