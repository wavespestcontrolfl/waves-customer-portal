import { Card, CardBody, CardHeader, CardTitle } from "../../../../components/ui";

// The approved lines in the order the agents get them: the server's renderBankFactsLines puts "- " before each line,
// ordered by approval time. The server does not send its own render, so this is the same plain list, built here.
// Each channel puts its own heading above the list, and the built-in facts come first.
export function renderApprovedLines(facts) {
  return [...facts]
    .sort((a, b) => new Date(a.approved_at) - new Date(b.approved_at))
    .map((fact) => `- ${String(fact.fact_text).trim()}`)
    .join("\n");
}

export default function HowItWillRead({ facts }) {
  const lines = renderApprovedLines(facts);
  return (
    <Card className="mb-4">
      <CardHeader>
        <CardTitle className="text-18">How it will read</CardTitle>
      </CardHeader>
      <CardBody className="space-y-2">
        <p className="text-ui-caption text-ink-secondary">
          A plain list of the approved facts, in the order the agents get them, after the built-in facts. Each channel adds its own heading above the list.
        </p>
        {lines
          ? <pre aria-label="How the approved facts will read" className="m-0 overflow-x-auto whitespace-pre-wrap break-words rounded-xs bg-zinc-50 p-3 text-ui-body text-ink-primary">{lines}</pre>
          : <p className="text-ui-body text-ink-secondary">No approved facts yet, so the agents get only the built-in facts.</p>}
      </CardBody>
    </Card>
  );
}
