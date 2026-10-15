// Connection to the cdg-ops-app Firebase project.
// These settings are public by design (Firebase web config) — safe in a public repo.
// What protects data is the security rules and server code, not this config.

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-functions.js";

const app = initializeApp({
  apiKey: "AIzaSyB7Qr7gLtEZ_DKzNM3yKKnOeEHv6XsWYa0",
  authDomain: "cdg-ops-app.firebaseapp.com",
  projectId: "cdg-ops-app",
  storageBucket: "cdg-ops-app.firebasestorage.app",
  messagingSenderId: "97419521266",
  appId: "1:97419521266:web:7d323f67b01acdff63346b",
});

export const auth = getAuth(app);

const functions = getFunctions(app, "us-central1");
export const callPinLogin = httpsCallable(functions, "pinLogin");
export const callChangePin = httpsCallable(functions, "changePin");
