import { useEffect, useState } from "react";
import { ActionFeedback, Card, CardBody, CardHeader, CardTitle } from "../../../../components/ui";
import { adminFetch } from "../../../../utils/admin-fetch";

// The approved lines as the agents' snapshot serves them (GET /admin/company-facts/preview): the server re-checks every
// approved row and leaves out any that fail, so this list can be shorter than the Approved list below it.
// `facts` is the Approved list on screen; a change in it (an approve, a retire) reads the preview again.
export default function HowItWillRead({ facts }) {
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const signature = facts.map((fact) => `${fact.id}:${fact.text_sha256}`).join(",");

  useEffect(() => {
    let live = true;
    setError("");
    setPreview(null);
    adminFetch("/admin/company-facts/preview")
      .then((body) => live && setPreview(body))
      .catch(() => live && setError("Could not load the preview. This does not mean any fact failed its checks. Try again."));
    return () => { live = false; };
  }, [signature, attempt]);

  // From the preview's own read only: it names the approved rows it looked at and kept, so a fact retired between this and the list never
  // counts as a failed check. The topics come from the list when it has the row.
  const leftOut = preview?.leftOut || [];
  const topicOf = (id) => facts.find((fact) => fact.id === id)?.topic;
  return (
    <Card className="mb-4">
      <CardHeader>
        <CardTitle className="text-18">Preview — voice calls, email drafts and texting drafts use these facts</CardTitle>
      </CardHeader>
      <CardBody className="space-y-2">
        <p className="text-ui-caption text-ink-secondary">
          This is how the list reads to them: the approved facts in the order approved, after the built-in facts. Texting drafts use them too: staff still review every text draft before it goes out.
        </p>
        {error && <ActionFeedback error onRetry={() => setAttempt((n) => n + 1)}>{error}</ActionFeedback>}
        {!error && !preview && <ActionFeedback>Loading the preview…</ActionFeedback>}
        {preview && preview.lines && (
          <pre aria-label="How the approved facts will read" className="m-0 overflow-x-auto whitespace-pre-wrap break-words rounded-xs bg-zinc-50 p-3 text-ui-body text-ink-primary">{preview.lines}</pre>
        )}
        {/* An empty list is "no approved facts" only when the read found none; approved facts that all failed the checks say so. */}
        {preview && !preview.lines && leftOut.length === 0 && <p className="text-ui-body text-ink-secondary">No approved facts yet.</p>}
        {leftOut.length > 0 && !preview?.lines && (
          <ActionFeedback error>
            {leftOut.length === 1 ? "1 approved fact is" : `${leftOut.length} approved facts are`} not served because {leftOut.length === 1 ? "it no longer passes" : "they no longer pass"} the checks ({leftOut.map((id) => topicOf(id) || "another fact").join(", ")}). Voice calls and email drafts get no facts from the bank right now. Retire {leftOut.length === 1 ? "it" : "them"}, or edit {leftOut.length === 1 ? "it" : "each"} as a new draft.
          </ActionFeedback>
        )}
        {leftOut.length > 0 && preview?.lines && (
          <ActionFeedback error>
            {leftOut.length === 1 ? "1 approved fact is" : `${leftOut.length} approved facts are`} not in this list ({leftOut.map((id) => topicOf(id) || "another fact").join(", ")}). It no longer passes the checks, so it will not go to the agents. Retire it, or edit it as a new draft.
          </ActionFeedback>
        )}
      </CardBody>
    </Card>
  );
}
