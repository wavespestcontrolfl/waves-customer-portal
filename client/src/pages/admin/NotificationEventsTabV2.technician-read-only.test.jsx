// @vitest-environment jsdom
//
// PR #4673 (ADMIN-BUG-R39 + codex round-4 P2): the staff-wide Automations
// tab is technician-readable, but every write behind it is requireAdmin —
// admin-sms-templates' PUT/POST/DELETE and the whole admin-email-templates
// router (status toggle, draft save, the Email Templates tab its links
// open). A technician (isAdminRole=false) gets read-only SMS *and* email
// cards: switches disabled, fields disabled, no Save / Delete / Email
// Templates links. An admin keeps every control.
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import NotificationEventsTabV2 from "./NotificationEventsTabV2";

const EVENTS = {
  catalog: [],
  events: [
    {
      event_key: "visit_reminder",
      name: "Visit reminder",
      status: "paired",
      channels_expected: ["sms", "email"],
      sms_templates: [
        { id: "sms-1", template_key: "visit_reminder_sms", name: "Reminder text", body: "See you tomorrow", is_active: true },
      ],
      email_automations: [
        {
          automation_key: "visit_reminder_email",
          template_key: "visit_reminder_tpl",
          template_name: "Reminder email",
          status: "active",
          active_version_id: "v1",
          active_version_number: 1,
          version_status: "draft",
          subject: "Your visit is tomorrow",
          preview_text: "Quick heads-up",
          delay_minutes: 0,
        },
      ],
    },
    {
      event_key: "__email_only__",
      name: "Email only",
      channels_expected: ["email"],
      sms_templates: [],
      email_automations: [],
    },
  ],
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => EVENTS })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("technician: SMS and email cards are read-only — no Save, no Email Templates links, switches and fields disabled", async () => {
  render(<NotificationEventsTabV2 isAdminRole={false} />);
  await screen.findByText("Reminder email");
  expect(screen.queryByRole("button", { name: /Save/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Open in Email Templates/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Edit blocks \/ versions/ })).not.toBeInTheDocument();
  expect(screen.queryByText(/Create a draft in Email Templates/)).not.toBeInTheDocument();
  expect(screen.getByLabelText("Pause visit_reminder_email")).toBeDisabled();
  expect(screen.getByLabelText("Disable Reminder text")).toBeDisabled();
  expect(screen.getByDisplayValue("Your visit is tomorrow")).toBeDisabled();
  expect(screen.getByDisplayValue("Quick heads-up")).toBeDisabled();
  expect(screen.getByDisplayValue("See you tomorrow")).toBeDisabled();
});

it("control: an admin keeps Save, the Email Templates links, and enabled switches and fields on both cards", async () => {
  render(<NotificationEventsTabV2 isAdminRole />);
  await screen.findByText("Reminder email");
  expect(screen.getAllByRole("button", { name: /Save/ })).toHaveLength(2);
  expect(screen.getByRole("button", { name: /Open in Email Templates/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Edit blocks \/ versions/ })).toBeInTheDocument();
  expect(screen.getByLabelText("Pause visit_reminder_email")).not.toBeDisabled();
  expect(screen.getByLabelText("Disable Reminder text")).not.toBeDisabled();
  expect(screen.getByDisplayValue("Your visit is tomorrow")).not.toBeDisabled();
  expect(screen.getByDisplayValue("See you tomorrow")).not.toBeDisabled();
});
