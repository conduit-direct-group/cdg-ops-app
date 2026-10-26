// Admin "People" screens: list everyone, add a person, reset PINs, unlock, edit, turn accounts off/on.
// Every action is checked again on the server (admins only), so hiding buttons here is just tidiness.

import { el, friendlyError, spinner, banner, toast, confirmSheet, picker } from "./ui.js";
import { data, onDataChange } from "./data.js";
import {
  callAdminListEmployees,
  callAdminCreateEmployee,
  callAdminResetPin,
  callAdminUnlock,
  callAdminUpdateEmployee,
  callAdminEnableLogin,
  callAdminOrg,
  callAdminSaveOrg,
  db,
} from "./firebase.js";
import { doc, onSnapshot } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

// Role names come from the live Roles list (Admin → Roles); unknown ids show as-is.
function roleNames(roles) {
  const names = new Map((data.roles || []).map((r) => [r.id, r.name]));
  return roles.map((r) => names.get(r) || r).join(", ");
}

const teamName = (id) => (id ? data.teams?.find((t) => t.id === id)?.name || "?" : "");
// "#1004 · Operator · Team A · Line 2" (before roles are confirmed: the job title instead).
function personLine(p) {
  return [`#${p.employeeNumber}`, p.rolesConfirmed ? roleNames(p.roles) : p.position, p.team ? `Team ${teamName(p.team)}` : "", p.trainingName ? "🎓 linked" : ""].filter(Boolean).join(" · ");
}

// Departments + reports to (launch list 1): the org part of a person, from adminOrg.
const deptName = (org, id) => org?.departments.find((dep) => dep.id === id)?.name || "";

// Opens the People screens inside `container`. `onExit` returns to the Admin menu.
export function openAdmin(container, { myEmployeeNumber, onExit }) {
  const ui = {
    view: "list", // list | add | edit | person | tempPin
    people: null,
    selected: null, // employeeNumber
    tempPin: null, // { name, pin } — shown once, never stored
    justAdded: [], // [{ name, number, pin }] — PINs from "Save & add another", shown on the form until you leave it
    nextNumber: "",
    filter: "all", // all | unconfirmed | noTeam | noLogin | noDept | noReports | noHead
    org: null, // { departments, headsReportTo, noHead, byEmp: Map emp → { department, suggested, deptHead, isHead, override, reportsTo, source } }
    draft: null, // what's typed in the add/edit form, so a failed save doesn't wipe it
    message: "",
    messageKind: "",
    retry: null, // "Try again" for the last thing that failed
    loadError: "",
    busy: false,
  };

  // Success goes to a toast; errors and notes stay on the screen.
  function show(view, message = "", messageKind = "") {
    Object.assign(ui, { view, busy: false, retry: null, message: messageKind === "ok" ? "" : message, messageKind });
    render();
    if (messageKind === "ok" && message) toast(message);
  }

  function person() {
    return ui.people?.find((p) => p.employeeNumber === ui.selected);
  }

  async function load() {
    try {
      const [{ data }, org] = await Promise.all([callAdminListEmployees(), callAdminOrg().then((r) => r.data, () => null)]);
      ui.people = data.employees;
      ui.nextNumber = data.nextNumber || "";
      ui.org = org ? { ...org, byEmp: new Map(org.people.map((x) => [x.emp, x])) } : null;
      ui.loadError = "";
    } catch (err) {
      ui.loadError = friendlyError(err);
    }
    render();
  }

  function reload() {
    Object.assign(ui, { people: null, loadError: "" });
    render();
    load();
  }

  // Runs a server action, then refreshes the list. Returns the result, or null if it failed.
  // `again` is what "Try again" runs if it fails.
  async function act(fn, again = null) {
    Object.assign(ui, { busy: true, message: "", messageKind: "", retry: null });
    render();
    try {
      const { data } = await fn();
      await load();
      ui.busy = false;
      return data;
    } catch (err) {
      Object.assign(ui, { busy: false, message: friendlyError(err), messageKind: "error", retry: again });
      render();
      return null;
    }
  }

  const messageBox = () => banner(ui);

  function backBar(label, onclick) {
    return el("button", { class: "link-btn", type: "button", onclick, disabled: ui.busy }, `← ${label}`);
  }

  function tags(p) {
    return [
      !p.rolesConfirmed
        ? el("span", { class: "tag warn" }, `Suggested: ${p.suggestedRoles.length ? roleNames(p.suggestedRoles) : "no match"} — needs Chris to confirm`)
        : null,
      p.active && !p.loginEnabled ? el("span", { class: "tag" }, "No login yet") : null,
      !p.active ? el("span", { class: "tag off" }, "Off") : null,
      p.locked ? el("span", { class: "tag warn" }, `Locked ${p.minutesLeft} min`) : null,
      p.active && p.mustChangePin ? el("span", { class: "tag" }, "Hasn't picked PIN") : null,
    ];
  }

  // ---- People list --------------------------------------------------------

  // Quick filters for working through a new list (e.g. after the Gusto import). Turned-off people only in "All".
  const FILTERS = {
    all: { label: "All", test: () => true },
    unconfirmed: { label: "Role not confirmed", test: (p) => p.active && !p.rolesConfirmed },
    noTeam: { label: "No team set", test: (p) => p.active && !p.team },
    noLogin: { label: "No login yet", test: (p) => p.active && !p.loginEnabled },
    noDept: { label: "No department", test: (p) => !!ui.org && p.active && !orgOf(p).department },
    noReports: { label: "Missing reports to", test: (p) => !!ui.org && p.active && !!orgOf(p).department && orgOf(p).source === "missing" },
    noHead: { label: "Department with no head", test: (p) => !!ui.org && p.active && ui.org.noHead.includes(orgOf(p).department) },
  };
  const orgOf = (p) => ui.org?.byEmp.get(p.employeeNumber) || {};
  const personName = (emp) => ui.people?.find((x) => x.employeeNumber === emp)?.name || (emp ? `#${emp}` : "");
  // Department · ⭐ head · Reports to — three columns on wide screens, stacked on a phone.
  function orgCols(p) {
    if (!ui.org) return null;
    const o = orgOf(p);
    return el("span", { class: "org-cols" },
      el("span", { class: o.department ? "org-col" : "org-col muted" }, o.department ? deptName(ui.org, o.department) : "No department"),
      el("span", { class: "org-col org-head", "aria-label": o.isHead ? "Department head" : null }, o.isHead ? "⭐ Head" : ""),
      o.supervisesTeams?.length ? el("span", { class: "org-col" }, `Supervises ${o.supervisesTeams.map((t) => teamName(t)).join(", ")}`) : null,
      el("span", { class: o.reportsTo || o.source === "top" ? "org-col" : "org-col muted" },
        o.reportsTo ? `→ ${personName(o.reportsTo)}${o.source === "override" ? " (set)" : ""}` : o.source === "top" ? "Top of the chart" : o.department ? "⚠ Reports to: missing" : ""));
  }
  const visible = () => (ui.people || []).filter(FILTERS[ui.filter].test);
  function filterChips() {
    if (!ui.people) return null;
    // One "Show" picker (7 filters would fill a phone screen as buttons).
    return el("div", { class: "filter-pick" }, el("span", { class: "field-label" }, "Show"),
      picker({ id: "people-filter", title: "Show", value: ui.filter, options: Object.entries(FILTERS).filter(([, f]) => f.test !== null).map(([id, f]) => ({ value: id, label: `${f.label} (${ui.people.filter(f.test).length})` })), onChange: (v) => { ui.filter = v; render(); } }));
  }

  function renderList() {
    const rows =
      ui.loadError && !ui.people
        ? []
        : ui.people === null
        ? [spinner("Loading people…")]
        : visible().map((p) =>
            el(
              "button",
              { class: "person-row", type: "button", onclick: () => { ui.selected = p.employeeNumber; show("person"); } },
              el("span", { class: "person-name" }, p.name),
              el("span", { class: "person-meta" }, personLine(p)),
              orgCols(p),
              el("span", { class: "tags" }, tags(p))
            )
          );
    return [
      backBar("Admin", onExit),
      el("h1", {}, "People"),
      el("p", { class: "hint" }, ui.people ? `${ui.people.length} ${ui.people.length === 1 ? "person" : "people"}` : ""),
      ui.loadError ? banner({ message: `Couldn't load the people list. ${ui.loadError}`, messageKind: "error", retry: reload }) : null,
      messageBox(),
      el("button", { class: "btn", type: "button", onclick: () => startAdd() }, "+ Add a person"),
      filterChips(),
      ui.people && !visible().length && !ui.loadError ? el("p", { class: "empty" }, el("strong", {}, "Nobody left here ✔"), el("p", {}, "Everyone in this filter is done.")) : null,
      el("div", { class: "person-list" }, rows),
    ];
  }

  // ---- Add / edit form ----------------------------------------------------

  // A new person starts with the next free employee number filled in (it can be changed).
  // `keep` = same roles, team, and home line as the last one (Save & add another).
  function startAdd(keep = null) {
    if (!keep) ui.justAdded = [];
    ui.draft = { number: ui.nextNumber, name: "", roles: keep?.roles || ["operator"], team: keep?.team || "", department: keep?.department || "", head: false, reportsTo: "", supervisesTeams: [], canPost: false };
    show("add");
  }

  function startEdit() {
    const p = person();
    ui.draft = {
      number: p.employeeNumber, name: p.name, position: p.position || "", roles: p.rolesConfirmed ? [...p.roles] : [...p.suggestedRoles],
      team: p.team || "", trainingName: p.trainingName || "",
      department: orgOf(p).department || "", head: orgOf(p).deptHead === true, reportsTo: orgOf(p).override || "", supervisesTeams: [...(orgOf(p).supervisesTeams || [])],
      canPost: orgOf(p).canPost === true,
    };
    show("edit");
  }

  function renderForm(existing) {
    const d = ui.draft;
    const numberInput = existing
      ? null
      : el("input", {
          class: "field", id: "f-number", autocomplete: "off", autocapitalize: "characters", maxlength: "12", required: true,
          value: d.number, oninput: (e) => { d.number = e.target.value; },
        });
    const nameInput = el("input", {
      class: "field", id: "f-name", autocomplete: "off", maxlength: "60", required: true,
      value: d.name, oninput: (e) => { d.name = e.target.value; },
    });
    // Active roles, plus any retired role this person still has (so it can be unticked).
    const roleChoices = (data.roles || []).filter((r) => r.active !== false || d.roles.includes(r.id));
    ui.formHadRoles = roleChoices.length > 0;
    const roleBoxes = roleChoices.length
      ? roleChoices.map((r) =>
          el(
            "label",
            { class: "check-row" },
            el("input", {
              type: "checkbox", value: r.id, checked: d.roles.includes(r.id),
              onchange: (e) => { d.roles = e.target.checked ? [...d.roles, r.id] : d.roles.filter((x) => x !== r.id); },
            }),
            el("span", {}, r.active === false ? `${r.name} (retired)` : r.name)
          )
        )
      : [data.roles
          ? banner({ message: "No roles yet. Go to Admin → Roles and tap \"Add the starting roles\" first.", messageKind: "error" })
          : spinner("Loading roles…")];

    // Read at save time (the inputs update the draft as you type).
    const fields = () => ({ name: d.name, roles: d.roles, team: d.team || null, ...(existing ? { position: d.position || "", trainingName: d.trainingName || null } : {}) });
    // `again` = add this person and keep the form open for the next one.
    async function save(e, again = false) {
      e?.preventDefault();
      if (existing) {
        const ok = await act(() => callAdminUpdateEmployee({ employeeNumber: existing.employeeNumber, ...fields() }), () => save(null));
        ui.replacedNote = "";
        if (ok && (await saveOrg(existing.employeeNumber))) show("person", `Saved${ui.replacedNote}`, "ok");
        return;
      }
      const r = await act(() => callAdminCreateEmployee({ employeeNumber: d.number, ...fields() }), () => save(null, again));
      if (!r) return;
      if (!(await saveOrg(r.employeeNumber))) return;
      if (again) {
        ui.justAdded.unshift({ name: d.name.trim(), number: r.employeeNumber, pin: r.tempPin });
        toast(`${d.name.trim()} added — #${r.employeeNumber}`);
        startAdd({ roles: d.roles, team: d.team });
        document.getElementById("f-name")?.focus();
        return;
      }
      ui.tempPin = { name: d.name.trim(), pin: r.tempPin };
      ui.selected = r.employeeNumber;
      show("tempPin");
    }
    // Department, head, reports to, can post — only when something changed. One head per department: if someone else is the
    // head, ask "Replace [current head]?" first.
    async function saveOrg(emp, replace = false) {
      if (!ui.org) return true;
      const o = ui.org.byEmp.get(emp) || {};
      const sameTeams = [...(o.supervisesTeams || [])].sort().join() === [...(d.supervisesTeams || [])].sort().join();
      if ((o.department || "") === (d.department || "") && (o.deptHead === true) === d.head && (o.override || "") === (d.reportsTo || "") && sameTeams && (o.canPost === true) === (d.canPost === true)) return true;
      try {
        const supervisesTeams = d.roles.includes("supervisor") ? d.supervisesTeams || [] : [];
        const { data: r } = await callAdminSaveOrg({ emp, department: d.department || null, head: d.head && !!d.department, reportsTo: d.reportsTo || null, supervisesTeams, canPost: d.canPost === true, replace });
        await load();
        ui.replacedNote = r.replaced ? ` — ${r.replaced} is no longer the ${deptName(ui.org, d.department)} head` : "";
        return true;
      } catch (err) {
        const current = err?.details?.currentHead;
        if (current && !replace) {
          const ok = await confirmSheet({ title: `Replace ${current.name}?`, text: `${current.name} is the ${deptName(ui.org, d.department)} head. Make this person the head instead?`, confirmLabel: `Replace ${current.name}` });
          if (ok) return saveOrg(emp, true);
          d.head = false; // keep the current head; save the rest
          return saveOrg(emp);
        }
        Object.assign(ui, { busy: false, message: current ? "Saved — but not as department head." : friendlyError(err), messageKind: "error", retry: null });
        render();
        return false;
      }
    }
    const depts = (ui.org?.departments || []).filter((dep) => dep.active !== false || dep.id === d.department);
    const suggested = existing ? orgOf(existing).suggested : null;
    const auto = existing ? orgOf(existing) : {};
    const others = (ui.people || []).filter((x) => x.active && (!existing || x.employeeNumber !== existing.employeeNumber));
    const teams = (data.teams || []).filter((t) => t.active !== false || t.id === d.team);

    return [
      backBar(existing ? existing.name : "People", () => show(existing ? "person" : "list")),
      el("h1", {}, existing ? "Edit person" : "Add a person"),
      messageBox(),
      // People added with "Save & add another" — their temporary PINs, until you leave this form.
      !existing && ui.justAdded.length
        ? el(
            "div",
            { class: "card" },
            el("strong", {}, `Just added (${ui.justAdded.length}) — give each person their temporary PIN`),
            el("div", { class: "import-preview" }, ui.justAdded.map((a) =>
              el("div", { class: "import-row" }, el("span", { class: "import-line" }, `#${a.number}`), el("span", { class: "gap-term" }, a.name), el("strong", { class: "pin-inline" }, a.pin)))),
            el("p", { class: "card-note" }, "Write these down now — they aren't shown again (you can always reset a PIN).")
          )
        : null,
      el(
        "form",
        { onsubmit: save },
        existing
          ? el("p", { class: "hint" }, `Employee #${existing.employeeNumber}`)
          : [el("label", { class: "field-label", for: "f-number" }, "Employee number (next free one filled in — change it if needed)"), numberInput],
        el("label", { class: "field-label", for: "f-name" }, "Name (as it should appear in the app)"),
        nameInput,
        existing
          ? [el("label", { class: "field-label", for: "f-position" }, "Position (from Gusto)"),
             el("input", { class: "field", id: "f-position", autocomplete: "off", maxlength: "80", value: d.position, oninput: (e) => { d.position = e.target.value; } })]
          : null,
        el("p", { class: "field-label" }, "Roles"),
        existing && !existing.rolesConfirmed
          ? el("p", { class: "message" }, `Suggested from “${existing.position || "no position"}”: ${existing.suggestedRoles.length ? roleNames(existing.suggestedRoles) : "no match — pick one"}. Tick the right role(s) — saving confirms them.`)
          : null,
        roleBoxes,
        ui.org
          ? [
            el("label", { class: "field-label", for: "f-dept" }, "Department"),
            picker({ id: "f-dept", title: "Department", value: d.department, placeholder: "No department", options: [{ value: "", label: "No department" }, ...depts.map((dep) => ({ value: dep.id, label: dep.active === false ? `${dep.name} (retired)` : dep.name }))], onChange: (v) => { d.department = v; if (!v) d.head = false; render(); } }),
            suggested && suggested !== d.department
              ? el("p", { class: "card-note" }, `Suggested from their roles: ${deptName(ui.org, suggested)} `,
                  el("button", { class: "link-btn", type: "button", onclick: () => { d.department = suggested; render(); } }, "Use it"))
              : null,
            el("label", { class: "check-row" }, el("input", { type: "checkbox", checked: d.head, disabled: !d.department, onchange: (e) => { d.head = e.target.checked; } }), el("span", {}, d.department ? "⭐ Department head (one per department)" : "⭐ Department head — pick a department first")),
            el("label", { class: "check-row" }, el("input", { type: "checkbox", checked: d.canPost, onchange: (e) => { d.canPost = e.target.checked; } }), el("span", {}, "📣 Can post announcements (department heads and Admins always can)")),
            d.roles.includes("supervisor")
              ? [el("p", { class: "field-label" }, "Teams they supervise (one or more shifts)"),
                 el("div", { class: "chips" }, (data.teams || []).filter((t) => t.active !== false || (d.supervisesTeams || []).includes(t.id)).map((t) => {
                   const on = (d.supervisesTeams || []).includes(t.id);
                   return el("button", { class: on ? "chip on" : "chip", type: "button", "aria-pressed": String(on), onclick: () => { d.supervisesTeams = on ? d.supervisesTeams.filter((x) => x !== t.id) : [...(d.supervisesTeams || []), t.id]; render(); } }, `Team ${t.name}`);
                 })),
                 el("p", { class: "card-note" }, "Leads and operators on these teams report to this Supervisor (their own team counts too).")]
              : null,
            el("label", { class: "field-label", for: "f-reports" }, "Reports to"),
            picker({ id: "f-reports", title: "Reports to", value: d.reportsTo, placeholder: "Automatic",
              options: [{ value: "", label: `Automatic${existing && auto.reportsTo && !auto.override ? ` (${personName(auto.reportsTo)})` : ""}` }, { value: "none", label: "No one — top of the chart" }, ...others.map((x) => ({ value: x.employeeNumber, label: `${x.name} (#${x.employeeNumber})` }))],
              onChange: (v) => { d.reportsTo = v; render(); } }),
            el("p", { class: "card-note" }, "Automatic: Production by shift (Operator → team Line Lead → team Supervisor → Production Manager); other departments → their head; heads → the Production Manager (or who's set in Admin → Departments). Pick a person to override it."),
          ]
          : el("p", { class: "card-note" }, "Department and reports to couldn't load — save the rest, then try again."),
        el("label", { class: "field-label", for: "f-team" }, "Team"),
        picker({ id: "f-team", title: "Team", value: d.team, placeholder: "No team", options: [{ value: "", label: "No team" }, ...teams.map((t) => ({ value: t.id, label: `Team ${t.name}` }))], onChange: (v) => { d.team = v; render(); } }),
        // No home line (Decision 104): people are put on lines each shift on the Crew Board (Who's here today → Stations).
        // Links this person to their training record, so their own refreshers due show in "Needs you" on Home.
        existing && trainingRoster.length
          ? [el("label", { class: "field-label", for: "f-training" }, "Training record (name on the training roster)"),
             picker({ id: "f-training", title: "Training record", value: d.trainingName || "", placeholder: "Not linked",
               options: [{ value: "", label: "Not linked" }, ...trainingRoster.map((n) => ({ value: n, label: n }))], onChange: (v) => { d.trainingName = v; render(); } })]
          : null,
        el("button", { class: "btn", type: "submit", disabled: ui.busy }, ui.busy ? "Saving…" : existing ? "Save" : "Add and get PIN"),
        existing ? null : el("button", { class: "btn secondary", type: "button", disabled: ui.busy, onclick: () => save(null, true) }, "+ Save & add another person")
      ),
    ];
  }

  // ---- Temporary PIN (shown once) -----------------------------------------

  function renderTempPin() {
    const { name, pin } = ui.tempPin || {};
    return [
      el("h1", {}, "Temporary PIN"),
      el("p", { class: "hint" }, `Give this to ${name}:`),
      el("div", { class: "temp-pin", "aria-label": pin.split("").join(" ") }, pin),
      el(
        "div",
        { class: "card" },
        "They'll pick their own PIN the first time they sign in. This PIN won't be shown again — if it's lost, just reset it."
      ),
      el("button", { class: "btn", type: "button", onclick: () => { ui.tempPin = null; show("person"); } }, "✔ Done"),
    ];
  }

  // ---- One person ---------------------------------------------------------

  function renderPerson() {
    const p = person();
    if (!p) return renderList();
    const isMe = p.employeeNumber === myEmployeeNumber;

    async function resetPin(askFirst = true) {
      const ok = !askFirst || (await confirmSheet({
        title: `Reset ${p.name}'s PIN?`,
        text: "They'll be signed out on every device and get a new temporary PIN.",
        confirmLabel: "Reset PIN",
      }));
      if (!ok) return;
      const data = await act(() => callAdminResetPin({ employeeNumber: p.employeeNumber }), () => resetPin(false));
      if (data) {
        ui.tempPin = { name: p.name, pin: data.tempPin };
        show("tempPin");
      }
    }

    async function enableLogin(askFirst = true) {
      const ok = !askFirst || (await confirmSheet({
        title: `Enable login for ${p.name}?`,
        text: "You'll get a temporary PIN to give them. They pick their own PIN the first time they sign in.",
        confirmLabel: "Enable login",
      }));
      if (!ok) return;
      const data = await act(() => callAdminEnableLogin({ employeeNumber: p.employeeNumber }), () => enableLogin(false));
      if (data) {
        ui.tempPin = { name: p.name, pin: data.tempPin };
        show("tempPin");
      }
    }

    async function unlock() {
      if (await act(() => callAdminUnlock({ employeeNumber: p.employeeNumber }), unlock)) show("person", "Unlocked — they can sign in now", "ok");
    }

    async function setActive(active, askFirst = true) {
      const ok = !askFirst || (await confirmSheet(active
        ? { title: `Turn ${p.name}'s account back on?`, confirmLabel: "Turn back on" }
        : { title: `Turn off ${p.name}'s account?`, text: "They'll be signed out everywhere and can't sign in until it's turned back on.", confirmLabel: "Turn off account", danger: true }));
      if (!ok) return;
      if (await act(() => callAdminUpdateEmployee({ employeeNumber: p.employeeNumber, active }), () => setActive(active, false))) {
        show("person", active ? "Account is on" : "Account is off", "ok");
      }
    }

    return [
      backBar("People", () => show("list")),
      el("h1", {}, p.name),
      el("p", { class: "roles" }, personLine(p)),
      el("p", { class: "tags center" }, tags(p)),
      messageBox(),
      p.locked ? el("button", { class: "btn", type: "button", onclick: () => unlock(), disabled: ui.busy }, "🔓 Unlock now") : null,
      p.position ? el("p", { class: "hint" }, p.position) : null,
      ui.org ? el("div", { class: "card org-card" },
        el("p", {}, el("strong", {}, "Department: "), orgOf(p).department ? `${deptName(ui.org, orgOf(p).department)}${orgOf(p).isHead ? " · ⭐ Head" : ""}` : "none yet"),
        orgOf(p).canPost ? el("p", {}, "📣 Can post announcements") : null,
        orgOf(p).supervisesTeams?.length ? el("p", {}, el("strong", {}, "Supervises: "), orgOf(p).supervisesTeams.map((t) => `Team ${teamName(t)}`).join(", ")) : null,
        el("p", {}, el("strong", {}, "Reports to: "), orgOf(p).reportsTo ? `${personName(orgOf(p).reportsTo)}${orgOf(p).source === "override" ? " (set by an admin)" : " (automatic)"}` : orgOf(p).source === "top" ? "no one (top of the chart)" : "⚠ missing")) : null,
      !p.rolesConfirmed ? el("p", { class: "message" }, "Role not confirmed yet — tap Edit, tick the right role(s), and Save.") : null,
      p.loginEnabled
        ? el("button", { class: "btn secondary", type: "button", onclick: () => resetPin(), disabled: ui.busy || !p.active }, "🔑 Reset PIN")
        : el("button", { class: "btn", type: "button", onclick: () => enableLogin(), disabled: ui.busy || !p.active || !p.rolesConfirmed }, p.rolesConfirmed ? "🔑 Enable login" : "🔑 Enable login (confirm role first)"),
      el("button", { class: "btn secondary", type: "button", onclick: startEdit, disabled: ui.busy }, "✎ Edit name, roles, team, department"),
      isMe
        ? null
        : el(
            "button",
            { class: p.active ? "btn danger" : "btn secondary", type: "button", onclick: () => setActive(!p.active), disabled: ui.busy },
            p.active ? "⛔ Turn off account" : "↺ Turn account back on"
          ),
    ];
  }

  function render() {
    let content;
    if (ui.view === "add") content = renderForm(null);
    else if (ui.view === "edit") content = renderForm(person());
    else if (ui.view === "tempPin") content = renderTempPin();
    else if (ui.view === "person") content = renderPerson();
    else content = renderList();
    container.replaceChildren(...content.flat().filter(Boolean));
  }

  // Redraw when the Roles list changes (role names), but not mid-typing in a form that already has its checkboxes.
  const stop = onDataChange(() => {
    const editing = (ui.view === "add" || ui.view === "edit") && ui.formHadRoles;
    if (!ui.busy && !editing) render();
  });

  // Names on the training roster (Training data), for the "Training record" link.
  let trainingRoster = [];
  const stopRoster = onSnapshot(doc(db, "trainingRef", "data"), (snap) => {
    try { trainingRoster = snap.exists() ? (JSON.parse(snap.get("json")).roster || []).map((r) => r.name).filter(Boolean).sort() : []; } catch { trainingRoster = []; }
    if (ui.view === "edit" && !ui.busy) render();
  }, () => {});

  render();
  load();
  return () => { stop(); stopRoster(); };
}
