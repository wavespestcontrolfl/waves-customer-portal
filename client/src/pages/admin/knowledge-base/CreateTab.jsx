import { useRef, useState } from "react";
import {
  ActionFeedback,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Select,
  Textarea,
} from "../../../components/ui";
import { adminFetch } from "../../../utils/admin-fetch";
import { CATEGORIES } from "./config";

export default function CreateTab({ showFeedback, onCreated, isMobile }) {
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("general");
  const [content, setContent] = useState("");
  const [tags, setTags] = useState("");
  const [confidence, setConfidence] = useState("medium");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const savingRef = useRef(false);

  const handleSave = async () => {
    if (savingRef.current) return;
    if (!title.trim()) {
      setError("Title is required.");
      showFeedback("Title required", true);
      return;
    }

    savingRef.current = true;
    setSaving(true);
    setError("");
    try {
      await adminFetch("/admin/kb", {
        method: "POST",
        body: JSON.stringify({
          title,
          category,
          content,
          tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean),
          confidence,
          source: "manual",
        }),
      });
      showFeedback("Entry created");
      onCreated();
    } catch (requestError) {
      const message = requestError.message || "The entry could not be created.";
      setError(message);
      showFeedback(`Error: ${message}`, true);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <div className="max-w-[720px]">
      <Card>
        <CardHeader>
          <CardTitle className="text-18">New knowledge base entry</CardTitle>
        </CardHeader>
        <CardBody>
          <fieldset disabled={saving} className="m-0 min-w-0 space-y-4 border-0 p-0">
            <Field label="Title" required error={!title.trim() && error === "Title is required." ? error : undefined}>
              <Input
                value={title}
                onChange={(event) => {
                  setTitle(event.target.value);
                  if (error === "Title is required.") setError("");
                }}
                placeholder="e.g. Rodent Exclusion Warranty Protocol"
              />
            </Field>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Category">
                <Select value={category} onChange={(event) => setCategory(event.target.value)}>
                  {CATEGORIES.map((item) => (
                    <option key={item} value={item}>{item}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Confidence">
                <Select value={confidence} onChange={(event) => setConfidence(event.target.value)}>
                  <option value="high">High — verified, authoritative</option>
                  <option value="medium">Medium — believed accurate</option>
                  <option value="low">Low — needs verification</option>
                  <option value="unverified">Unverified — just captured</option>
                </Select>
              </Field>
            </div>

            <Field label="Tags (comma-separated)">
              <Input
                value={tags}
                onChange={(event) => setTags(event.target.value)}
                placeholder="e.g. rodent, exclusion, warranty, renewal"
              />
            </Field>

            <Field label="Content (Markdown)">
              <Textarea
                value={content}
                onChange={(event) => setContent(event.target.value)}
                rows={isMobile ? 12 : 16}
                placeholder={"# Entry Title\n\nWrite your knowledge base entry in markdown…"}
              />
            </Field>
          </fieldset>

          {error && error !== "Title is required." && (
            <ActionFeedback error className="mt-4">{error}</ActionFeedback>
          )}

          <Button className="mt-5 w-full" loading={saving} onClick={handleSave}>
            Create entry
          </Button>
        </CardBody>
      </Card>
    </div>
  );
}
