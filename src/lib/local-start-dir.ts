/*
 * Resolve configured local start directory candidates in precedence order:
 * host-specific folder first, followed by the global default folder.
 * Returns trimmed, non-empty, deduplicated paths; excludes home.
 */

export interface LocalStartSettings {
  explorerDefaultLocalDir: string;
  explorerHostLocalDirs: Record<string, string>;
}

export function resolveLocalStartCandidates(
  hostId: string | null | undefined,
  settings: LocalStartSettings,
): string[] {
  const candidates: string[] = [];

  if (hostId && settings.explorerHostLocalDirs) {
    const hostDir = settings.explorerHostLocalDirs[hostId];
    if (typeof hostDir === "string") {
      const trimmed = hostDir.trim();
      if (trimmed.length > 0) {
        candidates.push(trimmed);
      }
    }
  }

  if (typeof settings.explorerDefaultLocalDir === "string") {
    const defaultDir = settings.explorerDefaultLocalDir.trim();
    if (defaultDir.length > 0 && !candidates.includes(defaultDir)) {
      candidates.push(defaultDir);
    }
  }

  return candidates;
}
