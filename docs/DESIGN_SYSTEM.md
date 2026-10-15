# Print Wallah design system ("Graphite")

The frontend is plain HTML, CSS and JavaScript (no framework, no build step). This file explains the visual system so new screens stay consistent. The tokens live at the top of `public/styles.css`.

## Files

| File | Role |
| --- | --- |
| `public/index.html` | Document shell. Element IDs used by the scripts: `#app`, `#toast`, `#nudge` (top-layer popovers), `#confirm`, `#modal`, `#topbar`, `#brand-link`, `#nav-context`, `#logout-button`, `#site-footer`. |
| `public/styles.css` | Tokens, base, buttons, fields, segmented control, pills, notices, dialogs, toast, sign-in, reduced-motion. Loaded everywhere. |
| `public/admin.css` | Shop Admin + Super Admin layouts. Loaded only on admin routes. |
| `public/customer.css` | Customer portal. Loaded only on `/shop/<id>`. |
| `public/icons.js` | One registry of 24px line icons: `icon(name, size)` (`aicon` is an alias). Add an icon by adding a key to `ICON_PATHS`. |
| `public/vendor/fonts/` | Geist and Geist Mono (OFL). The `latin-ext` file is required because it contains the rupee sign. |

## Principles

- Deep, cool graphite surfaces. Depth comes from tone steps (`--bg`, `--s1`..`--s4`), hairline borders (`--line`, `--line-2`, `--line-3`) and a faint top highlight (`--hi`), not from glow or gradients.
- One accent, emerald `--ac`: primary buttons, focus rings and live state only. Warning, danger and info colours appear as a small dot plus text, not filled badges.
- Rectangles with modest radii (6 to 18px). No pill-shaped controls.
- Every number uses tabular figures. Amounts always go through `money()`.
- Section labels are sentence case; hierarchy comes from size, weight and colour.

## Tokens (see `:root`)

Colour: `--bg --field --s1 --s2 --s3 --s4`, `--line --line-2 --line-3`, `--t1 --t2 --t3 --t4`, `--ac --ac-hi --ac-lo --ac-ink --ac-text --ac-soft --ac-line`, `--warn/--bad/--info` with `-soft` and `-line`. Text tokens `--t1` to `--t3` meet WCAG AA (4.5:1) on every surface they are used on.
Shape: `--r1..--r5`. Elevation: `--hi --sh-1 --sh-2 --sh-3`. Type: `--font --mono`. Motion: `--ease --ease-io`. Layout: `--gutter` (16/24/32px) and `--page`.

## Components

- Buttons: `.button` plus `-primary`, `-light` (default look), `-quiet`, `-danger`, `-small`, `-lg`, `-block`, `-icon`. One primary action per step (the UPI screen shows two because paying and confirming are two separate steps).
- Fields: `.field > label + input/select/textarea`, `.field-hint`, `.form-error`, `.input-icon`, `.choice` (checkbox tile), `.segmented`, `.stepper`.
- Status: `.pill` (account/printer state, via `statePill()`), `.stage` (order status, via `stageBadge()`).
- Surfaces: `.panel`/`.a-panel`, `.card` (customer), `.notice` and `.inline-notice`, `.empty`, `.skeleton`.
- Overlays: `showModal()`, `showDrawer()` (side drawer on desktop, bottom sheet on phones), `confirmDialog()`, `toast()`, `nudge()`. Dialogs animate out via `closeWithMotion()`; a re-opened dialog cancels any pending close timer.

## Layouts

- Sign-in: split layout on desktop (brand panel with a lightweight SVG illustration), single column on phones.
- Customer portal, desktop: sticky live-preview canvas (left) and one inspector panel (right) holding file, settings and pay. Phones: file, preview, settings, editor, pay in one column with a sticky total bar (`#mobile-total`).
- Shop Admin: 76px icon rail on desktop; bottom tab bar plus header actions on phones. Order rows use container queries (`@container orders`) to switch between a compact, a two-line and a ledger layout depending on the width of the list, not the viewport.
- Super Admin: top bar with tabs, metrics strip, shop ledger.
- Breakpoints: 560, 640, 720, 860, 1000 and 1100px (mostly layout switches).

## Motion and accessibility

- Motion is short (120 to 340ms) and eased; entering content uses `.view-enter` / `.enter`. The only 3D effect is a very small pointer tilt on the print preview (`wireTilt` in `customer.js`), enabled for fine pointers without reduced motion.
- `@media (prefers-reduced-motion: reduce)` neutralises all animation and transitions; `forced-colors` has fallbacks.
- Keyboard: `:focus-visible` rings everywhere, a skip link, labelled controls, `aria-pressed` on segmented buttons, `aria-current="step"` on the progress tracker, roles on alerts and status regions.
- Toast and nudge are `popover="manual"` elements so they render in the top layer above open dialogs.

## Adding a screen

1. Build markup from the components above; use tokens, never raw colours.
2. Put page-specific layout in the audience stylesheet, shared pieces in `styles.css`.
3. Keep logic hooks (IDs, `data-*`, the classes the scripts query) stable; restyle freely.
4. Check at 390px and 1440px wide, with the keyboard, and with reduced motion on.
