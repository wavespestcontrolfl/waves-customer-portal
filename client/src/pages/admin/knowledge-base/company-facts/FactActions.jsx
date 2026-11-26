import { useRef, useState } from "react";
import { ActionFeedback, Button, Field, Input } from "../../../../components/ui";
import { adminFetch } from "../../../../utils/admin-fetch";
import FactChecks from "./FactChecks";
import FactForm from "./FactForm";
import { errorMessage } from "./factCopy";
import { factTextSha256 } from "./factHash";

const BASE = "/admin/company-facts";
const send = (path, method, body) => adminFetch(`${BASE}${path}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) });

// One in-flight request at a time per card. run() reports success through onDone(message) and failure as one plain sentence.
function useAction(onDone, onStale) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const busyRef = useRef(false);
  const run = async (work, doneMessage, switchTo) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      await work();
      onDone(doneMessage, switchTo);
    } catch (requestError) {
      setError(errorMessage(requestError));
      if (requestError.code === "STALE_TEXT") onStale();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  return { busy, error, run, setError };
}

export function DraftActions({ fact, ownerActions, onDone, onStale }) {
  const [mode, setMode] = useState("view");
  const [ticked, setTicked] = useState(false);
  const [freshWarnings, setFreshWarnings] = useState(null);
  const { busy, error, run } = useAction(onDone, onStale);
  const blocks = fact.check_result?.blocks || [];
  const warnings = freshWarnings || fact.check_result?.warnings || [];
  const canApprove = ownerActions && !blocks.length && (!warnings.length || ticked);

  const approve = () => run(async () => {
    // The hash of the exact wording on screen: the server refuses the approval if the wording changed since.
    const textSha256 = await factTextSha256(fact.fact_text);
    try {
      await send(`/${fact.id}/approve`, "POST", { textSha256, ...(warnings.length ? { acknowledgeWarnings: true } : {}) });
    } catch (requestError) {
      if (requestError.code === "WARNINGS_NOT_ACKNOWLEDGED") setFreshWarnings(requestError.details?.warnings || null);
      throw requestError;
    }
  }, "Fact approved.", "approved");

  if (mode === "edit") {
    return (
      <FactForm
        mode="draft"
        initial={fact}
        onCancel={() => setMode("view")}
        onSubmit={async (values) => { await send(`/${fact.id}`, "PATCH", values); setMode("view"); onDone("Draft saved."); }}
      />
    );
  }
  return (
    <div className="space-y-3">
      <FactChecks check={fact.check_result} warnings={freshWarnings} canTick={ownerActions && !blocks.length} ticked={ticked} onTick={setTicked} />
      {mode === "discard" && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-ui-body">Discard this draft for good?</span>
          <Button variant="danger" loading={busy} onClick={() => run(() => send(`/${fact.id}`, "DELETE"), "Draft discarded.")}>Discard</Button>
          <Button variant="secondary" onClick={() => setMode("view")}>Keep</Button>
        </div>
      )}
      {mode === "view" && (
        <div className="flex flex-wrap gap-2">
          {ownerActions && <Button loading={busy} disabled={!canApprove} onClick={approve}>Approve</Button>}
          <Button variant="secondary" onClick={() => setMode("edit")}>Edit</Button>
          <Button variant="secondary" onClick={() => setMode("discard")}>Discard</Button>
        </div>
      )}
      {!ownerActions && <p className="text-ui-caption text-ink-secondary">Only the owner account can approve.</p>}
      {error && <ActionFeedback error>{error}</ActionFeedback>}
    </div>
  );
}

export function ApprovedActions({ fact, onDone, onStale }) {
  const [mode, setMode] = useState("view");
  const [reason, setReason] = useState("");
  const { busy, error, run } = useAction(onDone, onStale);
  const reasonOk = reason.trim().length >= 3;

  if (mode === "edit") {
    return (
      <FactForm
        mode="approved"
        initial={fact}
        onCancel={() => setMode("view")}
        onSubmit={async (values) => { await send(`/${fact.id}`, "PATCH", values); setMode("view"); onDone("New draft saved. The approved fact is unchanged until it is approved.", "draft"); }}
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
