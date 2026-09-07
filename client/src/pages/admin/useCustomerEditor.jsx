import { useState } from "react";
import { Button } from "../../components/ui";
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

function CustomerEditor({
  editForm,
  setEditForm,
  savingEdit,
  saveEdit,
  stages,
  onCancel,
}) {
  return (
    <div className="bg-white border-hairline border-zinc-900 rounded-sm p-5 mt-1">
      {" "}
      <div className="text-13 font-medium text-ink-primary mb-3">
        Edit customer
      </div>{" "}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
        {[
          { key: "firstName", label: "First name" },
          { key: "lastName", label: "Last name" },
          { key: "email", label: "Email", type: "email" },
          { key: "phone", label: "Phone", type: "tel" },
          { key: "city", label: "City" },
          { key: "monthlyRate", label: "$/Mo", type: "number" },
        ].map((f) => (
          <div key={f.key}>
            {" "}
            <label className="u-label text-ink-tertiary block mb-1">
              {f.label}
            </label>{" "}
            <input
              value={editForm[f.key] || ""}
              onChange={(e) =>
                setEditForm((p) => ({
                  ...p,
                  [f.key]: e.target.value,
                }))
              }
              type={f.type || "text"}
              className="block w-full bg-white text-13 text-ink-primary border-hairline border-zinc-300 rounded-sm h-8 px-2 focus:outline-none focus:border-zinc-900"
            />{" "}
          </div>
        ))}
        <div>
          {" "}
          <label className="u-label text-ink-tertiary block mb-1">
            Tier
          </label>{" "}
          <select
            value={editForm.tier || ""}
            onChange={(e) =>
              setEditForm((p) => ({
                ...p,
                tier: e.target.value || null,
              }))
            }
            className="block w-full bg-white text-13 text-ink-primary border-hairline border-zinc-300 rounded-sm h-8 px-2 cursor-pointer focus:outline-none focus:border-zinc-900"
          >
            {" "}
            <option value="">No Plan</option>{" "}
            <option value="Platinum">Platinum (20%)</option>{" "}
            <option value="Gold">Gold (15%)</option>{" "}
            <option value="Silver">Silver (10%)</option>{" "}
            <option value="Bronze">Bronze (0%)</option>{" "}
            <option value="One-Time">One-Time</option>{" "}
          </select>{" "}
        </div>{" "}
        <div>
          {" "}
          <label className="u-label text-ink-tertiary block mb-1">
            Stage
          </label>{" "}
          <select
            value={editForm.pipelineStage || ""}
            onChange={(e) =>
              setEditForm((p) => ({
                ...p,
                pipelineStage: e.target.value,
              }))
            }
            className="block w-full bg-white text-13 text-ink-primary border-hairline border-zinc-300 rounded-sm h-8 px-2 cursor-pointer focus:outline-none focus:border-zinc-900"
          >
            {stages.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>{" "}
        </div>{" "}
      </div>
      {/* Service contacts — route appointment reminders, post-service
                          SMS, and review requests to different people than the
                          bill-payer (e.g. mother pays, son lives at the property).
                          Up to 3 slots; the server compacts them, so clearing
                          slot 1 promotes slot 2. */}
      {[
        {
          prefix: "serviceContact",
          title: "Service Contact",
          hint: "(optional — overrides primary for reminders, review requests)",
        },
        { prefix: "serviceContact2", title: "Service Contact 2" },
        { prefix: "serviceContact3", title: "Service Contact 3" },
      ].map((slot) => (
        <div
          key={slot.prefix}
          className="border-t border-hairline border-zinc-200 pt-3 mb-3"
        >
          {" "}
          <div className="u-label text-ink-tertiary mb-2">
            {slot.title}{" "}
            {slot.hint && (
              <span className="normal-case text-11 text-ink-tertiary">
                {slot.hint}
              </span>
            )}{" "}
          </div>{" "}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {[
              { key: `${slot.prefix}Name`, label: "Name" },
              {
                key: `${slot.prefix}Phone`,
                label: "Phone",
                type: "tel",
              },
              {
                key: `${slot.prefix}Email`,
                label: "Email",
                type: "email",
              },
            ].map((f) => (
              <div key={f.key}>
                {" "}
                <label className="u-label text-ink-tertiary block mb-1">
                  {f.label}
                </label>{" "}
                <input
                  value={editForm[f.key] || ""}
                  onChange={(e) =>
                    setEditForm((p) => ({
                      ...p,
                      [f.key]: e.target.value,
                    }))
                  }
                  type={f.type || "text"}
                  className="block w-full bg-white text-13 text-ink-primary border-hairline border-zinc-300 rounded-sm h-8 px-2 focus:outline-none focus:border-zinc-900"
                />{" "}
              </div>
            ))}
          </div>{" "}
        </div>
      ))}{" "}
      <div className="flex gap-2">
        {" "}
        <Button variant="primary" onClick={saveEdit} disabled={savingEdit}>
          {savingEdit ? "Saving…" : "Save"}
        </Button>{" "}
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>{" "}
      </div>{" "}
    </div>
  );
}
