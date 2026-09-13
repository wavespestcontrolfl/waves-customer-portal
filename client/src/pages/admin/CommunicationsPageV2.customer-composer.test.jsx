// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SmsTab } from "./CommunicationsPageV2";

const speech = vi.hoisted(() => ({ callback: null, toggle: vi.fn() }));
vi.mock("../../hooks/useSpeechDictation", () => ({ default: (callback) => {
  speech.callback = callback;
  return { listening: false, supported: true, toggle: speech.toggle };
} }));
vi.mock("../../utils/imageCompression", async (original) => ({
  ...await original(),
  fitImagesToBudget: async (files) => ({ ok: true, files }),
}));

const customer = { id: "customer-a", phone: "+19415550100" };
const line = "+19415550199";
const customerMessages = [
  { channel: "sms", contactPhone: customer.phone, ourEndpointId: line, ourEndpointLabel: "Test line", direction: "inbound", body: "Please close the side gate.", createdAt: "2024-07-02T12:00:00Z" },
  { channel: "sms", contactPhone: customer.phone, ourEndpointId: "+19415550198", direction: "inbound", body: "Other line", createdAt: "2024-07-01T12:00:00Z" },
  { channel: "sms", contactPhone: "+19415550101", ourEndpointId: line, direction: "inbound", body: "Other contact", createdAt: "2024-07-01T12:00:00Z" },
];
let responses;
const response = (data) => new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
const requests = (path) => fetch.mock.calls.filter(([url]) => String(url).endsWith(path));
const bodyOf = (path) => JSON.parse(requests(path)[0][1].body);
function setup() {
  const onSent = vi.fn();
  const view = render(<SmsTab active customer={customer} customerMessages={customerMessages} onSent={onSent} />, { wrapper: MemoryRouter });
  return { ...view, onSent, field: screen.getByRole("textbox", { name: "Text message" }) };
}
beforeEach(() => {
  responses = {};
  localStorage.setItem("waves_admin_token", "test-token");
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

it("keeps the profile recipient and thread line, sends once, and clears only on provider acceptance", async () => {
  window.history.replaceState({}, "", "/?phone=9415550197&draftId=unrelated");
  let accept;
  responses["/admin/communications/sms"] = () => new Promise((resolve) => { accept = resolve; });
  const { field, onSent } = setup();
  expect(screen.queryByPlaceholderText("Search by name or enter phone number…")).not.toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "Send from" })).toHaveValue(line);
  expect(screen.getByRole("combobox", { name: "Send from" })).toBeDisabled();
  fireEvent.change(field, { target: { value: "Hello" } });
  const send = screen.getByRole("button", { name: "Send" });
  fireEvent.click(send); fireEvent.click(send);
  expect(requests("/admin/communications/sms")).toHaveLength(1);
  expect(bodyOf("/admin/communications/sms")).toMatchObject({ to: customer.phone, customerId: customer.id, fromNumber: line, body: "Hello" });
  expect(field).toHaveValue("Hello");
  await act(async () => { accept({ sent: true, providerMessageId: "SMaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }); });
  expect(field).toHaveValue("");
  expect(onSent).toHaveBeenCalledOnce();
  expect(requests("/admin/drafts/unrelated")).toHaveLength(0);
  expect(requests("/admin/communications/stats")).toHaveLength(0);
});

it("retains a suppressed message and does not report it as sent", async () => {
  responses["/admin/communications/sms"] = { sent: true, providerMessageId: "GATE_BLOCKED", reason: "Sending disabled" };
  const { field, onSent } = setup();
  fireEvent.change(field, { target: { value: "Keep this draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(await screen.findByText("Failed: Sending disabled")).toBeInTheDocument();
  expect(field).toHaveValue("Keep this draft");
  expect(onSent).not.toHaveBeenCalled();
});

it("uses this conversation for AI draft and preserves edits made while the draft is pending", async () => {
  let resolveDraft;
  responses["/admin/communications/ai-draft"] = () => new Promise((resolve) => { resolveDraft = resolve; });
  const { field } = setup();
  fireEvent.click(screen.getByRole("button", { name: "AI Draft" }));
  expect(bodyOf("/admin/communications/ai-draft")).toEqual({ customerPhone: customer.phone, lastMessage: "Please close the side gate." });
  fireEvent.change(field, { target: { value: "Staff edit" } });
  await act(async () => { resolveDraft({ draft: "Generated answer" }); });
  expect(field).toHaveValue("Staff edit");
  responses["/admin/communications/ai-draft"] = { draft: "We will close the gate." };
  fireEvent.click(screen.getByRole("button", { name: "AI Draft" }));
  await waitFor(() => expect(field).toHaveValue("We will close the gate."));
});

it("rewrites against only the selected phone and business line and accepts dictated text", async () => {
  responses["/admin/communications/rewrite-sms"] = { body: "We will close the gate after service." };
  const { field } = setup();
  act(() => speech.callback("close gate"));
  expect(field).toHaveValue("close gate");
  fireEvent.click(screen.getByRole("button", { name: "Start voice dictation" }));
  expect(speech.toggle).toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Rewrite message in Waves tone" }));
  expect(bodyOf("/admin/communications/rewrite-sms")).toMatchObject({ customerId: customer.id, customerPhone: customer.phone, lastInboundMessage: "Please close the side gate.", recentMessages: [{ direction: "inbound", body: "Please close the side gate.", createdAt: "2024-07-02T12:00:00Z" }] });
  await waitFor(() => expect(field).toHaveValue("We will close the gate after service."));
});

it("uploads signed attachment metadata, blocks scheduling MMS, and supports an immediate MMS", async () => {
  const attachment = { url: "https://example.invalid/qa.png", key: "qa/image", fileName: "qa.png", size: 4, mimeType: "image/png", attachmentToken: "synthetic-signed-token" };
  responses["/admin/communications/attach"] = { attachments: [attachment] };
  responses["/admin/communications/sms"] = { sent: true, providerMessageId: "MMbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" };
  const { container, onSent } = setup();
  fireEvent.change(container.querySelector('input[type="file"]'), { target: { files: [new File(["test"], "qa.png", { type: "image/png" })] } });
  await screen.findByRole("button", { name: "Remove qa.png" });
  fireEvent.change(screen.getByRole("combobox", { name: "Send timing" }), { target: { value: "tomorrow_8" } });
  fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
  expect(await screen.findByText(/Attachments aren't supported on scheduled sends/)).toBeInTheDocument();
  expect(requests("/admin/communications/schedule-sms")).toHaveLength(0);
  expect(screen.getByRole("button", { name: "Remove qa.png" })).toBeInTheDocument();
  fireEvent.change(screen.getByRole("combobox", { name: "Send timing" }), { target: { value: "now" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(bodyOf("/admin/communications/sms")).toMatchObject({ mediaUrls: [attachment.url], mediaAttachments: [attachment] });
  await waitFor(() => expect(onSent).toHaveBeenCalledOnce());
  expect(screen.queryByRole("button", { name: "Remove qa.png" })).not.toBeInTheDocument();
});

it("schedules text for 8 AM Eastern tomorrow through the existing scheduler", async () => {
  responses["/admin/communications/schedule-sms"] = { success: true, id: "scheduled-qa" };
  const { field, onSent } = setup();
  fireEvent.change(field, { target: { value: "Scheduled note" } });
  fireEvent.change(screen.getByRole("combobox", { name: "Send timing" }), { target: { value: "tomorrow_8" } });
  fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
  const payload = bodyOf("/admin/communications/schedule-sms");
  expect(payload).toMatchObject({ to: customer.phone, customerId: customer.id, fromNumber: line, body: "Scheduled note" });
  expect(payload.scheduledFor).toMatch(/^\d{4}-\d{2}-\d{2}T08:00$/);
  expect(payload.scheduledFor.slice(0, 10) > new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" })).toBe(true);
  await waitFor(() => expect(onSent).toHaveBeenCalledOnce());
  expect(requests("/admin/communications/sms")).toHaveLength(0);
});

it("reads older customer conversations through the loaded snapshot even when the displayed messages are already read", async () => {
  const readScope = { conversationIds: ["recent-conversation", "older-conversation"], readBefore: "2024-07-02T12:01:00Z" };
  const messages = [{ id: "recent-message", conversationId: "recent-conversation", channel: "sms", direction: "inbound", isRead: true, createdAt: "2024-07-02T12:00:00Z" }];
  const view = render(<SmsTab active={false} customer={customer} customerMessages={messages} customerReadScope={readScope} />, { wrapper: MemoryRouter });
  expect(requests("/admin/communications/messages/read")).toHaveLength(0);
  view.rerender(<SmsTab active customer={customer} customerMessages={messages} customerReadScope={readScope} />);
  await waitFor(() => expect(requests("/admin/communications/messages/read")).toHaveLength(1));
  expect(bodyOf("/admin/communications/messages/read")).toEqual({ messageIds: [], conversationIds: readScope.conversationIds, readBefore: readScope.readBefore });
});

// codex #4213 P2: smsThreadKey keeps the full identity of an international
// number, so the customer-mode history filter must use the same key or an
// international customer's rewrite loses every recent message.
it("keeps an international customer's history in the rewrite request", async () => {
  responses["/admin/communications/rewrite-sms"] = { body: "Tuesday works for us." };
  const intl = { id: "customer-uk", phone: "+442079460958" };
  const intlMessages = [
    { channel: "sms", contactPhone: intl.phone, ourEndpointId: line, ourEndpointLabel: "Test line", direction: "inbound", body: "Can you come Tuesday?", createdAt: "2024-07-02T12:00:00Z" },
    { channel: "sms", contactPhone: "+12079460958", ourEndpointId: line, direction: "inbound", body: "US lookalike", createdAt: "2024-07-01T12:00:00Z" },
  ];
  render(<SmsTab active customer={intl} customerMessages={intlMessages} onSent={vi.fn()} />, { wrapper: MemoryRouter });
  const field = screen.getByRole("textbox", { name: "Text message" });
  fireEvent.change(field, { target: { value: "tuesday works" } });
  fireEvent.click(screen.getByRole("button", { name: "Rewrite message in Waves tone" }));
  expect(bodyOf("/admin/communications/rewrite-sms")).toMatchObject({ customerId: intl.id, customerPhone: intl.phone, lastInboundMessage: "Can you come Tuesday?", recentMessages: [{ direction: "inbound", body: "Can you come Tuesday?" }] });
  await waitFor(() => expect(field).toHaveValue("Tuesday works for us."));
});
