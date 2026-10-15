// Connection to the cdg-ops-app Firebase project.
// These settings are public by design (Firebase web config) — safe in a public repo.
// What protects data is the security rules and server code, not this config.

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-functions.js";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-storage.js";

const app = initializeApp({
  apiKey: "AIzaSyB7Qr7gLtEZ_DKzNM3yKKnOeEHv6XsWYa0",
  authDomain: "cdg-ops-app.firebaseapp.com",
  projectId: "cdg-ops-app",
  storageBucket: "cdg-ops-app.firebasestorage.app",
  messagingSenderId: "97419521266",
  appId: "1:97419521266:web:7d323f67b01acdff63346b",
});

export const auth = getAuth(app);

// Database reads keep a copy on the device, so lists still show on bad Wi-Fi and catch up when it's back.
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});

// Photos, videos, and documents attached to fixes.
export const storage = getStorage(app);

const functions = getFunctions(app, "us-central1");
export const callPinLogin = httpsCallable(functions, "pinLogin");
export const callChangePin = httpsCallable(functions, "changePin");
export const callAdminListEmployees = httpsCallable(functions, "adminListEmployees");
export const callAdminCreateEmployee = httpsCallable(functions, "adminCreateEmployee");
export const callAdminResetPin = httpsCallable(functions, "adminResetPin");
export const callAdminUnlock = httpsCallable(functions, "adminUnlock");
export const callAdminUpdateEmployee = httpsCallable(functions, "adminUpdateEmployee");
export const callAdminSaveRole = httpsCallable(functions, "adminSaveRole");
export const callAdminSaveLine = httpsCallable(functions, "adminSaveLine");
export const callAdminSaveMachine = httpsCallable(functions, "adminSaveMachine");
export const callSubmitFix = httpsCallable(functions, "submitFix");
export const callReviewFix = httpsCallable(functions, "reviewFix");
export const callRetireFix = httpsCallable(functions, "retireFix");
export const callVoteFix = httpsCallable(functions, "voteFix");
// Copying files from the old library can take a few minutes.
export const callAdminImportOldLibrary = httpsCallable(functions, "adminImportOldLibrary", { timeout: 540000 });
