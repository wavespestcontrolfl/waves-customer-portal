// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SmsTab } from "./CommunicationsPageV2";
import { SMS_DRAFT_STORAGE_KEY } from "../../hooks/useSmsDraft";

vi.mock("../../utils/imageCompression", async (original) => ({ ...await original(), fitImagesToBudget: async (files) => ({ ok: true, files }) }));

const line = "+19413187612";
const inbound = (id, body, phone = "+19415550100") => ({
  id, from: phone, to: line, direction: "inbound", body, isRead: true,
  createdAt: "2024-07-01T12:00:00Z",
});
let messages, failLog, hasMore, loadLog;
const attachment = { url: "https://example.invalid/gate.png", key: "fixture/gate", fileName: "gate.png", size: 4, mimeType: "image/png", attachmentToken: "fixture-token" };
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const tick = async (ms = 350) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const logRequests = () => fetch.mock.calls.filter(([url]) => String(url).includes("/communications/log?"));
const setup = () => render(<SmsTab active />, { wrapper: MemoryRouter });
const setupWithOwner = (id, props = {}) => render(<MemoryRouter><Routes><Route element={<Outlet context={{ user: { id, role: "admin" } }} />}><Route path="*" element={<SmsTab active {...props} />} /></Route></Routes></MemoryRouter>);
const savedApproval = {
  msgBody: "Edited approval reply", fromNumber: "+19415550199", selectedCustomerId: "customer-a",
  threadLock: { contactPhone: "+19415550100", ourNumber: "+19415550199", label: "Fixture office" },
  loadedMessageDraft: { id: "approval-a", draftResponse: "Original reply", recipientPhone: "+19415550100", fromNumber: "+19415550199" },
};
const saveDraft = (owner, draft) => sessionStorage.setItem(SMS_DRAFT_STORAGE_KEY, JSON.stringify({ owners: { [owner]: { "9415550100": draft } } }));

beforeEach(() => {
  vi.useFakeTimers();
  Element.prototype.scrollIntoView = vi.fn();
  localStorage.setItem("waves_admin_token", "synthetic-token");
  sessionStorage.clear();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL = () => "blob:fixture-preview";
    static revokeObjectURL = vi.fn();
  });
  messages = [inbound("a", "Please check the gate")];
  failLog = false; hasMore = false; loadLog = null;
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    const parsed = new URL(String(url), "http://localhost");
    if (parsed.pathname.endsWith("/log")) {
      if (loadLog) return loadLog(parsed);
      return failLog ? response({ error: "Unavailable" }, 503) : response({ messages, hasMore, page: Number(parsed.searchParams.get("page")) });
    }
    if (parsed.pathname.endsWith("/blocked-numbers")) return response({ numbers: [] });
    if (parsed.pathname.endsWith("/attach")) return response({ attachments: [attachment] });
    if (parsed.pathname.endsWith("/sms")) return response({ sent: true, providerMessageId: "SMaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
    if (parsed.pathname.endsWith("/drafts/approval-a")) return response({ id: "approval-a", draftResponse: "Original reply", recipientPhone: "+19415550100", customerPhone: "+19415550100", customerId: "customer-a", resolvedFromNumber: "+19415550199" });
    return response({});
  }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); window.history.replaceState({}, "", "/"); });

it("shows a recoverable load error instead of an empty inbox", async () => {
  failLog = true;
  setup(); await tick();
  expect(screen.getByRole("alert")).toHaveTextContent("Messages could not be refreshed");
  expect(screen.queryByText("No conversations found.")).not.toBeInTheDocument();
  failLog = false;
  fireEvent.click(screen.getByRole("button", { name: "Try again" })); await tick();
  expect(screen.getByText("Please check the gate")).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("retains messages on a failed refresh and recovers with new messages", async () => {
  setup(); await tick();
  failLog = true; await tick(30000);
  expect(screen.getByText("Please check the gate")).toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("last successful load");
  failLog = false; messages = [...messages, inbound("b", "Another request", "+19415550101")];
  await tick(30000);
  expect(screen.getByText("Another request")).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("pauses polling while hidden or on another channel and refreshes on return", async () => {
  const view = setup(); await tick();
  const initialCalls = logRequests().length;
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  await tick(60000);
  expect(logRequests()).toHaveLength(initialCalls);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  fireEvent(document, new Event("visibilitychange")); await tick();
  expect(logRequests()).toHaveLength(initialCalls + 1);
  view.rerender(<SmsTab active={false} />); await tick(60000);
  expect(logRequests()).toHaveLength(initialCalls + 1);
  view.rerender(<SmsTab active />); await tick();
  expect(logRequests()).toHaveLength(initialCalls + 2);
});

it("keeps refreshed arrivals first in the log and uses the latest inbound for AI Draft", async () => {
  setup(); await tick();
  fireEvent.click(screen.getByText("Please check the gate"));
  fireEvent.click(screen.getByRole("button", { name: "Text back" }));
  messages = [{ ...inbound("new", "The gate is now open"), createdAt: "2024-07-01T12:02:00Z" }, ...messages];
  await tick(30000);
  fireEvent.click(screen.getByRole("button", { name: "Log View" }));
  const latest = screen.getByText("The gate is now open");
  const older = screen.getByText("Please check the gate");
  expect(latest.compareDocumentPosition(older) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "AI Draft", exact: true })); await tick();
  const request = fetch.mock.calls.find(([url]) => String(url).endsWith("/communications/ai-draft"));
  expect(JSON.parse(request[1].body)).toMatchObject({ lastMessage: "The gate is now open" });
});

it("updates the open conversation when a delivery receipt changes without a new message", async () => {
  messages.push({ id: "reply", direction: "outbound", from: line, to: "+19415550100", body: "We will check", status: "sent", messageType: "manual", createdAt: "2024-07-01T12:01:00Z" });
  setup(); await tick();
  fireEvent.click(screen.getByText("We will check")); await tick();
  expect(screen.getByText("Sent to carrier")).toBeInTheDocument();
  messages = messages.map((message) => message.id === "reply" ? { ...message, status: "undelivered" } : message);
  await tick(30000);
  expect(screen.getByText("Undelivered")).toBeInTheDocument();
});

it("does not replace a newer search with a delayed previous result", async () => {
  setup(); await tick();
  let resolveOld;
  loadLog = (url) => url.searchParams.get("search") === "old"
    ? new Promise((resolve) => { resolveOld = resolve; })
    : response({ messages: [inbound("new", "Current search result")], page: 1 });
  const search = screen.getByPlaceholderText("Search all SMS by name, phone, or message text…");
  fireEvent.change(search, { target: { value: "old" } }); await tick();
  fireEvent.change(search, { target: { value: "new" } }); await tick();
  await act(async () => resolveOld(response({ messages: [inbound("old", "Stale result")], page: 1 })));
  expect(screen.getByText("Current search result")).toBeInTheDocument();
  expect(screen.queryByText("Stale result")).not.toBeInTheDocument();
});

it("keeps loaded older history and its pagination position during polling", async () => {
  loadLog = (url) => response({ messages: [inbound(url.searchParams.get("page"), `Page ${url.searchParams.get("page")}`, `+1941555010${url.searchParams.get("page")}`)], hasMore: true, page: Number(url.searchParams.get("page")) });
  setup(); await tick();
  fireEvent.click(screen.getByRole("button", { name: /Load older/ })); await tick();
  expect(screen.getByText("Page 2")).toBeInTheDocument();
  await tick(30000);
  expect(screen.getByText("Page 2")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /Load older/ })); await tick();
  expect(screen.getByText("Page 3")).toBeInTheDocument();
});

it("restores each conversation's own text and attachments when switching customers", async () => {
  messages.push(inbound("b", "Please check the lawn", "+19415550101"));
  const { container } = setup(); await tick();
  fireEvent.click(screen.getByText("Please check the gate"));
  fireEvent.click(screen.getByRole("button", { name: "Text back" }));
  const field = screen.getByRole("textbox", { name: "Text message" });
  fireEvent.change(field, { target: { value: "Gate reply" } });
  fireEvent.click(screen.getByRole("button", { name: "Override" }));
  const sender = screen.getByRole("combobox", { name: "Send from" });
  const chosenLine = [...sender.options].find((option) => option.value && option.value !== line).value;
  fireEvent.change(sender, { target: { value: chosenLine } });
  fireEvent.change(container.querySelector('input[type="file"]'), { target: { files: [new File(["test"], "gate.png", { type: "image/png" })] } });
  await tick();
  expect(screen.getByRole("button", { name: "Remove gate.png" })).toBeInTheDocument();
  fireEvent.click(screen.getByText("Please check the lawn"));
  fireEvent.click(screen.getByRole("button", { name: "Text back" }));
  expect(field).toHaveValue("");
  expect(screen.queryByRole("button", { name: "Remove gate.png" })).not.toBeInTheDocument();
  fireEvent.change(field, { target: { value: "Lawn reply" } });
  fireEvent.click(screen.getByText("Please check the gate"));
  fireEvent.click(screen.getByRole("button", { name: "Text back" }));
  expect(field).toHaveValue("Gate reply");
  expect(sender).toHaveValue(chosenLine);
  expect(screen.getByRole("button", { name: "Remove gate.png" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Send", exact: true })); await tick();
  const request = fetch.mock.calls.find(([url]) => String(url).endsWith("/communications/sms"));
  expect(JSON.parse(request[1].body)).toMatchObject({ to: "+19415550100", body: "Gate reply", replyToMessageId: "a", mediaUrls: [attachment.url] });
  fireEvent.click(screen.getByText("Please check the gate"));
  fireEvent.click(screen.getByRole("button", { name: "Text back" }));
  expect(field).toHaveValue("");
  fireEvent.click(screen.getByText("Please check the lawn"));
  fireEvent.click(screen.getByRole("button", { name: "Text back" }));
  expect(field).toHaveValue("Lawn reply");
});

it("does not carry a reply target into a manually changed recipient", async () => {
  setup(); await tick();
  fireEvent.click(screen.getByText("Please check the gate"));
  fireEvent.click(screen.getByRole("button", { name: "Text back" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Text message" }), { target: { value: "Gate reply" } });
  fireEvent.change(screen.getByPlaceholderText("Search by name or enter phone number…"), { target: { value: "+19415550102" } });
  expect(screen.getByRole("textbox", { name: "Text message" })).toHaveValue("");
  fireEvent.change(screen.getByRole("textbox", { name: "Text message" }), { target: { value: "New recipient reply" } });
  fireEvent.click(screen.getByRole("button", { name: "Send", exact: true })); await tick();
  const request = fetch.mock.calls.find(([url]) => String(url).endsWith("/communications/sms"));
  expect(JSON.parse(request[1].body)).toMatchObject({ to: "+19415550102", body: "New recipient reply" });
  expect(JSON.parse(request[1].body)).not.toHaveProperty("replyToMessageId");
});

it("replies to the outstanding request on its own line after newer recruiting activity", async () => {
  messages = [
    { ...inbound("request-a", "Need help"), messageType: "inbound", customerId: "customer-a" },
    { ...inbound("applicant-b", "Applicant reply"), to: "+19412972606", messageType: "job_applicant_reply", customerId: "customer-a", createdAt: "2024-07-01T12:01:00Z" },
  ];
  const { container } = setup(); await tick();
  fireEvent.change(container.querySelector("#sms-thread-filter"), { target: { value: "unanswered" } });
  fireEvent.click(screen.getByText("Applicant reply"));
  fireEvent.click(screen.getByRole("button", { name: "Text back" }));
  expect(screen.getByRole("combobox", { name: "Send from" })).toHaveValue(line);
  fireEvent.change(screen.getByRole("textbox", { name: "Text message" }), { target: { value: "We can help" } });
  fireEvent.click(screen.getByRole("button", { name: "Send", exact: true })); await tick();
  const request = fetch.mock.calls.find(([url]) => String(url).endsWith("/communications/sms"));
  expect(JSON.parse(request[1].body)).toMatchObject({ fromNumber: line, to: "+19415550100", customerId: "customer-a", replyToMessageId: "request-a" });
});

it.each([false, true])("restores edited approvals with sender and approval authority (draft deep link: %s)", async (deepLink) => {
  const owner = `approval-owner-${deepLink}`;
  saveDraft(owner, savedApproval);
  window.history.replaceState({}, "", `/?phone=9415550100${deepLink ? "&draftId=approval-a" : ""}`);
  setupWithOwner(owner); await tick();
  expect(screen.getByRole("textbox", { name: "Text message" })).toHaveValue("Edited approval reply");
  expect(screen.getByRole("combobox", { name: "Send from" })).toHaveValue("+19415550199");
  fireEvent.click(screen.getByRole("button", { name: "Send", exact: true })); await tick();
  const request = fetch.mock.calls.find(([url]) => String(url).endsWith("/drafts/approval-a/revise"));
  expect(request).toBeTruthy();
  expect(JSON.parse(request[1].body)).toEqual({ revisedResponse: "Edited approval reply", fromNumber: "+19415550199" });
  expect(fetch.mock.calls.some(([url]) => String(url).endsWith("/communications/sms"))).toBe(false);
});

it("restores a contract link with the customer and send metadata that own it", async () => {
  const owner = "contract-draft-owner";
  const url = "https://example.invalid/contract/fixture";
  saveDraft(owner, { ...savedApproval, loadedMessageDraft: null, msgBody: `Please sign\n\n${url}`, insertedCustomerLinks: { contract: { url, recipientKey: "9415550100", customerId: "customer-a", contractId: "contract-a", immediateOnly: true } } });
  window.history.replaceState({}, "", "/?phone=9415550100");
  setupWithOwner(owner); await tick();
  expect(screen.getByRole("textbox", { name: "Text message" })).toHaveValue(`Please sign\n\n${url}`);
  fireEvent.click(screen.getByRole("button", { name: "Send", exact: true })); await tick();
  const request = fetch.mock.calls.find(([url]) => String(url).endsWith("/communications/sms"));
  expect(JSON.parse(request[1].body)).toMatchObject({ customerId: "customer-a", contractId: "contract-a", fromNumber: "+19415550199", body: `Please sign\n\n${url}` });
});

it("keeps a fixed customer profile separate from an inbox draft on a shared phone", async () => {
  const owner = "profile-draft-owner";
  saveDraft(owner, { ...savedApproval, loadedMessageDraft: null, selectedCustomerId: "another-customer", msgBody: "Another record's draft" });
  setupWithOwner(owner, { customer: { id: "profile-customer", phone: "+19415550100" }, customerMessages: [{ channel: "sms", contactPhone: "+19415550100", ourEndpointId: "+19415550199" }] });
  await tick();
  const field = screen.getByRole("textbox", { name: "Text message" });
  expect(field).toHaveValue("");
  fireEvent.change(field, { target: { value: "Profile reply" } });
  fireEvent.click(screen.getByRole("button", { name: "Send", exact: true })); await tick();
  fireEvent.change(field, { target: { value: "Second profile reply" } });
  fireEvent.click(screen.getByRole("button", { name: "Send", exact: true })); await tick();
  const requests = fetch.mock.calls.filter(([url]) => String(url).endsWith("/communications/sms"));
  expect(requests).toHaveLength(2);
  for (const request of requests) expect(JSON.parse(request[1].body)).toMatchObject({ customerId: "profile-customer", fromNumber: "+19415550199" });
});

it("keeps a manually selected sending line when entering a new recipient", async () => {
  setup(); await tick();
  const sender = screen.getByRole("combobox", { name: "Send from" });
  const chosenLine = [...sender.options].find((option) => option.value && option.value !== line).value;
  fireEvent.change(sender, { target: { value: chosenLine } });
  fireEvent.change(screen.getByPlaceholderText("Search by name or enter phone number…"), { target: { value: "+19415550108" } });
  expect(sender).toHaveValue(chosenLine);
  fireEvent.change(screen.getByRole("textbox", { name: "Text message" }), { target: { value: "New conversation" } });
  fireEvent.click(screen.getByRole("button", { name: "Send", exact: true })); await tick();
  const request = fetch.mock.calls.find(([url]) => String(url).endsWith("/communications/sms"));
  expect(JSON.parse(request[1].body)).toMatchObject({ to: "+19415550108", fromNumber: chosenLine });
});

it("requires an explicit sender for a new message without a saved line", async () => {
  setup(); await tick();
  fireEvent.change(screen.getByPlaceholderText("Search by name or enter phone number…"), { target: { value: "+19415550101" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Text message" }), { target: { value: "New conversation" } });
  fireEvent.click(screen.getByRole("button", { name: "Send", exact: true }));
  expect(screen.getByText("Choose a sending number before sending this message.")).toBeInTheDocument();
  expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/communications/sms"))).toHaveLength(0);
});

it.each([23, 24])("checks restored attachment expiry at send time (%s hours old)", async (ageHours) => {
  const owner = `attachment-owner-${ageHours}`;
  const media = { ...attachment, key: `sms-attachments/${Date.now() - ageHours * 60 * 60 * 1000}-fixture-gate.png` };
  saveDraft(owner, { msgBody: "Gate photo", fromNumber: line, attachments: [media] });
  window.history.replaceState({}, "", "/?phone=9415550100");
  setupWithOwner(owner); await tick();
  fireEvent.click(screen.getByRole("button", { name: "Send", exact: true })); await tick();
  const smsRequests = () => fetch.mock.calls.filter(([url]) => String(url).endsWith("/communications/sms"));
  if (ageHours === 23) {
    expect(smsRequests()).toHaveLength(1);
    expect(JSON.parse(smsRequests()[0][1].body).mediaUrls).toEqual([media.url]);
    return;
  }
  expect(smsRequests()).toHaveLength(0);
  expect(screen.getByText("An attachment has expired. Remove it and attach it again before sending.")).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Text message" })).toHaveValue("Gate photo");
  fireEvent.click(screen.getByRole("button", { name: "Remove gate.png" }));
  fireEvent.click(screen.getByRole("button", { name: "Send", exact: true })); await tick();
  expect(smsRequests()).toHaveLength(1);
  expect(JSON.parse(smsRequests()[0][1].body).body).toBe("Gate photo");
});
