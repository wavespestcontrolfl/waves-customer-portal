// @vitest-environment jsdom
//
// PR #4673 (ADMIN-BUG-R39): the staff-wide notification events tab is
// technician-readable, but every write behind it is requireAdmin (admin-sms-templates'
// PUT/POST/DELETE). A technician (isAdminRole=false) gets read-only SMS cards:
// switches disabled, fields disabled, no Save / Delete. An admin keeps every control.
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
      status: "sms_only",
      channels_expected: ["sms"],
      sms_templates: [
        { id: "sms-1", template_key: "visit_reminder_sms", name: "Reminder text", body: "See you tomorrow", is_active: true },
      ],
    },
  ],
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => EVENTS })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("technician: SMS cards are read-only — no Save, switches and fields disabled", async () => {
  render(<NotificationEventsTabV2 isAdminRole={false} />);
  await screen.findByText("Reminder text");
  expect(screen.queryByRole("button", { name: /Save/ })).not.toBeInTheDocument();
  expect(screen.getByLabelText("Disable Reminder text")).toBeDisabled();
  expect(screen.getByDisplayValue("See you tomorrow")).toBeDisabled();
});

it("control: an admin keeps Save and enabled switches and fields on the SMS card", async () => {
  render(<NotificationEventsTabV2 isAdminRole />);
  await screen.findByText("Reminder text");
  expect(screen.getAllByRole("button", { name: /Save/ })).toHaveLength(1);
  expect(screen.getByLabelText("Disable Reminder text")).not.toBeDisabled();
  expect(screen.getByDisplayValue("See you tomorrow")).not.toBeDisabled();
});
