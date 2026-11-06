// @vitest-environment jsdom
//
// Staff documents, archive and restore (daily-work audit 2026-11-06): the
// archive confirm says where an archived document goes, "Show archived" lists
// those documents with a Restore action, and Restore posts to the restore route
// and reads the list again. Rows keep the actions of the view they were read
// for while the next read is still on its way.
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TimeTrackingPage from "./TimeTrackingPage";

vi.mock("../../hooks/useStaffDocumentsAvailable", () => ({ default: () => false }));
vi.mock("../../hooks/usePayGrowthAvailable", () => ({ default: () => false }));
vi.mock("../../hooks/usePayrollAvailable", () => ({ default: () => false }));
vi.mock("../../hooks/useTechPayStubs", () => ({ default: () => ({ status: "off" }) }));
vi.mock("../../hooks/useRenderedTabBeacon", () => ({ default: () => {} }));

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json" },
});

const doc = (id, title) => ({
  id,
  title,
  category: "policy",
  file_name: `${id}.pdf`,
  file_type: "pdf",
  file_size: 2048,
  created_at: "2026-09-01T12:00:00Z",
});
const ACTIVE = doc("doc-active", "Vehicle policy");
const ARCHIVED = doc("doc-archived", "Old uniform policy");

beforeEach(() => {
  localStorage.setItem("waves_admin_token", "synthetic-token");
  localStorage.setItem("waves_admin_user", JSON.stringify({ id: "admin-1", role: "admin" }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

function renderDocuments() {
  return render(
    <MemoryRouter initialEntries={["/admin/timetracking?tab=documents"]}>
      <TimeTrackingPage />
    </MemoryRouter>,
  );
}

describe("archived staff documents", () => {
  it("lists archived documents and restores one", async () => {
    let restored = false;
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
      const u = new URL(String(url), "http://localhost");
      calls.push([u, options]);
      if (u.pathname.endsWith("/technicians")) return json({ technicians: [] });
      if (u.pathname.endsWith("/documents/doc-archived/restore")) {
        restored = true;
        return json({ ...ARCHIVED, is_archived: false });
      }
      if (u.pathname.endsWith("/documents")) {
        if (u.searchParams.get("archived") === "only") return json({ documents: restored ? [] : [ARCHIVED] });
        return json({ documents: restored ? [ARCHIVED, ACTIVE] : [ACTIVE] });
      }
      return json({});
    }));
    renderDocuments();

    expect(await screen.findByText("Vehicle policy")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Archive" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show archived" }));
    expect(await screen.findByText("Old uniform policy")).toBeInTheDocument();
    expect(screen.getByText("Archived documents")).toBeInTheDocument();
    expect(screen.queryByText("Vehicle policy")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "+ Upload Document" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    expect(await screen.findByText("No archived documents.")).toBeInTheDocument();
    const restore = calls.find(([u]) => u.pathname.endsWith("/restore"));
    expect(restore[0].pathname).toBe("/api/admin/timetracking/documents/doc-archived/restore");
    expect(restore[1].method).toBe("POST");
    expect(screen.getByText("Document restored")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show active" }));
    expect(await screen.findByText("Old uniform policy")).toBeInTheDocument();
    expect(screen.getByText("Vehicle policy")).toBeInTheDocument();
  });

  it("the archive confirm points at Show archived", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const u = new URL(String(url), "http://localhost");
      if (u.pathname.endsWith("/technicians")) return json({ technicians: [] });
      return json({ documents: [ACTIVE] });
    }));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderDocuments();

    fireEvent.click(await screen.findByRole("button", { name: "Archive" }));
    expect(confirm).toHaveBeenCalledWith('Archive "Vehicle policy"? You can restore it from Show archived.');
  });

  it("rows keep their own view's actions until the next view's read lands", async () => {
    let finishArchived;
    const archivedRead = new Promise((resolve) => { finishArchived = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const u = new URL(String(url), "http://localhost");
      if (u.pathname.endsWith("/technicians")) return json({ technicians: [] });
      if (u.searchParams.get("archived") === "only") return archivedRead;
      return json({ documents: [ACTIVE] });
    }));
    renderDocuments();

    expect(await screen.findByText("Vehicle policy")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show archived" }));
    // The active row is still on screen: it offers Archive, never Restore.
    expect(screen.getByText("Vehicle policy")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Archive" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Restore" })).not.toBeInTheDocument();

    await act(async () => { finishArchived(json({ documents: [ARCHIVED] })); });
    await waitFor(() => expect(screen.getByRole("button", { name: "Restore" })).toBeInTheDocument());
    expect(screen.queryByText("Vehicle policy")).not.toBeInTheDocument();
  });
});
