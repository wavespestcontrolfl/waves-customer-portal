// @vitest-environment jsdom
// Pre-push Codex P1: an earlier round rerouted the consultation-link lane's
// lead-only send (no resolved customer) to POST /admin/leads/:id/send-sms,
// bypassing THIS route's own interlocks (the Agent Review draft's atomic
// claim, pending-suggestion thread parking, the active auto-send check).
// Reverted: the send stays on /admin/communications/sms, carrying `leadId`
// in the body so the server records the same lead audit trail via a shared
// helper. This file proves attachments and the operator-picked fromNumber
// reach that route alongside leadId, instead of the send being rerouted.
import React from "react";
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SmsTab } from "./CommunicationsPageV2";

// The Insert Link sheet's per-customer rows (consultation included) are
// admin-only (a technician selecting one would only get a 403 from the
// server) — smsIsAdminRole reads this via useOutletContext.
vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, useOutletContext: () => ({ user: { role: "admin" } }) };
});

let responses;
const response = (data) => new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
const requests = (path) => fetch.mock.calls.filter(([url]) => String(url).endsWith(path));
const bodyOf = (path) => JSON.parse(requests(path)[0][1].body);

beforeEach(() => {
  responses = {};
  localStorage.setItem("waves_admin_token", "test-token");
  window.history.replaceState({}, "", "/?phone=9415551234");
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    const value = responses[String(url).replace(/^\/api/, "")];
    return response(typeof value === "function" ? await value() : value || {});
  }));
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL = vi.fn(() => "blob:qa-preview");
    static revokeObjectURL = vi.fn();
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); window.history.replaceState({}, "", "/"); });

it("keeps the lead-only consultation send on /admin/communications/sms, carrying leadId, fromNumber, mediaUrls and mediaAttachments — never rerouted", async () => {
  const attachment = { url: "https://example.invalid/qa.png", key: "qa/image", fileName: "qa.png", size: 4, mimeType: "image/png", attachmentToken: "synthetic-signed-token" };
  responses["/admin/communications/customer-link"] = {
    kind: "consultation",
    url: "https://waves.link/l/abc123",
    line: "Hi Jamie, it's Waves. Pick a time for us to stop by for a free consultation: https://waves.link/l/abc123\n\nOr reply here and we'll set it up.\n\nReply STOP to opt out.\n\n",
    standalone: true,
    firstName: "Jamie",
    leadId: "lead-99",
  };
  responses["/admin/communications/attach"] = { attachments: [attachment] };
  responses["/admin/communications/sms"] = { sent: true, providerMessageId: "SMbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" };

  const onSent = vi.fn();
  const { container } = render(<SmsTab active onSent={onSent} />, { wrapper: MemoryRouter });

  // Open Quick Links and pick the consultation row — the lead-only fallback
  // (no customerId resolved for this phone) hands back a leadId.
  fireEvent.click(await screen.findByRole("button", { name: "Quick Links" }));
  fireEvent.click(await screen.findByRole("button", { name: /Free consultation/i }));
  await waitFor(() => expect(requests("/admin/communications/customer-link")).toHaveLength(1));
  expect(bodyOf("/admin/communications/customer-link")).toMatchObject({ phone: "9415551234", kind: "consultation" });
  await screen.findByRole("textbox", { name: "Text message" });
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Text message" }).value).toContain("Pick a time"));

  // Attach an image, same flow the generic-route test uses.
  fireEvent.change(container.querySelector('input[type="file"]'), { target: { files: [new File(["test"], "qa.png", { type: "image/png" })] } });
  await screen.findByRole("button", { name: "Remove qa.png" });

  // Pick a sending line — the operator's choice, not the default.
  fireEvent.change(screen.getByRole("combobox", { name: "Send from" }), { target: { value: "+19412975749" } });

  fireEvent.click(screen.getByRole("button", { name: "Send" }));

  await waitFor(() => expect(requests("/admin/communications/sms")).toHaveLength(1));
  const sentBody = bodyOf("/admin/communications/sms");
  expect(sentBody).toMatchObject({
    to: "9415551234",
    leadId: "lead-99",
    fromNumber: "+19412975749",
    mediaUrls: [attachment.url],
    mediaAttachments: [attachment],
  });
  expect(sentBody.customerId).toBeUndefined();
  expect(sentBody.body).toContain("Pick a time");
  // Never rerouted to the leads route — the whole point of the fix.
  expect(requests("/admin/leads/lead-99/send-sms")).toHaveLength(0);
  // No `customer` prop here (this is the standalone Communications inbox,
  // not a Customer 360 panel), so a successful send reloads the inbox list
  // rather than calling onSent — the provider-accepted toast is what
  // confirms the send itself went through and was accepted.
  await screen.findByText(/Provider accepted/);
  expect(onSent).not.toHaveBeenCalled();
});
