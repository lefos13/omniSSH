import { Rocket } from "lucide-react";
import changelogRaw from "../../../CHANGELOG.md?raw";
import { parseChangelog, type ChangelogItem } from "./parse-changelog";
import { useUpdaterStore } from "../../stores/updater-store";

/*
 * In-app "What's new" screen rendering the repo's CHANGELOG.md. The raw file is
 * bundled at build time and parsed once at module load; sections/groups/bullets
 * map onto headings and lists, with lightweight inline support for bold, code,
 * and links. The entry matching the running version gets a "Current" badge.
 */
const ENTRIES = parseChangelog(changelogRaw);

const INLINE_RE = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/;

function InlineText({ text }: { text: string }) {
  const parts = text.split(new RegExp(INLINE_RE, "g")).filter((p) => p !== "");

  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith("**") && part.endsWith("**")) {
          return (
            <strong key={i} className="font-semibold text-text-primary">
              {part.slice(2, -2)}
            </strong>
          );
        }
        if (part.startsWith("`") && part.endsWith("`")) {
          return (
            <code
              key={i}
              className="px-1 py-0.5 rounded bg-bg-subtle border border-border/60 text-[length:var(--text-xs)] font-mono text-text-secondary"
            >
              {part.slice(1, -1)}
            </code>
          );
        }
        const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
        if (link) {
          return (
            <button
              key={i}
              type="button"
              onClick={() => {
                void (async () => {
                  try {
                    const { openUrl } = await import("@tauri-apps/plugin-opener");
                    await openUrl(link[2]);
                  } catch {
                    /* best-effort */
                  }
                })();
              }}
              className="text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
            >
              {link[1]}
            </button>
          );
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}

function ItemRow({ item }: { item: ChangelogItem }) {
  return (
    <li
      className={`flex gap-2 text-[length:var(--text-sm)] leading-relaxed text-text-secondary ${
        item.depth > 0 ? "ml-5 mt-1" : "mt-1"
      }`}
    >
      <span aria-hidden="true" className="shrink-0 text-accent">
        {item.depth > 0 ? "›" : "•"}
      </span>
      <span className="min-w-0">
        <InlineText text={item.text} />
      </span>
    </li>
  );
}

export function ChangelogPage() {
  const appVersion = useUpdaterStore((s) => s.appVersion);

  return (
    <div
      data-testid="changelog-page"
      className="flex flex-col h-full overflow-y-scroll bg-bg-base"
    >
      <div className="max-w-4xl w-full mx-auto px-8 py-8 flex flex-col gap-8">
        {/* Page title */}
        <div>
          <h1 className="text-[length:var(--text-lg)] font-semibold text-text-primary">
            What's new
          </h1>
          <p className="text-[length:var(--text-xs)] text-text-muted mt-1">
            Everything that changed in OmniSSH, release by release
          </p>
        </div>

        <div className="flex flex-col gap-10">
          {ENTRIES.map((entry) => {
            const isCurrent = entry.version === appVersion;
            return (
              <article
                key={entry.version}
                data-testid={`changelog-entry-${entry.version}`}
                className="flex flex-col gap-4"
              >
                {/* Version header */}
                <div className="flex items-center gap-3 flex-wrap">
                  <Rocket
                    size={16}
                    strokeWidth={1.8}
                    className="text-accent shrink-0"
                    aria-hidden="true"
                  />
                  <h2 className="text-[length:var(--text-base)] font-semibold text-text-primary">
                    v{entry.version}
                  </h2>
                  {entry.date && (
                    <span className="text-[length:var(--text-xs)] text-text-muted">
                      {entry.date}
                    </span>
                  )}
                  {isCurrent && (
                    <span className="px-2 py-0.5 rounded-full bg-accent/10 text-accent text-[length:var(--text-2xs)] font-medium uppercase tracking-wide">
                      Current
                    </span>
                  )}
                </div>

                {entry.sections.map((section, si) => (
                  <section key={`${entry.version}-${si}`} className="flex flex-col gap-3">
                    {section.title && (
                      <h3 className="text-[length:var(--text-sm)] font-semibold text-text-primary">
                        {section.title}
                      </h3>
                    )}
                    {section.groups.map((group, gi) => (
                      <div key={gi} className="flex flex-col gap-1">
                        {group.title && (
                          <h4 className="text-[length:var(--text-sm)] font-medium text-text-secondary">
                            {group.title}
                          </h4>
                        )}
                        <ul className="flex flex-col">
                          {group.items.map((item, ii) => (
                            <ItemRow key={ii} item={item} />
                          ))}
                        </ul>
                      </div>
                    ))}
                  </section>
                ))}
              </article>
            );
          })}
        </div>
      </div>
    </div>
  );
}
