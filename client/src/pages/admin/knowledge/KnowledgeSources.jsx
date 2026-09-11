import { useEffect, useRef, useState } from "react";
import {
  ActionFeedback, Badge, Button, Card, CardBody, CardHeader, CardTitle,
  Field, Input, Select, Table, TBody, TD, TH, THead, TR, UiSurface,
} from "../../../components/ui";
import { adminFetch } from "../../../utils/admin-fetch";

const EMPTY_ADD_FORM = {
  filename: "",
  file_path: "",
  file_type: "csv",
  description: "",
};

export default function KnowledgeSources() {
  const [sources, setSources] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [compilingIds, setCompilingIds] = useState(() => new Set());
  const [addForm, setAddForm] = useState(EMPTY_ADD_FORM);
  const [showAdd, setShowAdd] = useState(false);
  const [adding, setAdding] = useState(false);
  const addingRef = useRef(false);
  const compilingRef = useRef(new Set());

  const loadSources = async ({ afterMutation = false } = {}) => {
    try {
      const data = await adminFetch("/admin/knowledge/sources");
      setSources(data.sources || []);
      // Concurrent compiles each refresh the list, and loadError replaces the
      // whole panel. A later success supersedes an earlier refresh failure, or
      // the stale error keeps hiding the table it just reloaded.
      setLoadError("");
    } catch (requestError) {
      if (!afterMutation) throw requestError;
      setLoadError("Changes saved, but the source list could not be refreshed.");
    }
  };

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError("");
    adminFetch("/admin/knowledge/sources")
      .then((data) => {
        if (active) setSources(data.sources || []);
      })
      .catch((requestError) => {
        if (active) setLoadError(requestError?.message || "Could not load sources.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [attempt]);

  const handleCompile = async (sourceId) => {
    if (compilingRef.current.has(sourceId)) return;
    compilingRef.current.add(sourceId);
    setCompilingIds((current) => new Set(current).add(sourceId));
    setActionError("");
    try {
      await adminFetch("/admin/knowledge/compile", {
        method: "POST",
        body: JSON.stringify({ sourceId }),
      });
      await loadSources({ afterMutation: true });
    } catch (requestError) {
      setActionError(requestError?.message || "Could not compile this source.");
    } finally {
      compilingRef.current.delete(sourceId);
      setCompilingIds((current) => {
        const next = new Set(current);
        next.delete(sourceId);
        return next;
      });
    }
  };

  const handleAdd = async (event) => {
    event.preventDefault();
    if (addingRef.current) return;
    addingRef.current = true;
    setAdding(true);
    setActionError("");
    try {
      await adminFetch("/admin/knowledge/sources", {
        method: "POST",
        body: JSON.stringify(addForm),
      });
      setShowAdd(false);
      setAddForm(EMPTY_ADD_FORM);
      await loadSources({ afterMutation: true });
    } catch (requestError) {
      setActionError(requestError?.message || "Could not add source.");
    } finally {
      addingRef.current = false;
      setAdding(false);
    }
  };

  const updateForm = (field) => (event) => setAddForm((previous) => ({
    ...previous,
    [field]: event.target.value,
  }));

  if (loading) {
    return (
      <UiSurface density="comfortable">
        <ActionFeedback>Loading sources…</ActionFeedback>
      </UiSurface>
    );
  }
  if (loadError) {
    return (
      <UiSurface density="comfortable">
        <ActionFeedback error onRetry={() => setAttempt((value) => value + 1)}>
          {loadError}
        </ActionFeedback>
      </UiSurface>
    );
  }

  return (
    <UiSurface density="comfortable" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-ui-body text-ink-secondary u-nums">
          {sources.length} source documents
        </p>
        <Button variant="secondary" onClick={() => setShowAdd(true)}>Add source</Button>
      </div>

      {showAdd && (
        <Card>
          <CardHeader><CardTitle>Add source document</CardTitle></CardHeader>
          <CardBody>
            <form className="space-y-4" onSubmit={handleAdd}>
              <div className="grid gap-4 md:grid-cols-2">
                <Field label="Filename">
                  <Input value={addForm.filename} onChange={updateForm("filename")} />
                </Field>
                <Field
                  label="Wiki file path"
                  help="Path inside the repository wiki/ folder, such as protocols/termite.md."
                >
                  <Input value={addForm.file_path} onChange={updateForm("file_path")} />
                </Field>
                <Field label="File type">
                  <Select value={addForm.file_type} onChange={updateForm("file_type")}>
                    <option value="csv">CSV</option>
                    <option value="xlsx">Excel</option>
                    <option value="md">Markdown</option>
                    <option value="txt">Text</option>
                    <option value="json">JSON</option>
                    <option value="js">JavaScript</option>
                  </Select>
                </Field>
                <Field label="Description">
                  <Input value={addForm.description} onChange={updateForm("description")} />
                </Field>
              </div>
              {actionError && <ActionFeedback error>{actionError}</ActionFeedback>}
              <div className="ui-record-actions">
                <Button type="submit" loading={adding}>Add</Button>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setShowAdd(false);
                    setActionError("");
                  }}
                >
                  Cancel
                </Button>
              </div>
            </form>
          </CardBody>
        </Card>
      )}

      {!showAdd && actionError && <ActionFeedback error>{actionError}</ActionFeedback>}

      {sources.length === 0 ? (
        <Card>
          <CardBody className="py-10 text-center">
            <CardTitle>No source documents yet</CardTitle>
            <p className="mt-2 text-ui-body text-ink-secondary">
              Add a source document to build the knowledge base.
            </p>
          </CardBody>
        </Card>
      ) : (
        <Card>
          <CardBody className="p-0">
            {/* Spec §5.7: Sources is table-first; layout="records" collapses to
                labelled records under 1100px so phones keep the same rows. */}
            <Table layout="records" aria-label="Source documents">
              <THead>
                <TR>
                  <TH>File</TH>
                  <TH>Description</TH>
                  <TH>Type</TH>
                  <TH>Status</TH>
                  <TH className="text-right">Compile</TH>
                </TR>
              </THead>
              <TBody>
                {sources.map((source) => {
                  const compiling = compilingIds.has(source.id);
                  return (
                    <TR key={source.id}>
                      <TD className="break-words font-medium text-zinc-900">{source.filename}</TD>
                      <TD data-label="Description" className="break-words text-ink-secondary">
                        {source.description || "No description"}
                      </TD>
                      <TD data-label="Type" className="text-ink-secondary">{source.file_type}</TD>
                      <TD data-label="Status">
                        {source.processed ? (
                          <Badge tone="strong">Compiled</Badge>
                        ) : (
                          <Badge>Not compiled</Badge>
                        )}
                      </TD>
                      <TD align="right" data-label="Compile">
                        {source.processed ? (
                          <span className="text-ink-tertiary">—</span>
                        ) : (
                          <Button
                            variant="secondary"
                            loading={compiling}
                            onClick={() => handleCompile(source.id)}
                          >
                            Compile
                          </Button>
                        )}
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </CardBody>
        </Card>
      )}
    </UiSurface>
  );
}
