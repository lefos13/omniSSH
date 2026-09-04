/*
 * Component tests for ExplorerFileTable selection reporting.
 *
 * Verifies that the optional onSelectionChange prop:
 * 1. Reports single-click selection.
 * 2. Reports modifier (Cmd/Ctrl) multi-select and toggling.
 * 3. Reports Shift range selection across rows.
 * 4. Reports Cmd+A / Ctrl+A select-all.
 * 5. Reports keyboard Arrow navigation selection.
 * 6. Reports clearing when clicking outside rows or navigating directories.
 * 7. Leaves table behavior completely intact when omitted.
 */

import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import { ExplorerFileTable } from "./ExplorerFileTable";
import { createSftpProvider } from "../../providers/sftp-provider";
import type { ExplorerEntry } from "../../types/explorer";

function makeEntry(over: Partial<ExplorerEntry> = {}): ExplorerEntry {
  return {
    name: "file.txt",
    id: "/home/file.txt",
    entryType: "File",
    size: 100,
    modified: 1000,
    permissionsDisplay: "rw-r--r--",
    permissions: 0o644,
    isSymlink: false,
    storageClass: null,
    ...over,
  };
}

const TEST_ENTRIES: ExplorerEntry[] = [
  makeEntry({ name: "alpha.txt", id: "/home/alpha.txt" }),
  makeEntry({ name: "bravo.txt", id: "/home/bravo.txt" }),
  makeEntry({ name: "charlie.txt", id: "/home/charlie.txt" }),
  makeEntry({ name: "delta.txt", id: "/home/delta.txt" }),
];

interface HarnessProps {
  entries?: ExplorerEntry[];
  currentPath?: string;
  onSelectionChange?: (entries: ExplorerEntry[]) => void;
}

function TableHarness({
  entries = TEST_ENTRIES,
  currentPath = "/home",
  onSelectionChange,
}: HarnessProps) {
  return (
    <ExplorerFileTable
      provider={createSftpProvider("test-session")}
      entries={entries}
      sortBy="name"
      sortAsc={true}
      onSortChange={() => {}}
      clipboard={null}
      onSetClipboard={() => {}}
      onNavigate={() => {}}
      onDownload={() => {}}
      onDelete={async () => {}}
      currentPath={currentPath}
      loading={false}
      onSelectionChange={onSelectionChange}
    />
  );
}

describe("ExplorerFileTable — onSelectionChange contract", () => {
  it("reports single-click selection", () => {
    const onSelectionChange = vi.fn();
    render(<TableHarness onSelectionChange={onSelectionChange} />);

    const row = screen.getByTestId("explorer-entry-alpha.txt");
    fireEvent.click(row);

    expect(onSelectionChange).toHaveBeenLastCalledWith([TEST_ENTRIES[0]]);
  });

  it("reports modifier-assisted multi-select (Cmd/Ctrl) and toggling", () => {
    const onSelectionChange = vi.fn();
    render(<TableHarness onSelectionChange={onSelectionChange} />);

    // Click first entry
    fireEvent.click(screen.getByTestId("explorer-entry-alpha.txt"));
    expect(onSelectionChange).toHaveBeenLastCalledWith([TEST_ENTRIES[0]]);

    // Cmd-click third entry
    fireEvent.click(screen.getByTestId("explorer-entry-charlie.txt"), { metaKey: true });
    expect(onSelectionChange).toHaveBeenLastCalledWith([TEST_ENTRIES[0], TEST_ENTRIES[2]]);

    // Cmd-click first entry to deselect it
    fireEvent.click(screen.getByTestId("explorer-entry-alpha.txt"), { metaKey: true });
    expect(onSelectionChange).toHaveBeenLastCalledWith([TEST_ENTRIES[2]]);
  });

  it("reports Shift range selection", () => {
    const onSelectionChange = vi.fn();
    render(<TableHarness onSelectionChange={onSelectionChange} />);

    // Click alpha.txt (index 0)
    fireEvent.click(screen.getByTestId("explorer-entry-alpha.txt"));
    expect(onSelectionChange).toHaveBeenLastCalledWith([TEST_ENTRIES[0]]);

    // Shift-click charlie.txt (index 2)
    fireEvent.click(screen.getByTestId("explorer-entry-charlie.txt"), { shiftKey: true });
    expect(onSelectionChange).toHaveBeenLastCalledWith([
      TEST_ENTRIES[0],
      TEST_ENTRIES[1],
      TEST_ENTRIES[2],
    ]);
  });

  it("reports select-all via Cmd+A", () => {
    const onSelectionChange = vi.fn();
    render(<TableHarness onSelectionChange={onSelectionChange} />);

    const row = screen.getByTestId("explorer-entry-alpha.txt");
    fireEvent.keyDown(row, { key: "a", metaKey: true });

    expect(onSelectionChange).toHaveBeenLastCalledWith(TEST_ENTRIES);
  });

  it("reports keyboard arrow navigation", () => {
    const onSelectionChange = vi.fn();
    render(<TableHarness onSelectionChange={onSelectionChange} />);

    const row = screen.getByTestId("explorer-entry-alpha.txt");
    fireEvent.click(row);
    expect(onSelectionChange).toHaveBeenLastCalledWith([TEST_ENTRIES[0]]);

    // Arrow down to bravo.txt
    fireEvent.keyDown(row, { key: "ArrowDown" });
    expect(onSelectionChange).toHaveBeenLastCalledWith([TEST_ENTRIES[1]]);
  });

  it("reports clearing selection when clicking outside rows", () => {
    const onSelectionChange = vi.fn();
    const { container } = render(<TableHarness onSelectionChange={onSelectionChange} />);

    // Select an entry
    fireEvent.click(screen.getByTestId("explorer-entry-alpha.txt"));
    expect(onSelectionChange).toHaveBeenLastCalledWith([TEST_ENTRIES[0]]);

    // Click table background container (not on a row)
    const tableContainer = container.querySelector(".overflow-y-scroll") as HTMLElement;
    fireEvent.click(tableContainer);

    expect(onSelectionChange).toHaveBeenLastCalledWith([]);
  });

  it("reports clearing selection when currentPath changes", () => {
    const onSelectionChange = vi.fn();
    const { rerender } = render(
      <TableHarness currentPath="/home" onSelectionChange={onSelectionChange} />,
    );

    fireEvent.click(screen.getByTestId("explorer-entry-alpha.txt"));
    expect(onSelectionChange).toHaveBeenLastCalledWith([TEST_ENTRIES[0]]);

    // Navigate to a new directory
    rerender(<TableHarness currentPath="/var/log" onSelectionChange={onSelectionChange} />);
    expect(onSelectionChange).toHaveBeenLastCalledWith([]);
  });

  it("functions without errors when onSelectionChange is omitted", () => {
    const { container } = render(<TableHarness onSelectionChange={undefined} />);

    const row = screen.getByTestId("explorer-entry-alpha.txt");
    expect(() => {
      fireEvent.click(row);
      fireEvent.click(screen.getByTestId("explorer-entry-bravo.txt"), { metaKey: true });
      fireEvent.click(screen.getByTestId("explorer-entry-charlie.txt"), { shiftKey: true });
      fireEvent.keyDown(row, { key: "ArrowDown" });
      fireEvent.keyDown(row, { key: "a", metaKey: true });
      const tableContainer = container.querySelector(".overflow-y-scroll") as HTMLElement;
      fireEvent.click(tableContainer);
    }).not.toThrow();
  });
});
