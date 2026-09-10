// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../components/admin/AdminCommandHeader", () => ({
  default: ({ sections = [], activeKey, onSectionChange, action, headingLevel, sticky }) => (
    <div data-heading-level={headingLevel} data-sticky={String(sticky)}>
      {sections.map(({ key, label }) => (
        <button
          key={key}
          type="button"
          aria-current={activeKey === key ? "page" : undefined}
          onClick={() => onSectionChange(key)}
        >
          {label}
        </button>
      ))}
      {action && <button type="button" onClick={action.onClick}>{action.label}</button>}
    </div>
  ),
}));

import KnowledgePage from "./KnowledgePage";

function response(data, { ok = true, status = 200 } = {}) {
  return { ok, status, json: vi.fn(async () => data) };
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location-search">{location.search}</output>;
}

function renderWiki(entry) {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route
          path="/admin/knowledge"
          element={(
            <>
              <KnowledgePage embedded />
              <LocationProbe />
            </>
          )}
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe("KnowledgePage embedded navigation", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("waves_admin_token", "admin-token");
    vi.stubGlobal("fetch", vi.fn(async () => response({})));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("uses wikiTab without overwriting the Knowledge area", () => {
    localStorage.setItem("waves_admin_user", JSON.stringify({ role: "admin" }));
    renderWiki("/admin/knowledge?source=bookmark&wikiTab=sources");

    expect(screen.getByRole("button", { name: "Sources" }))
      .toHaveAttribute("aria-current", "page");
    fireEvent.click(screen.getByRole("button", { name: "Recent Queries" }));

    expect(screen.getByTestId("location-search")).toHaveTextContent(
      "?source=bookmark&wikiTab=queries",
    );
  });

  it("does not expose the admin-only Health area to non-admin staff", () => {
    localStorage.setItem("waves_admin_user", JSON.stringify({ role: "technician" }));
    renderWiki("/admin/knowledge?wikiTab=health");

    expect(screen.queryByRole("button", { name: "Health" }))
      .not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Articles" }))
      .toHaveAttribute("aria-current", "page");
  });

  it("retains a failed question and restores opener focus on close", async () => {
    localStorage.setItem("waves_admin_user", JSON.stringify({ role: "admin" }));
    fetch.mockImplementation(async (url, options) => options?.method === "POST"
      ? response({ error: "Knowledge service unavailable" }, { ok: false, status: 503 })
      : response({ articles: [] }));
    renderWiki("/admin/knowledge");

    const opener = screen.getByRole("button", { name: /ask a question/i });
    fireEvent.click(opener);
    expect(screen.getByRole("dialog")).toHaveAttribute("data-ui-density", "comfortable");
    const question = screen.getByRole("textbox", { name: "Question" });
    fireEvent.change(question, { target: { value: "What is the annual rate?" } });
    fireEvent.submit(question.closest("form"));

    expect(await screen.findByRole("alert")).toHaveTextContent("Knowledge service unavailable");
    expect(question).toHaveValue("What is the annual rate?");
    expect(fetch).toHaveBeenCalledWith(
      "/api/admin/knowledge/query",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ question: "What is the annual rate?" }),
      }),
    );

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
    fireEvent.click(opener);
    expect(screen.getByRole("textbox", { name: "Question" })).toHaveValue("");
  });

  it("guards duplicate question and file-back requests and retains the answer on failure", async () => {
    localStorage.setItem("waves_admin_user", JSON.stringify({ role: "admin" }));
    const questionPending = deferred();
    const fileBackPending = deferred();
    fetch.mockImplementation((url, options) => {
      if (url.endsWith("/query") && options?.method === "POST") return questionPending.promise;
      if (url.endsWith("/file-back") && options?.method === "POST") return fileBackPending.promise;
      return Promise.resolve(response({ articles: [] }));
    });
    renderWiki("/admin/knowledge");

    fireEvent.click(screen.getByRole("button", { name: /ask a question/i }));
    const question = screen.getByRole("textbox", { name: "Question" });
    fireEvent.change(question, { target: { value: "Question one" } });
    fireEvent.submit(question.closest("form"));
    fireEvent.submit(question.closest("form"));
    expect(fetch.mock.calls.filter(([url]) => url.endsWith("/query"))).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Ask" })).toBeDisabled();

    questionPending.resolve(response({
      answer: "Answer one",
      queryId: "query-1",
      articleTitles: [{ title: "Rate guide" }],
    }));
    expect(await screen.findByText("Answer one")).toBeInTheDocument();
    expect(screen.getByText("Sources: Rate guide")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Good" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Incomplete" })).toBeDisabled();

    const fileBack = screen.getByRole("button", { name: "File into wiki" });
    fireEvent.click(fileBack);
    fireEvent.click(fileBack);
    expect(fetch.mock.calls.filter(([url]) => url.endsWith("/file-back"))).toHaveLength(1);
    expect(fetch).toHaveBeenCalledWith(
      "/api/admin/knowledge/file-back",
      expect.objectContaining({ body: JSON.stringify({ queryId: "query-1" }) }),
    );
    fileBackPending.resolve(response({ error: "Could not write article" }, { ok: false, status: 500 }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not write article");
    expect(screen.getByText("Answer one")).toBeInTheDocument();
  });

  it("explains why an answer without a query ID cannot be filed", async () => {
    localStorage.setItem("waves_admin_user", JSON.stringify({ role: "admin" }));
    fetch.mockImplementation(async (url, options) => (
      url.endsWith("/query") && options?.method === "POST"
        ? response({ answer: "Answer without an ID", articleTitles: [] })
        : response({ articles: [] })
    ));
    renderWiki("/admin/knowledge");

    fireEvent.click(screen.getByRole("button", { name: /ask a question/i }));
    const question = screen.getByRole("textbox", { name: "Question" });
    fireEvent.change(question, { target: { value: "Question without an ID" } });
    fireEvent.submit(question.closest("form"));

    expect(await screen.findByText("Answer without an ID")).toBeInTheDocument();
    const fileBack = screen.getByRole("button", { name: "File into wiki" });
    expect(fileBack).toBeDisabled();
    expect(fileBack).toHaveAccessibleDescription(
      "Filing into the wiki is unavailable for this answer.",
    );
    expect(fetch.mock.calls.filter(([url]) => url.endsWith("/file-back"))).toHaveLength(0);
  });
});
