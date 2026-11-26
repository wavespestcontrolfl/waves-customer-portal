import { useEffect, useState } from "react";
import { ActionFeedback, Card, CardBody, CardHeader, CardTitle } from "../../../../components/ui";
import { adminFetch } from "../../../../utils/admin-fetch";

// The approved lines as the agents' snapshot serves them (GET /admin/company-facts/preview): the server re-checks every
// approved row and leaves out any that fail, so this list can be shorter than the Approved list below it.
// `facts` is the Approved list on screen; a change in it (an approve, a retire) reads the preview again.
export default function HowItWillRead({ facts }) {
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState("");
  const signature = facts.map((fact) => `${fact.id}:${fact.text_sha256}`).join(",");

  useEffect(() => {
    let live = true;
    setError("");
    adminFetch("/admin/company-facts/preview")
      .then((body) => live && setPreview(body))
      .catch(() => live && setError("The preview could not be loaded."));
    return () => { live = false; };
  }, [signature]);

  const left = preview ? facts.length - preview.count : 0;
  return (
    <Card className="mb-4">
      <CardHeader>
        <CardTitle className="text-18">How it will read</CardTitle>
      </CardHeader>
      <CardBody className="space-y-2">
        <p className="text-ui-caption text-ink-secondary">
          The approved facts as the agents get them now, in the order approved, after the built-in facts. Each channel adds its own heading above the list.
        </p>
        {error && <ActionFeedback error>{error}</ActionFeedback>}
        {!error && !preview && <ActionFeedback>Loading the preview…</ActionFeedback>}
        {preview && preview.lines && (
          <pre aria-label="How the approved facts will read" className="m-0 overflow-x-auto whitespace-pre-wrap break-words rounded-xs bg-zinc-50 p-3 text-ui-body text-ink-primary">{preview.lines}</pre>
        )}
        {preview && !preview.lines && <p className="text-ui-body text-ink-secondary">The agents get no extra facts now, only the built-in facts.</p>}
        {left > 0 && (
          <ActionFeedback error>
            {left === 1 ? "1 approved fact is" : `${left} approved facts are`} not in this list. It no longer passes the checks, so the agents do not get it. Retire it, or edit it as a new draft.
          </ActionFeedback>
        )}
      </CardBody>
    </Card>
  );
}
