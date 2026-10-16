# cdg-ops-app

CDG Operations app: login, Fix Library, open issues (connected to Odoo), and admin screens.

## Branches and sites

| Branch | Site | Use |
|---|---|---|
| `dev` | https://dev--cdg-ops.netlify.app | **All work happens here.** Every push updates the test site. |
| `main` | https://cdg-ops.netlify.app | **Live site.** Only changes on a release (merge `dev` → `main`). |

Never commit directly to `main`. A release is a merge of `dev` into `main`, done only when Chris says "release".

**Heads-up:** both sites use the same Firebase project (`cdg-ops-app`) — same logins, data, and server
functions, and the same Odoo connection. Only the screens (`web/`) are separate. Anything done on the
test site (reporting a problem, approving a fix) is real. Server functions and rules are deployed from
this PC with `firebase deploy` and take effect for both sites at once.

## Folders

- `web/` — the screens (published by Netlify)
- `functions/` — server code (Firebase Cloud Functions); `npm test` in this folder runs the tests
- `firestore.rules`, `storage.rules` — database and file security rules
- `brand/`, `tools/` — the CDG logo and the script that makes the app icons from it
