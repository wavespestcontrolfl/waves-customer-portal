import { useEffect, useState } from "react";
import { ActionFeedback, Button } from "../../../../components/ui";
import { adminFetch } from "../../../../utils/admin-fetch";
import { formatDate } from "../config";
import { ACTION_LABELS } from "./factCopy";

function detailLine(event) {
  const detail = event.detail || {};
  if (event.action === "retired" && detail.reason) return `Reason: ${detail.reason}`;
  if (event.action === "approved" && detail.warnings?.length) return "The owner checked the warnings.";
  return "";
}

// Who did what and when, oldest first, from GET /admin/company-facts/:id/history.
export default function FactHistory({ fact }) {
  const [open, setOpen] = useState(false);
  // The events read, with the fact version (updated_at) they were read at. Every edit, check, approve or retire moves updated_at,
  // so a list reload after a change makes the cache stale and the open panel reads again.
  const [loaded, setLoaded] = useState(null);
  const [error, setError] = useState("");
  const events = loaded && loaded.version === fact.updated_at ? loaded.events : null;

  useEffect(() => {
    if (!open || events) return;
    let live = true;
    const version = fact.updated_at;
    adminFetch(`/admin/company-facts/${fact.id}/history`)
      .then((body) => { if (live) { setError(""); setLoaded({ version, events: body.events || [] }); } })
      .catch(() => live && setError("The history could not be loaded."));
    return () => { live = false; };
  }, [open, events, fact.id, fact.updated_at]);

  return (
    <div className="mt-3 border-t-hairline border-zinc-200 pt-2">
      <Button variant="ghost" size="sm" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? "Hide history" : "History"}
      </Button>
      {open && error && <ActionFeedback error>{error}</ActionFeedback>}
      {open && !error && !events && <ActionFeedback>Loading history…</ActionFeedback>}
      {open && events && (
        <ol className="mt-2 space-y-1 text-ui-body" aria-label="Fact history">
          {fact.owner_words && fact.approved_at && (
            <li className="text-ink-secondary">Owner's words at approval: "{fact.owner_words}"</li>
          )}
          {events.map((event) => (
            <li key={event.id}>
              <span className="font-medium">{ACTION_LABELS[event.action] || event.action}</span>
              {" by "}{event.actor_name || "a staff member"}
              {" on "}{formatDate(event.at, true)}
              {detailLine(event) && <span className="text-ink-secondary">{`. ${detailLine(event)}`}</span>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
