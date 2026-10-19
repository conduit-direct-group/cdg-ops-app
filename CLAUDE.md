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
Tuck secondary things into the big `picker()` / `collapsible()` parts (ui.js) to keep screens clean — never hide
urgent or daily items (alerts, sign-offs due, Report a problem, a role's main actions), and tell Chris what was tucked away and why.

"Done" means: checked at phone (375px), tablet (1024px), and desktop widths; self-reviewed against the standard;
then screenshots and the dev test link shown to Chris.

## Working with Chris
- Chris is not a developer: one step at a time, explain the why, offer choices, short and plain.
- The master plan is a revisioned file in Chris's Downloads (`CDG_Operations_App_Plan_*_RevN.md`); decisions go there.
- No secrets, PINs, or employee data in this repo — it is public.

## When something is missing
- Any time you ask Chris for something (a file, login, API key, program name, decision), always include a **"Don't have it yet"** option.
- If he picks it:
  1. Log it in the plan's Open Items under **"Waiting on Chris,"** with: what's needed, why, which feature it blocks, and the date.
  2. Skip only the part that needs it. Keep building everything else.
  3. Never fake it, guess it, or put in a placeholder.
- At the start of each session, if anything in "Waiting on Chris" is older than 2 weeks, mention it once.
