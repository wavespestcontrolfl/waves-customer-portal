// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const adminFetch = vi.hoisted(() => vi.fn());
vi.mock("../../lib/adminFetch", () => ({ adminFetch }));

import SentAnotherWayAction from "./SentAnotherWayAction";

const eligible = { id: "project-1", canMarkSentOutside: true, sent_outside_portal_at: null };

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

beforeEach(() => adminFetch.mockReset());
afterEach(cleanup);

describe("SentAnotherWayAction", () => {
  it("renders nothing when the server does not offer it", () => {
    const { container } = render(<SentAnotherWayAction project={{ id: "p", canMarkSentOutside: false }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the button, then a confirm step, and sends nothing until confirmed", () => {
    render(<SentAnotherWayAction project={eligible} />);
    fireEvent.click(screen.getByRole("button", { name: "Sent another way" }));
    expect(screen.getByText(/Nothing goes to the customer/)).toBeInTheDocument();
    expect(adminFetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Sent another way" })).toBeInTheDocument();
    expect(adminFetch).not.toHaveBeenCalled();
  });

  it("posts the trimmed note and swaps the button for the sent date", async () => {
    adminFetch.mockResolvedValue(jsonResponse(200, { ok: true, sent_outside_portal_at: "2026-11-02T15:00:00.000Z" }));
    const onMarked = vi.fn();
    render(<SentAnotherWayAction project={eligible} onMarked={onMarked} />);
    fireEvent.click(screen.getByRole("button", { name: "Sent another way" }));
    fireEvent.change(screen.getByLabelText(/Note \(optional\)/), { target: { value: "  Emailed to the agent  " } });
    fireEvent.click(screen.getByRole("button", { name: "Mark as sent" }));

    await waitFor(() => expect(screen.getByTestId("sent-another-way-done")).toHaveTextContent("Sent outside the portal on Nov 2, 2026"));
    expect(adminFetch).toHaveBeenCalledWith("/admin/projects/project-1/mark-sent-outside", {
      method: "POST",
      body: { note: "Emailed to the agent" },
    });
    expect(onMarked).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Sent another way" })).toBeNull();
  });

  it("keeps the confirm step open and shows the server error on failure", async () => {
    adminFetch.mockResolvedValue(jsonResponse(409, { error: "This report is already marked as sent another way" }));
    render(<SentAnotherWayAction project={eligible} />);
    fireEvent.click(screen.getByRole("button", { name: "Sent another way" }));
    fireEvent.click(screen.getByRole("button", { name: "Mark as sent" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("already marked");
    expect(screen.getByRole("button", { name: "Mark as sent" })).toBeEnabled();
    expect(screen.queryByTestId("sent-another-way-done")).toBeNull();
  });

  it("shows the saved date for an already-marked report, with no button", () => {
    render(<SentAnotherWayAction project={{ id: "p", canMarkSentOutside: false, sent_outside_portal_at: "2026-10-26T14:00:00.000Z" }} />);
    expect(screen.getByTestId("sent-another-way-done")).toHaveTextContent("Sent outside the portal on Oct 26, 2026");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("caps the note box at 500 characters", () => {
    render(<SentAnotherWayAction project={eligible} />);
    fireEvent.click(screen.getByRole("button", { name: "Sent another way" }));
    expect(screen.getByLabelText(/Note \(optional\)/)).toHaveAttribute("maxLength", "500");
  });
});
