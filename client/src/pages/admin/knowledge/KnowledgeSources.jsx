import { useEffect, useRef, useState } from "react";
import {
  ActionFeedback, Badge, Button, Card, CardBody, CardHeader, CardTitle,
  Field, Input, Select, UiSurface,
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
        <div className="grid gap-3 lg:grid-cols-2">
          {sources.map((source) => {
            const compiling = compilingIds.has(source.id);
            return (
              <Card key={source.id} className="min-w-0">
                <CardBody className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <CardTitle className="break-words">{source.filename}</CardTitle>
                    <p className="mt-1 break-words text-ui-caption text-ink-secondary">
                      {source.description || "No description"} • {source.file_type}
                    </p>
                  </div>
                  {source.processed ? (
                    <Badge>Compiled</Badge>
                  ) : (
                    <Button
                      variant="secondary"
                      loading={compiling}
                      onClick={() => handleCompile(source.id)}
                    >
                      Compile
                    </Button>
                  )}
                </CardBody>
              </Card>
            );
          })}
        </div>
      )}
    </UiSurface>
  );
}
