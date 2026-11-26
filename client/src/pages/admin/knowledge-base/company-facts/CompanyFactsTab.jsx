import { useState } from "react";
import { ActionFeedback, Button, Card, CardBody, CardHeader, CardTitle } from "../../../../components/ui";
import { adminFetch } from "../../../../utils/admin-fetch";
import FactCard from "./FactCard";
import FactForm from "./FactForm";
import HowItWillRead from "./HowItWillRead";
import useFactList from "./useFactList";

const STATUSES = [
  { key: "draft", label: "Drafts", empty: "No drafts waiting." },
  { key: "approved", label: "Approved", empty: "No approved facts yet." },
  { key: "retired", label: "Retired", empty: "Nothing retired." },
];

function AddDraft({ onSaved, onCancel }) {
  return (
    <Card className="mb-4">
      <CardHeader><CardTitle className="text-18">Add a draft</CardTitle></CardHeader>
      <CardBody>
        <FactForm
          mode="new"
          onCancel={onCancel}
          onSubmit={async (values) => {
            const body = { topic: values.topic, factText: values.factText };
            if (values.question) body.question = values.question;
            if (values.ownerWords) body.ownerWords = values.ownerWords;
            await adminFetch("/admin/company-facts", { method: "POST", body: JSON.stringify(body) });
            onSaved();
          }}
        />
      </CardBody>
    </Card>
  );
}

function FactList({ list, status, onDone, onStale }) {
  if (list.loading) return <ActionFeedback className="min-h-11">Loading facts…</ActionFeedback>;
  if (list.error && !list.facts.length) return <ActionFeedback error onRetry={list.reload}>{list.error}</ActionFeedback>;
  if (!list.facts.length) return <p className="text-ui-body text-ink-secondary">{status.empty}</p>;
  return (
    <div className="grid gap-3">
      {list.facts.map((fact) => (
        <FactCard key={fact.id} fact={fact} ownerActions={list.ownerActions} onDone={onDone} onStale={onStale} />
      ))}
      {list.error && <ActionFeedback error>{list.error}</ActionFeedback>}
      {list.nextCursor && <Button variant="secondary" loading={list.loadingMore} onClick={list.loadMore}>Load more</Button>}
    </div>
  );
}

export default function CompanyFactsTab({ showFeedback }) {
  const [statusKey, setStatusKey] = useState("draft");
  const [adding, setAdding] = useState(false);
  const list = useFactList(statusKey);
  const status = STATUSES.find((item) => item.key === statusKey);

  const done = (message, switchTo) => {
    if (message) showFeedback(message);
    if (switchTo && switchTo !== statusKey) setStatusKey(switchTo);
    else list.reload(true);
  };

  return (
    <div className="max-w-[900px]">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-18 leading-[1.35] font-medium text-zinc-900">Company facts</h2>
          <p className="mt-1 text-ui-body text-ink-secondary">
            Short facts the agents may state to customers. Anyone on the team can draft one. Only the owner account approves it.
          </p>
        </div>
        <Button onClick={() => { setAdding(true); setStatusKey("draft"); }}>Add draft</Button>
      </div>

      {adding && (
        <AddDraft
          onCancel={() => setAdding(false)}
          onSaved={() => { setAdding(false); showFeedback("Draft saved."); list.reload(true); }}
        />
      )}

      <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Fact state">
        {STATUSES.map((item) => (
          <Button key={item.key} variant={item.key === statusKey ? "primary" : "secondary"} aria-pressed={item.key === statusKey} onClick={() => setStatusKey(item.key)}>
            {item.label}
          </Button>
        ))}
      </div>

      {statusKey === "approved" && !list.loading && !list.error && <HowItWillRead facts={list.facts} />}
      <FactList list={list} status={status} onDone={done} onStale={() => list.reload(true)} />
    </div>
  );
}
