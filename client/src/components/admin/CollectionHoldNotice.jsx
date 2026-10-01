import { Button } from "../ui";
import { formatETDate } from "../../lib/timezone";

// B10: the shared face of useCollectionHold. One `hold` object (the hook's
// return value, read once per customer) feeds every surface that shows it.
//
//   variant="banner" — the full notice with the Release control (the billing
//                      summary owns Release; it lives in exactly one place).
//   variant="charge" — the compact warning that sits beside a manual charge
//                      control (Charge now, charge-card) so an operator never
//                      overrides a hold without seeing it.
//
// An unknown hold (the read failed or is still running) is surfaced, never
// rendered as "no hold".
export const HOLD_UNKNOWN_MESSAGE =
  "Couldn't check for a billing hold — reload before charging";

export function CollectionHoldStatus({ hold, variant = "banner", className = "" }) {
  if (!hold) return null;
  const { status, dispute, releasing, releaseErr, releaseNote, release, reload } = hold;
  const charge = variant === "charge";

  if (status === "loading" && charge) {
    return (
      <div role="status" className={`text-ui-label text-ink-secondary ${className}`}>
        Checking for a billing hold…
      </div>
    );
  }

  if (status === "error") {
    return (
      <div
        role="alert"
        className={`rounded border border-hairline p-2.5 text-ui-label text-alert-fg ${className}`}
      >
        {HOLD_UNKNOWN_MESSAGE}
        {reload && (
          <Button size="sm" variant="secondary" className="ml-2" onClick={reload}>
            Retry
          </Button>
        )}
      </div>
    );
  }

  if (charge) {
    if (!dispute) return null;
    return (
      <div role="alert" className={`rounded border border-hairline p-2.5 ${className}`}>
        <div className="text-ui-label font-medium text-alert-fg">
          Billing on hold — customer disputed a bill on a collections call
        </div>
        <div className="text-ui-label text-ink-secondary mt-0.5">
          A charge you make here goes past the hold.
        </div>
      </div>
    );
  }

  return (
    <>
      {dispute && (
        <div role="alert" className={`mb-3 rounded border border-hairline p-2.5 ${className}`}>
          <div className="text-ui-label font-medium text-alert-fg">
            Billing on hold — customer disputed a bill on a collections call
          </div>
          <div className="text-ui-label text-ink-secondary mt-0.5">
            {dispute.reason ? `Reason: ${dispute.reason}. ` : ""}
            {dispute.created_at
              ? `Placed ${formatETDate(dispute.created_at, { month: "short", day: "numeric", year: "numeric" })}. `
              : ""}
            Automatic card charges are stopped until the hold is released.
          </div>
          <Button
            size="sm"
            variant="secondary"
            className="mt-2"
            onClick={() => {
              if (
                !window.confirm(
                  "Release this billing hold?\n\nAutomatic charges (monthly dues and the other automatic card charges) will resume on their next attempt, and any invoice that was held back will be sent. Only release once the dispute is resolved.",
                )
              )
                return;
              release();
            }}
            disabled={releasing}
          >
            {releasing ? "Releasing…" : "Release hold"}
          </Button>
          {releaseErr && (
            <div className="text-ui-label text-alert-fg mt-1">{releaseErr}</div>
          )}
        </div>
      )}
      {!dispute && releaseErr && (
        <div
          role="alert"
          className="mb-3 rounded border border-hairline p-2.5 text-ui-label text-alert-fg"
        >
          {releaseErr}
        </div>
      )}
      {releaseNote && (
        <div
          role="status"
          className="mb-3 rounded border border-hairline p-2.5 text-ui-label text-ink-secondary"
        >
          {releaseNote}
        </div>
      )}
    </>
  );
}
