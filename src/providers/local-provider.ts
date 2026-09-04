/*
 * Operations adapter for the local filesystem browser.
 *
 * Implements `FileSystemProvider` with read-only capabilities (mutation actions
 * such as delete, rename, upload, download, and file creation disabled).
 * Derives parent and root paths platform-agnostically and converts native
 * `LocalEntry` records into normalized `ExplorerEntry` objects for the shared
 * explorer table.
 */

import type { LocalEntry } from "../types/local-fs";
import type { ExplorerEntry, ProviderCapabilities, FileSystemProvider } from "../types/explorer";

/*
 * Converts a backend `LocalEntry` into the normalized `ExplorerEntry` contract
 * consumed by `ExplorerFileTable` and related explorer views.
 */
export function toLocalExplorerEntry(e: LocalEntry): ExplorerEntry {
  return {
    name: e.name,
    id: e.path,
    entryType: e.entry_type === "Directory" ? "Directory" : "File",
    size: e.size,
    modified: e.modified,
    permissionsDisplay: e.permissions_display,
    permissions: e.permissions,
    isSymlink: e.is_symlink,
    storageClass: null,
  };
}

const LOCAL_CAPABILITIES: ProviderCapabilities = {
  canRename: false,
  canCreateFile: false,
  canCreateFolder: false,
  canDelete: false,
  canUpload: false,
  canDownload: false,
  canDragDropUpload: false,
  canInternalDragMove: false,
  canCopyPaste: false,
  canEditInEditor: false,
  canGetInfo: true,
  hasPermissions: true,
  hasStorageClass: false,
  canPresignUrl: false,
};

export interface LocalProviderOptions {
  sessionId?: string;
  homePath?: string;
  rootPath?: string;
  rootLabel?: string;
  parentPath?: (path: string) => string;
}

/*
 * Creates a `FileSystemProvider` backed by local filesystem listings.
 * Path separators, roots, and home navigation fall back to listing metadata
 * passed in via options.
 */
export function createLocalProvider(options: LocalProviderOptions = {}): FileSystemProvider {
  const sessionId = options.sessionId ?? "local";

  return {
    type: "local",
    sessionId,
    capabilities: LOCAL_CAPABILITIES,
    joinPath(parent: string, child: string): string {
      const isWindows = parent.includes("\\") || /^[a-zA-Z]:/.test(parent);
      const sep = isWindows ? "\\" : "/";
      if (parent.endsWith(sep) || parent.endsWith("/")) {
        return `${parent}${child}`;
      }
      return `${parent}${sep}${child}`;
    },
    parentPath(path: string): string {
      if (options.parentPath) {
        return options.parentPath(path);
      }
      const isWindows = path.includes("\\") || /^[a-zA-Z]:/.test(path);
      const sep = isWindows ? "\\" : "/";
      const trimmed = path.endsWith(sep) || path.endsWith("/") ? path.slice(0, -1) : path;
      const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
      if (idx <= 0) {
        return options.rootPath ?? (isWindows ? (trimmed.match(/^[a-zA-Z]:[/\\]?/)?.[0] ?? "C:\\") : "/");
      }
      return trimmed.substring(0, idx);
    },
    rootLabel(): string {
      return options.rootLabel ?? options.rootPath ?? "/";
    },
    rootPath(): string {
      return options.rootPath ?? "/";
    },
    homePath(): string {
      return options.homePath ?? "";
    },
    isAtRoot(path: string): boolean {
      const root = options.rootPath ?? "/";
      return path === root;
    },
    normalizePath(raw: string): string {
      const trimmed = raw.trim();
      const root = options.rootPath ?? "/";
      if (trimmed === root) return root;
      const stripped = trimmed.replace(/[/\\]+$/, "");
      return stripped === "" ? root : stripped;
    },
  };
}
