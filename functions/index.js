// Server code for the CDG Operations App.
// Runs on Google's servers (Cloud Functions), never on the phone or tablet.
//
// Coming next (Decision 16 in the project plan):
//   - PIN login: check employee # + PIN, lock out after 5 wrong tries, issue a sign-in token
//   - Admin: create accounts, reset PINs
//   - Sign-offs: re-check the PIN on the server for every sign-off
//
// Rule: no secrets, PINs, or employee data in this file — ever. The repo is public.

const { initializeApp } = require("firebase-admin/app");

initializeApp();
