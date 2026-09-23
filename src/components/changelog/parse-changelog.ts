/*
 * Minimal parser for the Keep-a-Changelog markdown in the repo's CHANGELOG.md,
 * tailored to the shapes that file actually uses: `## [x.y.z] - date` entries,
 * `###` sections, `####` sub-groups, and `*`/`-` bullets (indented bullets are
 * nested items). Intro text, horizontal-rule separators, and link-reference
 * definitions are skipped. No markdown library — the changelog page only needs
 * this structured shape to render itself.
 */
export interface ChangelogItem {
  text: string;
  /** 0 = top-level bullet, 1 = indented/nested bullet (capped at 1). */
  depth: number;
}

export interface ChangelogGroup {
  title: string | null;
  items: ChangelogItem[];
}

export interface ChangelogSection {
  title: string;
  groups: ChangelogGroup[];
}

export interface ChangelogEntry {
  version: string;
  date: string | null;
  sections: ChangelogSection[];
}

const ENTRY_RE = /^## \[([^\]]+)\](?:\s+-\s+(.+))?$/;
const SECTION_RE = /^### (.+)$/;
const GROUP_RE = /^#### (.+)$/;
const ITEM_RE = /^(\s*)([*+-])\s+(.+)$/;
const SKIP_RE = /^(?:---+|\[[^\]]+\]:\S*.*)$/;

export function parseChangelog(markdown: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  let entry: ChangelogEntry | null = null;
  let section: ChangelogSection | null = null;
  let group: ChangelogGroup | null = null;

  const ensureSection = (): ChangelogSection => {
    if (!section) {
      section = { title: "", groups: [] };
      entry!.sections.push(section);
    }
    return section;
  };

  const ensureGroup = (): ChangelogGroup => {
    if (!group) {
      group = { title: null, items: [] };
      ensureSection().groups.push(group);
    }
    return group;
  };

  for (const rawLine of markdown.split(/\r?\n/)) {
    const entryMatch = ENTRY_RE.exec(rawLine);
    if (entryMatch) {
      entry = { version: entryMatch[1], date: entryMatch[2] ?? null, sections: [] };
      entries.push(entry);
      section = null;
      group = null;
      continue;
    }
    if (!entry) continue; // intro text before the first entry
    if (SKIP_RE.test(rawLine)) continue;

    const sectionMatch = SECTION_RE.exec(rawLine);
    if (sectionMatch) {
      section = { title: sectionMatch[1], groups: [] };
      entry.sections.push(section);
      group = null;
      continue;
    }

    const groupMatch = GROUP_RE.exec(rawLine);
    if (groupMatch) {
      group = { title: groupMatch[1], items: [] };
      ensureSection().groups.push(group);
      continue;
    }

    const itemMatch = ITEM_RE.exec(rawLine);
    if (itemMatch) {
      const depth = itemMatch[1].length > 0 ? 1 : 0;
      ensureGroup().items.push({ text: itemMatch[3], depth });
      continue;
    }

    // Continuation of the previous bullet; anything else unstructured is dropped.
    const current = group?.items[group.items.length - 1];
    if (rawLine.trim() && current) {
      current.text += ` ${rawLine.trim()}`;
    }
  }

  // Drop empty sections (e.g. an `## [Unreleased]` heading with no content).
  return entries
    .map((e) => ({
      ...e,
      sections: e.sections.filter((s) => s.groups.some((g) => g.items.length > 0)),
    }))
    .filter((e) => e.sections.length > 0);
}
