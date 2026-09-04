const PROPERTY_NAMES = {
  assembly: "Assembly/Cast unit Mark",
  part: "Part Position",
  uniqueId: "Unique ID"
};

let API = null;
let pendingBridgeDrawingNo = "";
let lastBridgeDrawingNo = "";
let activeColourPopover = null;
const MAX_TAGS_PER_RUN = 100;

const state = {
  activeTab: "assembly",
  assemblies: [],
  parts: [],
  uniqueIds: [],
  modelObjects: [],
  partialMatches: [],
  tagMarkupIds: [],
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

function visibleBrowserItems() {
  const filter = normalize(el("filterInput").value);
  const items = currentItems();
  return filter ? items.filter((item) => normalize(item.value).includes(filter)) : items;
}

function currentBrowserLabel() {
  return state.activeTab === "assembly" ? "Assembly" : state.activeTab === "part" ? "Part" : "Unique ID";
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
  const items = currentItems();
  const filter = normalize(el("filterInput").value);
  const filtered = visibleBrowserItems();
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
    const colour = document.createElement("button"); colour.className = "colour-btn"; colour.textContent = "🎨"; colour.type = "button"; colour.title = "Colour"; colour.setAttribute("aria-label", "Colour");
    if (state.coloredGroups[state.activeTab].has(groupData.group)) colour.classList.add("active");
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

function hslToRgb(h, s, l) {
  s /= 100;
  l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

function randomAssemblyColor() {
  const hue = Math.floor(Math.random() * 360);
  const saturation = 55 + Math.random() * 30;
  const lightness = 42 + Math.random() * 16;
  const [r, g, b] = hslToRgb(hue, saturation, lightness);
  return { r, g, b, a: 255 };
}

async function setEntryColor(entry, color) {
  try {
    await API.viewer.setObjectState(
      { modelObjectIds: [{ modelId: entry.modelId, objectRuntimeIds: [entry.objectRuntimeId] }] },
      { color }
    );
    return true;
  } catch (err) {
    log(`setObjectState (colour) failed for ${entry.modelId}/${entry.objectRuntimeId}`, err.message);
    return false;
  }
}

async function applyGroupColours(groupData) {
  const assignments = groupData.entries.map((entry) => ({
    modelId: entry.modelId,
    objectRuntimeId: entry.objectRuntimeId,
    color: randomAssemblyColor()
  }));
  for (const assignment of assignments) await setEntryColor(assignment, assignment.color);
  state.coloredGroups[state.activeTab].set(groupData.group, assignments);
  log(`Applied random colours to "${groupData.group}"`, { assembliesColored: assignments.length });
}

async function clearGroupColours(groupName) {
  const assignments = state.coloredGroups[state.activeTab].get(groupName);
  if (!assignments) return;
  for (const assignment of assignments) await setEntryColor(assignment, "reset");
  state.coloredGroups[state.activeTab].delete(groupName);
  log(`Cleared colours for "${groupName}"`);
}

async function toggleGroupColour(groupData, on) {
  if (on) {
    setResult(`Applying random colours to "${groupData.group}"...`);
    await applyGroupColours(groupData);
    setResult(`Coloured ${groupData.entries.length} assembly(ies) in "${groupData.group}".`, "ok");
  } else {
    await clearGroupColours(groupData.group);
    setResult(`Colours cleared for "${groupData.group}".`);
  }
}

function closeColourPopover() {
  if (!activeColourPopover) return;
  activeColourPopover.remove(); activeColourPopover = null;
  document.removeEventListener("click", handleOutsideColourClick, true);
}

function handleOutsideColourClick(event) {
  if (activeColourPopover && !activeColourPopover.contains(event.target)) {
    closeColourPopover();
  }
}

function openColourPopover(anchor, groupData) {
  closeColourPopover();
  const popup = document.createElement("div"); popup.className = "colour-popover";
  const title = document.createElement("div"); title.className = "colour-popover-title"; title.textContent = "Colour";
  const switchLabel = document.createElement("label"); switchLabel.className = "switch";
  const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.checked = state.coloredGroups[state.activeTab].has(groupData.group);
  const slider = document.createElement("span"); slider.className = "slider";
  switchLabel.append(checkbox, slider); popup.append(title, switchLabel);
  checkbox.addEventListener("click", (event) => event.stopPropagation());
  checkbox.addEventListener("change", async () => { checkbox.disabled = true; await toggleGroupColour(groupData, checkbox.checked); checkbox.disabled = false; });
  document.body.append(popup);
  const rect = anchor.getBoundingClientRect();
  popup.style.top = `${rect.bottom + window.scrollY + 4}px`;
  popup.style.left = `${Math.max(8, Math.min(rect.left + window.scrollX, window.innerWidth - popup.offsetWidth - 12))}px`;
  activeColourPopover = popup;
  setTimeout(() => document.addEventListener("click", handleOutsideColourClick, true));
}

function makeMarkupPick(x, y, z, modelId, objectRuntimeId) {
  const pick = {
    type: "point",
    positionX: x,
    positionY: y,
    positionZ: z
  };
  if (modelId && Number.isFinite(objectRuntimeId)) {
    pick.modelId = modelId;
    pick.objectId = objectRuntimeId;
  }
  return pick;
}

function textMarkupForBox(modelId, objectRuntimeId, text, box) {
  const min = box.min;
  const max = box.max;
  const centerX = (min.x + max.x) / 2;
  const centerY = (min.y + max.y) / 2;
  const topZ = max.z;
  const leaderLength = Math.max((max.z - min.z) * 0.65, 300);

  return {
    text,
    color: { r: 37, g: 99, b: 235, a: 255 },
    // The leader starts on the model object. Its label endpoint is deliberately
    // free in model space so Trimble renders the text next to, not inside, it.
    start: makeMarkupPick(centerX, centerY, topZ, modelId, objectRuntimeId),
    end: makeMarkupPick(centerX, centerY, topZ + leaderLength)
  };
}

async function getTagMarkups(items) {
  const byModel = new Map();
  const seen = new Set();
  let totalCandidates = 0;

  for (const item of items) {
    for (const entry of item.entries) {
      const key = `${entry.modelId}\u0000${entry.objectRuntimeId}\u0000${item.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      totalCandidates += 1;
      if (totalCandidates > MAX_TAGS_PER_RUN) continue;
      if (!byModel.has(entry.modelId)) byModel.set(entry.modelId, []);
      byModel.get(entry.modelId).push({ objectRuntimeId: entry.objectRuntimeId, text: item.value });
    }
  }

  const markups = [];
  for (const [modelId, entries] of byModel) {
    for (let index = 0; index < entries.length; index += 200) {
      const batch = entries.slice(index, index + 200);
      const boxes = await API.viewer.getObjectBoundingBoxes(
        modelId,
        batch.map((entry) => entry.objectRuntimeId)
      );
      const boxesById = new Map((boxes || []).map((item) => [item.id, item.boundingBox]));

      for (const entry of batch) {
        const box = boxesById.get(entry.objectRuntimeId);
        if (box?.min && box?.max) {
          markups.push(textMarkupForBox(modelId, entry.objectRuntimeId, entry.text, box));
        } else {
          log("No bounding box available for tag", { modelId, objectRuntimeId: entry.objectRuntimeId, text: entry.text });
        }
      }
    }
  }
  return { markups, skipped: Math.max(0, totalCandidates - MAX_TAGS_PER_RUN) };
}

async function clearBrowserTags() {
  if (!state.tagMarkupIds.length) return;
  await API.markup.removeMarkups(state.tagMarkupIds);
  state.tagMarkupIds = [];
}

async function tagCurrentList() {
  if (!API?.markup?.addTextMarkup) {
    setResult("Text markups are unavailable in this Trimble Connect session.", "error");
    return;
  }

  const items = visibleBrowserItems();
  if (!items.length) {
    setResult("There are no visible values to tag.", "error");
    return;
  }

  const button = el("tagButton");
  button.disabled = true;
  button.textContent = "Tagging…";
  setResult(`Preparing ${currentBrowserLabel()} tags…`);

  try {
    await clearBrowserTags();
    const { markups, skipped } = await getTagMarkups(items);
    if (!markups.length) {
      setResult("No tag positions could be created from the current model objects.", "error");
      return;
    }

    const added = [];
    for (let index = 0; index < markups.length; index += 20) {
      added.push(...await API.markup.addTextMarkup(markups.slice(index, index + 20)));
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    state.tagMarkupIds = added.map((markup) => markup.id).filter(Number.isFinite);
    setResult(
      skipped
        ? `Added ${added.length} tags. ${skipped} more are not tagged yet — filter the list and tag the next set.`
        : `Added ${added.length} ${currentBrowserLabel().toLowerCase()} tag${added.length === 1 ? "" : "s"}.`,
      "ok"
    );
    log("Browser tags added", { tab: state.activeTab, requested: items.length, markups: added.length, skipped });
  } catch (error) {
    setResult("Couldn't add the current-list tags. Check Advanced → Debug log.", "error");
    log("Browser tagging failed", error.message);
  } finally {
    button.disabled = false;
    button.textContent = "Tag current list";
  }
}

async function deleteAllMarkups() {
  if (!API?.markup?.removeMarkups) {
    setResult("Markup deletion is unavailable in this Trimble Connect session.", "error");
    return;
  }

  const button = el("deleteMarkupsButton");
  button.disabled = true;
  button.textContent = "Deleting…";
  try {
    await API.markup.removeMarkups(undefined);
    state.tagMarkupIds = [];
    setResult("Deleted all markups from the 3D viewer.", "ok");
    log("All viewer markups deleted.");
  } catch (error) {
    setResult("Couldn't delete the viewer markups. Check Advanced → Debug log.", "error");
    log("Delete all markups failed", error.message);
  } finally {
    button.disabled = false;
    button.textContent = "Delete all markups";
  }
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
  el("tagButton").addEventListener("click", tagCurrentList);
  el("deleteMarkupsButton").addEventListener("click", deleteAllMarkups);
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
