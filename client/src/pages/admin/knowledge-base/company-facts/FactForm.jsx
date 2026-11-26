import { useState } from "react";
import { ActionFeedback, Button, Field, Input, Textarea } from "../../../../components/ui";
import { errorMessage } from "./factCopy";

const MAX_CHARS = 400;

const COPY = {
  new: { save: "Save draft", note: "Write one to three plain sentences. Leave out numbers, prices, times and product names." },
  draft: { save: "Save changes", note: "Saving runs the checks again." },
  approved: { save: "Save as a new draft", note: "The approved fact stays live until the owner approves this new draft." },
};

// Add a draft, edit a draft, or draft a replacement of an approved fact. onSubmit(values) returns a promise.
export default function FactForm({ mode, initial = {}, onSubmit, onCancel }) {
  const [topic, setTopic] = useState(initial.topic || "");
  const [factText, setFactText] = useState(initial.fact_text || "");
  const [question, setQuestion] = useState(initial.question || "");
  // A replacement of an approved fact starts with no owner's words: the old quote does not vouch for new wording.
  const startWords = mode === "approved" ? "" : initial.owner_words || "";
  const [ownerWords, setOwnerWords] = useState(startWords);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // A new draft sends everything. An edit sends only what the editor changed, plus the hash of the wording it opened,
  // so an untouched field never overwrites someone else's edit and a concurrent change of the wording is refused (409).
  const valuesToSend = (now) => {
    if (mode === "new") return now;
    const was = { topic: initial.topic || "", factText: (initial.fact_text || "").trim(), question: initial.question || "", ownerWords: startWords };
    const changed = Object.fromEntries(Object.entries(now).filter(([key, value]) => value !== was[key]));
    return Object.keys(changed).length ? { ...changed, baseTextSha256: initial.text_sha256 } : null;
  };

  const save = async () => {
    if (busy) return;
    if (!topic.trim() || !factText.trim()) {
      setError("Add a short topic and the fact.");
      return;
    }
    const values = valuesToSend({ topic: topic.trim(), factText: factText.trim(), question: question.trim(), ownerWords: ownerWords.trim() });
    if (!values) {
      setError("Nothing has changed yet.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await onSubmit(values);
    } catch (requestError) {
      setError(errorMessage(requestError, "The fact could not be saved."));
      setBusy(false);
    }
  };

  return (
    <fieldset disabled={busy} className="m-0 min-w-0 space-y-3 border-0 p-0">
      <p className="text-ui-body text-ink-secondary">{COPY[mode].note}</p>
      <Field label="Topic" required help="A short title for this list. Customers never see it.">
        <Input value={topic} maxLength={120} onChange={(event) => setTopic(event.target.value)} />
      </Field>
      <Field label="The fact" required help={`${factText.trim().length} of ${MAX_CHARS} characters`}>
        <Textarea value={factText} rows={3} onChange={(event) => setFactText(event.target.value)} />
      </Field>
      <Field label="Question it answers (optional)" help="No customer names.">
        <Input value={question} maxLength={300} onChange={(event) => setQuestion(event.target.value)} />
      </Field>
      <Field label="Owner's words (optional)" help="The owner's own answer, kept with the fact. It is not shown to customers.">
        <Textarea value={ownerWords} rows={2} maxLength={500} onChange={(event) => setOwnerWords(event.target.value)} />
      </Field>
      {error && <ActionFeedback error>{error}</ActionFeedback>}
      <div className="flex flex-wrap gap-2">
        <Button loading={busy} onClick={save}>{COPY[mode].save}</Button>
        <Button variant="secondary" onClick={onCancel}>Cancel</Button>
      </div>
    </fieldset>
  );
}
