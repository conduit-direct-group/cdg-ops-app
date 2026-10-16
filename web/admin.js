// Admin "People" screens: list everyone, add a person, reset PINs, unlock, edit, turn accounts off/on.
// Every action is checked again on the server (admins only), so hiding buttons here is just tidiness.

import { el, friendlyError, spinner, banner, toast, confirmSheet } from "./ui.js";
import { data, onDataChange } from "./data.js";
import {
  callAdminListEmployees,
  callAdminCreateEmployee,
  callAdminResetPin,
  callAdminUnlock,
  callAdminUpdateEmployee,
} from "./firebase.js";

// Role names come from the live Roles list (Admin → Roles); unknown ids show as-is.
function roleNames(roles) {
  const names = new Map((data.roles || []).map((r) => [r.id, r.name]));
  return roles.map((r) => names.get(r) || r).join(", ");
}

// Opens the People screens inside `container`. `onExit` returns to the Admin menu.
export function openAdmin(container, { myEmployeeNumber, onExit }) {
  const ui = {
    view: "list", // list | add | edit | person | tempPin
    people: null,
    selected: null, // employeeNumber
    tempPin: null, // { name, pin } — shown once, never stored
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
      const { data } = await callAdminListEmployees();
      ui.people = data.employees;
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
      !p.active ? el("span", { class: "tag off" }, "Off") : null,
      p.locked ? el("span", { class: "tag warn" }, `Locked ${p.minutesLeft} min`) : null,
      p.active && p.mustChangePin ? el("span", { class: "tag" }, "Hasn't picked PIN") : null,
    ];
  }

  // ---- People list --------------------------------------------------------

  function renderList() {
    const rows =
      ui.loadError && !ui.people
        ? []
        : ui.people === null
        ? [spinner("Loading people…")]
        : ui.people.map((p) =>
            el(
              "button",
              { class: "person-row", type: "button", onclick: () => { ui.selected = p.employeeNumber; show("person"); } },
              el("span", { class: "person-name" }, p.name),
              el("span", { class: "person-meta" }, `#${p.employeeNumber} · ${roleNames(p.roles)}`),
              el("span", { class: "tags" }, tags(p))
            )
          );
    return [
      backBar("Admin", onExit),
      el("h1", {}, "People"),
      el("p", { class: "hint" }, ui.people ? `${ui.people.length} ${ui.people.length === 1 ? "person" : "people"}` : ""),
      ui.loadError ? banner({ message: `Couldn't load the people list. ${ui.loadError}`, messageKind: "error", retry: reload }) : null,
      messageBox(),
      el("button", { class: "btn", type: "button", onclick: startAdd }, "+ Add a person"),
      el("div", { class: "person-list" }, rows),
    ];
  }

  // ---- Add / edit form ----------------------------------------------------

  function startAdd() {
    ui.draft = { number: "", name: "", roles: ["operator"] };
    show("add");
  }

  function startEdit() {
    const p = person();
    ui.draft = { number: p.employeeNumber, name: p.name, roles: [...p.roles] };
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

    async function save(e) {
      e?.preventDefault();
      if (existing) {
        const ok = await act(() => callAdminUpdateEmployee({ employeeNumber: existing.employeeNumber, name: d.name, roles: d.roles }), save);
        if (ok) show("person", "Saved", "ok");
      } else {
        const data = await act(() => callAdminCreateEmployee({ employeeNumber: d.number, name: d.name, roles: d.roles }), save);
        if (data) {
          ui.tempPin = { name: d.name.trim(), pin: data.tempPin };
          ui.selected = data.employeeNumber;
          show("tempPin");
        }
      }
    }

    return [
      backBar(existing ? existing.name : "People", () => show(existing ? "person" : "list")),
      el("h1", {}, existing ? "Edit name and roles" : "Add a person"),
      messageBox(),
      el(
        "form",
        { onsubmit: save },
        existing
          ? el("p", { class: "hint" }, `Employee #${existing.employeeNumber}`)
          : [el("label", { class: "field-label", for: "f-number" }, "Employee number"), numberInput],
        el("label", { class: "field-label", for: "f-name" }, "Name (as it should appear in the app)"),
        nameInput,
        el("p", { class: "field-label" }, "Roles"),
        roleBoxes,
        el("button", { class: "btn", type: "submit", disabled: ui.busy }, ui.busy ? "Saving…" : existing ? "Save" : "Add and get PIN")
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
      el("p", { class: "roles" }, `#${p.employeeNumber} · ${roleNames(p.roles)}`),
      el("p", { class: "tags center" }, tags(p)),
      messageBox(),
      p.locked ? el("button", { class: "btn", type: "button", onclick: () => unlock(), disabled: ui.busy }, "🔓 Unlock now") : null,
      el("button", { class: "btn secondary", type: "button", onclick: () => resetPin(), disabled: ui.busy || !p.active }, "🔑 Reset PIN"),
      el("button", { class: "btn secondary", type: "button", onclick: startEdit, disabled: ui.busy }, "✎ Edit name and roles"),
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

  render();
  load();
  return stop;
}
