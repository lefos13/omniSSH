import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ExplorerFileTable } from "../ExplorerFileTable";
import { createSftpProvider } from "../../../providers/sftp-provider";
import type { ExplorerEntry } from "../../../types/explorer";

function makeEntry(over: Partial<ExplorerEntry> = {}): ExplorerEntry {
  return {
    name: "notes.txt",
    id: "/home/notes.txt",
    entryType: "File",
    size: 12,
    modified: 100,
    permissionsDisplay: "rw-r--r--",
    permissions: 0o644,
    isSymlink: false,
    storageClass: null,
    ...over,
  };
}

const SAMPLE_ENTRIES: ExplorerEntry[] = [
  makeEntry({ name: "subfolder", id: "/home/subfolder", entryType: "Directory", size: 0, modified: 500 }),
  makeEntry({ name: "BigData.iso", id: "/home/BigData.iso", size: 5_000_000, modified: 100 }),
  makeEntry({ name: "notes.txt", id: "/home/notes.txt", size: 300, modified: 900 }),
  makeEntry({ name: "server.log", id: "/home/server.log", size: 10, modified: 50 }),
];

function renderTable(over: {
  entries?: ExplorerEntry[];
  searchQuery?: string;
  onClearSearch?: () => void;
} = {}) {
  const onClearSearch = over.onClearSearch ?? vi.fn();
  const utils = render(
    <ExplorerFileTable
      provider={createSftpProvider("sess-1")}
      entries={over.entries ?? SAMPLE_ENTRIES}
      sortBy="name"
      sortAsc={true}
      onSortChange={vi.fn()}
      clipboard={null}
      onSetClipboard={vi.fn()}
      onNavigate={vi.fn()}
      onDownload={vi.fn()}
      onDelete={async () => {}}
      onEditInEditor={vi.fn()}
      currentPath="/home"
      loading={false}
      searchQuery={over.searchQuery}
      onClearSearch={onClearSearch}
    />,
  );
  return { ...utils, onClearSearch };
}

function getVisibleRowNames(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("[data-entry-name]")).map(
    (el) => el.getAttribute("data-entry-name") ?? "",
  );
}

describe("ExplorerFileTable — filtering and search", () => {
  it("renders all entries when searchQuery is empty or whitespace", () => {
    const { container, rerender } = renderTable({ searchQuery: "" });
    expect(getVisibleRowNames(container)).toEqual([
      "subfolder",
      "BigData.iso",
      "notes.txt",
      "server.log",
    ]);

    rerender(
      <ExplorerFileTable
        provider={createSftpProvider("sess-1")}
        entries={SAMPLE_ENTRIES}
        sortBy="name"
        sortAsc={true}
        onSortChange={vi.fn()}
        clipboard={null}
        onSetClipboard={vi.fn()}
        onNavigate={vi.fn()}
        onDownload={vi.fn()}
        onDelete={async () => {}}
        onEditInEditor={vi.fn()}
        currentPath="/home"
        loading={false}
        searchQuery="   "
        onClearSearch={vi.fn()}
      />,
    );
    expect(getVisibleRowNames(container)).toEqual([
      "subfolder",
      "BigData.iso",
      "notes.txt",
      "server.log",
    ]);
  });

  it("filters entries by substring matching", () => {
    const { container } = renderTable({ searchQuery: "log" });
    expect(getVisibleRowNames(container)).toEqual(["server.log"]);
  });

  it("performs case-insensitive filtering", () => {
    const { container } = renderTable({ searchQuery: "bigdata" });
    expect(getVisibleRowNames(container)).toEqual(["BigData.iso"]);

    const { container: container2 } = renderTable({ searchQuery: "DATA" });
    expect(getVisibleRowNames(container2)).toEqual(["BigData.iso"]);
  });

  it("navigates with Arrow keys across filtered entries only", () => {
    // Query matching "log" and "notes"
    const { container: subContainer } = renderTable({ searchQuery: ".txt" });
    const rows = subContainer.querySelectorAll<HTMLElement>("[data-entry-row]");
    expect(rows.length).toBe(1);
    expect(rows[0].getAttribute("data-entry-name")).toBe("notes.txt");

    // Filter with 2 items
    const { container: twoItemsContainer } = renderTable({ searchQuery: "e" }); // subfolder, notes.txt, server.log
    const twoRows = twoItemsContainer.querySelectorAll<HTMLElement>("[data-entry-row]");
    expect(twoRows.length).toBe(3);

    // Focus first row and press ArrowDown
    fireEvent.click(twoRows[0]);
    expect(twoRows[0]).toHaveAttribute("data-entry-name", "subfolder");

    fireEvent.keyDown(twoRows[0], { key: "ArrowDown" });
    // Next item in filtered list is notes.txt
    expect(twoRows[1].classList.contains("bg-accent/10")).toBe(true);
  });

  it("selects all filtered entries with Cmd/Ctrl+A", () => {
    const { container } = renderTable({ searchQuery: "e" }); // matches subfolder, notes.txt, server.log
    const rows = container.querySelectorAll<HTMLElement>("[data-entry-row]");
    expect(rows.length).toBe(3);

    fireEvent.keyDown(rows[0], { key: "a", metaKey: true });
    for (const row of Array.from(rows)) {
      expect(row.classList.contains("bg-accent/10")).toBe(true);
    }
  });

  it("displays empty match state when entries exist but none match search", () => {
    const onClearSearch = vi.fn();
    renderTable({ searchQuery: "nonexistent", onClearSearch });

    expect(screen.getByText('No files match "nonexistent"')).toBeInTheDocument();

    const clearBtn = screen.getByRole("button", { name: "Clear filter" });
    expect(clearBtn).toBeInTheDocument();

    fireEvent.click(clearBtn);
    expect(onClearSearch).toHaveBeenCalledTimes(1);
  });

  it("displays folder empty state when folder has 0 entries regardless of search query", () => {
    renderTable({ entries: [], searchQuery: "test" });
    expect(screen.getByText("This folder is empty")).toBeInTheDocument();
    expect(screen.queryByText(/No files match/)).not.toBeInTheDocument();
  });
});
