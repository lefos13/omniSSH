import { useState, useEffect, useCallback, useRef } from "react";
import { ModalShell, BTN_GHOST, BTN_PRIMARY, BTN_DANGER } from "../shared/ModalShell";
import { ModalBackdrop } from "../shared/ModalBackdrop";
import { useSettingsStore } from "../../stores/settings-store";
import { CustomSelect, type SelectOption } from "../shared/CustomSelect";
import { useUpdaterStore } from "../../stores/updater-store";
import { toast } from "../../stores/toast-store";
import { RefreshCw, CheckCircle2, AlertCircle, Palette, SquareTerminal, ArrowUpDown, Info, ExternalLink, Check, FileCode, Plus, Trash2, FolderOpen, Star, Search, Database, Download, Upload, ShieldCheck, KeyRound, Puzzle, Pencil, Globe, Server, AlertTriangle, History } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { CursorStyle, ThemeMode, EditorConfig, PasteButton, DoubleClickAction } from "../../stores/settings-store";
import type { BackupPreflightSummary, BulkMigrationResult, CredentialStorage, MigrationPreflightSummary, TerminalHighlightRule, SyncAppliedCounts, SyncConflictEntry, SyncDatasetSummary, SyncErrorKind, SyncHistoryCounts, SyncHistoryEntry, SyncPhase, SyncPushOutcome, SyncStatusSnapshot } from "../../types";
import { useLocalVaultStore } from "../../stores/local-vault-store";
import { useHostsStore } from "../../stores/hosts-store";
import { useGroupsStore } from "../../stores/groups-store";
import { useSyncStore } from "../../stores/sync-store";
import type { SyncScheduleInput } from "../../stores/sync-store";
import { ConfirmDangerDialog } from "../shared/ConfirmDangerDialog";
import { ChangeVaultPasswordDialog, CreateVaultDialog, UnlockVaultDialog, VaultDefaultStorageDialog } from "../vault";
import { TerminalHighlightModal } from "./TerminalHighlightModal";
import { SyncDatasetModal, SyncSaveReport } from "./SyncDatasetModal";
import { isLightColor } from "../../lib/terminal-highlighter";
import { relativeTime } from "../../utils/time";



// ─── Shared styles ───────────────────────────────────────────────────────────

const LABEL_CLASS = "text-[length:var(--text-sm)] font-medium text-text-primary";
const DESC_CLASS = "text-[length:var(--text-xs)] text-text-muted mt-0.5";

const INPUT_CLASS = [
  "w-20 px-2.5 py-1.5 rounded-lg text-[length:var(--text-sm)] tabular-nums",
  "bg-bg-base border border-border text-text-primary",
  "outline-none focus:border-border-focus focus:ring-2 focus:ring-ring",
  "transition-[border-color,box-shadow] duration-[var(--duration-fast)]",
].join(" ");

const BTN_SECONDARY = [
  "flex items-center gap-1.5 px-3 py-1.5 rounded-lg shrink-0",
  "text-[length:var(--text-sm)] font-medium",
  "bg-bg-base border border-border text-text-secondary",
  "hover:text-text-primary hover:border-border-focus",
  "disabled:opacity-50 disabled:pointer-events-none",
  "transition-all duration-[var(--duration-fast)]",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
].join(" ");

// Mirrors the input/label styling used by the Host modal so dialogs feel uniform.
const TEXT_INPUT_CLASS = [
  "w-full px-3 py-2 rounded-lg text-[length:var(--text-sm)]",
  "bg-bg-base border border-border text-text-primary placeholder:text-text-muted",
  "outline-none focus:border-border-focus focus:ring-2 focus:ring-ring",
  "transition-[border-color,box-shadow] duration-[var(--duration-fast)]",
].join(" ");

const FIELD_LABEL_CLASS = "block text-[length:var(--text-xs)] font-medium text-text-secondary mb-1";

const REPO_URL = "https://github.com/lefos13/omniSSH";

// ─── Sections ─────────────────────────────────────────────────────────────────
// Each settings category is a section here. To add a new category, add an entry
// to SECTIONS, a description, and render its content in <SectionContent />.

type SectionId = "appearance" | "terminal" | "explorer" | "transfers" | "editors" | "plugins" | "security" | "sync" | "data" | "about";

const SECTIONS: { id: SectionId; label: string; icon: LucideIcon }[] = [
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "terminal", label: "Terminal", icon: SquareTerminal },
  { id: "explorer", label: "Explorer", icon: FolderOpen },
  { id: "transfers", label: "Transfers", icon: ArrowUpDown },
  { id: "editors", label: "Editors", icon: FileCode },
  { id: "plugins", label: "Plugins", icon: Puzzle },
  { id: "security", label: "Security & Vault", icon: KeyRound },
  { id: "sync", label: "Dataset Sync", icon: RefreshCw },
  { id: "data", label: "Data", icon: Database },
  { id: "about", label: "About & Updates", icon: Info },
];

const SECTION_DESCRIPTIONS: Record<SectionId, string> = {
  appearance: "Theme and interface look.",
  terminal: "Font, cursor, and scrollback history.",
  explorer: "How the file browser behaves.",
  transfers: "Control how files are transferred.",
  editors: "Editors used by “Edit” / “Open With” in the file browser.",
  plugins: "Enable built-in host trackers and set their defaults.",
  security: "Manage encrypted local host passwords.",
  sync: "Keep your hosts on a server you own, encrypted end to end.",
  data: "Back up, restore, and reset your data.",
  about: "App information, links, and updates.",
};

// Remember the last-open section across tab switches. The settings page
// unmounts when another tab is active, so component state alone would reset.
let lastSettingsSection: SectionId = "appearance";

// ─── Component ───────────────────────────────────────────────────────────────

export function SettingsPage() {
  const [active, setActive] = useState<SectionId>(() => lastSettingsSection);
  const selectSection = (id: SectionId) => { lastSettingsSection = id; setActive(id); };
  const activeSection = SECTIONS.find((s) => s.id === active);

  return (
    <div className="flex flex-col h-full p-2">
      <div className="flex flex-1 min-h-0 rounded-lg overflow-hidden border border-border/60">
        {/* Sidebar */}
        <nav
          aria-label="Settings sections"
          className="w-60 shrink-0 flex flex-col gap-1 px-3 py-4 border-r border-border/50 bg-bg-surface/40 overflow-y-auto no-select"
        >
          <h2 className="px-3 pt-1 pb-2 text-[length:var(--text-2xs)] font-semibold uppercase tracking-wider text-text-muted">
            Settings
          </h2>
          {SECTIONS.map(({ id, label, icon: Icon }) => {
            const isActive = active === id;
            return (
              <button
                key={id}
                type="button"
                data-testid={`settings-nav-${id}`}
                aria-current={isActive ? "page" : undefined}
                onClick={() => selectSection(id)}
                className={[
                  "flex items-center gap-2.5 px-3 py-2 rounded-lg text-left",
                  "text-[length:var(--text-sm)] font-medium",
                  "transition-colors duration-[var(--duration-fast)]",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  isActive
                    ? "bg-bg-overlay text-text-primary border border-border/60 shadow-[var(--shadow-sm)]"
                    : "text-text-secondary border border-transparent hover:text-text-primary hover:bg-bg-overlay/50",
                ].join(" ")}
              >
                <Icon
                  size={17}
                  strokeWidth={isActive ? 2 : 1.6}
                  className={`shrink-0 ${isActive ? "text-accent" : "text-text-muted"}`}
                />
                {label}
              </button>
            );
          })}
        </nav>

        {/* Content */}
        <div className="flex-1 overflow-y-scroll bg-bg-base">
          <div className="max-w-4xl mx-auto px-8 py-6">
            {/* Section header */}
            <div className="mb-6">
              <h1 className="text-2xl font-semibold tracking-tight text-text-primary">
                {activeSection?.label}
              </h1>
              <p className="text-[length:var(--text-sm)] text-text-muted mt-1.5">
                {SECTION_DESCRIPTIONS[active]}
              </p>
            </div>

            <SectionContent section={active} />
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Section content ───────────────────────────────────────────────────────────

function SectionContent({ section }: { section: SectionId }) {
  switch (section) {
    case "appearance":
      return <AppearanceSettings />;
    case "terminal":
      return <TerminalSettings />;
    case "explorer":
      return <ExplorerSettings />;
    case "transfers":
      return <TransferSettings />;
    case "editors":
      return <EditorsSettings />;
    case "plugins":
      return <PluginsSettings />;
    case "security":
      return <SecuritySettings />;
    case "sync":
      return <SyncSettings />;
    case "data":
      return <DataSettings />;
    case "about":
      return <AboutSettings />;
  }
}

// Candidates for the interface font. Entries without a `family` are always
// offered (Geist is bundled; System UI is a generic). Entries with a `family`
// are only shown when that font is actually installed (see availableFonts),
// since an unavailable font silently falls back to the system default.
const INTERFACE_FONT_CANDIDATES: { value: string; label: string; family?: string }[] = [
  { value: "'Geist', system-ui, sans-serif", label: "Geist (Default)" },
  { value: "system-ui, sans-serif", label: "System UI" },
  { value: "'Arial', system-ui, sans-serif", label: "Arial", family: "Arial" },
  { value: "'Avenir', system-ui, sans-serif", label: "Avenir", family: "Avenir" },
  { value: "'Avenir Next', system-ui, sans-serif", label: "Avenir Next", family: "Avenir Next" },
  { value: "'Calibri', system-ui, sans-serif", label: "Calibri", family: "Calibri" },
  { value: "'Cantarell', system-ui, sans-serif", label: "Cantarell", family: "Cantarell" },
  { value: "'DejaVu Sans', system-ui, sans-serif", label: "DejaVu Sans", family: "DejaVu Sans" },
  { value: "'Fira Sans', system-ui, sans-serif", label: "Fira Sans", family: "Fira Sans" },
  { value: "'FreeSans', system-ui, sans-serif", label: "FreeSans", family: "FreeSans" },
  { value: "'Helvetica', system-ui, sans-serif", label: "Helvetica", family: "Helvetica" },
  { value: "'Helvetica Neue', system-ui, sans-serif", label: "Helvetica Neue", family: "Helvetica Neue" },
  { value: "'Inter', system-ui, sans-serif", label: "Inter", family: "Inter" },
  { value: "'Lato', system-ui, sans-serif", label: "Lato", family: "Lato" },
  { value: "'Liberation Sans', system-ui, sans-serif", label: "Liberation Sans", family: "Liberation Sans" },
  { value: "'Lucida Grande', system-ui, sans-serif", label: "Lucida Grande", family: "Lucida Grande" },
  { value: "'Nimbus Sans', system-ui, sans-serif", label: "Nimbus Sans", family: "Nimbus Sans" },
  { value: "'Noto Sans', system-ui, sans-serif", label: "Noto Sans", family: "Noto Sans" },
  { value: "'Open Sans', system-ui, sans-serif", label: "Open Sans", family: "Open Sans" },
  { value: "'Roboto', system-ui, sans-serif", label: "Roboto", family: "Roboto" },
  { value: "'Segoe UI', system-ui, sans-serif", label: "Segoe UI", family: "Segoe UI" },
  { value: "'Source Sans 3', system-ui, sans-serif", label: "Source Sans 3", family: "Source Sans 3" },
  { value: "'Source Sans Pro', system-ui, sans-serif", label: "Source Sans Pro", family: "Source Sans Pro" },
  { value: "'Tahoma', system-ui, sans-serif", label: "Tahoma", family: "Tahoma" },
  { value: "'Trebuchet MS', system-ui, sans-serif", label: "Trebuchet MS", family: "Trebuchet MS" },
  { value: "'Ubuntu', system-ui, sans-serif", label: "Ubuntu", family: "Ubuntu" },
  { value: "'Verdana', system-ui, sans-serif", label: "Verdana", family: "Verdana" },
  { value: "'Work Sans', system-ui, sans-serif", label: "Work Sans", family: "Work Sans" },
];

// Monospace candidates for the terminal. The default matches the store's
// terminalFontFamily so it selects correctly; JetBrains Mono is bundled.
const TERMINAL_FONT_CANDIDATES: FontCandidate[] = [
  { value: "'JetBrains Mono', 'Fira Code', 'SF Mono', Menlo, monospace", label: "JetBrains Mono (Default)" },
  { value: "'JetBrainsMono Nerd Font', 'JetBrains Mono', monospace", label: "JetBrains Nerd Font (icons)" },
  { value: "monospace", label: "System Monospace" },
  { value: "'Cascadia Code', monospace", label: "Cascadia Code", family: "Cascadia Code" },
  { value: "'Cascadia Mono', monospace", label: "Cascadia Mono", family: "Cascadia Mono" },
  { value: "'Consolas', monospace", label: "Consolas", family: "Consolas" },
  { value: "'Courier New', monospace", label: "Courier New", family: "Courier New" },
  { value: "'DejaVu Sans Mono', monospace", label: "DejaVu Sans Mono", family: "DejaVu Sans Mono" },
  { value: "'Fira Code', monospace", label: "Fira Code", family: "Fira Code" },
  { value: "'Fira Mono', monospace", label: "Fira Mono", family: "Fira Mono" },
  { value: "'Hack', monospace", label: "Hack", family: "Hack" },
  { value: "'IBM Plex Mono', monospace", label: "IBM Plex Mono", family: "IBM Plex Mono" },
  { value: "'Inconsolata', monospace", label: "Inconsolata", family: "Inconsolata" },
  { value: "'Liberation Mono', monospace", label: "Liberation Mono", family: "Liberation Mono" },
  { value: "'Menlo', monospace", label: "Menlo", family: "Menlo" },
  { value: "'Monaco', monospace", label: "Monaco", family: "Monaco" },
  { value: "'Noto Sans Mono', monospace", label: "Noto Sans Mono", family: "Noto Sans Mono" },
  { value: "'Roboto Mono', monospace", label: "Roboto Mono", family: "Roboto Mono" },
  { value: "'SF Mono', monospace", label: "SF Mono", family: "SF Mono" },
  { value: "'Source Code Pro', monospace", label: "Source Code Pro", family: "Source Code Pro" },
  { value: "'Ubuntu Mono', monospace", label: "Ubuntu Mono", family: "Ubuntu Mono" },
];

// Monospace candidates for the UI (`--font-mono`: permissions, paths, kbd,
// snippets, addresses). JetBrains Mono (the default) is bundled; "System UI"
// uses the OS UI monospace (`ui-monospace`). The rest are common system fonts,
// filtered to those actually installed.
const INTERFACE_MONO_FONT_CANDIDATES: FontCandidate[] = [
  { value: "'JetBrains Mono', 'Fira Code', ui-monospace, monospace", label: "JetBrains Mono (Default)" },
  { value: "ui-monospace, monospace", label: "System UI" },
  { value: "'Cascadia Code', monospace", label: "Cascadia Code", family: "Cascadia Code" },
  { value: "'Cascadia Mono', monospace", label: "Cascadia Mono", family: "Cascadia Mono" },
  { value: "'Consolas', monospace", label: "Consolas", family: "Consolas" },
  { value: "'DejaVu Sans Mono', monospace", label: "DejaVu Sans Mono", family: "DejaVu Sans Mono" },
  { value: "'Fira Code', monospace", label: "Fira Code", family: "Fira Code" },
  { value: "'Hack', monospace", label: "Hack", family: "Hack" },
  { value: "'IBM Plex Mono', monospace", label: "IBM Plex Mono", family: "IBM Plex Mono" },
  { value: "'Menlo', monospace", label: "Menlo", family: "Menlo" },
  { value: "'Roboto Mono', monospace", label: "Roboto Mono", family: "Roboto Mono" },
  { value: "'SF Mono', monospace", label: "SF Mono", family: "SF Mono" },
  { value: "'Source Code Pro', monospace", label: "Source Code Pro", family: "Source Code Pro" },
  { value: "'Ubuntu Mono', monospace", label: "Ubuntu Mono", family: "Ubuntu Mono" },
];

/**
 * Whether a named font is actually installed. document.fonts.check() is
 * unreliable (it returns true for unknown names), so measure a test string:
 * if rendering with the font matches every generic fallback exactly, the font
 * isn't present and the browser fell back.
 */
function isFontAvailable(family: string): boolean {
  if (typeof document === "undefined") return false;
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return false;
  const sample = "mmmmmmmmmmlli MWQ 0123";
  const size = "72px";
  for (const base of ["monospace", "serif", "sans-serif"]) {
    ctx.font = `${size} ${base}`;
    const baseWidth = ctx.measureText(sample).width;
    ctx.font = `${size} "${family}", ${base}`;
    if (ctx.measureText(sample).width !== baseWidth) return true;
  }
  return false;
}

type FontCandidate = { value: string; label: string; family?: string };

/** Filter candidates down to those actually installed on this system. */
function filterInstalledFonts(candidates: FontCandidate[]): SelectOption[] {
  return candidates
    .filter((f) => !f.family || isFontAvailable(f.family))
    .map(({ value, label }) => ({ value, label }));
}

/** Font-picker options: installed candidates, re-checked once web fonts load,
 *  with the current value kept selectable even if it isn't detected. */
function useInstalledFontOptions(candidates: FontCandidate[], current: string): SelectOption[] {
  const [available, setAvailable] = useState<SelectOption[]>(() => filterInstalledFonts(candidates));
  useEffect(() => {
    let cancelled = false;
    document.fonts?.ready?.then(() => { if (!cancelled) setAvailable(filterInstalledFonts(candidates)); }).catch(() => {});
    return () => { cancelled = true; };
  }, [candidates]);
  if (available.some((o) => o.value === current)) return available;
  const cur = candidates.find((c) => c.value === current);
  return [{ value: current, label: cur?.label ?? "Current" }, ...available];
}

const ACCENT_PRESETS: { name: string; hue: number }[] = [
  { name: "Blue", hue: 250 },
  { name: "Indigo", hue: 277 },
  { name: "Violet", hue: 300 },
  { name: "Pink", hue: 350 },
  { name: "Red", hue: 25 },
  { name: "Orange", hue: 70 },
  { name: "Green", hue: 150 },
  { name: "Teal", hue: 195 },
];

function AppearanceSettings() {
  const themeMode = useSettingsStore((s) => s.themeMode);
  const setThemeMode = useSettingsStore((s) => s.setThemeMode);
  const accentHue = useSettingsStore((s) => s.accentHue);
  const setAccentHue = useSettingsStore((s) => s.setAccentHue);
  const accentCustom = useSettingsStore((s) => s.accentCustom);
  const setAccentCustom = useSettingsStore((s) => s.setAccentCustom);
  const interfaceFont = useSettingsStore((s) => s.interfaceFont);
  const setInterfaceFont = useSettingsStore((s) => s.setInterfaceFont);
  const interfaceMonoFont = useSettingsStore((s) => s.interfaceMonoFont);
  const setInterfaceMonoFont = useSettingsStore((s) => s.setInterfaceMonoFont);

  const fontOptions = useInstalledFontOptions(INTERFACE_FONT_CANDIDATES, interfaceFont);
  const monoFontOptions = useInstalledFontOptions(INTERFACE_MONO_FONT_CANDIDATES, interfaceMonoFont);

  const [wheelOpen, setWheelOpen] = useState(false);
  const customRef = useRef<HTMLDivElement>(null);
  const isCustom = accentCustom !== null;
  const working = accentCustom ?? { l: 0.70, c: 0.15, h: accentHue };
  const workingColor = `oklch(${working.l} ${working.c} ${working.h})`;
  const updateCustom = (patch: Partial<typeof working>) => setAccentCustom({ ...working, ...patch });

  // Close the wheel popover on outside click / Escape.
  useEffect(() => {
    if (!wheelOpen) return;
    const onDown = (e: PointerEvent) => {
      if (customRef.current && !customRef.current.contains(e.target as Node)) setWheelOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setWheelOpen(false); };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [wheelOpen]);

  return (
    <>
    <SettingsGroup label="Theme">
      <SettingRow>
        <div>
          <p className={LABEL_CLASS}>Color Theme</p>
          <p className={DESC_CLASS}>Switch between the dark and softer grey light interface</p>
        </div>
        <SegmentedControl<ThemeMode>
          id="s-light-theme"
          value={themeMode}
          onChange={setThemeMode}
          options={[
            { value: "dark", label: "Dark" },
            { value: "light", label: "Light" },
          ]}
        />
      </SettingRow>

      <SettingRow>
        <div>
          <p className={LABEL_CLASS}>Accent Color</p>
          <p className={DESC_CLASS}>Used for buttons, links, and active states</p>
        </div>
        <div className="flex items-center gap-2.5 shrink-0">
          {ACCENT_PRESETS.map((preset) => {
            const selected = !isCustom && accentHue === preset.hue;
            const color = `oklch(0.70 0.15 ${preset.hue})`;
            return (
              <button
                key={preset.hue}
                type="button"
                title={preset.name}
                aria-label={preset.name}
                aria-pressed={selected}
                data-testid={`s-accent-${preset.hue}`}
                onClick={() => setAccentHue(preset.hue)}
                className="relative flex items-center justify-center w-6 h-6 rounded-full shrink-0 transition-transform duration-[var(--duration-fast)] hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                style={{
                  backgroundColor: color,
                  boxShadow: selected ? `0 0 0 2px var(--color-bg-surface), 0 0 0 4px ${color}` : undefined,
                }}
              >
                {selected && <Check size={13} strokeWidth={3} className="text-white" />}
              </button>
            );
          })}

          {/* Custom — a rainbow swatch that opens the hue wheel */}
          <div className="relative" ref={customRef}>
            <button
              type="button"
              title="Custom"
              aria-label="Custom color"
              aria-haspopup="dialog"
              aria-expanded={wheelOpen}
              aria-pressed={isCustom}
              data-testid="s-accent-custom"
              onClick={() => setWheelOpen((o) => !o)}
              className="relative flex items-center justify-center w-6 h-6 rounded-full shrink-0 transition-transform duration-[var(--duration-fast)] hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              style={{
                background: isCustom
                  ? workingColor
                  : "conic-gradient(oklch(0.70 0.15 0), oklch(0.70 0.15 60), oklch(0.70 0.15 120), oklch(0.70 0.15 180), oklch(0.70 0.15 240), oklch(0.70 0.15 300), oklch(0.70 0.15 360))",
                boxShadow: isCustom ? `0 0 0 2px var(--color-bg-surface), 0 0 0 4px ${workingColor}` : undefined,
              }}
            >
              {isCustom && <Check size={13} strokeWidth={3} className="text-white [filter:drop-shadow(0_1px_1px_rgb(0_0_0/0.5))]" />}
            </button>

            {wheelOpen && (
              <div
                role="dialog"
                aria-label="Custom accent color"
                className="absolute right-0 top-full mt-2 z-50 flex flex-col items-center gap-2 p-3 rounded-xl bg-bg-overlay border border-border shadow-[var(--shadow-lg)]"
              >
                <HueWheel
                  hue={working.h}
                  l={working.l}
                  c={working.c}
                  onChange={(h) => updateCustom({ h })}
                  size={140}
                />
                <div className="w-full flex flex-col gap-2.5">
                  <label className="flex flex-col gap-1">
                    <span className="text-[length:var(--text-2xs)] uppercase tracking-wider text-text-muted">Lightness</span>
                    <input
                      type="range" min={0.45} max={0.85} step={0.01} value={working.l}
                      onChange={(e) => updateCustom({ l: Number(e.target.value) })}
                      className="w-full h-1.5 cursor-pointer"
                      style={{ accentColor: workingColor }}
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-[length:var(--text-2xs)] uppercase tracking-wider text-text-muted">Saturation</span>
                    <input
                      type="range" min={0} max={0.3} step={0.005} value={working.c}
                      onChange={(e) => updateCustom({ c: Number(e.target.value) })}
                      className="w-full h-1.5 cursor-pointer"
                      style={{ accentColor: workingColor }}
                    />
                  </label>
                </div>
              </div>
            )}
          </div>
        </div>
      </SettingRow>
    </SettingsGroup>

    <SettingsGroup label="Interface">
      <SettingRow>
        <div>
          <p className={LABEL_CLASS}>Interface Font</p>
          <p className={DESC_CLASS}>Font for menus, labels, and panels</p>
        </div>
        <CustomSelect
          id="s-interface-font"
          data-testid="s-interface-font"
          value={interfaceFont}
          onChange={setInterfaceFont}
          options={fontOptions}
          className="w-44"
          previewOptionFont
        />
      </SettingRow>
      <SettingRow>
        <div>
          <p className={LABEL_CLASS}>Interface Monospace Font</p>
          <p className={DESC_CLASS}>Font for paths, permissions, and code (not the terminal)</p>
        </div>
        <CustomSelect
          id="s-interface-mono-font"
          data-testid="s-interface-mono-font"
          value={interfaceMonoFont}
          onChange={setInterfaceMonoFont}
          options={monoFontOptions}
          className="w-44"
          previewOptionFont
        />
      </SettingRow>
    </SettingsGroup>
    </>
  );
}

/** Circular hue picker — click/drag around the ring to set the hue.
 *  Ring + thumb colours use the given lightness/chroma so the preview is honest
 *  (e.g. at zero chroma the ring turns gray). */
function HueWheel({ hue, onChange, size = 96, l = 0.70, c = 0.15 }: {
  hue: number; onChange: (h: number) => void; size?: number; l?: number; c?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);

  const setFromPointer = useCallback((clientX: number, clientY: number) => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const dx = clientX - (rect.left + rect.width / 2);
    const dy = clientY - (rect.top + rect.height / 2);
    let deg = Math.atan2(dx, -dy) * (180 / Math.PI);
    if (deg < 0) deg += 360;
    onChange(Math.round(deg) % 360);
  }, [onChange]);

  const r = size / 2;
  const ringWidth = 14;
  const tr = r - ringWidth / 2; // thumb track radius (centre of the ring band)
  const rad = (hue * Math.PI) / 180;
  const thumbX = r + tr * Math.sin(rad);
  const thumbY = r - tr * Math.cos(rad);

  const stops: string[] = [];
  for (let d = 0; d <= 360; d += 15) stops.push(`oklch(${l} ${c} ${d}) ${d}deg`);

  return (
    <div
      ref={ref}
      role="slider"
      aria-label="Accent hue"
      aria-valuemin={0}
      aria-valuemax={360}
      aria-valuenow={hue}
      tabIndex={0}
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        setFromPointer(e.clientX, e.clientY);
      }}
      onPointerMove={(e) => {
        if (e.buttons === 0) return;
        setFromPointer(e.clientX, e.clientY);
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight" || e.key === "ArrowUp") { e.preventDefault(); onChange((hue + 1) % 360); }
        if (e.key === "ArrowLeft" || e.key === "ArrowDown") { e.preventDefault(); onChange((hue + 359) % 360); }
      }}
      className="relative shrink-0 rounded-full cursor-pointer touch-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      style={{ width: size, height: size, background: `conic-gradient(${stops.join(", ")})` }}
    >
      {/* Donut hole — matches the card surface so the wheel reads as a ring */}
      <div className="absolute rounded-full bg-bg-overlay pointer-events-none" style={{ inset: ringWidth }} />
      {/* Thumb */}
      <span
        className="absolute w-4 h-4 rounded-full border-2 border-white shadow-[var(--shadow-md)] pointer-events-none -translate-x-1/2 -translate-y-1/2"
        style={{ left: thumbX, top: thumbY, backgroundColor: `oklch(${l} ${c} ${hue})` }}
      />
    </div>
  );
}

/*
 * Format a human-readable scope label for a highlight rule.
 */
function getHighlightScopeLabel(rule: TerminalHighlightRule, hosts: import("../../types").SavedHost[]): string {
  if (rule.scope === "global") return "Global";
  const matched = (rule.hostIds || [])
    .map((id) => hosts.find((h) => h.id === id)?.label || hosts.find((h) => h.id === id)?.host)
    .filter(Boolean);
  if (matched.length === 0) return "No hosts";
  if (matched.length === 1) return matched[0]!;
  return `${matched.length} hosts`;
}

function TerminalSettings() {
  const fontSize = useSettingsStore((s) => s.terminalFontSize);
  const cursorStyle = useSettingsStore((s) => s.terminalCursorStyle);
  const cursorBlink = useSettingsStore((s) => s.terminalCursorBlink);
  const lineHeight = useSettingsStore((s) => s.terminalLineHeight);
  const scrollback = useSettingsStore((s) => s.terminalScrollback);

  const setFontSize = useSettingsStore((s) => s.setTerminalFontSize);
  const setCursorStyle = useSettingsStore((s) => s.setTerminalCursorStyle);
  const setCursorBlink = useSettingsStore((s) => s.setTerminalCursorBlink);
  const setLineHeight = useSettingsStore((s) => s.setTerminalLineHeight);
  const setScrollback = useSettingsStore((s) => s.setTerminalScrollback);
  const fontFamily = useSettingsStore((s) => s.terminalFontFamily);
  const setFontFamily = useSettingsStore((s) => s.setTerminalFontFamily);
  const copyOnSelect = useSettingsStore((s) => s.terminalCopyOnSelect);
  const setCopyOnSelect = useSettingsStore((s) => s.setTerminalCopyOnSelect);
  const pasteButton = useSettingsStore((s) => s.terminalPasteButton);
  const setPasteButton = useSettingsStore((s) => s.setTerminalPasteButton);

  const highlightRules = useSettingsStore((s) => s.terminalHighlightRules);
  const addHighlightRule = useSettingsStore((s) => s.addTerminalHighlightRule);
  const updateHighlightRule = useSettingsStore((s) => s.updateTerminalHighlightRule);
  const removeHighlightRule = useSettingsStore((s) => s.removeTerminalHighlightRule);
  const toggleHighlightRule = useSettingsStore((s) => s.toggleTerminalHighlightRule);

  const [highlightModalOpen, setHighlightModalOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<TerminalHighlightRule | null>(null);
  const hosts = useHostsStore((s) => s.hosts);

  const handleSaveHighlightRule = (rule: Omit<TerminalHighlightRule, "id"> & { id?: string }) => {
    if (rule.id) {
      updateHighlightRule(rule.id, rule);
    } else {
      addHighlightRule(rule);
    }
  };

  const termFontOptions = useInstalledFontOptions(TERMINAL_FONT_CANDIDATES, fontFamily);

  return (
    <>
      <SettingsGroup label="Font">
        <SettingRow>
          <div>
            <label htmlFor="s-fontfamily" className={LABEL_CLASS}>Font Family</label>
            <p className={DESC_CLASS}>Monospace font used by terminals</p>
          </div>
          <CustomSelect
            id="s-fontfamily"
            data-testid="s-fontfamily"
            value={fontFamily}
            onChange={setFontFamily}
            options={termFontOptions}
            className="w-44"
            previewOptionFont
          />
        </SettingRow>

        <SettingRow>
          <div>
            <label htmlFor="s-fontsize" className={LABEL_CLASS}>Font Size</label>
            <p className={DESC_CLASS}>Size in pixels (8–42)</p>
          </div>
          <RangeSetting id="s-fontsize" value={fontSize} min={8} max={42} step={1} unit="px" onChange={setFontSize} />
        </SettingRow>

        <SettingRow>
          <div>
            <label htmlFor="s-lineheight" className={LABEL_CLASS}>Line Height</label>
            <p className={DESC_CLASS}>Spacing between lines (1.0–2.0)</p>
          </div>
          <RangeSetting id="s-lineheight" value={lineHeight} min={1.0} max={2.0} step={0.1} decimals={1} onChange={setLineHeight} />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup label="Cursor">
        <SettingRow>
          <div>
            <p className={LABEL_CLASS}>Cursor Style</p>
            <p className={DESC_CLASS}>Shape of the terminal cursor</p>
          </div>
          <SegmentedControl<CursorStyle>
            id="s-cursor"
            value={cursorStyle}
            onChange={setCursorStyle}
            options={[
              { value: "bar", label: "Bar" },
              { value: "block", label: "Block" },
              { value: "underline", label: "Underline" },
            ]}
          />
        </SettingRow>

        <SettingRow>
          <div>
            <label htmlFor="s-blink" className={LABEL_CLASS}>Cursor Blink</label>
            <p className={DESC_CLASS}>Animate the cursor</p>
          </div>
          <Toggle id="s-blink" checked={cursorBlink} onChange={setCursorBlink} />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup label="Clipboard">
        <SettingRow>
          <div>
            <label htmlFor="s-copyonselect" className={LABEL_CLASS}>Copy on Select</label>
            <p className={DESC_CLASS}>Copy highlighted text to the clipboard automatically</p>
          </div>
          <Toggle id="s-copyonselect" checked={copyOnSelect} onChange={setCopyOnSelect} />
        </SettingRow>

        <SettingRow>
          <div>
            <p className={LABEL_CLASS}>Paste Button</p>
            <p className={DESC_CLASS}>Mouse button that pastes the clipboard into the terminal</p>
          </div>
          <SegmentedControl<PasteButton>
            id="s-pastebutton"
            value={pasteButton}
            onChange={setPasteButton}
            options={[
              { value: "none", label: "Off" },
              { value: "right", label: "Right-click" },
              { value: "middle", label: "Middle-click" },
            ]}
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup label="Keyword Highlighting">
        {highlightRules.length === 0 ? (
          <div className="px-4 py-6 rounded-xl bg-bg-surface border border-border/50 text-center">
            <p className="text-[length:var(--text-sm)] text-text-muted">
              No keyword highlights configured. Add keywords to highlight words in terminal output.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {highlightRules.map((rule) => {
              const scopeLabel = getHighlightScopeLabel(rule, hosts);
              const isBg = rule.style === "background";
              return (
                <div
                  key={rule.id}
                  data-testid={`highlight-rule-row-${rule.id}`}
                  className={[
                    "flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl",
                    "bg-bg-surface border border-border/60 transition-colors",
                    !rule.enabled && "opacity-60",
                  ].join(" ")}
                >
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <Toggle
                      id={`hl-toggle-${rule.id}`}
                      checked={rule.enabled !== false}
                      onChange={() => toggleHighlightRule(rule.id)}
                    />

                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className="w-3.5 h-3.5 rounded-full shrink-0 border border-white/20"
                        style={{ backgroundColor: rule.color }}
                        title={rule.color}
                      />
                      <span
                        className={[
                          "px-2 py-0.5 rounded font-mono text-[length:var(--text-sm)] font-semibold truncate",
                          isBg ? "shadow-sm" : undefined,
                        ].join(" ")}
                        style={{
                          color: isBg ? (isLightColor(rule.color) ? "#000000" : "#ffffff") : rule.color,
                          backgroundColor: isBg ? rule.color : "transparent",
                        }}
                      >
                        {rule.pattern}
                      </span>
                    </div>

                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="px-1.5 py-0.5 rounded text-[length:var(--text-2xs)] font-medium bg-bg-overlay border border-border/60 text-text-secondary">
                        {isBg ? "Background" : "Text"}
                      </span>
                      {rule.matchCase && (
                        <span className="px-1.5 py-0.5 rounded text-[length:var(--text-2xs)] font-medium bg-bg-overlay border border-border/60 text-text-secondary" title="Case sensitive">
                          Aa
                        </span>
                      )}
                      {rule.matchWholeWord && !rule.isRegex && (
                        <span className="px-1.5 py-0.5 rounded text-[length:var(--text-2xs)] font-medium bg-bg-overlay border border-border/60 text-text-secondary" title="Whole word">
                          \b
                        </span>
                      )}
                      {rule.isRegex && (
                        <span className="px-1.5 py-0.5 rounded text-[length:var(--text-2xs)] font-medium bg-bg-overlay border border-border/60 text-text-secondary" title="Regular expression">
                          .*
                        </span>
                      )}
                      <span
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[length:var(--text-2xs)] font-medium bg-bg-overlay border border-border/60 text-text-secondary truncate max-w-[160px]"
                        title={scopeLabel}
                      >
                        {rule.scope === "global" ? <Globe size={11} className="shrink-0" /> : <Server size={11} className="shrink-0" />}
                        <span className="truncate">{scopeLabel}</span>
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      data-testid={`highlight-rule-edit-${rule.id}`}
                      onClick={() => {
                        setEditingRule(rule);
                        setHighlightModalOpen(true);
                      }}
                      title="Edit rule"
                      className="p-1.5 rounded-lg border border-border text-text-muted hover:text-text-primary hover:border-border-focus transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <Pencil size={13} strokeWidth={2} />
                    </button>
                    <button
                      type="button"
                      data-testid={`highlight-rule-delete-${rule.id}`}
                      onClick={() => removeHighlightRule(rule.id)}
                      title="Delete rule"
                      className="p-1.5 rounded-lg border border-border text-text-muted hover:text-status-error hover:border-status-error/40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <Trash2 size={13} strokeWidth={2} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="mt-3">
          <button
            type="button"
            data-testid="add-highlight-rule-btn"
            onClick={() => {
              setEditingRule(null);
              setHighlightModalOpen(true);
            }}
            className={BTN_SECONDARY}
          >
            <Plus size={13} strokeWidth={2} /> Add highlight rule
          </button>
        </div>

        <p className="px-1 text-[length:var(--text-xs)] text-text-muted">
          Highlighted words update open terminals immediately. Scoped rules only activate on matching hosts.
        </p>
      </SettingsGroup>

      <SettingsGroup label="History">
        <SettingRow>
          <div>
            <label htmlFor="s-scrollback" className={LABEL_CLASS}>Scrollback Buffer</label>
            <p className={DESC_CLASS}>Number of lines to keep in history (500–100,000)</p>
          </div>
          <NumberSetting id="s-scrollback" value={scrollback} min={500} max={100000} step={500} onChange={setScrollback} />
        </SettingRow>
        <p className="px-1 text-[length:var(--text-xs)] text-text-muted">
          Changes apply to open terminals immediately.
        </p>
      </SettingsGroup>

      <TerminalHighlightModal
        open={highlightModalOpen}
        initial={editingRule}
        onClose={() => {
          setHighlightModalOpen(false);
          setEditingRule(null);
        }}
        onSave={handleSaveHighlightRule}
      />
    </>
  );
}


function ExplorerSettings() {
  const doubleClickAction = useSettingsStore((s) => s.explorerDoubleClickAction);
  const setDoubleClickAction = useSettingsStore((s) => s.setExplorerDoubleClickAction);

  return (
    <SettingsGroup>
      <SettingRow>
        <div>
          <p className={LABEL_CLASS}>Double-click a File</p>
          <p className={DESC_CLASS}>What happens when you double-click a file in the browser</p>
        </div>
        <SegmentedControl<DoubleClickAction>
          id="s-doubleclick"
          value={doubleClickAction}
          onChange={setDoubleClickAction}
          options={[
            { value: "download", label: "Download" },
            { value: "open", label: "Open in Editor" },
          ]}
        />
      </SettingRow>
      <p className="px-1 text-[length:var(--text-xs)] text-text-muted">
        Opening falls back to downloading when no editor is configured (see Editors).
      </p>
    </SettingsGroup>
  );
}

function TransferSettings() {
  const transferConcurrency = useSettingsStore((s) => s.transferConcurrency);
  const setConcurrency = useSettingsStore((s) => s.setTransferConcurrency);

  return (
    <SettingsGroup>
      <SettingRow>
        <div>
          <label htmlFor="s-concurrency" className={LABEL_CLASS}>Concurrent Transfers</label>
          <p className={DESC_CLASS}>Maximum simultaneous file transfers (1–10)</p>
        </div>
        <NumberSetting id="s-concurrency" value={transferConcurrency} min={1} max={10} step={1} onChange={setConcurrency} />
      </SettingRow>
    </SettingsGroup>
  );
}

/* Built-in host trackers (plugins). The master toggle gates every tracker
 * view; each tracker row documents what it monitors. Per-host assignment
 * lives in the host editor's Plugins tab — this section only holds global
 * defaults, mirroring how terminal/explorer sections avoid per-host state. */
function PluginsSettings() {
  const pluginsEnabled = useSettingsStore((s) => s.pluginsEnabled);
  const setPluginsEnabled = useSettingsStore((s) => s.setPluginsEnabled);

  return (
    <>
      <SettingsGroup>
        <SettingRow>
          <div>
            <label htmlFor="s-plugins-enabled" className={LABEL_CLASS}>Enable plugins</label>
            <p className={DESC_CLASS}>Show tracker views for connected hosts with plugins assigned</p>
          </div>
          <Toggle id="s-plugins-enabled" checked={pluginsEnabled} onChange={setPluginsEnabled} />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup label="Built-in trackers">
        {TRACKER_CATALOG.map((t) => (
          <SettingRow key={t.id}>
            <div>
              <p className={LABEL_CLASS}>{t.label}</p>
              <p className={DESC_CLASS}>{t.description}</p>
            </div>
            <span className="text-[length:var(--text-xs)] text-text-muted shrink-0">
              {t.intervalLabel}
            </span>
          </SettingRow>
        ))}
        <p className="px-1 text-[length:var(--text-xs)] text-text-muted">
          Assign trackers to a host from its Plugins tab in the host editor. Destructive
          actions always show the exact command for review before running.
        </p>
      </SettingsGroup>
    </>
  );
}

const TRACKER_CATALOG: { id: string; label: string; description: string; intervalLabel: string }[] = [
  { id: "health", label: "Server Health", description: "CPU load, memory, disk usage, and uptime.", intervalLabel: "every 10s" },
  { id: "docker", label: "Docker", description: "Containers, status, and logs. No cleanup commands.", intervalLabel: "every 10s" },
  { id: "pm2", label: "PM2", description: "Node.js processes managed by PM2.", intervalLabel: "every 10s" },
  { id: "systemd", label: "systemd Services", description: "Running services and journal logs.", intervalLabel: "every 15s" },
  { id: "logs", label: "Log Viewer", description: "Tail journald units and log files.", intervalLabel: "on demand" },
  { id: "http", label: "HTTP Health Probe", description: "App health endpoints (Spring Actuator preset).", intervalLabel: "every 15s" },
  { id: "k8s", label: "Kubernetes", description: "Pods and logs via remote kubectl.", intervalLabel: "every 15s" },
  { id: "ssl", label: "SSL & Ports", description: "Certificate expiry and port reachability.", intervalLabel: "on demand" },
  { id: "dbping", label: "Database Ping", description: "Postgres, Redis, and MySQL presets.", intervalLabel: "on demand" },
  { id: "cron", label: "Cron & Timers", description: "crontab entries and systemd timers.", intervalLabel: "every 60s" },
];

// ─── Dataset Sync ─────────────────────────────────────────────────────────────

/* Count line for a push summary; zeros are dropped so it reports what actually
 * travelled. */
function describePush(outcome: SyncPushOutcome): string {
  const counts: [number, string][] = [
    [outcome.hosts, "hosts"],
    [outcome.groups, "groups"],
    [outcome.snippets, "snippets"],
    [outcome.snippetFolders, "snippet folders"],
    [outcome.portForwards, "port forwards"],
    [outcome.s3Connections, "S3 connections"],
    [outcome.hostPlugins, "plugins"],
    [outcome.credentialsIncluded, "credentials"],
    [outcome.tombstones, "deletions"],
  ];
  const parts = counts.filter(([count]) => count > 0).map(([count, label]) => `${count} ${label}`);
  if (outcome.appSettings) parts.push("app settings");
  /* A host leaving the scope is counted apart from the deletions above: nothing
   * was deleted anywhere, this dataset just stopped carrying it. */
  if (outcome.scopeRemovals > 0) {
    const noun = outcome.scopeRemovals === 1 ? "host" : "hosts";
    parts.push(`${outcome.scopeRemovals} ${noun} left the scope`);
  }
  return parts.length > 0 ? parts.join(" · ") : "Nothing had changed since the last push.";
}

/* Count line for what a merge wrote locally. Shared by the pull report and the
 * rollback report, which applies a retained generation through that same
 * merge: a content kind that did not change is dropped, and the deletions and
 * credentials carried are named for what they are so "12 hosts" is never
 * mistaken for the whole dataset. */
function describeAppliedCounts(
  applied: SyncAppliedCounts,
  deleted: number,
  credentialsApplied: number,
): string {
  const counts: [number, string][] = [
    [applied.hosts, "hosts"],
    [applied.groups, "groups"],
    [applied.snippets, "snippets"],
    [applied.snippetFolders, "snippet folders"],
    [applied.portForwards, "port forwards"],
    [applied.s3Connections, "S3 connections"],
    [applied.hostPlugins, "plugins"],
    [deleted, "deletions"],
    [credentialsApplied, "credentials"],
  ];
  const parts = counts.filter(([count]) => count > 0).map(([count, label]) => `${count} ${label}`);
  if (applied.appSettings) parts.push("app settings");
  return parts.length > 0 ? parts.join(" · ") : "Nothing had changed since the last sync.";
}

/* The two numbers that explain what a merge refused to overwrite. Both are
 * silent at zero, because "kept 0 local edits" reads like a warning. */
function describePreserved(keptLocal: number, conflicts: number): string[] {
  const parts: string[] = [];
  if (keptLocal > 0) {
    parts.push(`kept ${keptLocal} local edit${keptLocal === 1 ? "" : "s"}`);
  }
  if (conflicts > 0) {
    parts.push(`${conflicts} conflict${conflicts === 1 ? "" : "s"}`);
  }
  return parts;
}

/*
 * What a dataset still needs before it can talk to its endpoint again. A backup
 * carries no secrets, so a dataset restored on another machine comes back with
 * its rows and its keychain entries missing; without this the only symptom would
 * be a push or pull that fails on a keychain lookup the user cannot see.
 */
function describeMissingDatasetSecrets(dataset: SyncDatasetSummary): string | null {
  const missing: string[] = [];
  if (!dataset.hasServerSecret) {
    missing.push(dataset.authType === "privateKey" ? "its private-key passphrase" : "its server password");
  }
  if (!dataset.hasPassphrase) {
    missing.push("its dataset passphrase");
  }
  if (missing.length === 0) return null;
  return missing.length === 1 ? missing[0] : `${missing[0]} and ${missing[1]}`;
}

/*
 * Conflict log for one dataset (AD-5). The merge resolves a both-changed record
 * by newest `updated_at`, so this list is the only trace of the copy that lost:
 * it names the record and the rule that decided, and it prints both timestamps
 * so the user can see which side was newer and that nothing vanished silently.
 *
 * Rendered only for the dataset that was just pulled: conflicts belong to one
 * pull, and an empty list with a non-zero count still explains itself.
 */
function SyncConflictLog({ conflicts }: { conflicts: SyncConflictEntry[] }) {
  return (
    <div
      data-testid="settings-sync-conflicts"
      className="mt-2 px-3 py-2.5 rounded-lg bg-bg-base border border-border/60 text-[length:var(--text-xs)] text-text-secondary"
    >
      <p className={LABEL_CLASS}>Conflicts resolved — the newer copy was kept</p>
      <p className={DESC_CLASS}>
        Nothing was discarded silently. Each row records which copy won and when each copy
        was last changed.
      </p>
      {conflicts.length === 0 ? (
        <p className="mt-2">The conflict details could not be loaded.</p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {conflicts.map((entry) => (
            <li key={entry.id} data-testid={`settings-sync-conflict-${entry.id}`}>
              <span className="font-mono text-text-primary">
                {entry.entityType} {entry.entityId}
              </span>
              <span> — {entry.resolution}</span>
              <span className="block text-text-muted">
                kept the copy updated {entry.winnerUpdatedAt ?? "at an unknown time"}
                {" · "}replaced the copy updated {entry.loserUpdatedAt ?? "at an unknown time"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* What one retained generation held, in the same vocabulary the push and pull
 * reports use. Counts that were never recorded (a generation published before
 * they were written) are reported as unknown rather than as zero. */
function describeHistoryCounts(counts: SyncHistoryCounts): string {
  const named: [number, string][] = [
    [counts.hosts, "hosts"],
    [counts.groups, "groups"],
    [counts.snippets, "snippets"],
    [counts.snippetFolders, "snippet folders"],
    [counts.portForwards, "port forwards"],
    [counts.s3Connections, "S3 connections"],
    [counts.hostPlugins, "plugins"],
    [counts.credentialsIncluded, "credentials"],
    [counts.tombstones, "deletions"],
  ];
  const parts = named.filter(([count]) => count > 0).map(([count, label]) => `${count} ${label}`);
  if (counts.appSettings) parts.push("app settings");
  if (counts.scopeRemovals > 0) {
    const noun = counts.scopeRemovals === 1 ? "host" : "hosts";
    parts.push(`${counts.scopeRemovals} ${noun} left the scope`);
  }
  return parts.length > 0 ? parts.join(" · ") : "nothing";
}

/* The contents of one retained generation, as the list and the confirm dialog
 * phrase it: named counts when the metadata carries them, otherwise an honest
 * "not recorded" rather than a misleading zero. */
function describeHistoryEntry(entry: SyncHistoryEntry): string {
  return entry.recordCounts
    ? describeHistoryCounts(entry.recordCounts)
    : "record counts were not recorded for it";
}

/*
 * Retained generations of one dataset (Task 11). Reading them is metadata only
 * — no passphrase, no bundle download — but it still opens a connection, so the
 * list loads when the user asks for it instead of for every saved row.
 *
 * Rolling back is offered per generation and confirmed first: it names what the
 * target generation holds, states that records made since are kept, and states
 * that the result is published as a new generation rather than replacing the
 * one on the server.
 */
function SyncHistoryPanel({ dataset, busy }: { dataset: SyncDatasetSummary; busy: boolean }) {
  const listing = useSyncStore((state) => state.history[dataset.id]);
  const loading = useSyncStore((state) => state.historyLoading) === dataset.id;
  const rollbackResult = useSyncStore((state) => state.rollbackResult);
  const loadHistory = useSyncStore((state) => state.loadHistory);
  const clearHistory = useSyncStore((state) => state.clearHistory);
  const rollback = useSyncStore((state) => state.rollback);
  const [confirm, setConfirm] = useState<SyncHistoryEntry | null>(null);

  const toggle = useCallback(() => {
    if (listing) {
      clearHistory(dataset.id);
      return;
    }
    void loadHistory(dataset.id).catch(() => { /* the dataset card renders the failure */ });
  }, [clearHistory, dataset.id, listing, loadHistory]);

  const runRollback = useCallback(async () => {
    const target = confirm;
    setConfirm(null);
    if (!target) return;
    try {
      await rollback(dataset.id, target.generation);
    } catch { /* the dataset card renders the failure */ }
  }, [confirm, dataset.id, rollback]);

  const result = rollbackResult?.datasetId === dataset.id ? rollbackResult : null;
  const preserved = result ? describePreserved(result.keptLocal, result.conflicts) : [];

  return (
    <div
      data-testid="settings-sync-history"
      className="mt-2 px-3 py-2.5 rounded-lg bg-bg-base border border-border/60 text-[length:var(--text-xs)] text-text-secondary"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className={LABEL_CLASS}>Generation history</p>
          <p className={DESC_CLASS}>
            Every publish keeps the generation it replaces, so a bad push can be undone.
          </p>
        </div>
        <button
          type="button"
          data-testid="settings-sync-history-toggle"
          onClick={toggle}
          disabled={busy || loading}
          aria-busy={loading}
          className={`${BTN_SECONDARY} w-[8.75rem]`}
        >
          {/* The spinner slot is always present (hidden when idle) and the box has
              a fixed width, so loading never resizes the button or shifts its
              contents. */}
          <RefreshCw
            size={13}
            strokeWidth={2}
            className={`shrink-0 ${loading ? "motion-safe:animate-spin" : "invisible"}`}
          />
          <span>{listing ? "Hide history" : "Show history"}</span>
        </button>
      </div>

      {listing && (
        <>
          {/* Generation 0 means nothing is published yet, which the empty list
              below already says; don't claim a generation exists. */}
          {listing.currentGeneration !== null && (
            <p className="mt-2">
              Generation {listing.currentGeneration} is published now. Rolling back to an
              earlier one applies it here as a merge and publishes the result as a new
              generation — nothing already on the server is replaced.
            </p>
          )}
          {listing.entries.length === 0 ? (
            <p data-testid="settings-sync-history-empty" className="mt-1">
              No earlier generation is retained on the server yet.
            </p>
          ) : (
            <ul className="mt-2 space-y-1.5">
              {listing.entries.map((entry) => (
                <li
                  key={entry.generation}
                  data-testid={`settings-sync-history-${entry.generation}`}
                  className="flex items-start justify-between gap-3"
                >
                  <span className="min-w-0">
                    <span className="font-mono text-text-primary">
                      generation {entry.generation}
                    </span>
                    <span className="block">
                      {describeHistoryEntry(entry)}
                      {entry.signed ? " · signed by the owner" : ""}
                    </span>
                    <span className="block text-text-muted">
                      {entry.updatedAt
                        ? `published ${relativeTime(entry.updatedAt)}`
                        : "publish time unknown"}
                      {entry.writerClientId ? ` · written by ${entry.writerClientId}` : ""}
                    </span>
                  </span>
                  <button
                    type="button"
                    data-testid={`settings-sync-rollback-${entry.generation}`}
                    onClick={() => setConfirm(entry)}
                    disabled={busy}
                    className={BTN_SECONDARY}
                    aria-label={`Roll the dataset “${dataset.name}” back to generation ${entry.generation}`}
                  >
                    <History size={13} strokeWidth={2} /> Roll back…
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {result && (
        <div
          data-testid="settings-sync-rollback-result"
          role="status"
          className="mt-2 px-3 py-2.5 rounded-lg bg-bg-surface border border-border/60"
        >
          <p className="flex items-center gap-1.5 text-status-success">
            <CheckCircle2 size={13} strokeWidth={2} /> Rolled back to generation{" "}
            {result.rolledBackTo} and published generation {result.generation}.
          </p>
          <p className="mt-1">{describePush(result.published)}</p>
          <p className="mt-1">
            Applied to this computer:{" "}
            {describeAppliedCounts(result.applied, result.deleted, result.credentialsApplied)}
          </p>
          {preserved.length > 0 && <p className="mt-1">{preserved.join(" · ")}</p>}
          <p className="mt-1 text-text-muted">
            Local records made since generation {result.rolledBackTo} were kept and travel with
            generation {result.generation}; other computers pick it up on their next pull.
          </p>
        </div>
      )}

      <ConfirmDangerDialog
        open={confirm !== null}
        title="Roll this dataset back?"
        message={
          confirm
            ? `“${dataset.name}” will apply generation ${confirm.generation} (${describeHistoryEntry(confirm)}${
                confirm.updatedAt ? `, published ${relativeTime(confirm.updatedAt)}` : ""
              }). Records you created or changed since then are kept, and the merged result is published as a new generation — generation ${dataset.lastGeneration} stays on the server and nothing is overwritten. Other computers keep working until their next pull.`
            : ""
        }
        confirmLabel="Roll back"
        onConfirm={() => void runRollback()}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}

/* ─── Save report ───────────────────────────────────────────────────────────
 * "Joined a dataset that is already published here" and "created an empty one

/* ─── Automatic sync (Task 6) ────────────────────────────────────────────────
 * Automatic sync is opt-in per dataset: the master switch starts off, saving a
 * dataset never turns it on, and each cadence has an explicit "0 = manual only"
 * meaning. Both cadences are stored in seconds (minutes in the UI for the pull
 * interval) and are validated here as well as in the backend.
 *
 * A cadence field accepts a whole number only: blank, fractional ("0.5"), and
 * out-of-range values are reported inline and never sent. Values commit on blur
 * or Enter rather than per keystroke, so typing "15" cannot save "1" first.
 */

const PULL_INTERVAL_MAX_MINUTES = 1440;
const PUSH_DEBOUNCE_MIN_SECONDS = 5;
const PUSH_DEBOUNCE_MAX_SECONDS = 3600;

/** The field as a number, or null when it is blank or not numeric. */
function parseCadenceField(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

function pullIntervalError(raw: string): string | null {
  const minutes = parseCadenceField(raw);
  const allowed =
    minutes !== null &&
    Number.isInteger(minutes) &&
    (minutes === 0 || (minutes >= 1 && minutes <= PULL_INTERVAL_MAX_MINUTES));
  return allowed
    ? null
    : `Enter 0 to pull only when you click “Pull now”, or a whole number of minutes from 1 to ${PULL_INTERVAL_MAX_MINUTES}.`;
}

function pushDebounceError(raw: string): string | null {
  const seconds = parseCadenceField(raw);
  const allowed =
    seconds !== null &&
    Number.isInteger(seconds) &&
    (seconds === 0 ||
      (seconds >= PUSH_DEBOUNCE_MIN_SECONDS && seconds <= PUSH_DEBOUNCE_MAX_SECONDS));
  return allowed
    ? null
    : `Enter 0 to push only when you click “Push now”, or a whole number of seconds from ${PUSH_DEBOUNCE_MIN_SECONDS} to ${PUSH_DEBOUNCE_MAX_SECONDS}.`;
}

/*
 * The backend reports a failure as `{ kind, message }`; the kind is what turns
 * it into something to act on. A hint is rendered *after* the message, so it is
 * listed only for kinds whose message leaves something to act on: `notFound`
 * and `version` are absent on purpose, because their messages already say what
 * happened ("nothing has been published…", "update OmniSSH first") and
 * repeating them printed the same sentence twice in one line.
 */
const SYNC_ERROR_HINTS: Partial<Record<SyncErrorKind, string>> = {
  conflict: "Another machine published first — pull before pushing.",
  roleDenied: "This dataset is pull-only for your role — only its owner can publish.",
  vault: "Unlock the App Vault and try again.",
  decrypt: "Wrong dataset passphrase — re-save the dataset with the correct passphrase.",
  sftpUnavailable: "Dataset sync needs a server with the SFTP subsystem enabled.",
  locked: "Another machine is syncing this dataset — try again in a moment.",
  unreachable: "The server could not be reached — sync retries on the next trigger.",
};

/*
 * Live phase of one dataset. It comes from the scheduler rather than from local
 * button state, so a background run shows up here too; a click in this window
 * takes precedence while its own result is still in flight. An error keeps the
 * backend's message on screen instead of collapsing to a badge.
 */
function SyncPhaseLine({ dataset, status, busy }: {
  dataset: SyncDatasetSummary;
  status: SyncStatusSnapshot | undefined;
  busy: "pulling" | "pushing" | null;
}) {
  const phase: SyncPhase = busy ?? status?.phase ?? "idle";
  const lastSyncedAt = status?.lastSyncedAt ?? dataset.lastSyncedAt;
  const hint = status?.phase === "error" && status.kind ? SYNC_ERROR_HINTS[status.kind] : undefined;

  return (
    <div
      data-testid={`settings-sync-phase-${dataset.id}`}
      className="mt-2 space-y-1 text-[length:var(--text-xs)]"
    >
      {phase === "pulling" && (
        <p className="flex items-center gap-1.5 text-text-secondary">
          <RefreshCw size={12} strokeWidth={2} className="motion-safe:animate-spin" />
          Pulling changes from the server…
        </p>
      )}
      {phase === "pushing" && (
        <p className="flex items-center gap-1.5 text-text-secondary">
          <RefreshCw size={12} strokeWidth={2} className="motion-safe:animate-spin" />
          Publishing your changes…
        </p>
      )}
      {phase === "error" && (
        <p className="flex items-start gap-1.5 text-status-error">
          <AlertCircle size={12} strokeWidth={2} className="mt-0.5 shrink-0" />
          <span>
            {status?.message ?? "The last sync failed."}
            {hint && ` ${hint}`}
          </span>
        </p>
      )}
      {phase === "idle" && (
        <p className="flex items-center gap-1.5 text-text-muted">
          <CheckCircle2 size={12} strokeWidth={2} />
          {lastSyncedAt ? `Last synced ${relativeTime(lastSyncedAt)}.` : "Not synced yet."}
        </p>
      )}
      {status?.pendingLocalChanges && (
        <p data-testid={`settings-sync-pending-${dataset.id}`} className="text-status-connecting">
          Changes waiting to publish — they go out once the push delay has passed.
        </p>
      )}
    </div>
  );
}

/*
 * Automatic-sync controls for one saved dataset: the master switch plus both
 * cadences. The drafts are strings so a half-typed number is never coerced and
 * saved, and they are seeded once from the row — this component is the only
 * writer of these fields, and the store mirrors what was sent.
 *
 * A field whose current text is invalid falls back to the stored value, so
 * toggling the master switch can never persist what the user is mid-typing.
 */
function SyncScheduleControls({ dataset }: { dataset: SyncDatasetSummary }) {
  const updateDatasetSchedule = useSyncStore((s) => s.updateDatasetSchedule);
  const [autoSync, setAutoSync] = useState(dataset.autoSync);
  const [pullMinutes, setPullMinutes] = useState(() =>
    String(Math.round(dataset.pullIntervalSecs / 60)),
  );
  const [pushSeconds, setPushSeconds] = useState(() => String(dataset.pushDebounceSecs));

  const isMember = dataset.role === "member";

  const pullError = pullIntervalError(pullMinutes);
  const pushError = isMember ? null : pushDebounceError(pushSeconds);
  const pullSecs = pullError === null
    ? (parseCadenceField(pullMinutes) ?? 0) * 60
    : dataset.pullIntervalSecs;
  const pushSecs = isMember
    ? 0
    : pushError === null
      ? parseCadenceField(pushSeconds) ?? 0
      : dataset.pushDebounceSecs;
  const pullMins = pullSecs / 60;

  /* The dataset card renders the failure; a schedule change is not worth a toast. */
  const commit = useCallback((next: SyncScheduleInput) => {
    void updateDatasetSchedule(dataset.id, next).catch(() => {});
  }, [dataset.id, updateDatasetSchedule]);

  const changeAutoSync = (value: boolean) => {
    setAutoSync(value);
    commit({ autoSync: value, pullIntervalSecs: pullSecs, pushDebounceSecs: pushSecs });
  };

  const commitPull = () => {
    if (pullError !== null) return;
    const secs = (parseCadenceField(pullMinutes) ?? 0) * 60;
    if (secs === dataset.pullIntervalSecs) return;
    commit({ autoSync, pullIntervalSecs: secs, pushDebounceSecs: pushSecs });
  };

  const commitPush = () => {
    if (isMember || pushError !== null) return;
    const secs = parseCadenceField(pushSeconds) ?? 0;
    if (secs === dataset.pushDebounceSecs) return;
    commit({ autoSync, pullIntervalSecs: pullSecs, pushDebounceSecs: secs });
  };

  const commitOnEnter = (commitField: () => void) => (e: React.KeyboardEvent) => {
    if (e.key === "Enter") commitField();
  };

  return (
    <div className="mt-3 pt-3 border-t border-border/50">
      <div className="flex items-start justify-between gap-4">
        <div>
          <label htmlFor="settings-sync-auto" className={LABEL_CLASS}>Automatic sync</label>
          <p className={DESC_CLASS}>
            {autoSync
              ? isMember
                ? "This dataset pulls on its own using the cadence below."
                : "This dataset syncs on its own using the cadences below."
              : isMember
                ? "Off — this dataset only syncs when you press Pull now."
                : "Off — this dataset only syncs when you press Pull now or Push now."}
          </p>
        </div>
        <Toggle id="settings-sync-auto" checked={autoSync} onChange={changeAutoSync} />
      </div>

      <div className={`grid ${isMember ? "grid-cols-1 max-w-sm" : "grid-cols-2"} gap-3 mt-3`}>
        <div>
          <label htmlFor="settings-sync-pull-interval" className={FIELD_LABEL_CLASS}>
            Pull every (minutes)
          </label>
          <input
            id="settings-sync-pull-interval"
            data-testid="settings-sync-pull-interval"
            type="number"
            inputMode="numeric"
            min={0}
            max={PULL_INTERVAL_MAX_MINUTES}
            step={1}
            disabled={!autoSync}
            value={pullMinutes}
            onChange={(e) => setPullMinutes(e.target.value)}
            onBlur={commitPull}
            onKeyDown={commitOnEnter(commitPull)}
            className={TEXT_INPUT_CLASS}
          />
          {pullError === null ? (
            <p className={DESC_CLASS}>
              {!autoSync
                ? "Turn automatic sync on to give this dataset a pull cadence."
                : pullSecs === 0
                  ? "0 — only when I click “Pull now”."
                  : `Checks the server for changes every ${pullMins} minute${pullMins === 1 ? "" : "s"}.`}
            </p>
          ) : (
            <p
              data-testid="settings-sync-pull-interval-error"
              className="mt-1 text-[length:var(--text-xs)] text-status-error"
            >
              {pullError}
            </p>
          )}
        </div>

        {!isMember && (
          <div>
            <label htmlFor="settings-sync-push-debounce" className={FIELD_LABEL_CLASS}>
              Push delay (seconds)
            </label>
            <input
              id="settings-sync-push-debounce"
              data-testid="settings-sync-push-debounce"
              type="number"
              inputMode="numeric"
              min={0}
              max={PUSH_DEBOUNCE_MAX_SECONDS}
              step={1}
              disabled={!autoSync}
              value={pushSeconds}
              onChange={(e) => setPushSeconds(e.target.value)}
              onBlur={commitPush}
              onKeyDown={commitOnEnter(commitPush)}
              className={TEXT_INPUT_CLASS}
            />
            {pushError === null ? (
              <p className={DESC_CLASS}>
                {!autoSync
                  ? "Turn automatic sync on to give this dataset a push delay."
                  : pushSecs === 0
                    ? "0 — only when I click “Push now”."
                    : `Waits ${pushSecs} second${pushSecs === 1 ? "" : "s"} after your last change before publishing.`}
              </p>
            ) : (
              <p
                data-testid="settings-sync-push-debounce-error"
                className="mt-1 text-[length:var(--text-xs)] text-status-error"
              >
                {pushError}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Both cadences at 0 means the switch is on but nothing can ever trigger,
          which reads as "syncing works" and is not true. */}
      {autoSync && pullSecs === 0 && pushSecs === 0 && (
        <p data-testid="settings-sync-manual-only" className={DESC_CLASS}>
          Automatic sync is on, but both cadences are 0 — nothing runs until you set one.
        </p>
      )}

      {/* Sharing one dataset between installations is the normal case, not a
          hazard: a measured two-machine test showed the merge converges (the
          stale publisher is refused with `conflict`, the pull merges, the newer
          edit of a simultaneously-edited record wins, and the loser is logged).
          The one surprise worth naming up front is that "simultaneous" means
          "before they sync", so this note states the rule instead of leaving it
          to be discovered in the conflict log. */}
      {autoSync && (
        <div className="mt-3">
          <p data-testid="settings-sync-multi-writer-note" className={DESC_CLASS}>
            Syncing from more than one computer is safe: changes are merged record by
            record. If the same host is edited on two computers before they sync, the newer
            edit wins and the older one is listed under Conflicts. A push is refused while
            another computer has published in the meantime — pull first.
          </p>
        </div>
      )}
    </div>
  );
}

/*
 * Endpoint form for the self-hosted dataset. "Test connection" opens a real
 * ephemeral SSH+SFTP session, probes the remote path, and reports what is
 * there — it never creates or overwrites anything, so the user can point at a
 * path and find out whether a teammate's dataset already lives in it.
 *
 * The same server details feed the dataset row: **Save dataset** persists the
 * endpoint, the content toggles, and the dataset passphrase (which the backend
 * keeps in the keychain / App Vault). Secrets stay component state and are
 * handed to the invoke as parameters — they never reach the store,
 * `save_setting`, or the DB.
 *
 * A push always runs preflight first: publishing hosts without the credentials
 * they need is worse than refusing, so an unreadable secret blocks the run and
 * says which one.
 */
/*
 * Dataset Sync section. Displays active datasets, live phase and sync results,
 * automatic synchronization cadence controls, generation history, and rollback
 * affordances. Creation and editing are handled in SyncDatasetModal.
 */
function SyncSettings() {
  const {
    datasets, datasetsLoading, saveOutcome, pushing, pushResult, preflight,
    pulling, pullResult, conflicts, rollingBack, statuses,
    datasetError, datasetErrorKind,
    loadDatasets, deleteDataset, loadPreflight, push, pull,
    probeWritability, loadStatus, subscribeSyncStatus,
  } = useSyncStore();

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<SyncDatasetSummary | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<SyncDatasetSummary | null>(null);

  /* Loaded once when the section mounts. `loadDatasets` is a stable store
   * action, so this effect cannot re-trigger itself. */
  useEffect(() => {
    void loadDatasets().catch(() => { /* the dataset card renders the failure */ });
  }, [loadDatasets]);

  /*
   * The scope pickers list this machine's groups and hosts. Both stores are
   * shared with the dashboard and reload themselves on failure inside the
   * store, so a failed read leaves an empty picker rather than a broken
   * section — and selecting nothing is exactly what those modes then refuse.
   */
  useEffect(() => {
    void useGroupsStore.getState().loadGroups();
    void useHostsStore.getState().loadHosts();
  }, []);

  /*
   * The rows show the scheduler's phase, not just this window's button clicks,
   * so the section reads the current snapshots and then follows `sync:status`.
   * The listener is shared with the status bar; `subscribeSyncStatus` returns
   * the unsubscribe function, which is what closes this half of it.
   */
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void loadStatus();
    void subscribeSyncStatus()
      .then((release) => {
        if (cancelled) release();
        else unlisten = release;
      })
      .catch(() => { /* the rows keep what `sync_status` last reported */ });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [loadStatus, subscribeSyncStatus]);

  const openAdd = useCallback(() => {
    setEditing(null);
    setModalOpen(true);
  }, []);

  const beginEdit = useCallback((dataset: SyncDatasetSummary) => {
    setEditing(dataset);
    setModalOpen(true);
  }, []);

  const runPush = useCallback(async (datasetId: string) => {
    try {
      const check = await loadPreflight(datasetId);
      if (check.includeCredentials && (check.vaultLocked || check.credentialsBlocked > 0)) return;
      await push(datasetId);
    } catch { /* the dataset card renders the failure */ }
  }, [loadPreflight, push]);

  /* A pull needs no preflight: it only reads the remote bundle and writes
   * locally, so a locked vault costs the credentials it cannot store and
   * nothing else. The store reloads hosts/groups itself afterwards. For a
   * member row the pull additionally probes whether the remote is writable,
   * so the row can warn when the server is not enforcing the pull-only role.
   * The probe failure is silent: the pull itself already succeeded. */
  const runPull = useCallback(async (datasetId: string) => {
    try {
      await pull(datasetId);
      const row = useSyncStore.getState().datasets.find((d) => d.id === datasetId);
      if (row?.role === "member") {
        await probeWritability(datasetId);
      }
    } catch { /* the dataset card renders the failure */ }
  }, [pull, probeWritability]);

  const handleRemove = useCallback(async () => {
    const dataset = confirmRemove;
    setConfirmRemove(null);
    if (!dataset) return;
    if (editing?.id === dataset.id) {
      setEditing(null);
    }
    try {
      await deleteDataset(dataset.id);
      toast.success(`Removed “${dataset.name}”. Your local hosts are untouched.`);
    } catch { /* the dataset card renders the failure */ }
  }, [confirmRemove, deleteDataset, editing]);

  return (
    <div data-testid="settings-sync-container" className="space-y-4">
      {/* Top Header */}
      <div className="flex items-center justify-between pb-3 border-b border-border/50">
        <div>
          <p className={LABEL_CLASS}>Active datasets</p>
          <p className={DESC_CLASS}>
            Keep your hosts on a server you own, encrypted end to end.
          </p>
        </div>
        <button
          type="button"
          data-testid="settings-sync-add"
          onClick={openAdd}
          className={BTN_SECONDARY}
        >
          <Plus size={13} strokeWidth={2} /> Add dataset
        </button>
      </div>

      {!modalOpen && saveOutcome && (
        <div className="relative">
          <SyncSaveReport outcome={saveOutcome} />
        </div>
      )}

      {datasetError && (
        <p
          data-testid="settings-sync-dataset-error"
          className="flex items-start gap-1.5 px-3 py-2 rounded-lg bg-status-error/10 border border-status-error/30 text-[length:var(--text-xs)] text-status-error"
        >
          <AlertCircle size={13} strokeWidth={2} className="mt-0.5 shrink-0" />
          <span>
            {datasetError}
            {datasetErrorKind && SYNC_ERROR_HINTS[datasetErrorKind]
              ? ` ${SYNC_ERROR_HINTS[datasetErrorKind]}`
              : null}
          </span>
        </p>
      )}

      <div className="space-y-3">
        {datasetsLoading && datasets.length === 0 && (
          <p className={DESC_CLASS}>Loading saved datasets…</p>
        )}
        {!datasetsLoading && datasets.length === 0 && (
          <div className="px-6 py-8 rounded-xl bg-bg-surface border border-border/50 text-center space-y-3">
            <div className="mx-auto w-10 h-10 rounded-xl bg-accent/10 text-accent flex items-center justify-center">
              <RefreshCw size={20} strokeWidth={2} />
            </div>
            <div className="max-w-md mx-auto space-y-1">
              <p className={LABEL_CLASS}>No dataset saved yet</p>
              <p className={DESC_CLASS}>
                Publish your hosts, credentials, and settings to an encrypted SFTP directory on a server you own.
              </p>
            </div>
            <button
              type="button"
              data-testid="settings-sync-empty-add"
              onClick={openAdd}
              className={BTN_SECONDARY}
            >
              <Plus size={13} strokeWidth={2} /> Add dataset
            </button>
          </div>
        )}

        {datasets.map((dataset) => {
          /* One claim at a time per row: a push, a pull, and a rollback all
           * write the same records, so the row disables its buttons while any
           * of them runs. */
          const busy = pushing === dataset.id || pulling === dataset.id
            || rollingBack === dataset.id;
          const blocked = preflight?.datasetId === dataset.id
            && preflight.includeCredentials
            && (preflight.vaultLocked || preflight.credentialsBlocked > 0);
          const outcome = pushResult?.datasetId === dataset.id ? pushResult : null;
          const pulled = pullResult?.datasetId === dataset.id ? pullResult : null;
          const missingSecret = describeMissingDatasetSecrets(dataset);
          const preserved = pulled ? describePreserved(pulled.keptLocal, pulled.conflicts) : [];
          const showConflicts = pulled !== null && (pulled.conflicts > 0 || conflicts.length > 0);
          return (
            <div
              key={dataset.id}
              data-testid={`settings-sync-dataset-${dataset.id}`}
              className="px-4 py-3.5 rounded-xl bg-bg-surface border border-border/50 space-y-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className={`${LABEL_CLASS} font-semibold`}>{dataset.name}</p>
                    <span className={`px-2 py-0.5 text-[length:var(--text-2xs)] font-medium rounded-full border ${
                      dataset.role === "owner"
                        ? "bg-accent/10 text-accent border-accent/20"
                        : "bg-bg-subtle text-text-secondary border-border"
                    }`}>
                      {dataset.role === "owner" ? "Owner — can publish" : "Member — pull only"}
                    </span>
                    <span className="px-2 py-0.5 text-[length:var(--text-2xs)] font-mono text-text-muted rounded-full bg-bg-base border border-border/50">
                      generation {dataset.lastGeneration}
                    </span>
                  </div>
                  <p className="text-[length:var(--text-xs)] font-mono text-text-muted truncate mt-1">
                    {dataset.username}@{dataset.host}:{dataset.port} · {dataset.remotePath}
                  </p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    data-testid="settings-sync-edit"
                    onClick={() => beginEdit(dataset)}
                    disabled={busy}
                    className={BTN_SECONDARY}
                    aria-label={`Edit the dataset “${dataset.name}”`}
                  >
                    <Pencil size={13} strokeWidth={2} /> Edit
                  </button>
                  {dataset.role === "owner" && (
                    <button
                      type="button"
                      data-testid="settings-sync-push"
                      onClick={() => void runPush(dataset.id)}
                      disabled={busy}
                      className={BTN_SECONDARY}
                    >
                      <Upload size={13} strokeWidth={2} />
                      {pushing === dataset.id ? "Pushing…" : "Push now"}
                    </button>
                  )}
                  <button
                    type="button"
                    data-testid="settings-sync-pull"
                    onClick={() => void runPull(dataset.id)}
                    disabled={busy}
                    className={BTN_SECONDARY}
                  >
                    <Download size={13} strokeWidth={2} />
                    {pulling === dataset.id ? "Pulling…" : "Pull now"}
                  </button>
                  <button
                    type="button"
                    data-testid="settings-sync-remove"
                    onClick={() => setConfirmRemove(dataset)}
                    disabled={busy}
                    className={BTN_SECONDARY}
                  >
                    <Trash2 size={13} strokeWidth={2} /> Remove
                  </button>
                </div>
              </div>

              <div className="text-[length:var(--text-xs)] space-y-1">
                <p
                  data-testid={`settings-sync-scope-summary-${dataset.id}`}
                  className="text-text-muted"
                >
                  {dataset.role === "member"
                    ? "Scope: set by the dataset owner"
                    : dataset.scopeMode === "all"
                      ? "Scope: all hosts"
                      : dataset.scopeMode === "groups"
                        ? "Scope: selected groups"
                        : "Scope: selected hosts"}
                  {dataset.role === "owner" && (
                    <>
                      {" · "}
                      {dataset.scopeHostCount} host{dataset.scopeHostCount === 1 ? "" : "s"} in scope
                    </>
                  )}
                  {" · "}
                  {dataset.lastSyncedAt
                    ? `last synced ${relativeTime(dataset.lastSyncedAt)}`
                    : "never synced"}
                </p>

                {dataset.lastGeneration === 0 && (
                  <p
                    data-testid={`settings-sync-unpublished-${dataset.id}`}
                    className="text-status-connecting"
                  >
                    Nothing is published at {dataset.remotePath} yet — press Push now to create
                    the first generation.
                  </p>
                )}

                <SyncPhaseLine
                  dataset={dataset}
                  status={statuses[dataset.id]}
                  busy={pushing === dataset.id ? "pushing" : pulling === dataset.id ? "pulling" : null}
                />
              </div>

              {missingSecret && (
                <div
                  data-testid={`settings-sync-needs-secret-${dataset.id}`}
                  className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-status-warning/10 border border-status-warning/30"
                >
                  <AlertTriangle
                    size={13}
                    strokeWidth={2}
                    className="text-status-warning shrink-0 mt-0.5"
                  />
                  <span className="text-[length:var(--text-xs)] text-text-secondary">
                    This machine is missing {missingSecret} for this dataset. A backup carries
                    no secrets, so a dataset restored from one comes back without them — open
                    Edit, enter {missingSecret}, and save to sync again.
                  </span>
                </div>
              )}

              {dataset.role === "member" && preflight?.datasetId === dataset.id && preflight.remoteWritable && (
                <div
                  data-testid="settings-sync-member-writable-warning"
                  className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-status-warning/10 border border-status-warning/30"
                >
                  <AlertTriangle
                    size={13}
                    strokeWidth={2}
                    className="text-status-warning shrink-0 mt-0.5"
                  />
                  <span className="text-[length:var(--text-xs)] text-text-secondary">
                    This account can still write to {dataset.remotePath}, so the server is not
                    enforcing this dataset's pull-only role. Use a read-only SSH account for
                    members, or make the dataset directory read-only on the server
                    (for example with chmod), so a member can never publish over the owner's
                    dataset by accident.
                  </span>
                </div>
              )}

              {blocked && preflight && (
                <div
                  data-testid="settings-sync-preflight-warning"
                  className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-status-connecting/10 border border-status-connecting/30"
                >
                  <AlertTriangle
                    size={13}
                    strokeWidth={2}
                    className="text-status-connecting shrink-0 mt-0.5"
                  />
                  <span className="text-[length:var(--text-xs)] text-text-secondary">
                    {preflight.vaultLocked
                      ? "Unlock the App Vault to include credentials."
                      : `${preflight.credentialsBlocked} stored credential${preflight.credentialsBlocked === 1 ? "" : "s"} cannot be read on this computer.`}
                    {" "}Nothing was pushed — publish without them by turning the credential
                    toggles off, or unlock the vault and push again.
                  </span>
                </div>
              )}

              {outcome && (
                <div
                  data-testid="settings-sync-push-result"
                  className="px-3 py-2.5 rounded-lg bg-bg-base border border-border/60 text-[length:var(--text-xs)] text-text-secondary"
                >
                  <p className="flex items-center gap-1.5 text-status-success">
                    <CheckCircle2 size={13} strokeWidth={2} /> Pushed generation {outcome.generation}.
                  </p>
                  <p className="mt-1">{describePush(outcome)}</p>
                </div>
              )}

              {pulled && (
                <div
                  data-testid="settings-sync-pull-result"
                  className="px-3 py-2.5 rounded-lg bg-bg-base border border-border/60 text-[length:var(--text-xs)] text-text-secondary"
                >
                  <p className="flex items-center gap-1.5 text-status-success">
                    <CheckCircle2 size={13} strokeWidth={2} /> Pulled generation {pulled.generation}.
                  </p>
                  <p className="mt-1">
                    {describeAppliedCounts(pulled.applied, pulled.deleted, pulled.credentialsApplied)}
                  </p>
                  {pulled.publishedByAnotherMachine && (
                    <p data-testid="settings-sync-other-writer" className="mt-1">
                      This update came from another computer.
                    </p>
                  )}
                  {preserved.length > 0 && <p className="mt-1">{preserved.join(" · ")}</p>}
                </div>
              )}

              {showConflicts && <SyncConflictLog conflicts={conflicts} />}

              {dataset.role === "owner" && (
                <SyncHistoryPanel dataset={dataset} busy={busy} />
              )}

              <SyncScheduleControls dataset={dataset} />
            </div>
          );
        })}
      </div>

      <SyncDatasetModal
        open={modalOpen}
        editing={editing}
        onClose={() => {
          setModalOpen(false);
          setEditing(null);
        }}
      />

      <ConfirmDangerDialog
        open={confirmRemove !== null}
        title="Remove this dataset?"
        message={`“${confirmRemove?.name ?? ""}” is removed from this computer: OmniSSH stops syncing it and forgets its passphrase. Your local hosts are kept, and the published dataset on the server is untouched.`}
        confirmLabel="Remove"
        onConfirm={() => void handleRemove()}
        onCancel={() => setConfirmRemove(null)}
      />
    </div>
  );
}

// ─── Data ───────────────────────────────────────────────────────────────────────

function DataSettings() {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  // Import is two-step: pick a file, then prompt for its password.
  const [importPath, setImportPath] = useState<string | null>(null);

  const pickImportFile = useCallback(async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({
        multiple: false,
        directory: false,
        title: "Select OmniSSH backup",
        filters: [{ name: "OmniSSH backup", extensions: ["ascpbak"] }],
      });
      if (typeof picked === "string") setImportPath(picked);
    } catch { /* dialog cancelled / unavailable */ }
  }, []);

  return (
    <>
      <SettingsGroup label="Backup">
        <SettingRow>
          <div>
            <p className={LABEL_CLASS}>Export encrypted backup</p>
            <p className={DESC_CLASS}>
              Save all hosts, groups, snippets, settings, and stored credentials to a
              single password-protected file.
            </p>
          </div>
          <button type="button" data-testid="s-export-backup" onClick={() => setExportOpen(true)} className={BTN_SECONDARY}>
            <Download size={13} strokeWidth={2} /> Export…
          </button>
        </SettingRow>
        <SettingRow>
          <div>
            <p className={LABEL_CLASS}>Import backup</p>
            <p className={DESC_CLASS}>
              Restore from a backup file. This replaces all current data and restarts OmniSSH.
            </p>
          </div>
          <button type="button" data-testid="s-import-backup" onClick={() => void pickImportFile()} className={BTN_SECONDARY}>
            <Upload size={13} strokeWidth={2} /> Import…
          </button>
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup label="Danger zone">
        <div className="flex items-center justify-between gap-4 px-4 py-3 rounded-xl bg-bg-surface border border-status-error/30">
          <div>
            <p className={LABEL_CLASS}>Clear all data</p>
            <p className={DESC_CLASS}>
              Permanently delete every saved host, group, connection history entry,
              snippet, port-forward rule, and S3 connection — along with their stored
              credentials and all app preferences. OmniSSH restarts at first-launch state.
              This can’t be undone.
            </p>
          </div>
          <button
            type="button"
            data-testid="s-clear-data"
            onClick={() => setConfirmOpen(true)}
            className={[
              "flex items-center gap-1.5 px-3 py-1.5 rounded-lg shrink-0",
              "text-[length:var(--text-sm)] font-medium",
              "bg-status-error/10 border border-status-error/40 text-status-error",
              "hover:bg-status-error/15",
              "transition-colors duration-[var(--duration-fast)]",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            ].join(" ")}
          >
            <Trash2 size={13} strokeWidth={2} /> Clear all data…
          </button>
        </div>
      </SettingsGroup>

      <BackupPasswordModal mode="export" open={exportOpen} onClose={() => setExportOpen(false)} />
      <BackupPasswordModal
        mode="import"
        open={importPath !== null}
        path={importPath ?? undefined}
        onClose={() => setImportPath(null)}
      />
      <ConfirmResetModal open={confirmOpen} onClose={() => setConfirmOpen(false)} />
    </>
  );
}

/* Passphrase dialog for encrypted backup export/import.
 * Export queries preflight candidate counts, lets the user optionally skip
 * System Keychain reads to avoid repeated OS authorization prompts, and encrypts
 * the archive with a user-chosen passphrase. */
function BackupPasswordModal({ mode, open, path, onClose }: {
  mode: "export" | "import";
  open: boolean;
  path?: string;
  onClose: () => void;
}) {
  const isExport = mode === "export";
  const MIN_LEN = 8;
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [includeCredentials, setIncludeCredentials] = useState(true);
  const [preflight, setPreflight] = useState<BackupPreflightSummary | null>(null);
  const [preflightLoading, setPreflightLoading] = useState(false);
  const [preflightError, setPreflightError] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);

  const valid = isExport ? pw.length >= MIN_LEN && pw === confirm : pw.length > 0;
  const canSubmit = valid && !busy;

  useEffect(() => {
    if (open) {
      setPw("");
      setConfirm("");
      setBusy(false);
      setIncludeCredentials(true);
      requestAnimationFrame(() => inputRef.current?.focus());

      if (isExport) {
        let isMounted = true;
        setPreflightLoading(true);
        setPreflightError(null);
        setPreflight(null);

        void (async () => {
          try {
            const { invoke } = await import("@tauri-apps/api/core");
            const summary = await invoke<BackupPreflightSummary>("backup_preflight");
            if (isMounted) {
              setPreflight(summary);
            }
          } catch {
            if (isMounted) {
              setPreflightError("Couldn’t inspect credential counts.");
            }
          } finally {
            if (isMounted) {
              setPreflightLoading(false);
            }
          }
        })();

        return () => {
          isMounted = false;
        };
      }
    }
  }, [open, isExport]);

  const submit = useCallback(async () => {
    if (!canSubmit) return;
    setBusy(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      if (isExport) {
        const { save } = await import("@tauri-apps/plugin-dialog");
        const d = new Date();
        const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
        const dest = await save({
          title: "Save OmniSSH backup",
          defaultPath: `omnissh-backup-${stamp}.ascpbak`,
          filters: [{ name: "OmniSSH backup", extensions: ["ascpbak"] }],
        });
        if (!dest) { setBusy(false); return; } // dialog cancelled — keep the modal open
        await invoke("backup_export", { password: pw, path: dest, includeCredentials });
        toast.success("Encrypted backup saved.");
        onClose();
      } else {
        await invoke("backup_import", { password: pw, path });
        // Relaunch so all in-memory state reloads from the restored database.
        try {
          const { relaunch } = await import("@tauri-apps/plugin-process");
          await relaunch();
        } catch {
          window.location.reload();
        }
      }
    } catch (e: unknown) {
      setBusy(false);
      const msg = e && typeof e === "object" && "message" in e
        ? String((e as { message: unknown }).message)
        : null;
      toast.error(msg ?? (isExport ? "Couldn’t export backup." : "Import failed."));
    }
  }, [canSubmit, isExport, pw, path, includeCredentials, onClose]);
  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title={isExport ? "Export encrypted backup" : "Import backup"}
      icon={isExport ? ShieldCheck : AlertCircle}
      iconVariant={isExport ? "accent" : "danger"}
      maxWidth="md"
      busy={busy}
      testId={`backup-modal-${mode}`}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy} className={BTN_GHOST}>Cancel</button>
          <button
            form="backup-form"
            type="submit"
            data-testid="backup-submit"
            disabled={!canSubmit}
            className={isExport ? BTN_PRIMARY : BTN_DANGER}
          >
            {busy && <RefreshCw size={13} strokeWidth={2} className="motion-safe:animate-spin" />}
            {isExport ? (busy ? "Exporting…" : "Choose file & export") : (busy ? "Restoring…" : "Import & restart")}
          </button>
        </>
      }
    >
        <form id="backup-form" onSubmit={(e) => { e.preventDefault(); void submit(); }} className="flex flex-col gap-4">
          <p className="text-[length:var(--text-sm)] text-text-secondary">
            {isExport
              ? "Choose a password to encrypt the backup. You’ll need it to restore — there’s no way to recover the data without it."
              : "Enter the password this backup was created with. Importing replaces all current data and restarts OmniSSH."}
          </p>

          {isExport && (
            /* Credential scope selection allowing users to omit System Keychain
             * reads and avoid repeated OS-level access dialogs during export. */
            <div className="flex flex-col gap-2.5 rounded-xl border border-border/60 bg-bg-surface/50 p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[length:var(--text-xs)] font-medium uppercase tracking-wider text-text-muted">
                  Credential Scope
                </span>
                {preflightLoading && (
                  <span className="flex items-center gap-1 text-[length:var(--text-2xs)] text-text-muted">
                    <RefreshCw size={11} strokeWidth={2} className="motion-safe:animate-spin" />
                    Checking counts…
                  </span>
                )}
              </div>

              <div className="flex flex-col gap-2" role="radiogroup" aria-label="Credential scope">
                <label className="flex items-start gap-2.5 cursor-pointer text-[length:var(--text-sm)]">
                  <input
                    type="radio"
                    name="backup-credentials-mode"
                    data-testid="backup-include-credentials"
                    checked={includeCredentials}
                    disabled={busy}
                    onChange={() => setIncludeCredentials(true)}
                    className="mt-0.5 accent-accent"
                  />
                  <div className="flex flex-col">
                    <span className="font-medium text-text-primary">
                      Include System Keychain credentials (full backup)
                    </span>
                    <span className="text-[length:var(--text-xs)] text-text-muted">
                      Exports all saved hosts, snippets, settings, and stored credentials.
                    </span>
                  </div>
                </label>

                <label className="flex items-start gap-2.5 cursor-pointer text-[length:var(--text-sm)]">
                  <input
                    type="radio"
                    name="backup-credentials-mode"
                    data-testid="backup-skip-credentials"
                    checked={!includeCredentials}
                    disabled={busy}
                    onChange={() => setIncludeCredentials(false)}
                    className="mt-0.5 accent-accent"
                  />
                  <div className="flex flex-col">
                    <span className="font-medium text-text-primary">
                      Skip System Keychain credentials
                    </span>
                    <span className="text-[length:var(--text-xs)] text-text-muted">
                      Avoids System Keychain reads and prompts. Encrypted App Vault credentials remain in the backup and stay protected by their master password.
                    </span>
                    {preflight && preflight.localVaultHosts > 0 && (
                      <span className="text-[length:var(--text-xs)] text-text-muted">
                        Includes {preflight.localVaultHosts} App Vault host{preflight.localVaultHosts === 1 ? "" : "s"} without Keychain prompts.
                      </span>
                    )}
                  </div>
                </label>
              </div>

              {includeCredentials && preflight && (() => {
                const totalKeychain = preflight.keychainHostCandidates + preflight.s3Candidates;
                return (
                  <div className="mt-1 rounded-lg border border-status-warning/30 bg-status-warning/10 p-2.5 text-[length:var(--text-xs)] text-text-secondary">
                    {totalKeychain > 0 ? (
                      <p>
                        macOS may request Keychain access up to {totalKeychain} time{totalKeychain === 1 ? "" : "s"} during export ({preflight.keychainHostCandidates} host candidate{preflight.keychainHostCandidates === 1 ? "" : "s"}, {preflight.s3Candidates} S3 candidate{preflight.s3Candidates === 1 ? "" : "s"}).
                      </p>
                    ) : (
                      <p>No System Keychain credential candidates found.</p>
                    )}
                  </div>
                );
              })()}

              {preflightError && (
                <p className="text-[length:var(--text-xs)] text-status-error">
                  {preflightError}
                </p>
              )}
            </div>
          )}

          <div>
            <label htmlFor="backup-pw" className={FIELD_LABEL_CLASS}>Password</label>
            <input
              ref={inputRef}
              id="backup-pw"
              data-testid="backup-password"
              type="password"
              autoComplete={isExport ? "new-password" : "current-password"}
              value={pw}
              disabled={busy}
              onChange={(e) => setPw(e.target.value)}
              placeholder={isExport ? `At least ${MIN_LEN} characters` : "Backup password"}
              className={TEXT_INPUT_CLASS}
            />
          </div>

          {isExport && (
            <div>
              <label htmlFor="backup-pw2" className={FIELD_LABEL_CLASS}>Confirm password</label>
              <input
                id="backup-pw2"
                data-testid="backup-password-confirm"
                type="password"
                autoComplete="new-password"
                value={confirm}
                disabled={busy}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="Re-enter password"
                className={TEXT_INPUT_CLASS}
              />
              {confirm.length > 0 && pw !== confirm && (
                <p className="mt-1 text-[length:var(--text-xs)] text-status-error">Passwords don’t match.</p>
              )}
            </div>
          )}

          {!isExport && (
            <p className="text-[length:var(--text-xs)] text-text-muted mt-2">
              Credentials are restored to their original storage location. You can migrate them afterwards from Settings → Security.
            </p>
          )}

        </form>
    </ModalShell>
  );
}

/** Typed-confirmation dialog for the irreversible factory reset. The user must
 *  type the confirm word, then we wipe the backend and relaunch the app. */
function ConfirmResetModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const CONFIRM_WORD = "DELETE";
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);

  const canReset = text.trim() === CONFIRM_WORD && !busy;

  useEffect(() => {
    if (open) {
      setText("");
      setBusy(false);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const doReset = useCallback(async () => {
    setBusy(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("factory_reset");
      // Relaunch so all in-memory state — frontend stores AND backend sessions —
      // restarts from the now-empty database, a true first-launch state.
      try {
        const { relaunch } = await import("@tauri-apps/plugin-process");
        await relaunch();
      } catch {
        // Relaunch unavailable (dev/web) — reload the webview as a fallback.
        window.location.reload();
      }
    } catch {
      setBusy(false);
      toast.error("Couldn’t clear data. Please try again.");
    }
  }, []);

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title="Clear all data?"
      icon={AlertCircle}
      iconVariant="danger"
      maxWidth="md"
      busy={busy}
      testId="reset-modal"
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy} className={BTN_GHOST}>Cancel</button>
          <button
            type="button"
            data-testid="reset-confirm-submit"
            onClick={() => void doReset()}
            disabled={!canReset}
            className={`flex items-center gap-1.5 ${BTN_DANGER}`}
          >
            {busy && <RefreshCw size={13} strokeWidth={2} className="motion-safe:animate-spin" />}
            {busy ? "Clearing…" : "Clear all data"}
          </button>
        </>
      }
    >
        <div className="flex flex-col gap-4">
          <p className="text-[length:var(--text-sm)] text-text-secondary">
            This permanently deletes <strong className="text-text-primary">all</strong> saved
            hosts, groups, history, snippets, port-forward rules, S3 connections, stored
            credentials, and preferences. OmniSSH will restart fresh. This action cannot be undone.
          </p>
          <div>
            <label htmlFor="reset-confirm" className={FIELD_LABEL_CLASS}>
              Type <code className="px-1 rounded bg-bg-base text-status-error">{CONFIRM_WORD}</code> to confirm
            </label>
            <input
              ref={inputRef}
              id="reset-confirm"
              data-testid="reset-confirm-input"
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={text}
              disabled={busy}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && canReset) void doReset(); }}
              placeholder={CONFIRM_WORD}
              className={TEXT_INPUT_CLASS}
            />
          </div>
        </div>
    </ModalShell>
  );
}

// ─── Editors ──────────────────────────────────────────────────────────────────

/** A detected editor as returned by the `detect_editors` backend command. */
type DetectedEditor = { name: string; execPath: string; args: string };

function EditorsSettings() {
  const editors = useSettingsStore((s) => s.editors);
  const defaultEditorId = useSettingsStore((s) => s.defaultEditorId);
  const addEditor = useSettingsStore((s) => s.addEditor);
  const removeEditor = useSettingsStore((s) => s.removeEditor);
  const setDefaultEditor = useSettingsStore((s) => s.setDefaultEditor);

  const [detected, setDetected] = useState<DetectedEditor[] | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);

  const configuredPaths = new Set(editors.map((e) => e.execPath));
  const newlyDetected = (detected ?? []).filter((e) => !configuredPaths.has(e.execPath));

  const scan = useCallback(async () => {
    setDetecting(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const found = await invoke<DetectedEditor[]>("detect_editors");
      setDetected(found);
      // Feedback when the scan adds nothing new (the common case after the
      // first-run auto-seed) so the button doesn't feel inert.
      const configured = new Set(useSettingsStore.getState().editors.map((e) => e.execPath));
      if (found.filter((e) => !configured.has(e.execPath)).length === 0) {
        toast.info(found.length === 0
          ? "No editors found on this computer."
          : "All detected editors are already added.");
      }
    } catch {
      toast.error("Couldn't scan for editors.");
    } finally {
      setDetecting(false);
    }
  }, []);

  return (
    <>
      <SettingsGroup label="Editors">
        {editors.length === 0 ? (
          <div className="px-4 py-6 rounded-xl bg-bg-surface border border-border/50 text-center">
            <p className="text-[length:var(--text-sm)] text-text-muted">
              No editors configured. Scan for installed editors, or add one manually.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {editors.map((ed) => (
              <EditorRow
                key={ed.id}
                editor={ed}
                isDefault={ed.id === defaultEditorId}
                onMakeDefault={() => setDefaultEditor(ed.id)}
                onRemove={() => removeEditor(ed.id)}
              />
            ))}
          </div>
        )}

        {/* Actions: the two ways to add an editor. */}
        <div className="flex items-center gap-2 mt-3">
          <button onClick={() => void scan()} disabled={detecting} className={BTN_SECONDARY}>
            {detecting
              ? <RefreshCw size={13} strokeWidth={2} className="motion-safe:animate-spin" />
              : <Search size={13} strokeWidth={2} />}
            {detecting ? "Scanning…" : "Scan for editors"}
          </button>
          <button onClick={() => setCustomOpen(true)} className={BTN_SECONDARY}>
            <Plus size={13} strokeWidth={2} /> Add custom editor
          </button>
        </div>

        {editors.length > 0 && (
          <p className="px-1 mt-2 text-[length:var(--text-xs)] text-text-muted">
            The starred editor is used by “Edit”; the rest appear under “Open With”.
          </p>
        )}
      </SettingsGroup>

      {/* Detected-but-not-added editors appear only after a scan turns some up. */}
      {newlyDetected.length > 0 && (
        <SettingsGroup label="Found on this computer">
          <div className="flex flex-col gap-2">
            {newlyDetected.map((ed) => (
              <div
                key={ed.execPath}
                className="flex items-center justify-between gap-3 px-4 py-3 rounded-xl bg-bg-surface border border-border/50"
              >
                <div className="min-w-0">
                  <p className={LABEL_CLASS}>{ed.name}</p>
                  <p className="text-[length:var(--text-xs)] text-text-muted truncate" title={ed.execPath}>
                    {ed.execPath}
                  </p>
                </div>
                <button
                  onClick={() => addEditor({ name: ed.name, execPath: ed.execPath, args: ed.args || "{path}" })}
                  className={BTN_SECONDARY}
                >
                  <Plus size={13} strokeWidth={2} /> Add
                </button>
              </div>
            ))}
          </div>
        </SettingsGroup>
      )}

      <AddEditorModal open={customOpen} onClose={() => setCustomOpen(false)} onAdd={addEditor} />
    </>
  );
}

/* Vault status comes from Rust on every Settings mount. Password changes and
 * Keychain migration are delegated to dialogs and IPC commands without
 * retaining secrets in this page's state. */
function SecuritySettings() {
  const configured = useLocalVaultStore((state) => state.configured);
  const unlocked = useLocalVaultStore((state) => state.unlocked);
  const loading = useLocalVaultStore((state) => state.loading);
  const loadStatus = useLocalVaultStore((state) => state.loadStatus);
  const lockVault = useLocalVaultStore((state) => state.lockVault);
  const defaultCredentialStorage = useSettingsStore((s) => s.defaultCredentialStorage);
  const setDefaultCredentialStorage = useSettingsStore((s) => s.setDefaultCredentialStorage);
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [createVaultOpen, setCreateVaultOpen] = useState(false);
  const [promptDefaultStorageOpen, setPromptDefaultStorageOpen] = useState(false);
  const [preflight, setPreflight] = useState<MigrationPreflightSummary | null>(null);
  const [preflightLoading, setPreflightLoading] = useState(false);
  const [migrating, setMigrating] = useState(false);

  /* The mount-time preflight is IPC: it can settle after the page is gone
   * (closing Settings, or a test tearing the render down), and a setState on
   * an unmounted tree is an unhandled rejection, not a render. The flag is the
   * cancellation this fire-and-forget call otherwise has none of. */
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const fetchPreflight = useCallback(async () => {
    if (!alive.current) return;
    setPreflightLoading(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const summary = await invoke<MigrationPreflightSummary>("local_vault_migration_preflight");
      if (alive.current) setPreflight(summary);
    } catch {
      // Non-fatal preflight inspection
    } finally {
      if (alive.current) setPreflightLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus().catch(() => {
      if (alive.current) toast.error("Couldn’t load encrypted vault status.");
    });
    void fetchPreflight();
  }, [loadStatus, fetchPreflight]);

  const lock = useCallback(async () => {
    try {
      await lockVault();
      toast.success("Encrypted vault locked.");
    } catch {
      toast.error("Couldn’t lock encrypted vault.");
    }
  }, [lockVault]);

  /* Invokes bulk credential migration from macOS Keychain into the App Vault.
   * Unlocks the vault if needed before running, surfaces outcome feedback,
   * and refreshes preflight metrics upon completion. */
  const runMigration = useCallback(async () => {
    setMigrating(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const result = await invoke<BulkMigrationResult>("local_vault_migrate_all_from_keychain");
      if (result.failed.length === 0) {
        const skippedSuffix = result.skipped > 0 ? ` (skipped ${result.skipped} without keychain entries)` : "";
        toast.success(`Migrated ${result.migrated} credential${result.migrated === 1 ? "" : "s"} to App Vault${skippedSuffix}.`);
      } else {
        const failedLabels = result.failed.slice(0, 3).map((f) => f.hostLabel || f.hostId).join(", ");
        const extraCount = result.failed.length > 3 ? `, +${result.failed.length - 3} more` : "";
        const total = result.migrated + result.failed.length;
        toast.error(`Migrated ${result.migrated} of ${total} credentials. Failed: ${failedLabels}${extraCount}.`);
      }
    } catch (e: unknown) {
      const msg = e && typeof e === "object" && "message" in e
        ? String((e as { message: unknown }).message)
        : (typeof e === "string" ? e : null);
      toast.error(msg ?? "Couldn’t migrate credentials to App Vault.");
    } finally {
      await fetchPreflight();
      setMigrating(false);
    }
  }, [fetchPreflight]);

  const handleMigrateClick = useCallback(() => {
    if (!unlocked) {
      setUnlockOpen(true);
    } else {
      void runMigration();
    }
  }, [unlocked, runMigration]);

  return (
    <>
      <SettingsGroup label="Encrypted App Vault">
        {!configured ? (
          <div className="rounded-xl border border-border/50 bg-bg-surface px-4 py-3 flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className={LABEL_CLASS}>No encrypted vault set up</p>
              <p className={DESC_CLASS}>
                Create one with a master password, or choose “Encrypted App Vault” while
                editing a password-authenticated host.
              </p>
            </div>
            <button
              type="button"
              data-testid="settings-vault-create"
              onClick={() => setCreateVaultOpen(true)}
              disabled={loading}
              className={BTN_SECONDARY}
            >
              Create vault…
            </button>
          </div>
        ) : (
          <>
            <SettingRow>
              <div>
                <p className={LABEL_CLASS}>Vault Status</p>
                <p className={DESC_CLASS}>
                  {unlocked
                    ? "Unlocked for this OmniSSH session."
                    : "Locked. Enter the current master password to change it."}
                </p>
              </div>
              <span
                data-testid="settings-vault-status"
                className={`rounded-full px-2 py-1 text-[length:var(--text-2xs)] font-medium ${
                  unlocked ? "bg-status-success/10 text-status-success" : "bg-bg-overlay text-text-muted"
                }`}
              >
                {unlocked ? "Unlocked" : "Locked"}
              </span>
            </SettingRow>
            <SettingRow>
              <div>
                <p className={LABEL_CLASS}>Master Password</p>
                <p className={DESC_CLASS}>
                  Re-encrypt every locally stored host password with a new master password.
                </p>
              </div>
              <button
                type="button"
                data-testid="settings-vault-change-master-password"
                onClick={() => setChangePasswordOpen(true)}
                disabled={loading}
                className={BTN_SECONDARY}
              >
                Change password…
              </button>
            </SettingRow>
            {unlocked && (
              <SettingRow>
                <div>
                  <p className={LABEL_CLASS}>Session Access</p>
                  <p className={DESC_CLASS}>Lock now to require the master password again.</p>
                </div>
                <button
                  type="button"
                  data-testid="settings-vault-lock"
                  onClick={() => void lock()}
                  disabled={loading}
                  className={BTN_SECONDARY}
                >
                  Lock vault
                </button>
              </SettingRow>
            )}
            {preflight && preflight.migratable > 0 ? (
              <div className="rounded-xl border border-border/50 bg-bg-surface px-4 py-3 flex flex-col gap-3">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className={LABEL_CLASS}>Migrate Credentials to App Vault</p>
                    <p className={DESC_CLASS}>
                      Moving System Keychain credentials into the encrypted App Vault eliminates
                      repeated macOS Keychain prompts during backups and daily use.
                    </p>
                  </div>
                  <button
                    type="button"
                    data-testid="settings-vault-migrate"
                    onClick={handleMigrateClick}
                    disabled={migrating || preflightLoading}
                    className={BTN_SECONDARY}
                  >
                    <RefreshCw
                      size={13}
                      strokeWidth={2}
                      className={`shrink-0 ${migrating ? "motion-safe:animate-spin" : "invisible"}`}
                    />
                    Migrate all to App Vault
                  </button>
                </div>
                <div className="flex flex-col gap-1 pt-1 border-t border-border/40">
                  <p
                    data-testid="settings-vault-migrate-count"
                    className="text-[length:var(--text-xs)] text-text-secondary"
                  >
                    {preflight.migratable} credential{preflight.migratable === 1 ? "" : "s"} on System Keychain · {preflight.alreadyInVault} already in App Vault.
                    {preflight.nonMigratable > 0 && (
                      <span className="text-text-muted">
                        {" "}{preflight.nonMigratable} host{preflight.nonMigratable === 1 ? "" : "s"} {preflight.nonMigratable === 1 ? "uses" : "use"} SSH keys and can’t be moved to the App Vault yet.
                      </span>
                    )}
                  </p>
                  <p className="text-[length:var(--text-xs)] text-text-muted">
                    macOS asks to authorize each System Keychain credential the first time it is
                    read — one prompt per credential shown above. Approve with “Always Allow” to
                    make it once per credential instead of on every run.
                  </p>
                </div>
              </div>
            ) : preflight && preflight.migratable === 0 && preflight.alreadyInVault > 0 ? (
              <SettingRow>
                <div>
                  <p className={LABEL_CLASS}>Credential Migration</p>
                  <p
                    data-testid="settings-vault-migration-status"
                    className={DESC_CLASS}
                  >
                    All eligible credentials are stored in the App Vault.
                  </p>
                </div>
              </SettingRow>
            ) : null}
          </>
        )}
      </SettingsGroup>
      <SettingsGroup label="New Host Credentials">
        <SettingRow>
          <div>
            <p className={LABEL_CLASS}>Default Password Storage</p>
            <p className={DESC_CLASS}>
              Where new password-authenticated hosts store their credential by default. Choosing the App Vault creates it on first save.
            </p>
          </div>
          <CustomSelect
            id="security-default-storage"
            data-testid="security-default-storage"
            value={defaultCredentialStorage}
            onChange={(value) => {
              setDefaultCredentialStorage(value as CredentialStorage);
              /* Choosing the App Vault with none set up is the moment to create
               * it, rather than discovering at first host save that it is missing. */
              if (value === "localVault" && !configured) setCreateVaultOpen(true);
            }}
            options={[
              { value: "keychain", label: "System Keychain" },
              { value: "localVault", label: "Encrypted App Vault" },
            ]}
          />
        </SettingRow>
      </SettingsGroup>
      <CreateVaultDialog
        open={createVaultOpen}
        onClose={() => setCreateVaultOpen(false)}
        onSuccess={() => {
          toast.success("Encrypted App Vault created.");
          void fetchPreflight();
          /* A fresh vault is the moment to offer it as the storage default. If
           * the user already picked it in the dropdown, there is nothing to ask. */
          if (defaultCredentialStorage !== "localVault") setPromptDefaultStorageOpen(true);
        }}
      />
      <VaultDefaultStorageDialog
        open={promptDefaultStorageOpen}
        onClose={() => setPromptDefaultStorageOpen(false)}
        onAccept={() => {
          setDefaultCredentialStorage("localVault");
          setPromptDefaultStorageOpen(false);
          toast.success("App Vault set as the default password storage.");
        }}
      />
      <ChangeVaultPasswordDialog
        open={changePasswordOpen}
        onClose={() => setChangePasswordOpen(false)}
        onSuccess={() => toast.success("Master password changed. The vault remains unlocked.")}
      />
      <UnlockVaultDialog
        open={unlockOpen}
        onClose={() => setUnlockOpen(false)}
        onSuccess={() => {
          void runMigration();
        }}
      />
    </>
  );
}

function EditorRow({ editor, isDefault, onMakeDefault, onRemove }: {
  editor: EditorConfig;
  isDefault: boolean;
  onMakeDefault: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3 rounded-xl bg-bg-surface border border-border/50">
      <div className="min-w-0">
        <p className={`${LABEL_CLASS} flex items-center gap-1.5`}>
          {editor.name}
          {isDefault && (
            <span className="text-[length:var(--text-2xs)] font-medium text-accent uppercase tracking-wide">Default</span>
          )}
        </p>
        <p className="text-[length:var(--text-xs)] text-text-muted truncate" title={editor.execPath}>
          {editor.execPath} <span className="opacity-60">· {editor.args}</span>
        </p>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <button
          type="button"
          onClick={onMakeDefault}
          disabled={isDefault}
          title={isDefault ? "Default editor" : "Set as default"}
          aria-label={isDefault ? "Default editor" : "Set as default"}
          className={[
            "p-1.5 rounded-lg border transition-colors duration-[var(--duration-fast)]",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            isDefault
              ? "border-transparent text-accent pointer-events-none"
              : "border-border text-text-muted hover:text-text-primary hover:border-border-focus",
          ].join(" ")}
        >
          <Star size={15} strokeWidth={2} fill={isDefault ? "currentColor" : "none"} />
        </button>
        <button
          type="button"
          onClick={onRemove}
          title="Remove"
          aria-label={`Remove ${editor.name}`}
          className="p-1.5 rounded-lg border border-border text-text-muted hover:text-status-error hover:border-status-error/40 transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Trash2 size={15} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}

/** Modal form for adding a custom editor — opened from the Editors section so
 *  the multi-field form isn't always taking up space on the page. */
function AddEditorModal({ open, onClose, onAdd }: {
  open: boolean;
  onClose: () => void;
  onAdd: (editor: Omit<EditorConfig, "id">) => void;
}) {
  const [name, setName] = useState("");
  const [execPath, setExecPath] = useState("");
  const [args, setArgs] = useState("{path}");
  const [visible, setVisible] = useState(false);

  const nameRef = useRef<HTMLInputElement>(null);

  // Reset fields and play the open transition each time it's shown.
  useEffect(() => {
    if (open) {
      setName("");
      setExecPath("");
      setArgs("{path}");
      requestAnimationFrame(() => setVisible(true));
    } else {
      setVisible(false);
    }
  }, [open]);

  useEffect(() => {
    if (visible) requestAnimationFrame(() => nameRef.current?.focus());
  }, [visible]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const browse = useCallback(async () => {
    try {
      const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
      const picked = await openDialog({ multiple: false, directory: false, title: "Select editor executable" });
      if (typeof picked === "string") {
        setExecPath(picked);
        // Pre-fill the name from the file/app name when it's still blank.
        setName((cur) => (cur.trim() ? cur : (picked.split(/[\\/]/).pop() ?? "").replace(/\.(app|exe)$/i, "")));
      }
    } catch { /* dialog cancelled / unavailable */ }
  }, []);

  const canAdd = name.trim().length > 0 && execPath.trim().length > 0;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canAdd) return;
    onAdd({ name: name.trim(), execPath: execPath.trim(), args: args.trim() || "{path}" });
    onClose();
  };

  if (!open) return null;

  return (
    <ModalBackdrop
      onClose={onClose}
      className={[
        "fixed inset-0 z-50 flex items-start justify-center pt-[8vh]",
        "transition-[background-color,backdrop-filter] duration-[var(--duration-base)]",
        visible ? "bg-black/50 backdrop-blur-sm" : "bg-black/0 backdrop-blur-none",
      ].join(" ")}
    >
      <form
        onSubmit={submit}
        data-testid="editor-modal"
        className={[
          "w-full max-w-md rounded-xl bg-bg-overlay border border-border shadow-[var(--shadow-lg)]",
          "flex flex-col max-h-[84vh]",
          "transition-[opacity,transform] duration-[var(--duration-slow)] ease-[var(--ease-expo-out)]",
          visible ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-3",
        ].join(" ")}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-border shrink-0">
          <h2 className="text-[length:var(--text-lg)] font-semibold text-text-primary">Add Editor</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-subtle transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-4 overflow-y-auto flex-1 min-h-0 flex flex-col gap-4">
          <div>
            <label htmlFor="ed-name" className={FIELD_LABEL_CLASS}>Name</label>
            <input
              ref={nameRef}
              id="ed-name"
              data-testid="ed-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Sublime Text"
              className={TEXT_INPUT_CLASS}
            />
          </div>

          <div>
            <label htmlFor="ed-path" className={FIELD_LABEL_CLASS}>Executable path</label>
            <div className="flex items-center gap-2">
              <input
                id="ed-path"
                data-testid="ed-path"
                type="text"
                value={execPath}
                onChange={(e) => setExecPath(e.target.value)}
                placeholder="/path/to/editor"
                className={TEXT_INPUT_CLASS}
              />
              <button
                type="button"
                onClick={() => void browse()}
                className="inline-flex items-center gap-1.5 px-3 py-2 shrink-0 rounded-lg text-[length:var(--text-sm)] font-medium bg-bg-base border border-border text-text-secondary hover:text-text-primary hover:border-border-focus hover:bg-bg-overlay transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <FolderOpen size={13} strokeWidth={2} /> Browse
              </button>
            </div>
          </div>

          <div>
            <label htmlFor="ed-args" className={FIELD_LABEL_CLASS}>Arguments</label>
            <input
              id="ed-args"
              data-testid="ed-args"
              type="text"
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              placeholder="{path}"
              className={TEXT_INPUT_CLASS}
            />
            <p className={DESC_CLASS}>
              Use <code className="px-1 rounded bg-bg-base">{"{path}"}</code> where the file should go. If omitted, it's added at the end.
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 pb-5 pt-3 flex items-center justify-end gap-2 border-t border-border shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-[length:var(--text-sm)] text-text-secondary hover:text-text-primary rounded-lg transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canAdd}
            className="px-4 py-2 text-[length:var(--text-sm)] font-medium text-text-inverse bg-accent hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg-overlay"
          >
            Add editor
          </button>
        </div>
      </form>
    </ModalBackdrop>
  );
}

function AboutSettings() {
  const autoUpdate = useSettingsStore((s) => s.autoUpdate);
  const setAutoUpdate = useSettingsStore((s) => s.setAutoUpdate);

  return (
    <>
      <SettingsGroup label="About">
        <AboutCard />
      </SettingsGroup>
      <SettingsGroup label="Updates">
        <SettingRow>
          <div>
            <label htmlFor="s-auto-update" className={LABEL_CLASS}>Automatic Updates</label>
            <p className={DESC_CLASS}>Download and install updates in the background, applied on the next launch</p>
          </div>
          <Toggle id="s-auto-update" checked={autoUpdate} onChange={setAutoUpdate} />
        </SettingRow>
        <UpdateChecker />
      </SettingsGroup>
    </>
  );
}

function AboutCard() {
  const [appVersion, setAppVersion] = useState<string | null>(null);

  // Real app version (injected from git tags at build).
  useEffect(() => {
    void (async () => {
      try {
        const { getVersion } = await import("@tauri-apps/api/app");
        setAppVersion(await getVersion());
      } catch { /* best-effort */ }
    })();
  }, []);

  const openRepo = useCallback(async () => {
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(REPO_URL);
    } catch { /* best-effort */ }
  }, []);

  return (
    <div className="px-4 py-3 rounded-xl bg-bg-surface border border-border/50">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-[length:var(--text-base)] font-semibold text-text-primary">OmniSSH{import.meta.env.DEV ? "-dev" : ""}</p>
          <p className={DESC_CLASS}>A modern desktop client for SSH, SFTP/SCP, and S3</p>
        </div>
        <span className="shrink-0 text-[length:var(--text-xs)] tabular-nums text-text-muted">
          {appVersion ? `v${appVersion}` : ""}
        </span>
      </div>

      <div className="mt-3 pt-3 border-t border-border/50 flex items-center justify-between gap-4">
        <div>
          <p className={LABEL_CLASS}>Repository</p>
          <p className={DESC_CLASS}>Source code, issues, and releases on GitHub</p>
        </div>
        <button
          onClick={() => void openRepo()}
          className={[
            "flex items-center gap-1.5 px-3 py-1.5 rounded-lg shrink-0",
            "text-[length:var(--text-sm)] font-medium",
            "bg-bg-base border border-border text-text-secondary",
            "hover:text-text-primary hover:border-border-focus",
            "transition-all duration-[var(--duration-fast)]",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          ].join(" ")}
        >
          <ExternalLink size={13} strokeWidth={2} />
          GitHub
        </button>
      </div>
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────────

/** A labelled group of setting cards, mirroring the "THEME" / "INTERFACE" sections. */
function SettingsGroup({ label, children }: { label?: string; children: React.ReactNode }) {
  return (
    <section className="mb-6 last:mb-0">
      {label && (
        <h2 className="px-1 mb-3 text-[length:var(--text-2xs)] font-semibold uppercase tracking-wider text-text-muted">
          {label}
        </h2>
      )}
      <div className="flex flex-col gap-2">{children}</div>
    </section>
  );
}

function SettingRow({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3 rounded-xl bg-bg-surface border border-border/50">
      {children}
    </div>
  );
}

function Toggle({ id, checked, onChange }: { id: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      id={id}
      data-testid={id}
      role="switch"
      aria-checked={checked}

      onClick={() => onChange(!checked)}
      className={[
        "relative w-9 h-5 rounded-full shrink-0",
        "transition-colors duration-[var(--duration-fast)]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        checked ? "bg-accent" : "bg-bg-muted",
      ].join(" ")}
    >
      <span
        className={[
          "absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow-[var(--shadow-sm)]",
          "transition-transform duration-[var(--duration-fast)]",
          checked ? "translate-x-4" : "translate-x-0",
        ].join(" ")}
      />
    </button>
  );
}

/** Segmented toggle for small option sets (e.g. theme, cursor style). */
function SegmentedControl<T extends string>({ id, value, onChange, options }: {
  id?: string;
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div
      id={id}
      role="radiogroup"
      className="inline-grid shrink-0 gap-1 p-1 rounded-lg bg-bg-base border border-border"
      style={{ gridTemplateColumns: `repeat(${options.length}, 1fr)` }}
    >
      {options.map((opt) => {
        const selected = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={selected}
            data-testid={id ? `${id}-${opt.value}` : undefined}
            onClick={() => onChange(opt.value)}
            className={[
              "px-3 py-1.5 rounded-md text-center text-[length:var(--text-sm)] font-medium",
              "transition-colors duration-[var(--duration-fast)]",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              selected
                ? "bg-bg-overlay text-text-primary shadow-[var(--shadow-sm)]"
                : "text-text-muted hover:text-text-primary",
            ].join(" ")}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

// ─── Update checker ─────────────────────────────────────────────────────────

function UpdateChecker() {
  const status = useUpdaterStore((s) => s.status);
  const version = useUpdaterStore((s) => s.version);
  const error = useUpdaterStore((s) => s.error);
  const progress = useUpdaterStore((s) => s.progress);
  const appVersion = useUpdaterStore((s) => s.appVersion);
  const checkManually = useUpdaterStore((s) => s.checkManually);
  const relaunchNow = useUpdaterStore((s) => s.relaunchNow);

  useEffect(() => {
    void useUpdaterStore.getState().loadAppVersion();
  }, []);

  const showCheck =
    status === "idle" || status === "up-to-date" || status === "error" || status === "available";

  return (
    <div className="px-4 py-3 rounded-xl bg-bg-surface border border-border/50">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className={LABEL_CLASS}>App Version</p>
          <p className={DESC_CLASS}>
            {status === "up-to-date" && "You're on the latest version"}
            {status === "available" && `v${version} is available`}
            {status === "downloading" && `Downloading update... ${progress}%`}
            {status === "ready" && "Update downloaded. Restart to apply."}
            {status === "error" && (error ?? "Something went wrong")}
            {(status === "idle" || status === "checking") && (appVersion ? `Current: v${appVersion}` : "Reading version\u2026")}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {status === "up-to-date" && (
            <CheckCircle2 size={15} strokeWidth={2} className="text-status-connected shrink-0" />
          )}
          {status === "error" && (
            <AlertCircle size={15} strokeWidth={2} className="text-status-error shrink-0" />
          )}

          {showCheck && (
            <button
              onClick={() => void checkManually()}
              className={[
                "flex items-center gap-1.5 px-3 py-1.5 rounded-lg",
                "text-[length:var(--text-sm)] font-medium",
                "bg-bg-base border border-border text-text-secondary",
                "hover:text-text-primary hover:border-border-focus",
                "transition-all duration-[var(--duration-fast)]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              ].join(" ")}
            >
              <RefreshCw size={13} strokeWidth={2} />
              Check
            </button>
          )}

          {status === "checking" && (
            <span className="flex items-center gap-1.5 px-3 py-1.5 text-[length:var(--text-sm)] font-medium text-text-muted">
              <RefreshCw size={13} strokeWidth={2} className="motion-safe:animate-spin" />
              Checking...
            </span>
          )}

          {status === "downloading" && (
            <div className="w-24 h-1.5 rounded-full bg-bg-muted overflow-hidden">
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-200"
                style={{ width: `${progress}%` }}
              />
            </div>
          )}

          {status === "ready" && (
            <button
              onClick={() => void relaunchNow()}
              className={[
                "flex items-center gap-1.5 px-3 py-1.5 rounded-lg",
                "text-[length:var(--text-sm)] font-medium",
                "bg-status-connected text-text-inverse",
                "hover:opacity-90",
                "transition-all duration-[var(--duration-fast)]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              ].join(" ")}
            >
              Restart Now
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Slider with a live value readout, for bounded numeric settings. */
function RangeSetting({ id, value, min, max, step, decimals = 0, unit = "", onChange }: {
  id: string;
  value: number;
  min: number;
  max: number;
  step: number;
  decimals?: number;
  unit?: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-3 shrink-0">
      <input
        id={id}
        data-testid={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-36 h-1.5 cursor-pointer"
        style={{ accentColor: "var(--color-accent)" }}
      />
      <span className="w-10 shrink-0 text-right text-[length:var(--text-sm)] tabular-nums text-text-secondary">
        {value.toFixed(decimals)}{unit}
      </span>
    </div>
  );
}

/** Number input that uses local state while typing, commits on blur/Enter. */
function NumberSetting({ id, value, min, max, step, onChange }: {
  id: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  const [local, setLocal] = useState(String(value));

  // Sync from store when value changes externally
  useEffect(() => {
    setLocal(String(value));
  }, [value]);

  const commit = () => {
    const n = Number(local);
    if (isNaN(n)) {
      setLocal(String(value)); // revert
      return;
    }
    const clamped = Math.max(min, Math.min(max, n));
    onChange(clamped);
    setLocal(String(clamped));
  };

  return (
    <input
      id={id}
      data-testid={id}
      type="text"
      inputMode="decimal"
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
          (e.target as HTMLInputElement).blur();
        }
        // Arrow keys for increment/decrement
        if (e.key === "ArrowUp") {
          e.preventDefault();
          const next = Math.min(max, Number(local) + step);
          setLocal(String(Number(next.toFixed(2))));
          onChange(next);
        }
        if (e.key === "ArrowDown") {
          e.preventDefault();
          const next = Math.max(min, Number(local) - step);
          setLocal(String(Number(next.toFixed(2))));
          onChange(next);
        }
      }}
      className={INPUT_CLASS}
    />
  );
}
