# CDG Ops App — instructions for Claude

## Branches (always)
- Work only on `dev`. Never commit or push to `main`.
- Test site: https://dev--cdg-ops.netlify.app (updates on every push to `dev`).
- Merge `dev` → `main` (the live site, https://cdg-ops.netlify.app) only when Chris says "release".
- Both sites share one Firebase project and the Odoo connection: `firebase deploy` of functions/rules goes live for both at once — warn Chris first and keep server changes compatible with the live screens.

## Design and build standard (always)
Every screen follows [docs/DESIGN-STANDARD.md](docs/DESIGN-STANDARD.md). Use the shared parts and tokens in
`web/styles.css` (colors, text sizes, spacing, radius, buttons, cards, chips, banners, fields, toast) — no one-off
styling or hard-coded colors. Every screen handles loading, empty, error (with retry), offline, and success.

"Done" means: checked at phone (375px), tablet (1024px), and desktop widths; self-reviewed against the standard;
then screenshots and the dev test link shown to Chris.

## Working with Chris
- Chris is not a developer: one step at a time, explain the why, offer choices, short and plain.
- The master plan is a revisioned file in Chris's Downloads (`CDG_Operations_App_Plan_*_RevN.md`); decisions go there.
- No secrets, PINs, or employee data in this repo — it is public.
