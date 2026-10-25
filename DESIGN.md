---
version: alpha
name: OmniSSH
description: Dark-first desktop workspace for SSH terminals, SFTP/SCP explorers, and S3 storage.
colors:
  bg-base: "oklch(0.145 0.015 264)"
  bg-surface: "oklch(0.190 0.015 264)"
  bg-overlay: "oklch(0.230 0.015 264)"
  bg-subtle: "oklch(0.270 0.015 264)"
  bg-muted: "oklch(0.320 0.012 264)"
  text-primary: "oklch(0.945 0.010 264)"
  text-secondary: "oklch(0.720 0.015 264)"
  text-muted: "oklch(0.595 0.015 264)"
  text-inverse: "oklch(0.145 0.015 264)"
  accent: "oklch(0.700 0.150 250)"
  accent-hover: "oklch(0.650 0.150 250)"
  accent-muted: "oklch(0.700 0.150 250 / 0.15)"
  status-connected: "oklch(0.720 0.180 155)"
  status-connecting: "oklch(0.750 0.160 80)"
  status-error: "oklch(0.650 0.200 25)"
  status-disconnected: "oklch(0.560 0.015 264)"
  border: "oklch(0.320 0.012 264)"
  border-focus: "oklch(0.700 0.150 250)"
  ring: "oklch(0.700 0.150 250 / 0.40)"
typography:
  body:
    fontFamily: Geist
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.5
  body-small:
    fontFamily: Geist
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: Geist
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1.5
  micro:
    fontFamily: Geist
    fontSize: 11px
    fontWeight: 600
    lineHeight: 1.5
  heading:
    fontFamily: Geist
    fontSize: 17px
    fontWeight: 600
  code:
    fontFamily: JetBrains Mono
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
  terminal:
    fontFamily: JetBrains Mono
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.2
spacing:
  sidebar-width: 256px
  sidebar-collapsed: 0px
  tabbar-height: 44px
  statusbar-height: 26px
  scrollbar-size: 6px
omitted:
  - section: rounded
    reason: Radii come from Tailwind utilities on shared surfaces; theme.css defines no product radius token.
  - section: components
    reason: Shared primitives own their classes; there is no component token contract to encode.
---
# OmniSSH

## Overview

OmniSSH is a desktop operations workspace that keeps an SSH terminal, a file
explorer, and cloud storage in one window. The interface is dark-first, dense,
and deliberately quiet: near-neutral surfaces recede so terminal output and
file metadata carry the hierarchy. A single accent hue marks selection,
primary action, and focus. The chrome is built from five surface layers,
hairline borders, and compact type; decorative effect themes replace the
backdrop without changing the geometry or interaction model.

## Colors

The palette is a neutral stack plus one configurable accent and four status
roles. Surfaces step by roughly 0.045 in OKLCH lightness so adjacent layers read
as distinct without a drop shadow.

- **Background:** `bg-base` is the window and terminal field; `bg-surface` is
  the default panel; `bg-overlay`, `bg-subtle`, and `bg-muted` are raised
  dialogs, hover fills, and selected or pressed controls.
- **Text:** `text-primary` for values the user acts on, `text-secondary` for
  supporting copy, `text-muted` for metadata and placeholders, and
  `text-inverse` on accent-filled controls.
- **Accent:** `accent` marks focus, selection, primary buttons, active tabs, and
  connected status. `accent-hover` darkens the fill on press; `accent-muted` is
  the 15% tint used for selected rows and active tab backgrounds. The hue is a
  runtime setting, so accent tokens always derive from `--accent-hue` (250 by
  default) rather than a fixed brand hue.
- **Status:** `status-connected`, `status-connecting`, `status-error`, and
  `status-disconnected` are the only other saturated colors. They appear as
  dots, labels, and destructive actions, never as large fills.
- **Borders:** `border` separates structure; `border-focus` and `ring` belong to
  focus and active states only. A border that exists only to imply depth is not
  used; elevation is a shadow.

### Themes

Default values above are the dark theme. `theme.css` owns the alternate values;
the table records the ones that change the product's read most.

| Theme | Background base | Surface | Accent | Intent |
| --- | --- | --- | --- | --- |
| Light | `oklch(0.905 0.006 255)` | `oklch(0.955 0.004 255)` | `oklch(0.575 0.170 250)` | Soft grey daylight theme; same hierarchy, inverted lightness. |
| Matrix | `oklch(0.080 0.025 155 / 0.05)` | `oklch(0.120 0.030 155 / 0.78)` | `oklch(0.800 0.250 150)` | Translucent phosphor green over an animated glyph canvas. |
| Berserk | `oklch(0.085 0.020 25 / 0.05)` | `oklch(0.130 0.030 25 / 0.80)` | `oklch(0.620 0.240 25)` | Blood-black translucent chrome over animated embers. |
| Deep Sea | `oklch(0.075 0.030 235 / 0.05)` | `oklch(0.120 0.035 235 / 0.78)` | `oklch(0.760 0.180 205)` | Abyssal blue canvas with cyan accent. |
| Starfield | `oklch(0.070 0.025 265 / 0.05)` | `oklch(0.115 0.030 265 / 0.78)` | `oklch(0.730 0.170 245)` | Deep space canvas with a cool blue accent. |
| Fog | `oklch(0.085 0.006 150 / 0.05)` | `oklch(0.130 0.008 150 / 0.80)` | `oklch(0.680 0.070 145)` | Low-contrast mist with a desaturated green accent. |
| Erdtree | `oklch(0.090 0.020 80 / 0.05)` | `oklch(0.135 0.025 80 / 0.80)` | `oklch(0.780 0.150 85)` | Golden-tree canvas with an amber accent. |
| Sakura | `oklch(0.965 0.010 350 / 0.10)` | `oklch(0.985 0.008 350 / 0.82)` | `oklch(0.620 0.170 350)` | Light petal canvas; the only light effect theme. |
| Sakura Night | `oklch(0.090 0.020 340 / 0.05)` | `oklch(0.135 0.028 340 / 0.80)` | `oklch(0.740 0.170 320)` | Night petal canvas with a violet-pink accent. |
| Embers | `oklch(0.080 0.025 35 / 0.05)` | `oklch(0.125 0.028 35 / 0.78)` | `oklch(0.760 0.160 38)` | Warm ember canvas with an amber accent. |
| Lava | `oklch(0.070 0.020 20 / 0.05)` | `oklch(0.115 0.025 20 / 0.80)` | `oklch(0.700 0.190 18)` | Molten canvas with a rust accent and a text halo. |

## Typography

Geist carries interface copy; JetBrains Mono carries values the user compares or
copies. The scale is compact by desktop standards, with 14px body-small as the
dominant control size and 15px body reserved for primary reading.

- **Body:** Geist 400 at 15px/1.5 for descriptions and dialog copy.
- **Body small:** Geist 400 at 14px/1.5 for buttons, tabs, table rows, and form
  values. This is the default working size.
- **Label:** Geist 500 at 12px/1.5. Section headers and column headers set it
  uppercase with wide tracking; buttons leave it sentence case.
- **Micro:** Geist 600 at 11px/1.5 for badges, counts, environment tags, and
  status metadata.
- **Heading:** Geist 600 at 17px/1.3 for page and modal titles.
- **Code and terminal:** JetBrains Mono. Hostnames, paths, permissions, sizes,
  ports, timestamps, and terminal output use it. Terminal text defaults to
  14px/1.2 and is user-configurable.
- Dynamic numbers (sizes, ports, counts, transfer totals) use tabular figures so
  a value change does not shift its neighbours. Headings use balanced wrapping;
  long body copy uses pretty wrapping.

Do not substitute a second sans or mono family on a surface. User font overrides
replace the family token for the whole interface, not one component.

## Layout

The shell is a fixed viewport: a resizable sidebar, a main column with one
44px unified tab bar, a flexible content area, and a 26px status bar. The outer
frame uses 8px padding and 8px gaps; panels are opaque or translucent according
to the theme.

- Sidebar: 256px expanded, collapsed to a 0px rail with icon-only 36px
  controls. Group lists and host grids scroll inside the column, never the page.
- Main content: tabs are 32px tall with a 220px maximum label width; the active
  tab is accent-tinted with a 1px border. Terminal panes fill the remaining
  height and own their own scrollback.
- Explorer: a fixed 40px toolbar (home, breadcrumb, actions, search), a fixed
  column header, then a scrolling row list. The name column takes the remaining
  width; size is 80px, modified 176px, and permissions/storage class 96px. Below
  620px of pane width the modified column is hidden, and below 460px the
  permissions column is hidden as well.
- Scrollbars are 6px and share the `scrollbar-size` token so headers can reserve
  the same gutter.
- Spacing inside dense rows is 8px vertical and 12px horizontal; card padding is
  14px. Prefer the existing 4/6/8/12/14px steps over new values.

## Elevation & Depth

Three shadow levels express depth; borders express structure. Dark and light
themes carry separate shadow values because the same alpha reads differently on
each ground.

- `shadow-sm` for raised controls and active tabs; `shadow-md` for popovers,
  menus, and cards that float; `shadow-lg` for dialogs and the bottom connection
  pill.
- Effect themes add `backdrop-filter: blur(12px)` to chrome surfaces and 16px to
  dialogs, over the animated canvas. Do not apply backdrop blur to inputs,
  textareas, or selects: the promoted layer paints over adornment icons.
- Terminal panes are opaque so xterm output never competes with a moving
  background. Do not put translucency behind terminal glyphs.
- Ember and lava themes add a dark text halo to chrome, with terminal output
  explicitly exempt. Do not outline terminal text.

## Components

- **Unified tab:** 32px tall, `rounded-md`, 14px label, 14px icon. Inactive is
  `bg-overlay/80` with `border-border/60`; active is `accent/15` with an
  `accent/40` border and medium label weight. The tab icon carries the session
  status colour; pane headers and the status bar use a 6px dot. Connecting
  pulses only under `prefers-reduced-motion: no-preference`.
  The close button is invisible until hover or keyboard focus.
- **Host card:** `bg-surface`, 1px border, `rounded-xl`, 14px padding, and a
  top-left radial wash of the host colour at 20% alpha. The avatar is a 36px
  circle at 15% colour with the first grapheme of the label. A three-action strip
  is pinned top-right; text reserves that width and truncates. The health line is
  always mounted so a ping result never changes card height.
- **Explorer row:** 37px including padding, 16px type icon, flexible truncated
  name, right-aligned tabular size, centred timestamp, and monospaced
  permissions. Selected rows use `accent/10`; hover uses `bg-subtle`. Focus is an
  inset 2px ring. Offscreen rows may skip rendering; do not rely on their DOM
  state for layout.
- **Buttons:** primary is an accent fill with `text-inverse`; secondary is
  `bg-surface` with a border; ghost has no fill until hover; destructive uses
  `status-error` text and a tinted fill. All three keep a visible focus ring and
  use explicit colour/border transitions.
- **Empty states:** a muted 30px icon, one 14px sentence, an optional primary
  action, and a 11px hint. They sit inside the scroll area, not in a separate
  modal.
- **Errors:** connection failures use a header plus a wrapped message block;
  inline explorer failures use a full-width tinted banner with a wrapping
  message. Recovery instructions stay wrapped and readable; the terminal status
  pill may clamp and exposes the full text via its title.

## Do's and Don'ts

- Do keep terminal surfaces opaque and free of decorative motion. Background
  effects belong behind chrome, not behind glyphs.
- Do truncate server-controlled names with an ellipsis and expose the full value
  in a title or detail view.
- Do use tabular figures for any number that updates.
- Do keep focus rings and hover states; they are part of the control, not polish.
- Do animate only the properties a state actually changes; shared controls use
  explicit colour, border, opacity, or scale transitions.
- Do use lucide outline icons at 1.6–2px stroke; every shared surface does.
- Don't apply translucency or backdrop blur to form controls.
- Don't outline terminal text in the ember or lava themes.
