// @vitest-environment jsdom
// Technician composer (owner 2026-11-04, "the dead ends get fixed"): the Text link carries the customer, so the
// composer sends with a customer (the server refuses a technician's text without one), and a technician is not
// offered photo upload, which only an admin can do.
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../hooks/useRenderedTabBeacon", () => ({ default: () => {} }));

import CommunicationsPageV2 from "./CommunicationsPageV2";

const CUSTOMER_ID = "11111111-2222-4333-8444-555555555555";
const PHONE = "+19415550123";

beforeEach(() => {
  localStorage.setItem("waves_admin_token", "synthetic-token");
  vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
    const path = new URL(String(url), "http://localhost").pathname;
    const data = path.endsWith("/log") ? { messages: [] }
      : path.endsWith("/blocked-numbers") ? { numbers: [] }
        : path.endsWith("/communications/sms") && options.method === "POST" ? { sent: true, providerMessageId: "SMaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
          : {};
    return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  window.history.pushState({}, "", "/");
});

function mount(role, search) {
  // The composer reads its deep link from window.location, not the router.
  window.history.pushState({}, "", `/admin/communications${search}`);
  render(
    <MemoryRouter initialEntries={[`/admin/communications${search}`]}>
      <Routes>
        <Route element={<Outlet context={{ user: { id: `${role}-1`, role } }} />}>
          <Route path="/admin/communications" element={<CommunicationsPageV2 />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

const textLink = `?phone=${encodeURIComponent(PHONE)}&action=sms&customerId=${CUSTOMER_ID}&thread=${CUSTOMER_ID}`;

describe("composer Add attachment", () => {
  it("is not offered to a technician", async () => {
    mount("technician", textLink);
    await screen.findByRole("textbox", { name: "Text message" });
    expect(screen.queryByRole("button", { name: "Add attachment" })).not.toBeInTheDocument();
  });

  it("is still offered to an admin", async () => {
    mount("admin", textLink);
    await screen.findByRole("textbox", { name: "Text message" });
    expect(screen.getByRole("button", { name: "Add attachment" })).toBeInTheDocument();
  });
});

describe("composer opened from a technician's Text link", () => {
  it("sends the text with the customer named in the link", async () => {
    mount("technician", textLink);
    const field = await screen.findByRole("textbox", { name: "Text message" });
    fireEvent.change(field, { target: { value: "On my way" } });
    const sender = screen.queryByRole("combobox", { name: "Send from" });
    if (sender) fireEvent.change(sender, { target: { value: [...sender.options].find((o) => o.value).value } });
    fireEvent.click(screen.getByRole("button", { name: "Send", exact: true }));
    await waitFor(() => expect(fetch.mock.calls.some(([url, opts]) => String(url).endsWith("/communications/sms") && opts?.method === "POST")).toBe(true));
    const post = fetch.mock.calls.find(([url, opts]) => String(url).endsWith("/communications/sms") && opts?.method === "POST");
    expect(JSON.parse(post[1].body)).toMatchObject({ customerId: CUSTOMER_ID, body: "On my way" });
  });

  it("sends no customer when the link names none (an admin's plain Text link is unchanged)", async () => {
    // Another number: a saved draft is kept per recipient and would carry the customer from the test above.
    mount("admin", `?phone=${encodeURIComponent("+19415550124")}&action=sms`);
    const field = await screen.findByRole("textbox", { name: "Text message" });
    fireEvent.change(field, { target: { value: "Hello" } });
    const sender = screen.queryByRole("combobox", { name: "Send from" });
    if (sender) fireEvent.change(sender, { target: { value: [...sender.options].find((o) => o.value).value } });
    fireEvent.click(screen.getByRole("button", { name: "Send", exact: true }));
    await waitFor(() => expect(fetch.mock.calls.some(([url, opts]) => String(url).endsWith("/communications/sms") && opts?.method === "POST")).toBe(true));
    const post = fetch.mock.calls.find(([url, opts]) => String(url).endsWith("/communications/sms") && opts?.method === "POST");
    expect(JSON.parse(post[1].body).customerId).toBeUndefined();
  });
});
