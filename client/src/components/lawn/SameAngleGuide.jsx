// The technician's "same angle" guide in the lawn photo step (GATE_REPORT_WEB_SLIDER, owner 2026-10-20):
// last visit's photo for a shot sits beside the shot row, so today's photo can be lined up with it. The
// customer's report pairs the two in a drag slider. A guide only: nothing blocks the technician, and the
// server sends a shot only when the previous visit at this property has a photo for it.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function guideDayLabel(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ""));
  return m && Number(m[2]) >= 1 && Number(m[2]) <= 12 ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}` : "";
}

export default function SameAngleGuide({ shot, label, canOverlay, overlayOn, onToggleOverlay }) {
  if (!shot?.url) return null;
  const day = guideDayLabel(shot.date);
  return (
    <div data-testid="same-angle-guide" className="flex w-full items-center gap-2 pt-1">
      <img
        src={shot.url}
        alt={`${label} at the last visit${day ? `, ${day}` : ""}`}
        className="block h-[42px] w-14 flex-none rounded-[8px] border border-[#E5E5E5] object-cover"
      />
      <div className="min-w-0 flex-1 text-14 leading-snug text-zinc-500">
        Last visit{day ? `, ${day}` : ""}. Line up with this.
      </div>
      {canOverlay && (
        <button
          type="button"
          aria-pressed={overlayOn}
          onClick={onToggleOverlay}
          className="min-h-[44px] flex-none rounded-full border border-[#E5E5E5] bg-white px-3 text-14 text-zinc-900"
        >
          {overlayOn ? "Hide on photo" : "Show on photo"}
        </button>
      )}
    </div>
  );
}
