// Departments + reports to (Chris, 10-22-2026; launch list 1). Rules: functions/departments.js.
//   - Admin → Departments: the list (rename, add, turn off) and who department heads report to.
//   - More → My profile: "You report to: [name]" and the org chart — names and titles only — for everyone.
// Each person's department, head, and reports-to override are set on Admin → People.

import { el, friendlyError, spinner, banner, toast, emptyState, picker } from "./ui.js";
import { data } from "./data.js";
import { callOrgChart, callAdminOrg, callAdminSaveDepartments, callAdminListEmployees } from "./firebase.js";

// ---- Admin → Departments ------------------------------------------------------------------------

export function openDepartmentsAdmin(container, { onExit }) {
  const ui = { org: null, people: null, draft: null, busy: false, message: "", messageKind: "", retry: null, loadError: "" };

  async function load() {
    Object.assign(ui, { loadError: "" });
    render();
    try {
      const [org, people] = await Promise.all([callAdminOrg(), callAdminListEmployees()]);
      ui.org = org.data;
      ui.people = people.data.employees.filter((p) => p.active);
      ui.draft = { departments: ui.org.departments.map((d) => ({ ...d })), headsReportTo: ui.org.headsReportTo || "" };
    } catch (err) {
      ui.loadError = friendlyError(err);
    }
    render();
  }

  async function save() {
    if (!navigator.onLine) { Object.assign(ui, { message: friendlyError({ code: "offline" }), messageKind: "error", retry: save }); return render(); }
    Object.assign(ui, { busy: true, message: "", retry: null });
    render();
    try {
      const d = ui.draft;
      await callAdminSaveDepartments({ departments: d.departments.filter((x) => x.name.trim() || x.id), headsReportTo: d.headsReportTo || null });
      ui.busy = false;
      toast("Departments saved");
      await load();
    } catch (err) {
      Object.assign(ui, { busy: false, message: friendlyError(err), messageKind: "error", retry: save });
      render();
    }
  }

  function render() {
    const top = [el("button", { class: "link-btn", type: "button", onclick: onExit }, "← Admin"), el("h1", {}, "🏢 Departments")];
    if (ui.loadError) return container.replaceChildren(...top, banner({ message: ui.loadError, messageKind: "error", retry: load }));
    if (!ui.draft) return container.replaceChildren(...top, spinner());
    const d = ui.draft;
    const name = (emp) => ui.people.find((p) => p.employeeNumber === emp)?.name || "";
    const heads = new Map(ui.org.people.filter((p) => p.isHead).map((p) => [p.department, p.emp]));
    const prodHead = heads.get("production");
    container.replaceChildren(...[
      ...top,
      el("p", { class: "hint" }, "Each person's department and the ⭐ head are set on Admin → People. Turning a department off keeps it on the people already in it."),
      banner(ui),
      el("form", { class: "card", onsubmit: (e) => { e.preventDefault(); save(); } },
        el("strong", {}, "Departments"),
        el("div", { class: "dept-rows" }, d.departments.map((x) => el("div", { class: "dept-row" },
          el("input", { class: "field", value: x.name, maxlength: "60", "aria-label": "Department name", oninput: (e) => { x.name = e.target.value; } }),
          el("label", { class: "check-row" }, el("input", { type: "checkbox", checked: x.active !== false, onchange: (e) => { x.active = e.target.checked; } }), el("span", {}, "On")),
          el("span", { class: "dept-head" }, heads.get(x.id) ? `⭐ ${name(heads.get(x.id))}` : x.id ? (ui.org.noHead.includes(x.id) ? "⚠ No head" : "No one yet") : "")))),
        el("button", { class: "btn secondary", type: "button", onclick: () => { d.departments.push({ name: "", active: true }); render(); } }, "+ Add department"),
        el("label", { class: "field-label strong", for: "f-heads-to" }, "Department heads report to"),
        picker({ id: "f-heads-to", title: "Department heads report to", value: d.headsReportTo, placeholder: "The Production Manager",
          options: [{ value: "", label: `The Production head${prodHead ? ` (${name(prodHead)})` : ""}` }, ...ui.people.map((p) => ({ value: p.employeeNumber, label: `${p.name} (#${p.employeeNumber})` }))],
          onChange: (v) => { d.headsReportTo = v; render(); } }),
        el("p", { class: "card-note" }, "Production reports by shift: Operator → their team's Line Lead → their team's Supervisor → the Production Manager (Production's head)."),
        el("button", { class: "btn", type: "submit", disabled: ui.busy }, ui.busy ? "Saving…" : "Save")),
    ].filter(Boolean));
  }

  load();
  return () => {};
}

// ---- More → My profile + the org chart (everyone) ---------------------------------------------------

export function openProfile(container, { me, onExit, backLabel = "More" }) {
  const ui = { view: "profile", chart: null, loadError: "", q: "" };

  async function load() {
    Object.assign(ui, { loadError: "" });
    render();
    if (!navigator.onLine && !ui.chart) { ui.loadError = friendlyError({ code: "offline" }); return render(); }
    try { ui.chart = (await callOrgChart()).data; } catch (err) { ui.loadError = friendlyError(err); }
    render();
  }

  const roleNames = () => (data.myself?.roles || me.roles).map((r) => data.roles?.find((x) => x.id === r)?.name || r).join(", ");

  function renderProfile() {
    const c = ui.chart;
    const mine = c?.people.find((p) => p.emp === me.emp);
    const dept = c?.departments.find((d) => d.id === mine?.department);
    return [
      el("button", { class: "link-btn", type: "button", onclick: onExit }, `← ${backLabel}`),
      el("h1", {}, "👤 My profile"),
      el("section", { class: "card profile-card" },
        el("strong", { class: "profile-name" }, me.name),
        el("p", { class: "card-note" }, `Employee #${me.emp}${roleNames() ? ` · ${roleNames()}` : ""}`),
        !c ? (ui.loadError ? banner({ message: ui.loadError, messageKind: "error", retry: load }) : spinner())
          : [
            el("p", {}, el("strong", {}, "Department: "), dept ? `${dept.name}${mine?.head ? " · ⭐ Head" : ""}` : "not set yet"),
            el("p", { class: "profile-reports" }, el("strong", {}, "You report to: "), c.me.reportsToName || (c.me.top ? "no one — you're at the top" : "not set yet — ask an Admin")),
          ]),
      el("button", { class: "btn", type: "button", disabled: !c, onclick: () => { ui.view = "chart"; render(); } }, "🏢 Org chart"),
    ];
  }

  // The chart as a tree: everyone under who they report to. People not placed yet are listed at the end.
  function renderChart() {
    const c = ui.chart;
    const byEmp = new Map(c.people.map((p) => [p.emp, p]));
    const kids = new Map();
    for (const p of c.people) if (p.reportsTo && byEmp.has(p.reportsTo)) (kids.get(p.reportsTo) || kids.set(p.reportsTo, []).get(p.reportsTo)).push(p);
    const roots = c.people.filter((p) => !p.reportsTo || !byEmp.has(p.reportsTo));
    const placed = roots.filter((p) => kids.has(p.emp));
    const unplaced = roots.filter((p) => !kids.has(p.emp));
    const deptName = (id) => c.departments.find((d) => d.id === id)?.name || "";
    const q = ui.q.trim().toLowerCase();
    const matches = (p) => !q || `${p.name} ${p.title} ${deptName(p.department)}`.toLowerCase().includes(q);
    const within = (p) => matches(p) || (kids.get(p.emp) || []).some(within);
    const line = (p) => el("span", { class: p.emp === me.emp ? "org-person me" : "org-person" },
      el("strong", {}, `${p.head ? "⭐ " : ""}${p.name}`), el("span", { class: "org-title" }, [p.title, p.head ? `${deptName(p.department)} head` : ""].filter(Boolean).join(" · ")));
    const node = (p, depth) => {
      const under = (kids.get(p.emp) || []).filter(within).sort((a, b) => (kids.has(b.emp) - kids.has(a.emp)) || a.name.localeCompare(b.name));
      if (!under.length) return el("div", { class: "org-leaf" }, line(p));
      return el("details", { class: "org-node", open: depth < 2 || !!q },
        el("summary", {}, line(p), el("span", { class: "org-count" }, String(under.length))),
        el("div", { class: "org-kids" }, under.map((k) => node(k, depth + 1))));
    };
    return [
      el("button", { class: "link-btn", type: "button", onclick: () => { ui.view = "profile"; render(); } }, "← My profile"),
      el("h1", {}, "🏢 Org chart"),
      el("p", { class: "hint" }, "Names and titles. Tap a name to open or close who reports to them."),
      el("input", { class: "field search", type: "search", value: ui.q, placeholder: "Find a name, title, or department", "aria-label": "Search the org chart",
        oninput: (e) => { ui.q = e.target.value; const pos = e.target.selectionStart; render(); const x = container.querySelector("input.search"); x?.focus(); x?.setSelectionRange(pos, pos); } }),
      el("div", { class: "org-tree" }, placed.filter(within).map((p) => node(p, 0))),
      unplaced.filter(matches).length
        ? el("section", { class: "card" }, el("strong", {}, "Not placed yet"), el("p", { class: "card-note" }, "Department or reports to isn't set for these people yet."),
            el("div", { class: "org-kids flat" }, unplaced.filter(matches).map((p) => el("div", { class: "org-leaf" }, line(p)))))
        : null,
      !c.people.some(matches) ? emptyState("No match", "Try part of a name.") : null,
    ];
  }

  function render() {
    container.replaceChildren(...(ui.view === "chart" && ui.chart ? renderChart() : renderProfile()).flat().filter(Boolean));
  }

  load();
  return () => {};
}
