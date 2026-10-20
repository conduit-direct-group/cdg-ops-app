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

export const app = initializeApp({
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

// Test mode: everywhere except the live site (the dev test site, a computer running it locally).
// Reports, fixes, and checklist sign-offs made in test mode are practice only: the server keeps them
// apart (test_ collections), the live app never shows them, and nothing goes to Odoo.
export const LIVE_HOST = "cdg-ops.netlify.app";
export const TEST_MODE = location.hostname !== LIVE_HOST;

// Every save goes through one of these. While offline they stop right away with a plain message
// (code "offline") instead of hanging — the red Offline bar explains why.
function call(name, options) {
  const fn = httpsCallable(functions, name, options);
  return (data = {}) =>
    navigator.onLine
      ? fn(TEST_MODE ? { ...data, test: true } : data)
      : Promise.reject(Object.assign(new Error("You're offline."), { code: "offline" }));
}

export const callPinLogin = call("pinLogin");
export const callChangePin = call("changePin");
export const callAdminListEmployees = call("adminListEmployees");
export const callAdminCreateEmployee = call("adminCreateEmployee");
export const callAdminResetPin = call("adminResetPin");
export const callAdminUnlock = call("adminUnlock");
export const callAdminUpdateEmployee = call("adminUpdateEmployee");
export const callAdminEnableLogin = call("adminEnableLogin");
export const callAdminImportEmployees = call("adminImportEmployees");
export const callAdminSaveRole = call("adminSaveRole");
export const callAdminSaveLine = call("adminSaveLine");
export const callAdminSaveMachine = call("adminSaveMachine");
export const callAdminSaveTeam = call("adminSaveTeam");
export const callAdminSaveShift = call("adminSaveShift");
export const callAdminSaveMachineType = call("adminSaveMachineType");
export const callSubmitFix = call("submitFix");
export const callReviewFix = call("reviewFix");
export const callRetireFix = call("retireFix");
export const callVoteFix = call("voteFix");
export const callLogSearchGap = call("logSearchGap");
export const callAdminMarkSearchGap = call("adminMarkSearchGap");
export const callAdminBulkAddFixes = call("adminBulkAddFixes");
export const callDeleteFix = call("deleteFix");
export const callRestoreFix = call("restoreFix");
export const callRestoreFixVersion = call("restoreFixVersion");
export const callRestoreTrashedFile = call("restoreTrashedFile");
export const callSignChecklist = call("signChecklist");
export const callAdminSaveChecklist = call("adminSaveChecklist");
export const callAdminSetChecklistMedia = call("adminSetChecklistMedia");
export const callAdminStartChecklists = call("adminStartChecklists");
export const callAdminImportOldChecklists = call("adminImportOldChecklists", { timeout: 540000 });
export const callSubmitRequest = call("submitRequest");
export const callUpdateRequest = call("updateRequest");
export const callAdminSaveRequestType = call("adminSaveRequestType");
export const callAdminStartRequestTypes = call("adminStartRequestTypes");
export const callSaveDeviceToken = call("saveDeviceToken");
export const callRemoveDeviceToken = call("removeDeviceToken");
export const callAdminImportFloorMap = call("adminImportFloorMap", { timeout: 120000 });
export const callAdminSetStationMachine = call("adminSetStationMachine");
export const callAdminEnsureOdooEquipment = call("adminEnsureOdooEquipment", { timeout: 120000 });
// Training (the trainer app)
export const callTrainingUnlock = call("trainingUnlock");
export const callTrainingLock = call("trainingLock");
export const callTrainingAddTrainer = call("trainingAddTrainer");
export const callTrainingSave = call("trainingSave");
export const callAdminImportTrainingData = call("adminImportTrainingData", { timeout: 120000 });
export const callAdminImportTrainingBackup = call("adminImportTrainingBackup", { timeout: 300000 });
export const callAdminSetTrainer = call("adminSetTrainer");
export const callReportProblem = call("reportProblem");
export const callMarkIssueFixed = call("markIssueFixed");
export const callMarkLineBackUp = call("markLineBackUp");
// Announcements and the shared PIN sign-off
export const callAnnouncementPeople = call("announcementPeople");
export const callPostAnnouncement = call("postAnnouncement");
export const callEndAnnouncement = call("endAnnouncement");
export const callSignAnnouncement = call("signAnnouncement");
export const callRecordReviewedInPerson = call("recordReviewedInPerson");
export const callAnnouncementTracking = call("announcementTracking");
export const callRemindAnnouncement = call("remindAnnouncement");
export const callAnnouncementSummary = call("announcementSummary");
export const callSignoffPeople = call("signoffPeople");
// Forms (edited in Admin → Forms) and Shift Handoff Notes
export const callSaveFormTemplate = call("saveFormTemplate");
export const callHandoffAutoFill = call("handoffAutoFill");
export const callStartHandoff = call("startHandoff");
export const callSaveHandoffDraft = call("saveHandoffDraft");
export const callSendHandoff = call("sendHandoff");
export const callDiscardHandoff = call("discardHandoff");
export const callReceiveHandoff = call("receiveHandoff");
export const callHandoffReceivers = call("handoffReceivers");
// Keep the Shop Clean (shift task lists)
export const callStartShopTasks = call("startShopTasks");
export const callShopTaskPeople = call("shopTaskPeople");
export const callAssignShopTask = call("assignShopTask");
export const callMarkShopTaskDone = call("markShopTaskDone");
export const callCheckShopTasks = call("checkShopTasks");
export const callShopTaskSigners = call("shopTaskSigners");
export const callAdminSyncOdoo = call("adminSyncOdoo", { timeout: 120000 });
// Copying files from the old library can take a few minutes.
export const callAdminImportOldLibrary = call("adminImportOldLibrary", { timeout: 540000 });
