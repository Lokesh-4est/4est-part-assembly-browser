const PROPERTY_NAMES = {
  assembly: "Assembly/Cast unit Mark",
  part: "Part Position",
  uniqueId: "Unique ID"
};

let API = null;
let pendingBridgeDrawingNo = "";
let lastBridgeDrawingNo = "";
let activeColourPopover = null;

const state = {
  activeTab: "assembly",
  assemblies: [],
  parts: [],
  uniqueIds: [],
  modelObjects: [],
  partialMatches: [],
  expandedGroups: { assembly: new Set(), part: new Set(), uniqueId: new Set() },
  expandedPartialGroups: new Set(),
  coloredGroups: { assembly: new Map(), part: new Map(), uniqueId: new Map() }
};

function el(id) { return document.getElementById(id); }
function normalize(value) { return String(value ?? "").trim().toLowerCase(); }
function display(value) { return String(value ?? "").trim(); }
function naturalCompare(a, b) { return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }); }

function log(label, data) {
  const box = el("debugLog");
  if (!box) return;
  const details = data === undefined ? "" : `\n${JSON.stringify(data, null, 2)}`;
  box.textContent = `[${new Date().toLocaleTimeString()}] ${label}${details}\n\n${box.textContent}`;
}

function setConnectionBanner(text, kind = "muted") {
  const banner = el("connectionBanner");
  banner.textContent = text;
  banner.className = `banner ${kind}`;
  if (kind === "ok") setTimeout(() => banner.classList.add("fade"), 2000);
}

function setResult(message = "", kind = "") {
  const target = el("status");
  target.textContent = message;
  target.className = `result ${kind}`;
}

function uniqueIds(values) {
  return [...new Set(values.map(Number).filter(Number.isFinite))];
}

function flattenRuntimeIds(items) {
  if (!Array.isArray(items)) return [];
  return items.flatMap((item) => {
    if (typeof item === "number") return [item];
    if (!item || typeof item !== "object") return [];
    return [item.runtimeId, item.id, ...flattenRuntimeIds(item.children)].filter(Boolean);
  });
}

async function getAllModelObjectIds() {
  try {
    const objects = await API.viewer.getObjects({});
    const result = (objects || []).map((model) => ({
      modelId: model.modelId,
      objectRuntimeIds: uniqueIds([...(model.objectRuntimeIds || []), ...flattenRuntimeIds(model.objects)])
    })).filter((model) => model.modelId && model.objectRuntimeIds.length);
    if (result.length) return result;
  } catch (error) { log("Full-model getObjects({}) failed", error.message); }

  try {
    const models = await API.viewer.getModels();
    const result = [];
    for (const model of models || []) {
      try {
        const hierarchy = await API.viewer.getHierarchyChildren(model.id, [], undefined, true);
        const ids = uniqueIds(flattenRuntimeIds(hierarchy));
        if (ids.length) result.push({ modelId: model.id, objectRuntimeIds: ids });
      } catch (error) { log(`Hierarchy read failed for ${model.id}`, error.message); }
    }
    if (result.length) return result;
  } catch (error) { log("getModels() failed", error.message); }

  try {
    const selection = await API.viewer.getSelection();
    return (selection || []).map((model) => ({
      modelId: model.modelId,
      objectRuntimeIds: uniqueIds(model.objectRuntimeIds || [])
    })).filter((model) => model.modelId && model.objectRuntimeIds.length);
  } catch (error) { log("getSelection() fallback failed", error.message); return []; }
}

function mapPropertyValues(object, modelId, maps) {
  for (const propertySet of object.properties || []) {
    for (const property of propertySet.properties || []) {
      const value = display(property.value);
      if (!value) continue;
      const key = property.name === PROPERTY_NAMES.assembly ? "assembly" :
        property.name === PROPERTY_NAMES.part ? "part" :
        property.name === PROPERTY_NAMES.uniqueId ? "uniqueId" : null;
      if (!key) continue;
      if (!maps[key].has(value)) maps[key].set(value, []);
      maps[key].get(value).push({ modelId, objectRuntimeId: object.id });
    }
  }
}

async function refreshModel() {
  if (!API) return;
  el("loadingState").hidden = false;
  el("emptyState").hidden = true;
  el("loadingText").textContent = "Reading complete model…";
  setResult();
  clearPartialResults();

  const modelObjects = await getAllModelObjectIds();
  const total = modelObjects.reduce((sum, model) => sum + model.objectRuntimeIds.length, 0);
  if (!total) {
    el("loadingState").hidden = true;
    el("emptyState").hidden = false;
    el("emptyState").textContent = "Couldn't read any objects from the complete model. Check Advanced → Debug log.";
    return;
  }

  const maps = { assembly: new Map(), part: new Map(), uniqueId: new Map() };
  let completed = 0;
  for (const { modelId, objectRuntimeIds } of modelObjects) {
    for (let index = 0; index < objectRuntimeIds.length; index += 200) {
      const batch = objectRuntimeIds.slice(index, index + 200);
      try {
        const objects = await API.viewer.getObjectProperties(modelId, batch);
        for (const object of objects || []) mapPropertyValues(object, modelId, maps);
      } catch (error) { log(`Property read failed for ${modelId}, batch ${index}`, error.message); }
      completed += batch.length;
      el("loadingText").textContent = `Reading complete model… (${completed}/${total})`;
    }
  }

  state.modelObjects = modelObjects;
  state.assemblies = [...maps.assembly].map(([value, entries]) => ({ value, entries })).sort((a, b) => naturalCompare(a.value, b.value));
  state.parts = [...maps.part].map(([value, entries]) => ({ value, entries })).sort((a, b) => naturalCompare(a.value, b.value));
  state.uniqueIds = [...maps.uniqueId].map(([value, entries]) => ({ value, entries })).sort((a, b) => naturalCompare(a.value, b.value));
  el("loadingState").hidden = true;
  renderBrowser();
  log("Model browser refreshed", { objects: completed, assemblies: state.assemblies.length, parts: state.parts.length, uniqueIds: state.uniqueIds.length });
}

function getGroupKey(value) {
  const separator = value.match(/^(.+)[._-][^._-]+$/);
  if (separator) return separator[1];
  const prefix = value.match(/^([A-Za-z]+)/);
  return prefix && prefix[1].length < value.length ? prefix[1] : value;
}

function buildBrowserGroups(items) {
  const grouped = new Map();
  for (const item of items) {
    const group = getGroupKey(item.value);
    if (!grouped.has(group)) grouped.set(group, []);
    grouped.get(group).push(item);
  }
  return [...grouped].map(([group, children]) => ({ group, items: children, entries: children.flatMap((item) => item.entries) }))
    .sort((a, b) => naturalCompare(a.group, b.group));
}

function currentItems() {
  return state.activeTab === "assembly" ? state.assemblies : state.activeTab === "part" ? state.parts : state.uniqueIds;
}

function renderCounts() {
  el("assemblyCount").textContent = state.assemblies.length ? `(${state.assemblies.length})` : "";
  el("partCount").textContent = state.parts.length ? `(${state.parts.length})` : "";
  el("uniqueIdCount").textContent = state.uniqueIds.length ? `(${state.uniqueIds.length})` : "";
}

function selectorFor(entries) {
  const byModel = new Map();
  for (const entry of entries) {
    if (!byModel.has(entry.modelId)) byModel.set(entry.modelId, []);
    byModel.get(entry.modelId).push(entry.objectRuntimeId ?? entry.objectId);
  }
  return { modelObjectIds: [...byModel].map(([modelId, objectRuntimeIds]) => ({ modelId, objectRuntimeIds: uniqueIds(objectRuntimeIds) })) };
}

async function selectAndZoom(entries, message) {
  try {
    const selector = selectorFor(entries);
    await API.viewer.setSelection(selector, "set");
    await API.viewer.setCamera(selector, { animationTime: 800 });
    setResult(message, "ok");
  } catch (error) {
    setResult("Found the object(s), but couldn't select or zoom. Try again.", "error");
    log("setSelection/setCamera failed", error.message);
  }
}

function renderBrowser() {
  closeColourPopover();
  renderCounts();
  const list = el("browserList");
  list.replaceChildren();
  const filter = normalize(el("filterInput").value);
  const items = currentItems();
  const filtered = filter ? items.filter((item) => normalize(item.value).includes(filter)) : items;
  if (!filtered.length) {
    el("emptyState").hidden = false;
    el("emptyState").textContent = items.length ? "No matches for that filter." : "No values of this type were found in this model.";
    return;
  }
  el("emptyState").hidden = true;
  const expanded = state.expandedGroups[state.activeTab];
  for (const groupData of buildBrowserGroups(filtered)) {
    const open = Boolean(filter) || expanded.has(groupData.group);
    const row = document.createElement("li"); row.className = "group-row";
    const arrow = document.createElement("button"); arrow.className = `arrow ${open ? "open" : ""}`; arrow.textContent = "▶"; arrow.setAttribute("aria-label", "Expand group");
    arrow.addEventListener("click", (event) => { event.stopPropagation(); open ? expanded.delete(groupData.group) : expanded.add(groupData.group); renderBrowser(); });
    const label = document.createElement("span"); label.className = "group-label"; label.textContent = groupData.group;
    const count = document.createElement("span"); count.className = "group-count"; count.textContent = groupData.items.length;
    const colour = document.createElement("button"); colour.className = `colour-button ${state.coloredGroups[state.activeTab].has(groupData.group) ? "active" : ""}`; colour.textContent = "Colour"; colour.type = "button";
    colour.addEventListener("click", (event) => { event.stopPropagation(); openColourPopover(colour, groupData); });
    row.append(arrow, label, count, colour);
    row.addEventListener("click", () => selectAndZoom(groupData.entries, `Selected ${groupData.entries.length} object(s) in "${groupData.group}".`));
    list.append(row);
    if (!open) continue;
    const children = document.createElement("ul"); children.className = "group-children";
    for (const item of groupData.items) {
      const child = document.createElement("li"); child.className = "leaf-row";
      const text = document.createElement("span"); text.textContent = item.value; child.append(text);
      if (item.entries.length > 1) { const duplicates = document.createElement("span"); duplicates.className = "dupe-badge"; duplicates.textContent = `${item.entries.length}×`; child.append(duplicates); }
      child.addEventListener("click", (event) => { event.stopPropagation(); selectAndZoom(item.entries, `Zoomed to "${item.value}".`); });
      children.append(child);
    }
    list.append(children);
  }
}

function randomColour() {
  const hue = Math.floor(Math.random() * 360);
  const chroma = 0.55, x = chroma * (1 - Math.abs((hue / 60) % 2 - 1)), m = 0.2;
  const channels = hue < 60 ? [chroma, x, 0] : hue < 120 ? [x, chroma, 0] : hue < 180 ? [0, chroma, x] : hue < 240 ? [0, x, chroma] : hue < 300 ? [x, 0, chroma] : [chroma, 0, x];
  return { r: Math.round((channels[0] + m) * 255), g: Math.round((channels[1] + m) * 255), b: Math.round((channels[2] + m) * 255), a: 255 };
}

async function setObjectColour(entry, colour) {
  await API.viewer.setObjectState({ modelObjectIds: [{ modelId: entry.modelId, objectRuntimeIds: [entry.objectRuntimeId] }] }, { color: colour });
}

async function toggleColours(groupData, enabled) {
  const colors = state.coloredGroups[state.activeTab];
  try {
    if (enabled) {
      const assignments = groupData.entries.map((entry) => ({ ...entry, colour: randomColour() }));
      for (const assignment of assignments) await setObjectColour(assignment, assignment.colour);
      colors.set(groupData.group, assignments);
      setResult(`Coloured ${assignments.length} object(s) in "${groupData.group}".`, "ok");
    } else {
      for (const assignment of colors.get(groupData.group) || []) await setObjectColour(assignment, "reset");
      colors.delete(groupData.group);
      setResult(`Colours cleared for "${groupData.group}".`);
    }
    renderBrowser();
  } catch (error) { setResult("Couldn't update object colours.", "error"); log("Colour update failed", error.message); }
}

function closeColourPopover() {
  if (!activeColourPopover) return;
  activeColourPopover.remove(); activeColourPopover = null;
  document.removeEventListener("click", closeColourPopover, true);
}

function openColourPopover(anchor, groupData) {
  closeColourPopover();
  const popup = document.createElement("div"); popup.className = "colour-popover";
  const label = document.createElement("label"); label.textContent = "Colour group";
  const toggle = document.createElement("input"); toggle.type = "checkbox"; toggle.checked = state.coloredGroups[state.activeTab].has(groupData.group);
  toggle.addEventListener("click", (event) => event.stopPropagation());
  toggle.addEventListener("change", async () => { toggle.disabled = true; await toggleColours(groupData, toggle.checked); toggle.disabled = false; });
  label.append(toggle); popup.append(label); document.body.append(popup);
  const rect = anchor.getBoundingClientRect(); popup.style.top = `${rect.bottom + window.scrollY + 4}px`; popup.style.left = `${Math.max(8, rect.left + window.scrollX - 90)}px`;
  activeColourPopover = popup; setTimeout(() => document.addEventListener("click", closeColourPopover, true));
}

function clearPartialResults() { state.partialMatches = []; state.expandedPartialGroups.clear(); el("partialMatchResults").replaceChildren(); el("partialMatchResults").hidden = true; }

function buildPartialGroups(matches) {
  const values = new Map();
  for (const match of matches) {
    const key = `${match.property}\u0000${match.value}`;
    if (!values.has(key)) values.set(key, { property: match.property, value: match.value, entries: [] });
    const item = values.get(key);
    if (!item.entries.some((entry) => entry.modelId === match.modelId && entry.objectRuntimeId === match.objectRuntimeId)) item.entries.push(match);
  }
  const groups = new Map();
  for (const item of values.values()) { if (!groups.has(item.property)) groups.set(item.property, []); groups.get(item.property).push(item); }
  return [...groups].map(([group, items]) => ({ group, items: items.sort((a, b) => naturalCompare(a.value, b.value)) })).sort((a, b) => naturalCompare(a.group, b.group));
}

function renderPartialResults() {
  const container = el("partialMatchResults"); container.replaceChildren();
  const list = document.createElement("ul"); list.className = "partial-list";
  for (const groupData of buildPartialGroups(state.partialMatches)) {
    const open = state.expandedPartialGroups.has(groupData.group);
    const row = document.createElement("li"); row.className = "partial-group-row";
    const arrow = document.createElement("button"); arrow.className = `arrow ${open ? "open" : ""}`; arrow.textContent = "▶"; arrow.setAttribute("aria-label", "Expand results");
    arrow.addEventListener("click", () => { open ? state.expandedPartialGroups.delete(groupData.group) : state.expandedPartialGroups.add(groupData.group); renderPartialResults(); });
    const label = document.createElement("span"); label.className = "group-label"; label.textContent = groupData.group;
    const count = document.createElement("span"); count.className = "group-count"; count.textContent = groupData.items.length;
    row.append(arrow, label, count); list.append(row);
    if (!open) continue;
    const children = document.createElement("ul"); children.className = "group-children";
    for (const item of groupData.items) {
      const child = document.createElement("li"); child.className = "leaf-row"; child.textContent = item.value;
      if (item.entries.length > 1) { const duplicates = document.createElement("span"); duplicates.className = "dupe-badge"; duplicates.textContent = `${item.entries.length}×`; child.append(duplicates); }
      child.addEventListener("click", () => selectAndZoom(item.entries, `Zoomed to "${item.value}".`)); children.append(child);
    }
    list.append(children);
  }
  container.append(list); container.hidden = false;
}

async function searchLocator() {
  if (!API) return setResult("Still connecting to Trimble Connect — try again in a moment.", "error");
  const target = display(el("locatorInput").value);
  if (!target) return setResult("Type a drawing number, mark, SKU, or position first.", "error");
  const partial = document.querySelector('input[name="searchMode"]:checked')?.value === "partial";
  const button = el("findButton"); button.disabled = true; button.querySelector(".btn-label").textContent = "Searching…";
  clearPartialResults(); setResult();
  const found = [];
  try {
    for (const { modelId, objectRuntimeIds } of await getAllModelObjectIds()) {
      for (let index = 0; index < objectRuntimeIds.length; index += 200) {
        const objects = await API.viewer.getObjectProperties(modelId, objectRuntimeIds.slice(index, index + 200));
        for (const object of objects || []) {
          propertySets: for (const propertySet of object.properties || []) {
            for (const property of propertySet.properties || []) {
              const propertyValue = normalize(property.value);
              const matches = partial ? propertyValue.includes(normalize(target)) : propertyValue === normalize(target);
              if (matches) {
                found.push({ modelId, objectRuntimeId: object.id, property: property.name || "Other", value: display(property.value) });
                break propertySets;
              }
            }
          }
        }
      }
    }
    if (!found.length) return setResult(`Couldn't find anything matching "${target}".`, "error");
    if (partial) { state.partialMatches = found; renderPartialResults(); return setResult(`Found ${found.length} partial match${found.length === 1 ? "" : "es"}. Choose a value below to select and zoom.`, "ok"); }
    await selectAndZoom(found, found.length === 1 ? `Zoomed to "${target}".` : `Selected and zoomed to ${found.length} matching object(s).`);
  } catch (error) { setResult("Search failed. Check Advanced → Debug log.", "error"); log("Locator search failed", error.message); }
  finally { button.disabled = false; button.querySelector(".btn-label").textContent = "Find & Zoom"; }
}

function setDrawingNo(value, source) {
  el("drawingNoValue").textContent = value || "NOT RECEIVED";
  el("drawingNoSource").textContent = `Source: ${source}`;
  if (value && !el("locatorInput").value.trim()) el("locatorInput").value = value;
}

function detectDrawingNo() {
  const sources = [
    ["extension URL", window.location.href],
    ["document referrer", document.referrer]
  ];
  for (const [source, url] of sources) {
    try {
      const drawingNo = new URL(url).searchParams.get("drawingNo")?.trim();
      if (drawingNo) { setDrawingNo(drawingNo, source); return; }
    } catch { /* An unavailable or non-URL referrer is not an error. */ }
  }
  setDrawingNo("", "No drawing number found in accessible link sources");
}

async function runPendingBridgeSearch() {
  if (!API || !pendingBridgeDrawingNo || pendingBridgeDrawingNo === lastBridgeDrawingNo) return;
  const drawingNo = pendingBridgeDrawingNo; pendingBridgeDrawingNo = ""; lastBridgeDrawingNo = drawingNo;
  el("locatorInput").value = drawingNo; setDrawingNo(drawingNo, "4EST Drawing Locator Bridge"); await searchLocator();
}

window.addEventListener("message", (event) => {
  if (event.origin !== "https://web.connect.trimble.com") return;
  if (event.data?.type !== "4est-drawing-locator:open-drawing" || typeof event.data.drawingNo !== "string" || !event.data.drawingNo.trim()) return;
  pendingBridgeDrawingNo = event.data.drawingNo.trim(); runPendingBridgeSearch();
});

async function inspectSelection() {
  try {
    const selection = await API.viewer.getSelection();
    for (const model of selection || []) {
      const ids = (model.objectRuntimeIds || []).slice(0, 5);
      if (ids.length) log(`Properties for ${model.modelId}`, await API.viewer.getObjectProperties(model.modelId, ids));
    }
    setResult("Properties were added to the debug log.", "ok");
  } catch (error) { setResult("Couldn't read the selected part's properties.", "error"); log("Inspect selection failed", error.message); }
}

function setupUI() {
  document.querySelectorAll("[data-tab]").forEach((button) => button.addEventListener("click", () => {
    state.activeTab = button.dataset.tab;
    document.querySelectorAll("[data-tab]").forEach((tab) => tab.classList.toggle("active", tab === button));
    el("filterInput").value = ""; renderBrowser();
  }));
  el("filterInput").addEventListener("input", renderBrowser);
  el("refreshButton").addEventListener("click", refreshModel);
  el("findButton").addEventListener("click", searchLocator);
  el("locatorInput").addEventListener("keydown", (event) => { if (event.key === "Enter") searchLocator(); });
  el("inspectButton").addEventListener("click", inspectSelection);
}

async function connectToTrimble() {
  try {
    if (!window.TrimbleConnectWorkspace) throw new Error("Trimble Connect Workspace API did not load.");
    API = await TrimbleConnectWorkspace.connect(window.parent, (event, data) => {
      log(`Workspace event: ${event}`, data);
      if (event === "extension.command") {
        const match = String(typeof data === "string" ? data : JSON.stringify(data)).match(/drawingNo=([^&"'\s]+)/i);
        if (match?.[1]) { pendingBridgeDrawingNo = decodeURIComponent(match[1]); setDrawingNo(pendingBridgeDrawingNo, "extension command"); runPendingBridgeSearch(); }
      }
    });
    setConnectionBanner("Connected", "ok");
    try { el("projectInfo").textContent = JSON.stringify(await API.project.getProject(), null, 2); } catch (error) { log("Project read failed", error.message); }
    await refreshModel(); await runPendingBridgeSearch();
  } catch (error) { setConnectionBanner("Couldn't connect to Trimble Connect. Try refreshing the page.", "error"); log("Workspace connection failed", error.message); }
}

(async function main() { el("debugLog").textContent = "Starting 4EST Part, Assembly & Drawing Locator…"; setupUI(); detectDrawingNo(); await connectToTrimble(); })();
