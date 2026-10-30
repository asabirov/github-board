---
name: board
kit: "@apliteni/apliteni-ui@0.146.0"
source: "src/tokens/tokens.css and src/tokens/accents.css in the kit package"
# One line for each token. `why` is the reason for the token.
# `node design/build.mjs` makes colors_and_type.css from this front matter
# and copies it into system.html.
shared:
  --font-display: { value: "'Poppins', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", why: "Page titles and large readouts only. It smears at 13 to 14 px." }
  --font-sans: { value: "'IBM Plex Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", why: "Tables, fields, cards and body text. It stays legible at small sizes." }
  --font-mono: { value: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace", why: "Code, label names and identifiers." }
  --text-xs: { value: "11px", why: "Badges only, in the semibold weight." }
  --text-sm: { value: "13px", why: "Secondary labels, buttons and card metadata." }
  --text-base: { value: "14.5px", why: "Body text, card titles and table cells." }
  --text-md: { value: "15.5px", why: "Group headings, such as a column name." }
  --text-lg: { value: "18px", why: "Panel titles, such as the card detail panel." }
  --text-xl: { value: "22px", why: "Section titles on this page." }
  --text-2xl: { value: "30px", why: "The page title. The board has one per page." }
  --weight-normal: { value: "400", why: "All text that is not a title or a group heading." }
  --weight-medium: { value: "500", why: "Buttons, as the kit's button uses it." }
  --weight-semibold: { value: "600", why: "Titles, group headings and badges. The board uses no heavier weight." }
  --leading-tight: { value: "1.2", why: "Headings and buttons." }
  --leading-snug: { value: "1.4", why: "Card titles and table rows." }
  --leading-normal: { value: "1.62", why: "Running text." }
  --tracking-tight: { value: "-0.01em", why: "Large headings, so that they do not look loose." }
  --space-1: { value: "4px", why: "The gap between a label and its value." }
  --space-2: { value: "8px", why: "The gap between cards in a compact column." }
  --space-3: { value: "12px", why: "The gap between cards, and card padding when compact." }
  --space-4: { value: "16px", why: "Card padding, and the page gutter on a phone." }
  --space-5: { value: "20px", why: "Panel padding when compact." }
  --space-6: { value: "24px", why: "Panel padding, and the gap between columns." }
  --space-8: { value: "32px", why: "The gap between groups in a section." }
  --space-10: { value: "40px", why: "The gap between sections when compact." }
  --space-12: { value: "48px", why: "The gap between sections." }
  --space-16: { value: "64px", why: "The space above the page footer." }
  --radius-xs: { value: "6px", why: "Swatches and small marks." }
  --radius-sm: { value: "9px", why: "Buttons and fields, as the kit's button uses it." }
  --radius-md: { value: "12px", why: "Issue cards inside a column." }
  --radius-lg: { value: "16px", why: "Columns and the detail panel." }
  --radius-xl: { value: "18px", why: "Kit cards, such as a section card." }
  --radius-2xl: { value: "24px", why: "The segmented control, as the kit's segmented control uses it." }
  --radius-pill: { value: "999px", why: "Badges and switches only." }
  --container: { value: "1120px", why: "The page width, gutter to gutter." }
  --panel-sm: { value: "320px", why: "The width of the card detail panel beside the columns." }
  --ring: { value: "2px solid var(--accent)", why: "The focus ring. It follows the accent and keeps 3:1 against each ground." }
  --ring-offset: { value: "1px", why: "The unpainted gap between a control and its focus ring." }
  --dur-med: { value: "250ms", why: "The time a switch knob takes to move, as in the kit switch." }
  --ease: { value: "cubic-bezier(0.4, 0, 0.2, 1)", why: "The kit curve for a symmetric change such as a toggle." }
dark:
  --bg: { value: "#0e0d14", why: "The page." }
  --surface: { value: "#211e2d", why: "A card and a field. Text sits on the page or a card." }
  --surface-2: { value: "#161520", why: "Sunken tracks with no text, such as a column ground." }
  --surface-3: { value: "#2d293c", why: "Quiet fills with no text, such as a switch track." }
  --bg-elevated: { value: "#2a2639", why: "A floating surface: a menu, a drawer or the detail panel." }
  --border: { value: "#332f45", why: "The edge of cards and fields." }
  --border-strong: { value: "#453f5c", why: "The edge of a control and of a floating surface." }
  --card-edge: { value: "var(--border)", why: "A card. Dark separates levels with a hairline and no shadow." }
  --float-edge: { value: "var(--border-strong)", why: "The outer line of a floating surface." }
  --float-edge-inner: { value: "var(--border)", why: "The inner line of a floating surface. Dark draws two lines." }
  --control-edge: { value: "var(--border)", why: "The edge of a secondary button." }
  --text: { value: "#e9e7f0", why: "Body text and values." }
  --strong: { value: "#ffffff", why: "Titles and the value that decides an action." }
  --dim: { value: "#c6c2d6", why: "Secondary text that a reader still reads." }
  --muted: { value: "#a29db6", why: "Secondary labels only. It clears 4.5:1 on every surface." }
  --green: { value: "#98ff8f", why: "Live and success. It does not follow the accent." }
  --pink: { value: "#e97ca5", why: "Danger and failure. It does not follow the accent." }
  --amber: { value: "#ffcf6a", why: "Warning and waiting." }
  --cyan: { value: "#20dcf5", why: "Information and flags." }
  --chip-success-ink: { value: "#98ff8f", why: "Badge ink for done, such as Ready to merge." }
  --chip-success-fill: { value: "rgba(152, 255, 143, 0.16)", why: "Badge fill for done." }
  --chip-warn-ink: { value: "#ffcf6a", why: "Badge ink for waiting or in review." }
  --chip-warn-fill: { value: "color-mix(in srgb, #ffcf6a 15%, transparent)", why: "Badge fill for waiting or in review." }
  --chip-danger-ink: { value: "#f5aec6", why: "Badge ink for blocked or failed." }
  --chip-danger-fill: { value: "rgba(233, 124, 165, 0.16)", why: "Badge fill for blocked or failed." }
  --chip-info-ink: { value: "#20dcf5", why: "Badge ink for information." }
  --chip-info-fill: { value: "rgba(32, 220, 245, 0.14)", why: "Badge fill for information." }
  --chip-neutral-fill: { value: "color-mix(in srgb, #a29db6 12%, transparent)", why: "Badge fill for neutral states, such as In progress. Its ink is --text." }
  --control-knob: { value: "#ffffff", why: "The knob of a switch." }
  --signal-contrast: { value: "#0c0c0c", why: "Ink on the selected segment of a segmented control in dark." }
  --signal-solid-ink: { value: "#0c0c0c", why: "Ink on a filled status badge." }
  --signal-solid-danger: { value: "#e97ca5", why: "The filled badge of the state to act on first." }
  --shadow-ink: { value: "#000000", why: "The ink that elevation mixes." }
  --elev-rest: { value: "0 0 #0000", why: "A card casts nothing in dark." }
  --elev-drop: { value: "0 14px 30px -12px color-mix(in srgb, var(--shadow-ink) 62%, transparent), 0 3px 9px -4px color-mix(in srgb, var(--shadow-ink) 50%, transparent)", why: "The one drop, under a floating surface only." }
light:
  --bg: { value: "#f2f3f6", why: "The page." }
  --surface: { value: "#ffffff", why: "A card and a field. Text sits on the page or a card." }
  --surface-2: { value: "#e9ecf3", why: "Sunken tracks with no text, such as a column ground." }
  --surface-3: { value: "#eef0f5", why: "Quiet fills with no text, such as a switch track." }
  --bg-elevated: { value: "#ffffff", why: "A floating surface: a menu, a drawer or the detail panel." }
  --border: { value: "#e4e7ee", why: "The edge of cards." }
  --border-strong: { value: "#cdd2dc", why: "The edge of fields and controls." }
  --card-edge: { value: "color-mix(in srgb, var(--border) 50%, var(--border-strong))", why: "A card. Light draws one line and a short drop." }
  --float-edge: { value: "color-mix(in srgb, var(--border) 50%, var(--border-strong))", why: "The line of a floating surface." }
  --float-edge-inner: { value: "transparent", why: "Light draws one line only." }
  --control-edge: { value: "var(--border-strong)", why: "The edge of a secondary button." }
  --text: { value: "#1a1e27", why: "Body text and values." }
  --strong: { value: "#0c0e13", why: "Titles and the value that decides an action." }
  --dim: { value: "#3a404b", why: "Secondary text that a reader still reads." }
  --muted: { value: "#5c6270", why: "Secondary labels only. It clears 4.5:1 on every surface." }
  --green: { value: "#1c8a2c", why: "Live and success. It does not follow the accent." }
  --pink: { value: "#a92d59", why: "Danger and failure. It does not follow the accent." }
  --amber: { value: "#b5730a", why: "Warning and waiting." }
  --cyan: { value: "#0c8fa8", why: "Information and flags." }
  --chip-success-ink: { value: "#145a26", why: "Badge ink for done, such as Ready to merge." }
  --chip-success-fill: { value: "#dff3e4", why: "Badge fill for done." }
  --chip-warn-ink: { value: "#825900", why: "Badge ink for waiting or in review." }
  --chip-warn-fill: { value: "#fbedd2", why: "Badge fill for waiting or in review." }
  --chip-danger-ink: { value: "#b7295f", why: "Badge ink for blocked or failed." }
  --chip-danger-fill: { value: "#fbe0ea", why: "Badge fill for blocked or failed." }
  --chip-info-ink: { value: "#096a7c", why: "Badge ink for information." }
  --chip-info-fill: { value: "#ddeff3", why: "Badge fill for information." }
  --chip-neutral-fill: { value: "color-mix(in srgb, #5c6270 13%, transparent)", why: "Badge fill for neutral states, such as In progress. Its ink is --text." }
  --control-knob: { value: "#ffffff", why: "The knob of a switch." }
  --signal-contrast: { value: "#0c0c0c", why: "Near-black ink on a status colour." }
  --signal-solid-ink: { value: "#ffffff", why: "Ink on a filled status badge." }
  --signal-solid-danger: { value: "#b7295f", why: "The filled badge of the state to act on first." }
  --shadow-ink: { value: "#1e1e32", why: "The ink that elevation mixes." }
  --elev-rest: { value: "0 2px 6px -1px color-mix(in srgb, var(--shadow-ink) 6%, transparent), 0 1px 3px -1px color-mix(in srgb, var(--shadow-ink) 4%, transparent)", why: "The short drop under a card in light." }
  --elev-drop: { value: "0 12px 32px -12px color-mix(in srgb, var(--shadow-ink) 16%, transparent), 0 1px 8px -3px color-mix(in srgb, var(--shadow-ink) 9%, transparent)", why: "The one drop, under a floating surface only." }
accents:
  nebula:
    --accent: { dark: "#b479ff", light: "#6a2dcc", why: "The kit's default accent. Accent ink: links and the selected card." }
    --accent-strong: { dark: "#7c3aed", light: "#6a2dcc", why: "Accent ground, such as the Sign in button." }
    --accent-contrast: { dark: "#ffffff", light: "#ffffff", why: "Ink on the accent ground. It clears AA." }
  phoenix:
    --accent: { dark: "#ff6a3d", light: "#a8370c", why: "The kit's ember accent." }
    --accent-strong: { dark: "var(--accent)", light: "var(--accent)", why: "Accent ground." }
    --accent-contrast: { dark: "#241006", light: "#ffffff", why: "Ink on the accent ground." }
  ocean:
    --accent: { dark: "#3b9dff", light: "#005ab4", why: "The kit's azure accent." }
    --accent-strong: { dark: "var(--accent)", light: "var(--accent)", why: "Accent ground." }
    --accent-contrast: { dark: "#04121f", light: "#ffffff", why: "Ink on the accent ground." }
  emerald:
    --accent: { dark: "#16c98a", light: "#076c48", why: "The kit's jade accent." }
    --accent-strong: { dark: "var(--accent)", light: "var(--accent)", why: "Accent ground." }
    --accent-contrast: { dark: "#04180f", light: "#ffffff", why: "Ink on the accent ground." }
---

# Board design system

The board uses the public MIT kit [`@apliteni/apliteni-ui`](https://github.com/apliteni/apliteni-ui)
0.146.0. The front matter above lists each token that the board uses, with its value and the
reason for it. Each value is copied from the kit's `src/tokens/tokens.css` and
`src/tokens/accents.css`. Where the kit writes `var(--glow-green)` or a similar alias, the front
matter gives the value that the alias has in that theme.

Open [`system.html`](system.html) to see the tokens and a sample board screen in each state.

## Rules

1. Use a kit component when one exists. Write a bespoke block only when the kit has none.
2. Use a token for every colour, font, size, space and radius. Do not write a literal.
3. Use the semantic tokens, never the brand ramp (`--purple-500` and the others).
4. If a value has no token, use the nearest token and record the gap below.
5. Check both themes and two accents before a pull request (`guidelines/colour-and-theming.md`).
6. Set `data-theme` on `<html>`. The kit has no `prefers-color-scheme` rule. Without the
   attribute, the kit uses dark.
7. Set `data-accent` on `<html>` only for an accent that is not Nebula.
8. Component sizes inside a kit component, such as the button padding of 9 px by 17 px, belong
   to the kit's CSS. They are not tokens. A bespoke copy uses the same values.
9. Media queries use the kit's three breakpoints: 860, 720 and 560 px.

## Status badges

| Board state | Badge | Reason |
| --- | --- | --- |
| In progress | neutral (`--text` on `--chip-neutral-fill`) | Work goes on and needs no action. |
| Agent reviewing | warn (`--chip-warn-*`) | Waiting or in review. |
| Ready to merge | success (`--chip-success-*`) | Done. |
| PR blocked | filled danger (`--signal-solid-danger`) | The state to act on first has the only filled badge. |

## Board-specific gaps

The kit has no token for these board needs. The board uses the nearest token.

| Need | Nearest token | Note |
| --- | --- | --- |
| Width of a board column | none. Columns share the width that the detail panel leaves. | The kit has no column width. |
| A hue for Agent reviewing | `--chip-warn-*` | The live app uses a violet badge. The kit has no violet chip. |
| Compact density | the spacing scale, one step down | See "Density" below. |
| Phone pointer target of 44 px | `--space-10` plus `--space-1` | `guidelines/accessibility-floor.md` sets 44 px. The kit has no size token for it. |

## Density

The kit has no density mode. `guidelines/layout-and-density.md` says: "Set density with the
spacing scale". It also says: "Do not add a compact/comfortable mode, `data-density` attribute,
or row-height scale."

The density switch in `system.html` shows a compact board for review only. It moves each gap
and padding one step down the spacing scale, as the kit's `.ui-table--dense` does. It invents no
value. If the owner approves compact, the board sets those steps in its own CSS. It adds no
density mode or attribute.

## Fonts

The kit does not bundle its fonts. The board serves IBM Plex Sans 400 to 700 (SIL Open Font
License) from its own build through `@fontsource/ibm-plex-sans`, so it makes no font request to a
third party. No board element uses `--font-display` yet, so the board loads no Poppins.
`system.html` embeds Poppins 600 and IBM Plex Sans 400 to 600, Latin subset, as `data:` URLs, so
that it works without a network.

## Deviations from the kit

These board rules in `board-frontend/src/app.css` and `board-frontend/tailwind.config.ts` differ
from the kit:

| Rule | Value | Reason |
| --- | --- | --- |
| Light sidebar rail | `#f6f7f7` | The owner ruled this colour on #1112. `scripts/measure-light-pins.mjs` guards it. |
| Light `--surface-2` | `#eceef0` | The page canvas that #491 deepened. The board keeps it so that the layout does not change. |
| Light `--bg-elevated` | `#edeef0` | The board draws this token as a tint on a white card (#1112). The kit's `#ffffff` makes skeletons white on white. |
| `--shadow-sm` | A soft two-layer shadow | The kit sets no small shadow. Board cards keep the lift that they had. |
| Success text | `--chip-success-ink` | The kit's light `--green` is 4.45:1 on white. The success ink is the same green in dark and passes 4.5:1 in light. |
