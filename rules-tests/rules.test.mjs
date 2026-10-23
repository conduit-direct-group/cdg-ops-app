// Security rules tests (Chris, 10-21-2026): proves on the Firebase emulator — a pretend copy, never the real project —
// that the database and storage rules block what they should. Run from C:\CDG\rules-tests:  npm test
// Made-up people only: 9001 operator, 9002 Training & Safety, 9003 Production Manager, 9004 Admin, 9005 Maintenance,
// 9006 Supervisor, 9007 turned-off Admin.

import { test, before, after, beforeEach } from "node:test";
import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, getDocs, collection, query, where } from "firebase/firestore";
import { ref, getBytes, uploadBytes } from "firebase/storage";

let env;
const PEOPLE = {
  9001: ["operator"], 9002: ["training-safety"], 9003: ["plant-manager"], 9004: ["admin"], 9005: ["maintenance"], 9006: ["supervisor"],
};
const as = (emp, pinTemp = false) => env.authenticatedContext(`emp_${emp}`, { emp: String(emp), pinTemp });
const db = (emp) => as(emp).firestore();
const st = (emp) => as(emp).storage();
const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

before(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-cdg-ops",
    firestore: { rules: readFileSync("../firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 },
    storage: { rules: readFileSync("../storage.rules", "utf8"), host: "127.0.0.1", port: 9199 },
  });
});
after(async () => { await env?.cleanup(); });

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const d = ctx.firestore();
    for (const [emp, roles] of Object.entries(PEOPLE)) await setDoc(doc(d, "employees", emp), { name: `Person ${emp}`, roles, active: true });
    await setDoc(doc(d, "employees", "9007"), { name: "Off", roles: ["admin"], active: false });
    // 9009 = an Admin WITH HR access (like Chris); 9010 = HR access but turned off. 9004 is an Admin without HR access.
    await setDoc(doc(d, "employees", "9009"), { name: "HR Admin", roles: ["admin"], active: true, hrAccess: true });
    await setDoc(doc(d, "employees", "9010"), { name: "HR off", roles: ["admin"], active: false, hrAccess: true });
    await setDoc(doc(d, "pinSecrets", "9001"), { hash: "x", salt: "y" });
    for (const c of ["incidents", "test_incidents"]) {
      await setDoc(doc(d, c, "inc1"), { type: "injury", what: "Cut hand", createdBy: "9001", status: "reported" });
      await setDoc(doc(d, c, "inc1", "private", "osha"), { injuredName: "Person 9001", bodyPart: "Left hand" });
      await setDoc(doc(d, c, "inc1", "private", "signatures"), { supervisor: { name: "Person 9006", path: "safety/inc1/sig-supervisor.png" } });
      await setDoc(doc(d, c, "inc2"), { type: "near-miss", what: "Pallet too high", status: "reported", anonymous: true });
    }
    await uploadBytes(ref(ctx.storage(), "safety/inc2/photo-1.jpg"), jpg, { contentType: "image/jpeg" });
    await uploadBytes(ref(ctx.storage(), "safety/test/inc2/photo-1.jpg"), jpg, { contentType: "image/jpeg" });
    await setDoc(doc(d, "incidentActions", "a1"), { incidentId: "inc1", ownerEmp: "9001", text: "Add a guard", due: "2026-10-30" });
    await setDoc(doc(d, "incidentActions", "a2"), { incidentId: "inc1", ownerEmp: "9005", text: "Fix the light", due: "2026-10-30" });
    await setDoc(doc(d, "issues", "i1"), { open: true, title: "Puller down", lineDown: true });
    await uploadBytes(ref(ctx.storage(), "safety/inc1/photo-1.jpg"), jpg, { contentType: "image/jpeg" });
    await uploadBytes(ref(ctx.storage(), "safety/inc1/sig-supervisor.png"), jpg, { contentType: "image/png" });
    await uploadBytes(ref(ctx.storage(), "safety/test/inc1/photo-1.jpg"), jpg, { contentType: "image/jpeg" });
  });
});

// ---- incidents (database) -----------------------------------------------------------------------------------------

test("incident reports: Training & Safety, Production Manager, Admin can see a report exists and its status — not the reporter, operators, supervisors", async () => {
  for (const c of ["incidents", "test_incidents"]) {
    for (const emp of [9002, 9003, 9004, 9009]) await assertSucceeds(getDoc(doc(db(emp), c, "inc1")));
    for (const emp of [9001, 9005, 9006, 9007]) await assertFails(getDoc(doc(db(emp), c, "inc1")));
    await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), c, "inc1")));
  }
});

test("injury details and signatures (private) need HR access — an Admin without it can't read them", async () => {
  for (const c of ["incidents", "test_incidents"]) {
    for (const part of ["osha", "signatures"]) {
      await assertSucceeds(getDoc(doc(db(9009), c, "inc1", "private", part)));
      for (const emp of [9001, 9002, 9003, 9004, 9005, 9006, 9007, 9010]) await assertFails(getDoc(doc(db(emp), c, "inc1", "private", part)));
    }
  }
});

test("nobody can give themselves HR access from a phone", async () => {
  await assertFails(setDoc(doc(db(9004), "employees", "9004"), { name: "x", roles: ["admin"], active: true, hrAccess: true }));
});

test("nobody can write incidents from a phone (only the server writes)", async () => {
  for (const emp of [9001, 9002, 9004]) await assertFails(setDoc(doc(db(emp), "incidents", "new"), { type: "near-miss", what: "x" }));
  await assertFails(setDoc(doc(db(9004), "incidents", "inc1", "private", "osha"), { injuredName: "x" }));
});

test("corrective actions: the owner sees their own, not other people's; follow-up sees all", async () => {
  await assertSucceeds(getDoc(doc(db(9001), "incidentActions", "a1")));
  await assertFails(getDoc(doc(db(9001), "incidentActions", "a2")));
  await assertSucceeds(getDocs(query(collection(db(9001), "incidentActions"), where("ownerEmp", "==", "9001"))));
  await assertFails(getDocs(collection(db(9001), "incidentActions")));
  await assertSucceeds(getDoc(doc(db(9002), "incidentActions", "a2")));
});

// ---- safety photos and signatures (storage) ---------------------------------------------------------------------

test("injury photos and every signature: HR access only — not Training & Safety, Production Manager, or an Admin without it", async () => {
  for (const path of ["safety/inc1/photo-1.jpg", "safety/inc1/sig-supervisor.png", "safety/test/inc1/photo-1.jpg"]) {
    await assertSucceeds(getBytes(ref(st(9009), path)));
    for (const emp of [9001, 9002, 9003, 9004, 9005, 9006, 9007, 9010]) await assertFails(getBytes(ref(st(emp), path)));
    await assertFails(getBytes(ref(env.unauthenticatedContext().storage(), path)));
  }
});

test("near-miss photos: the people who follow up (Training & Safety, Production Manager, Admin) — not operators or supervisors", async () => {
  for (const path of ["safety/inc2/photo-1.jpg", "safety/test/inc2/photo-1.jpg"]) {
    for (const emp of [9002, 9003, 9004, 9009]) await assertSucceeds(getBytes(ref(st(emp), path)));
    for (const emp of [9001, 9005, 9006, 9007]) await assertFails(getBytes(ref(st(emp), path)));
  }
});

test("phones can only drop a photo into safety/incoming with a random name — no employee number, JPEG only", async () => {
  await assertSucceeds(uploadBytes(ref(st(9001), "safety/incoming/Ab3dE5gH7jK9mN1pQ3sTuV.jpg"), jpg, { contentType: "image/jpeg" }));
  await assertFails(uploadBytes(ref(st(9001), "safety/incoming/9001_photo.jpg"), jpg, { contentType: "image/jpeg" }));
  await assertFails(uploadBytes(ref(st(9001), "safety/incoming/Ab3dE5gH7jK9mN1pQ3sTuV.png"), jpg, { contentType: "image/png" }));
  await assertFails(uploadBytes(ref(st(9001), "safety/incoming/Ab3dE5gH7jK9mN1pQ3sTuV.jpg"), jpg, { contentType: "application/pdf" }));
  await assertFails(uploadBytes(ref(st(9001), "safety/inc1/photo-9.jpg"), jpg, { contentType: "image/jpeg" }));
  await assertFails(uploadBytes(ref(st(9004), "safety/inc1/photo-9.jpg"), jpg, { contentType: "image/jpeg" }));
  // Nobody can read incoming photos back — not the uploader, not even HR.
  await assertFails(getBytes(ref(st(9001), "safety/incoming/Ab3dE5gH7jK9mN1pQ3sTuV.jpg")));
  await assertFails(getBytes(ref(st(9009), "safety/incoming/Ab3dE5gH7jK9mN1pQ3sTuV.jpg")));
});

// ---- PINs and people ---------------------------------------------------------------------------------------------

test("PIN records can never be read from a phone — not even by an Admin", async () => {
  for (const emp of [9001, 9004]) await assertFails(getDoc(doc(db(emp), "pinSecrets", "9001")));
  await assertFails(getDocs(collection(db(9004), "pinSecrets")));
  await assertFails(setDoc(doc(db(9004), "pinSecrets", "9001"), { hash: "z" }));
});

test("someone still on a temporary PIN can't read private data, even with the Admin role", async () => {
  await assertFails(getDoc(doc(as(9004, true).firestore(), "incidents", "inc1")));
  await assertFails(getDoc(doc(as(9004, true).firestore(), "issues", "i1")));
  await assertFails(getBytes(ref(as(9004, true).storage(), "safety/inc1/photo-1.jpg")));
});

test("employee records: you see only your own", async () => {
  await assertSucceeds(getDoc(doc(db(9001), "employees", "9001")));
  await assertFails(getDoc(doc(db(9001), "employees", "9002")));
  await assertFails(setDoc(doc(db(9001), "employees", "9001"), { roles: ["admin"] }));
});

// ---- open issues -------------------------------------------------------------------------------------------------

test("open issues board: Maintenance, Production Manager, Admin only", async () => {
  for (const emp of [9005, 9003, 9004]) await assertSucceeds(getDoc(doc(db(emp), "issues", "i1")));
  for (const emp of [9001, 9002, 9006, 9007]) await assertFails(getDoc(doc(db(emp), "issues", "i1")));
});

// ---- announcement tasks ---------------------------------------------------------------------------------------------

test("announcement tasks: the person sees their own; supervisors, Production Manager, Admins see all; nobody writes", async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "annTasks", "t1"), { emp: "9001", status: "open", annTitle: "Wipe the panels" });
    await setDoc(doc(ctx.firestore(), "annTasks", "t2"), { emp: "9005", status: "open", annTitle: "Other" });
  });
  await assertSucceeds(getDoc(doc(db(9001), "annTasks", "t1")));
  await assertFails(getDoc(doc(db(9001), "annTasks", "t2")));
  await assertSucceeds(getDocs(query(collection(db(9001), "annTasks"), where("emp", "==", "9001"))));
  await assertFails(getDocs(collection(db(9001), "annTasks")));
  await assertSucceeds(getDocs(collection(db(9006), "annTasks")));
  await assertSucceeds(getDoc(doc(db(9003), "annTasks", "t2")));
  await assertFails(getDoc(doc(db(9002), "annTasks", "t2")));
  await assertFails(setDoc(doc(db(9006), "annTasks", "t3"), { emp: "9001", status: "verified" }));
});
