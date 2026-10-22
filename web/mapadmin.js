// Admin → Shop map: load the plant map from the original's map file, and link each station to its machine.
// The map's content goes straight to the database (signed-in people only) — it is never stored in this repo.

import { el, friendlyError, spinner, emptyState, banner, toast, confirmSheet, picker } from "./ui.js";
import { data, onDataChange } from "./data.js";
import { db, callAdminImportFloorMap, callAdminSetStationMachine, callAdminEnsureOdooEquipment } from "./firebase.js";
import { collection, doc, onSnapshot } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

export function openMapAdmin(container, { onExit }) {
  const ui = { layout: undefined, stations: null, busy: false, message: "", messageKind: "", retry: null, filter: "all" };

  async function act(fn, again) {
    Object.assign(ui, { busy: true, message: "", retry: null });
    render();
    try {
      const { data: r } = await fn();
      ui.busy = false;
      render();
      return r;
    } catch (err) {
      Object.assign(ui, { busy: false, message: friendlyError(err), messageKind: "error", retry: again });
      render();
      return null;
    }
  }

  async function importFile(file) {
    let map;
    try {
      map = JSON.parse(await file.text());
    } catch {
      Object.assign(ui, { message: "That file isn't the map file (plant-data.json).", messageKind: "error" });
      return render();
    }
    if (ui.layout && !(await confirmSheet({ title: "Load this map file?", text: "It replaces the map, stations, and SOP text. Station-to-machine links are kept.", confirmLabel: "Load map" }))) return;
    const r = await act(() => callAdminImportFloorMap({ map }), () => importFile(file));
    if (r) toast(`Map loaded — ${r.zones} areas, ${r.stations} stations, ${r.sops} SOPs`);
  }

  async function link(st, machineId) {
    if (await act(() => callAdminSetStationMachine({ stationId: st.id, machineId: machineId || null }), () => link(st, machineId))) {
      toast(machineId ? `${st.label} → ${machineId}` : `${st.label} is an area (no machine)`);
    }
  }

  async function ensureOdoo() {
    // Only stations on the map and machines in use — never a retired one.
    const inUse = new Set((data.machines || []).filter((m) => m.active !== false).map((m) => m.id));
    const ids = [...new Set((ui.stations || []).filter((s) => s.active !== false).map((s) => s.machineId).filter((id) => id && inUse.has(id)))];
    const r = await act(() => callAdminEnsureOdooEquipment({ machineIds: ids }), ensureOdoo);
    if (r) toast(r.created.length ? `Added to Odoo: ${r.created.join(", ")}` : "Odoo already has every linked machine");
  }

  function render() {
    const machines = (data.machines || []).filter((m) => m.active !== false);
    const label = (m) => `${m.id} · ${m.name}${m.lineId ? ` (${data.lines?.find((l) => l.id === m.lineId)?.name || ""})` : ""}`;
    const stations = (ui.stations || []).filter((s) => s.active !== false)
      .filter((s) => ui.filter === "all" || (ui.filter === "unlinked" ? !s.machineId && !s.room : !!s.machineId))
      .sort((a, b) => a.zone.localeCompare(b.zone) || a.x - b.x || a.y - b.y);
    const all = (ui.stations || []).filter((s) => s.active !== false);
    const counts = { all: all.length, linked: all.filter((s) => s.machineId).length, unlinked: all.filter((s) => !s.machineId && !s.room).length };
    container.replaceChildren(...[
      el("button", { class: "link-btn", type: "button", onclick: onExit, disabled: ui.busy }, "← Admin"),
      el("h1", {}, "Shop map"),
      el("p", { class: "hint" }, "The plant floor map. Its content lives in the database (signed-in people only), never in the app's code."),
      banner(ui),
      ui.layout === undefined ? spinner() : null,
      ui.layout === null ? emptyState("No map loaded yet", "Load the map file (plant-data.json) below.") : null,
      ui.layout
        ? el("div", { class: "card" }, el("strong", {}, `${ui.layout.zones?.length || 0} areas · ${all.length} stations`),
            el("p", { class: "card-note" }, `Loaded ${ui.layout.importedAt?.toDate?.().toLocaleString() || ""}`))
        : null,
      el("label", { class: "btn secondary file-btn" }, ui.busy ? "Working…" : ui.layout ? "⇪ Load the map file again" : "⇪ Load the map file (plant-data.json)",
        el("input", { type: "file", accept: ".json,application/json", hidden: true, disabled: ui.busy, onchange: (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) importFile(f); } })),
      all.length
        ? [
            el("h2", {}, "Stations → machines"),
            el("p", { class: "hint" }, "Each machine station links to its M-number (Fix Library, maintenance, checklists). Areas like QC Staging have none."),
            el("div", { class: "chips" }, [["all", "All"], ["linked", "Linked"], ["unlinked", "Not linked"]].map(([id, t]) =>
              el("button", { class: ui.filter === id ? "chip on" : "chip", type: "button", onclick: () => { ui.filter = id; render(); } }, `${t} (${counts[id]})`))),
            el("div", { class: "map-links" }, stations.map((s) =>
              el("div", { class: "map-link-row" },
                el("div", { class: "sm-col" }, el("span", { class: "person-name" }, s.label), el("span", { class: "person-meta" }, [s.tag, s.room ? "area" : ""].filter(Boolean).join(" · "))),
                picker({
                  title: `${s.label} (${s.tag || s.zone})`, value: s.machineId || "", placeholder: "Not linked",
                  options: [{ value: "", label: "Area — no machine" }, ...machines.map((m) => ({ value: m.id, label: label(m) }))],
                  onChange: (v) => link(s, v),
                })))),
            el("button", { class: "btn secondary", type: "button", disabled: ui.busy, onclick: ensureOdoo }, "Make sure Odoo has every linked machine"),
          ]
        : null,
    ].flat(3).filter(Boolean));
  }

  const stops = [
    onSnapshot(doc(db, "floorMap", "layout"), (s) => { ui.layout = s.exists() ? s.data() : null; if (!ui.busy) render(); }, () => { ui.layout = null; render(); }),
    onSnapshot(collection(db, "floorStations"), (s) => { ui.stations = s.docs.map((d) => ({ id: d.id, ...d.data() })); if (!ui.busy) render(); }, () => {}),
    onDataChange(() => { if (!ui.busy) render(); }),
  ];
  render();
  return () => stops.forEach((x) => x());
}
