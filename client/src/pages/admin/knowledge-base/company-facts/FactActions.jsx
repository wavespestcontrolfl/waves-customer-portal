import { useEffect, useRef, useState } from "react";
import { ActionFeedback, Button, Field, Input } from "../../../../components/ui";
import { adminFetch } from "../../../../utils/admin-fetch";
import FactChecks from "./FactChecks";
import FactForm from "./FactForm";
import { errorMessage } from "./factCopy";
import { factTextSha256 } from "./factHash";

const BASE = "/admin/company-facts";
const send = (path, method, body) => adminFetch(`${BASE}${path}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) });

// What a tick covers: this wording and this set of warnings.
const reviewKey = (text, warnings) => `${text}\n${warnings.map((w) => `${w.code}:${(w.words || []).join(',')}`).join(';')}`;

// Tells the tab while a card has its edit form open, so a late action elsewhere never navigates away from (or closes) it.
function useReportEditing(id, mode, onEditing) {
  const editing = mode === "edit";
  useEffect(() => {
    onEditing?.(id, editing);
    return () => onEditing?.(id, false);
  }, [id, editing, onEditing]);
}

// Said only where the reload really runs (useAction below). The editor path has its own wording in factCopy.js and reloads nothing.
const GONE_NOTICES = {
  NOT_A_DRAFT: "Someone else already approved or changed this draft. The list was reloaded. Nothing was deleted.",
  NOT_FOUND: "That draft was already deleted. The list was reloaded.",
};

// One in-flight request at a time per card. run() reports success through onDone(message) and failure as one plain sentence.
function useAction(onDone, onStale) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const busyRef = useRef(false);
  const run = async (work, doneMessage, switchTo, onRefused) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      await work();
      onDone(doneMessage, switchTo);
    } catch (requestError) {
      // A fact that left this list is said as it is: the reload below is what these two sentences report.
      const message = GONE_NOTICES[requestError.code] || errorMessage(requestError);
      setError(message);
      if (["STALE_TEXT", "STALE_FACT", "STATUS_CHANGED"].includes(requestError.code)) {
        // The fact changed under this action: refresh the card, and let the caller close what it had open.
        onStale();
        onRefused?.();
      } else if (["NOT_A_DRAFT", "NOT_FOUND"].includes(requestError.code)) {
        // The fact was approved or deleted meanwhile, so its card is about to leave this list: say so on the page, not on the card, and reload.
        onRefused?.();
        onDone(message);
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  return { busy, error, run, setError };
}

export function DraftActions({ fact, ownerActions, onDone, onStale, onEditing }) {
  const [mode, setMode] = useState("view");
  useReportEditing(fact.id, mode, onEditing);
  // The tick and the server's fresh warnings belong to one wording: each remembers the text it was given for, and
  // counts only while the card still shows that text (an edit or a reload that changed the wording drops both).
  const [tickedFor, setTickedFor] = useState(null);
  const [fresh, setFresh] = useState(null);
  // What the card showed when Discard was opened: the delete carries it, so a newer version saved meanwhile is never deleted.
  const [discardBase, setDiscardBase] = useState(null);
  // Names the open Discard dialog: a refusal that arrives late closes only the dialog that asked, never a newer one or an editor opened since.
  const discardDialog = useRef(0);
  const { busy, error, run } = useAction(onDone, onStale);
  const blocks = fact.check_result?.blocks || [];
  const freshWarnings = fresh && fresh.text === fact.fact_text ? fresh.warnings : null;
  const warnings = freshWarnings || fact.check_result?.warnings || [];
  const ticked = tickedFor === reviewKey(fact.fact_text, warnings);
  const canApprove = ownerActions && !blocks.length && (!warnings.length || ticked);

  const approve = () => run(async () => {
    // The hash of the exact wording on screen: the server refuses the approval if the wording changed since.
    const reviewed = fact.fact_text;
    const textSha256 = await factTextSha256(reviewed);
    try {
      // The tick covers the warnings on screen: the server refuses the approval if its checks now find one that is not among them.
      await send(`/${fact.id}/approve`, "POST", { textSha256, ...(warnings.length ? { acknowledgeWarnings: true, reviewedWarnings: warnings.map((w) => w.code) } : {}) });
    } catch (requestError) {
      if (requestError.code === "WARNINGS_NOT_ACKNOWLEDGED") setFresh({ text: reviewed, warnings: requestError.details?.warnings || [] });
      throw requestError;
    }
  }, "Fact approved.", "approved");

  // Saving the draft with nothing changed makes the server run every check again and store the new result (PATCH with just the wording hash).
  const checkAgain = () => run(() => send(`/${fact.id}`, "PATCH", { baseTextSha256: fact.text_sha256, baseUpdatedAt: fact.updated_at, expectStatus: "draft" }), "Checked again.");

  if (mode === "edit") {
    return (
      <FactForm
        mode="draft"
        initial={fact}
        loadCurrent={() => send(`/${fact.id}`, "GET")}
        onStale={onStale}
        onCancel={() => setMode("view")}
        onSubmit={async (values) => { await send(`/${fact.id}`, "PATCH", values); setMode("view"); onDone("Draft saved."); }}
      />
    );
  }
  return (
    <div className="space-y-3">
      <FactChecks factId={fact.id} check={fact.check_result} warnings={freshWarnings} canTick={ownerActions && !blocks.length} ticked={ticked} onTick={(on) => setTickedFor(on ? reviewKey(fact.fact_text, warnings) : null)} />
      {mode === "discard" && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-ui-body">Discard this draft for good?</span>
          <Button variant="danger" loading={busy} onClick={() => {
            const mine = discardDialog.current;
            run(() => send(`/${fact.id}`, "DELETE", discardBase), "Draft discarded.", undefined, () => {
              if (discardDialog.current === mine) setMode((now) => (now === "discard" ? "view" : now));
            });
          }}>Discard</Button>
          <Button variant="secondary" onClick={() => { discardDialog.current += 1; setMode("view"); }}>Keep</Button>
        </div>
      )}
      {mode === "view" && (
        <div className="flex flex-wrap gap-2">
          {ownerActions && <Button loading={busy} disabled={!canApprove} onClick={approve}>Approve</Button>}
          <Button variant="secondary" onClick={() => { discardDialog.current += 1; setMode("edit"); }}>Edit</Button>
          <Button variant="secondary" loading={busy} onClick={checkAgain}>Check again</Button>
          <Button variant="secondary" onClick={() => { discardDialog.current += 1; setDiscardBase({ baseTextSha256: fact.text_sha256, baseUpdatedAt: fact.updated_at }); setMode("discard"); }}>Discard</Button>
        </div>
      )}
      {!ownerActions && <p className="text-ui-caption text-ink-secondary">Only the owner account can approve.</p>}
      {error && <ActionFeedback error>{error}</ActionFeedback>}
    </div>
  );
}

export function ApprovedActions({ fact, onDone, onStale, onEditing }) {
  const [mode, setMode] = useState("view");
  useReportEditing(fact.id, mode, onEditing);
  const [reason, setReason] = useState("");
  const { busy, error, run } = useAction(onDone, onStale);
  const reasonOk = reason.trim().length >= 3;

  if (mode === "edit") {
    return (
      <FactForm
        mode="approved"
        initial={fact}
        loadCurrent={() => send(`/${fact.id}`, "GET")}
        onStale={onStale}
        onCancel={() => setMode("view")}
        onSubmit={async (values) => {
          const saved = await send(`/${fact.id}`, "PATCH", values);
          // This form is done: unregister it before reporting, so it does not hold back the switch to Drafts. Other open editors still do.
          setMode("view");
          onEditing?.(fact.id, false);
          onDone("New draft saved. The approved fact is unchanged until it is approved.", "draft", saved?.fact?.id);
        }}
      />
    );
  }
  return (
    <div className="space-y-3">
      {mode === "retire" && (
        <div className="space-y-2">
          <Field label="Why are you retiring it?" required help="Required. At least 3 letters. It is kept in the history.">
            <Input value={reason} maxLength={300} onChange={(event) => setReason(event.target.value)} />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button variant="danger" loading={busy} disabled={!reasonOk} onClick={() => run(() => send(`/${fact.id}/retire`, "POST", { reason: reason.trim() }), "Fact retired.", "retired")}>Retire fact</Button>
            <Button variant="secondary" onClick={() => setMode("view")}>Keep it</Button>
          </div>
        </div>
      )}
      {mode === "view" && (
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setMode("edit")}>Edit</Button>
          <Button variant="secondary" onClick={() => setMode("retire")}>Retire</Button>
        </div>
      )}
      {error && <ActionFeedback error>{error}</ActionFeedback>}
    </div>
  );
}

export function RetiredActions({ fact, onDone, onStale }) {
  const { busy, error, run } = useAction(onDone, onStale);
  return (
    <div className="space-y-3">
      <Button variant="secondary" loading={busy} onClick={() => run(() => send(`/${fact.id}/restore`, "POST"), "Restored as a new draft. It still needs the owner's approval.", "draft")}>
        Restore as a new draft
      </Button>
      {error && <ActionFeedback error>{error}</ActionFeedback>}
    </div>
  );
}
