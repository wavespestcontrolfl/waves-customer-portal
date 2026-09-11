import { useRef, useState } from "react";
import {
  ActionFeedback,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Field,
  Input,
} from "../../../components/ui";
import { adminFetch } from "../../../utils/admin-fetch";

export default function AuditTab({ showFeedback, onRefresh }) {
  // null | "stale" | "force": which audit request is in flight
  const [runningMode, setRunningMode] = useState(null);
  const [results, setResults] = useState(null);
  const [maxEntries, setMaxEntries] = useState(10);
  const [error, setError] = useState("");
  const runningRef = useRef(false);

  const runAudit = async (forceAll = false) => {
    if (runningRef.current) return;
    runningRef.current = true;
    setRunningMode(forceAll ? "force" : "stale");
    setError("");
    try {
      const data = await adminFetch("/admin/kb/audit/run", {
        method: "POST",
        body: JSON.stringify({ maxEntries, forceAll }),
      });
      setResults(data);
      showFeedback(`Audit complete: ${data.audited} reviewed, ${data.flagged} flagged`);
      onRefresh();
    } catch (requestError) {
      const message = requestError.message || "The audit could not be completed.";
      setError(message);
      showFeedback(`Audit failed: ${message}`, true);
    } finally {
      runningRef.current = false;
      setRunningMode(null);
    }
  };

  return (
    <div className="max-w-[900px] space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-18">AI knowledge audit</CardTitle>
        </CardHeader>
        <CardBody>
          <p className="mb-5 text-ui-body text-ink-secondary">
            “Question Your Assumptions” — AI reviews entries for accuracy,
            staleness, and correctness. Runs automatically weekly via cron, or
            trigger manually below.
          </p>
          <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-end">
            <Field label="Max entries to review" className="sm:w-44">
              <Input
                type="number"
                value={maxEntries}
                onChange={(event) => setMaxEntries(parseInt(event.target.value, 10) || 10)}
                min={1}
                max={50}
              />
            </Field>
            <Button
              loading={runningMode === "stale"}
              disabled={runningMode !== null}
              onClick={() => runAudit(false)}
            >
              Audit stale & low-confidence
            </Button>
            <Button
              variant="secondary"
              loading={runningMode === "force"}
              disabled={runningMode !== null}
              onClick={() => runAudit(true)}
            >
              Audit all (force)
            </Button>
          </div>
          {error && <ActionFeedback error className="mt-4">{error}</ActionFeedback>}
        </CardBody>
      </Card>

      {results && (
        <Card>
          <CardHeader>
            <CardTitle>
              Results: <span className="u-nums">{results.audited}</span> reviewed, {" "}
              <span className={results.flagged > 0 ? "text-alert-fg u-nums" : "u-nums"}>
                {results.flagged}
              </span> flagged
            </CardTitle>
          </CardHeader>
          <CardBody>
            <div className="grid gap-3">
                {(results.results || []).map((result, index) => (
                  <Card
                    key={`${result.title || "entry"}-${index}`}
                    className={result.status === "pass" ? undefined : "border-alert-fg"}
                  >
                    <CardBody>
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <h3 className="text-ui-body font-medium text-zinc-900">{result.title}</h3>
                        <Badge tone={result.status === "pass" ? "strong" : "alert"}>
                          {result.status}
                        </Badge>
                      </div>
                      <p className="mt-2 text-ui-body text-ink-secondary">{result.summary}</p>
                      {result.issues?.length > 0 && (
                        <ul className="mt-3 list-disc space-y-1 pl-5 text-ui-body text-alert-fg">
                          {result.issues.map((issue, issueIndex) => (
                            <li key={`${issue}-${issueIndex}`}>{issue}</li>
                          ))}
                        </ul>
                      )}
                    </CardBody>
                  </Card>
                ))}
            </div>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
