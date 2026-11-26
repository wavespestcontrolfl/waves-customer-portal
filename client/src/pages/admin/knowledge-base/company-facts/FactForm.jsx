import { useState } from "react";
import { ActionFeedback, Button, Field, Input, Textarea } from "../../../../components/ui";
import { errorMessage } from "./factCopy";

const MAX_CHARS = 400;

const COPY = {
  new: { save: "Save draft", note: "Write one to three plain sentences. Leave out numbers, prices, times and product names." },
  draft: { save: "Save changes", note: "Saving runs the checks again." },
  approved: { save: "Save as a new draft", note: "The approved fact stays live until the owner approves this new draft." },
};

const startingValues = (mode, fact) => ({
  topic: fact.topic || "",
  factText: (fact.fact_text || "").trim(),
  question: fact.question || "",
  // A replacement of an approved fact starts with no owner's words: the old quote does not vouch for new wording.
  ownerWords: mode === "approved" ? "" : fact.owner_words || "",
});

// Add a draft, edit a draft, or draft a replacement of an approved fact. onSubmit(values) returns a promise.
// For an edit, `loadCurrent()` reads the fact as it is saved now (used to recover from a 409 STALE_TEXT).
// The baseline (the fields and wording hash the editor opened) is fixed at open: a list reload behind the form never moves it,
// so an untouched field is never sent and never overwrites another admin's edit. Only a STALE_TEXT recovery replaces it.
export default function FactForm({ mode, initial = {}, onSubmit, onCancel, loadCurrent, onStale }) {
  const [baseline, setBaseline] = useState(() => ({ values: startingValues(mode, initial), hash: initial.text_sha256, updatedAt: initial.updated_at }));
  const [fields, setFields] = useState(baseline.values);
  const [current, setCurrent] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const setField = (key) => (event) => setFields((prev) => ({ ...prev, [key]: event.target.value }));

  // A new draft sends everything. An edit sends only what the editor changed, plus what it opened: the wording hash, the row's
  // updated_at and the kind of fact (draft or approved). The server refuses a concurrent change of the wording (STALE_TEXT), of any
  // field (STALE_FACT), or of the status, such as an approval meanwhile (STATUS_CHANGED).
  const openedState = { baseTextSha256: baseline.hash, baseUpdatedAt: baseline.updatedAt, expectStatus: mode === "approved" ? "approved" : "draft" };
  const valuesToSend = (now) => {
    if (mode === "new") return now;
    const changed = Object.fromEntries(Object.entries(now).filter(([key, value]) => value !== baseline.values[key]));
    return Object.keys(changed).length ? { ...changed, ...openedState } : null;
  };

  // The wording was changed by someone else. Show it, keep what the editor typed (to copy), and move the baseline to the
  // saved fact. A field the editor did not touch takes the saved value; a field they changed keeps their text.
  const recover = async () => {
    const saved = await loadCurrent();
    const fresh = startingValues(mode, saved.fact);
    setFields((prev) => Object.fromEntries(Object.keys(prev).map((key) => [key, prev[key] === baseline.values[key] ? fresh[key] : prev[key]])));
    setBaseline({ values: fresh, hash: saved.fact.text_sha256, updatedAt: saved.fact.updated_at });
    setCurrent(saved.fact.fact_text);
  };

  const save = async () => {
    if (busy) return;
    const now = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value.trim()]));
    if (!now.topic || !now.factText) {
      setError("Add a short topic and the fact.");
      return;
    }
    const values = valuesToSend(now);
    if (!values) {
      setError("Nothing has changed yet.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await onSubmit(values);
    } catch (requestError) {
      setCurrent(null);
      if (["STALE_TEXT", "STALE_FACT"].includes(requestError.code) && loadCurrent) {
        try {
          await recover();
          setError(`Someone changed this ${requestError.code === "STALE_TEXT" ? "wording" : "fact"} while you had it open. Your text is still in the box. Compare it with the saved wording below, then save again.`);
        } catch {
          setError("Someone changed this fact, and the saved wording could not be loaded. Copy your text, close this, and reload the list.");
        }
      } else {
        setError(errorMessage(requestError, "The fact could not be saved."));
        // The fact moved on (approved, say): refresh the list behind this form. The form and what was typed stay.
        if (requestError.code === "STATUS_CHANGED") onStale?.();
      }
      setBusy(false);
    }
  };

  return (
    <fieldset disabled={busy} className="m-0 min-w-0 space-y-3 border-0 p-0">
      <p className="text-ui-body text-ink-secondary">{COPY[mode].note}</p>
      <Field label="Topic" required help="A short title for this list. Customers never see it.">
        <Input value={fields.topic} maxLength={120} onChange={setField("topic")} />
      </Field>
      <Field label="The fact" required help={`${fields.factText.trim().length} of ${MAX_CHARS} characters`}>
        <Textarea value={fields.factText} rows={3} onChange={setField("factText")} />
      </Field>
      <Field label="Question it answers (optional)" help="No customer names.">
        <Input value={fields.question} maxLength={300} onChange={setField("question")} />
      </Field>
      <Field label="Owner's words (optional)" help="The owner's own answer, kept with the fact. It is not shown to customers.">
        <Textarea value={fields.ownerWords} rows={2} maxLength={500} onChange={setField("ownerWords")} />
      </Field>
      {current !== null && (
        <div className="rounded-xs bg-zinc-50 p-3 text-ui-body" aria-label="Saved wording">
          <p className="m-0 text-ui-caption text-ink-secondary">Saved wording now:</p>
          <p className="m-0 whitespace-pre-wrap break-words">{current}</p>
        </div>
      )}
      {error && <ActionFeedback error>{error}</ActionFeedback>}
      <div className="flex flex-wrap gap-2">
        <Button loading={busy} onClick={save}>{COPY[mode].save}</Button>
        <Button variant="secondary" onClick={onCancel}>Cancel</Button>
      </div>
    </fieldset>
  );
}
