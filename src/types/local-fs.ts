/*
 * Types for local filesystem inspection and navigation.
 * Mirrors the Rust types returned by `local_list_dir` and `local_home_dir`.
 */

export interface BreadcrumbSegment {
  label: string;
  path: string;
}

export interface LocalEntry {
  name: string;
  path: string;
  entry_type: "File" | "Directory" | "Symlink" | "Other";
  size: number;
  modified: number | null;
  is_symlink: boolean;
  permissions: number | null;
  permissions_display: string | null;
}

export interface LocalDirectoryListing {
  path: string;
  parent: string | null;
  segments: BreadcrumbSegment[];
  entries: LocalEntry[];
}
