import { useState } from "react";
import { Input, Select, Button, Field } from "../../components/ui";
import { adminFetch } from "../../utils/admin-fetch";

function customerEditValues(c) {
  return {
    firstName: c.firstName,
    lastName: c.lastName,
    email: c.email || "",
    phone: c.phone || "",
    city: c.city || "",
    // Preserve the customer's real tier (null for leads / one-time / No
    // Plan). Defaulting to "Bronze" made an unrelated edit (e.g. fixing a
    // name) PUT waveguard_tier='Bronze', which the server read as a new
    // membership — writing a phantom plan AND emailing the customer a
    // "membership started" notice. The select's "No Plan" option is value "".
    tier: c.tier || null,
    monthlyRate: c.monthlyRate || "",
    pipelineStage: c.pipelineStage || "new_lead",
    serviceContactName: c.serviceContactName || "",
    serviceContactPhone: c.serviceContactPhone || "",
    serviceContactEmail: c.serviceContactEmail || "",
    serviceContact2Name: c.serviceContact2Name || "",
    serviceContact2Phone: c.serviceContact2Phone || "",
    serviceContact2Email: c.serviceContact2Email || "",
    serviceContact3Name: c.serviceContact3Name || "",
    serviceContact3Phone: c.serviceContact3Phone || "",
    serviceContact3Email: c.serviceContact3Email || "",
  };
}

// The page owns this controller's lifetime; both directory presentations use
// the same draft, even while the customer workspace temporarily hides the list.
export default function useCustomerEditor(onSaved, stages) {
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [savingEdit, setSavingEdit] = useState(false);
  const startEdit = (c) => {
    setEditingId(c.id);
    setEditForm(customerEditValues(c));
  };

  const saveEdit = async () => {
    setSavingEdit(true);
    try {
      await adminFetch(`/admin/customers/${editingId}`, {
        method: "PUT",
        body: JSON.stringify(editForm),
      });
      setEditingId(null);
      onSaved();
    } catch (e) {
      window.alert("Save failed: " + e.message);
    }
    setSavingEdit(false);
  };

  return {
    editingId,
    startEdit,
    editor: (
      <CustomerEditor
        editForm={editForm}
        setEditForm={setEditForm}
        savingEdit={savingEdit}
        saveEdit={saveEdit}
        stages={stages}
        onCancel={() => setEditingId(null)}
      />
    ),
  };
}

function CustomerEditor({ editForm, setEditForm, savingEdit, saveEdit, stages, onCancel }) {
  return <section aria-label="Edit customer" className="bg-white border-hairline border-zinc-900 rounded-sm p-5 mt-1">
    <h2 className="text-16 font-medium text-ink-primary mb-3">Edit customer</h2>
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
      {[
        { key: "firstName", label: "First name" },
        { key: "lastName", label: "Last name" },
        { key: "email", label: "Email", type: "email" },
        { key: "phone", label: "Phone", type: "tel" },
        { key: "city", label: "City" },
        { key: "monthlyRate", label: "$/Mo", type: "number" },
      ].map((field) => <Field key={field.key} label={field.label}>
        <Input value={editForm[field.key] || ""} type={field.type || "text"} onChange={(event) => setEditForm((previous) => ({ ...previous, [field.key]: event.target.value }))} />
      </Field>)}
      <Field label="Tier">
        <Select value={editForm.tier || ""} onChange={(event) => setEditForm((previous) => ({ ...previous, tier: event.target.value || null }))}>
          <option value="">No Plan</option><option value="Platinum">Platinum (20%)</option><option value="Gold">Gold (15%)</option><option value="Silver">Silver (10%)</option><option value="Bronze">Bronze (0%)</option><option value="One-Time">One-Time</option>
        </Select>
      </Field>
      <Field label="Stage">
        <Select value={editForm.pipelineStage || ""} onChange={(event) => setEditForm((previous) => ({ ...previous, pipelineStage: event.target.value }))}>
          {stages.map((stage) => <option key={stage.key} value={stage.key}>{stage.label}</option>)}
        </Select>
      </Field>
    </div>
    {/* The existing recipient slots and server-side compaction remain authoritative. */}
    {[
      { prefix: "serviceContact", title: "Service contact", hint: "Optional — overrides primary for reminders, review requests" },
      { prefix: "serviceContact2", title: "Service contact 2" },
      { prefix: "serviceContact3", title: "Service contact 3" },
    ].map((slot) => <fieldset key={slot.prefix} className="border-0 border-t border-solid border-zinc-200 p-0 pt-3 mb-3 min-w-0">
      <legend className="ui-label text-ink-secondary">{slot.title}</legend>
      {slot.hint && <p className="text-ui-caption text-ink-secondary mb-2">{slot.hint}</p>}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        {[{ suffix: "Name", label: "Name" }, { suffix: "Phone", label: "Phone", type: "tel" }, { suffix: "Email", label: "Email", type: "email" }].map((field) => {
          const key = `${slot.prefix}${field.suffix}`;
          return <Field key={key} label={field.label}>
            <Input value={editForm[key] || ""} type={field.type || "text"} onChange={(event) => setEditForm((previous) => ({ ...previous, [key]: event.target.value }))} />
          </Field>;
        })}
      </div>
    </fieldset>)}
    <div className="ui-record-actions">
      <Button onClick={saveEdit} loading={savingEdit}>Save</Button>
      <Button variant="ghost" onClick={onCancel}>Cancel</Button>
    </div>
  </section>;
}
