// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import InsertLinkSheet from "./InsertLinkSheet";

const customer = { id: "00000000-0000-4000-8000-000000000011", first_name: "Fixture", last_name: "Customer", email: "fixture@example.invalid", phone: "9415550111" };
const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
let searchResponse;
let sendResponse;
beforeEach(() => {
  searchResponse = async () => response({ customers: [customer] });
  sendResponse = async () => response({ success: true, message: "Fixture guide delivered." });
  localStorage.setItem("waves_admin_token", "fixture-token");
  vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
    if (url.startsWith("/api/admin/customers?")) return searchResponse(url);
    if (url === "/api/admin/communications/send-prep") return sendResponse(options);
    throw new Error(`Unexpected fixture request: ${url}`);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const sends = () => fetch.mock.calls.filter(([url]) => url.endsWith("/send-prep"));

async function selectGuide(props = {}) {
  const onClose = vi.fn();
  const onPick = vi.fn();
  render(<InsertLinkSheet open onClose={onClose} links={[]} onPick={onPick} {...props} />);
  fireEvent.click(screen.getByRole("button", { name: /^Flea treatment/ }));
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  fireEvent.change(screen.getByRole("textbox", { name: "Search customer" }), { target: { value: "Fixture" } });
  fireEvent.click(await screen.findByRole("button", { name: /Fixture Customer/ }));
  return { onClose, onPick };
}

describe("Quick Links prep delivery", () => {
  it("keeps every guide searchable when the link library fails, without sending on selection", () => {
    const onPick = vi.fn();
    render(<InsertLinkSheet open onClose={() => {}} links={[]} onPick={onPick} error="Library unavailable" />);
    fireEvent.click(screen.getByRole("button", { name: "Prep guides", exact: true }));
    for (const name of ["Flea treatment", "Bed bug treatment", "Cockroach treatment", "Interior pest treatment", "Rodent service", "Termite service", "Mosquito treatment", "Lawn treatment", "Sprinkler timer guide (lawn)"]) {
      expect(screen.getByRole("button", { name: new RegExp(`^${name.replace(/[()]/g, "\\$&")}`) })).toBeInTheDocument();
    }
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "irrigation" } });
    fireEvent.click(screen.getByRole("button", { name: /^Sprinkler timer guide/ }));
    expect(screen.getByRole("heading", { name: "Sprinkler timer guide (lawn)" })).toBeInTheDocument();
    expect(screen.getByText(/one-time seasonal tip/i)).toBeInTheDocument();
    expect(onPick).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Back to Quick Links" }));
    expect(screen.getByRole("searchbox")).toHaveValue("irrigation");
  });

  it.each([["Email only", "email", "Send by email"], ["Text only", "sms", "Send by text"], ["Email and text", "both", "Send email and text"]])("delivers only the selected %s channel through the existing sender", async (label, channel, action) => {
    const { onPick } = await selectGuide();
    fireEvent.click(screen.getByRole("radio", { name: label }));
    expect(sends()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: action }));
    await screen.findByText("Fixture guide delivered.");
    expect(sends()).toHaveLength(1);
    expect(JSON.parse(sends()[0][1].body)).toEqual({ customerId: customer.id, pestType: "flea", channel });
    expect(sends()[0][1].headers.Authorization).toBe("Bearer fixture-token");
    expect(onPick).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: action })).toBeDisabled();
  });

  it("holds the customer, channel, close and back controls while a send is pending", async () => {
    let complete;
    sendResponse = () => new Promise((resolve) => { complete = resolve; });
    const { onClose } = await selectGuide();
    const form = screen.getByRole("button", { name: "Send email and text" }).closest("form");
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(sends()).toHaveLength(1);
    for (const name of ["Change customer", "Close", "Back to Quick Links"]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
    }
    expect(screen.getByRole("radio", { name: "Email only" })).toBeDisabled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => complete(response({ success: true, message: "Fixture guide delivered." })));
    expect(screen.getByRole("button", { name: "Close" })).toBeEnabled();
  });

  it("surfaces partial delivery and the server's refusal without a success message", async () => {
    sendResponse = async () => response({ success: true, partial: true, message: "Email delivered. Text was not sent." });
    await selectGuide();
    fireEvent.click(screen.getByRole("button", { name: "Send email and text" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Email delivered. Text was not sent.");
    sendResponse = async () => response({ error: "This customer has no phone number on file." }, 400);
    fireEvent.click(screen.getByRole("radio", { name: "Text only" }));
    fireEvent.click(screen.getByRole("button", { name: "Send by text" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This customer has no phone number on file.");
  });

  it("retains the in-flight guide and its outcome across a hidden channel", async () => {
    let complete;
    sendResponse = () => new Promise((resolve) => { complete = resolve; });
    const props = { onClose: vi.fn(), links: [], onPick: vi.fn() };
    const view = render(<InsertLinkSheet open {...props} />);
    fireEvent.click(screen.getByRole("button", { name: /^Flea treatment/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Search customer" }), { target: { value: "Fixture" } });
    fireEvent.click(await screen.findByRole("button", { name: /Fixture Customer/ }));
    fireEvent.click(screen.getByRole("button", { name: "Send email and text" }));
    view.rerender(<InsertLinkSheet open={false} {...props} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    view.rerender(<InsertLinkSheet open {...props} />);
    expect(screen.getByRole("button", { name: "Sending…" })).toBeDisabled();
    view.rerender(<InsertLinkSheet open={false} {...props} />);
    await act(async () => complete(response({ success: true, partial: true, message: "Email delivered. Text was not sent." })));
    view.rerender(<InsertLinkSheet open {...props} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Email delivered. Text was not sent.");
    expect(screen.getByText("Fixture Customer")).toBeInTheDocument();
    expect(sends()).toHaveLength(1);
  });

  it("ignores an old customer search after the query changes", async () => {
    let finishOld;
    searchResponse = (url) => url.includes("Old")
      ? new Promise((resolve) => { finishOld = resolve; })
      : response({ customers: [customer] });
    render(<InsertLinkSheet open onClose={() => {}} links={[]} onPick={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /^Flea treatment/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Search customer" }), { target: { value: "Old" } });
    await waitFor(() => expect(finishOld).toBeTypeOf("function"));
    fireEvent.change(screen.getByRole("textbox", { name: "Search customer" }), { target: { value: "Fixture" } });
    await screen.findByRole("button", { name: /Fixture Customer/ });
    await act(async () => finishOld(response({ customers: [{ ...customer, id: "old", first_name: "Old" }] })));
    expect(screen.queryByRole("button", { name: /Old Customer/ })).not.toBeInTheDocument();
    expect(sends()).toHaveLength(0);
  });
});
