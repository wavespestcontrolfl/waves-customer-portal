// @vitest-environment jsdom
// Street-level address hold: an appointment-page link the composer inserted points at ONE visit. The send
// carries that visit's id (linkedVisitIds) so the server's shared send step can hold the text while the
// visit is an unconfirmed address hold. A send with no inserted visit link carries none.
import React from "react";
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SmsTab } from "./CommunicationsPageV2";

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
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); window.history.replaceState({}, "", "/"); });

it("an inserted appointment-page link rides the send with its visit id; a plain text carries none", async () => {
  responses["/admin/communications/link-library"] = { links: [] };
  responses["/admin/communications/customer-link"] = {
    kind: "appointment",
    url: "https://waves.link/l/appt1",
    line: "Everything about your visit: https://waves.link/l/appt1\n\n",
    immediateOnly: true,
    appointment: { id: "3f1c2a9e-5b7d-4e21-9c0a-1d2e3f4a5b6c", scheduledDate: "2099-01-05", serviceType: "Pest Control" },
    customerId: "cust-1",
  };
  responses["/admin/communications/sms"] = { sent: true, providerMessageId: "SMbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" };

  render(<SmsTab active onSent={vi.fn()} />, { wrapper: MemoryRouter });
  fireEvent.click(await screen.findByRole("button", { name: "Quick Links" }));
  fireEvent.click(await screen.findByRole("button", { name: /Appointment page link/i }));
  await waitFor(() => expect(requests("/admin/communications/customer-link")).toHaveLength(1));
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Text message" }).value).toContain("https://waves.link/l/appt1"));

  fireEvent.change(screen.getByRole("combobox", { name: "Send from" }), { target: { value: "+19412975749" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(requests("/admin/communications/sms")).toHaveLength(1));
  expect(bodyOf("/admin/communications/sms").linkedVisitIds).toEqual(["3f1c2a9e-5b7d-4e21-9c0a-1d2e3f4a5b6c"]);
});

it("a plain text with no inserted visit link carries no linkedVisitIds", async () => {
  responses["/admin/communications/link-library"] = { links: [] };
  responses["/admin/communications/sms"] = { sent: true, providerMessageId: "SMbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" };

  render(<SmsTab active onSent={vi.fn()} />, { wrapper: MemoryRouter });
  const box = await screen.findByRole("textbox", { name: "Text message" });
  fireEvent.change(box, { target: { value: "Thanks for calling." } });
  fireEvent.change(screen.getByRole("combobox", { name: "Send from" }), { target: { value: "+19412975749" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(requests("/admin/communications/sms")).toHaveLength(1));
  expect(bodyOf("/admin/communications/sms")).not.toHaveProperty("linkedVisitIds");
});

it("a harmless edit to an inserted reschedule link (hostname case) keeps its tracking, so the send still carries the visit id", async () => {
  responses["/admin/communications/link-library"] = { links: [] };
  responses["/admin/communications/reschedule-link"] = {
    url: "wavespest.co/r/abc123",
    line: "Pick a new time here: wavespest.co/r/abc123\n\n",
    firstName: null,
    appointment: { id: "8a7b6c5d-4e3f-4a2b-8c1d-0e9f8a7b6c5d", scheduledDate: "2099-01-05", windowStart: "09:00", serviceType: "Pest Control", status: "confirmed" },
  };
  responses["/admin/communications/sms"] = { sent: true, providerMessageId: "SMbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" };

  render(<SmsTab active onSent={vi.fn()} />, { wrapper: MemoryRouter });
  fireEvent.click(await screen.findByRole("button", { name: "Quick Links" }));
  fireEvent.click(await screen.findByRole("button", { name: /Reschedule link/i }));
  await waitFor(() => expect(requests("/admin/communications/reschedule-link")).toHaveLength(1));
  const box = screen.getByRole("textbox", { name: "Text message" });
  await waitFor(() => expect(box.value).toContain("wavespest.co/r/abc123"));

  // The operator only changes the hostname's casing; the link still works.
  fireEvent.change(box, { target: { value: box.value.replace("wavespest.co", "WavesPest.co") } });
  fireEvent.change(screen.getByRole("combobox", { name: "Send from" }), { target: { value: "+19412975749" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(requests("/admin/communications/sms")).toHaveLength(1));
  expect(bodyOf("/admin/communications/sms").linkedVisitIds).toEqual(["8a7b6c5d-4e3f-4a2b-8c1d-0e9f8a7b6c5d"]);
});
