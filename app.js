const PROPERTY_NAMES = {
  assembly: "Assembly/Cast unit mark",
  part: "Part Position"
};

const state = {
  activeTab: "assembly", // "assembly" | "part"
  assemblies: [],        // [{ value, entries: [{modelId, objectRuntimeId}] }] sorted
  parts: [],
  loaded: false,
  expandedGroups: { assembly: new Set(), part: new Set() }
};

let API = null;

function el(id) {
  return document.getElementById(id);
}

function log(label, data) {
  const box = el("debugLog");
  if (!box) return;
  const time = new Date().toLocaleTimeString();
  const line = data !== undefined
    ? `[${time}] ${label}\n${JSON.stringify(data, null, 2)}\n`
    : `[${time}] ${label}\n`;
  box.textContent = line + "\n" + box.textContent;
}

function setConnectionBanner(text, kind) {
  const banner = el("connectionBanner");
  if (!banner) return;
  banner.textContent = text;
  banner.className = "banner " + (kind === "ok" ? "ok" : kind === "error" ? "error" : "muted");
  if (kind === "ok") {
    setTimeout(() => {
      if (banner.textContent === "Connected") banner.classList.add("fade");
    }, 2000);
  }
}

function setResult(message, kind) {
  const status = el("zoomStatus");
  if (!status) return;
  status.textContent = message;
  status.className = "result " + (kind || "");
}

function normalizeValue(v) {
  return String(v === undefined || v === null ? "" : v).trim();
}

function naturalCompare(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

// Extracts a group prefix from a value so items can be nested under it.
// Handles two common naming styles:
//   "Rib01.01" / "Rib01-01" / "Rib01_01"  -> group "Rib01" (split before last separator)
//   "LGS001" / "ANGL045" (no separator)   -> group "LGS" / "ANGL" (leading letters)
// Falls back to using the whole value as its own group if neither pattern fits.
function getGroupKey(value) {
  const sepMatch = value.match(/^(.+)[._-][^._-]+$/);
  if (sepMatch) return sepMatch[1];

  const alphaMatch = value.match(/^([A-Za-z]+)/);
  if (alphaMatch && alphaMatch[1].length < value.length) return alphaMatch[1];

  return value;
}

// Groups a flat, already-sorted list of {value, entries} items into
// [{ group, items: [...], entries: <all entries combined> }], sorted.
function buildGroups(items) {
  const map = new Map();
  for (const item of items) {
    const key = getGroupKey(item.value);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }

  return Array.from(map.entries())
    .map(([group, groupItems]) => ({
      group,
      items: groupItems,
      entries: groupItems.flatMap(it => it.entries)
    }))
    .sort((a, b) => naturalCompare(a.group, b.group));
}

/* ---------- Object enumeration (same multi-strategy approach as the search tool) ---------- */

async function getAllModelObjectIds() {
  try {
    const objs = await API.viewer.getObjects();
    if (objs && objs.length && objs.some(o => (o.objectRuntimeIds || []).length)) {
      const result = objs.map(o => ({ modelId: o.modelId, objectRuntimeIds: o.objectRuntimeIds || [] }));
      log("Objects retrieved via unfiltered getObjects()", result.map(r => ({ modelId: r.modelId, count: r.objectRuntimeIds.length })));
      return result;
    }
  } catch (err) {
    log("getObjects() with no selector failed", err.message);
  }

  const models = await API.viewer.getModels();
  const result = [];
  for (const m of models) {
    try {
      const rootChildren = await API.viewer.getHierarchyChildren(m.id, [], undefined, true);
      const ids = (rootChildren || []).map(e => e.id).filter(id => id !== undefined && id !== null);
      if (ids.length) {
        result.push({ modelId: m.id, objectRuntimeIds: ids });
        log(`Got ${ids.length} object(s) for model ${m.id} via getHierarchyChildren`);
      }
    } catch (err) {
      log(`getHierarchyChildren failed for model ${m.id}`, err.message);
    }
  }
  if (result.length) return result;

  try {
    const selection = await API.viewer.getSelection();
    if (selection && selection.length && selection.some(s => (s.objectRuntimeIds || []).length)) {
      const fromSelection = selection.map(s => ({ modelId: s.modelId, objectRuntimeIds: s.objectRuntimeIds || [] }));
      log("Falling back to current viewer selection as the search scope", fromSelection.map(r => ({ modelId: r.modelId, count: r.objectRuntimeIds.length })));
      return fromSelection;
    }
  } catch (err) {
    log("Reading current selection failed", err.message);
  }

  return [];
}

/* ---------- Build the two lists by reading PART Position / Assembly position off every object ---------- */

async function buildLists() {
  el("loadingState").hidden = false;
  el("emptyState").hidden = true;
  setResult("");
  el("loadingText").textContent = "Reading model objects...";

  const modelObjectSets = await getAllModelObjectIds();
  const totalObjects = modelObjectSets.reduce((sum, s) => sum + s.objectRuntimeIds.length, 0);

  if (!totalObjects) {
    el("loadingState").hidden = true;
    el("emptyState").hidden = false;
    el("emptyState").textContent = "Couldn't read any objects from the model automatically. Try selecting the parts you want listed in the 3D Viewer, then click Refresh.";
    return;
  }

  const assemblyMap = new Map(); // value -> [{modelId, objectRuntimeId}]
  const partMap = new Map();

  const batchSize = 200;
  let checked = 0;

  for (const { modelId, objectRuntimeIds } of modelObjectSets) {
    for (let i = 0; i < objectRuntimeIds.length; i += batchSize) {
      const batch = objectRuntimeIds.slice(i, i + batchSize);
      let propsList;
      try {
        propsList = await API.viewer.getObjectProperties(modelId, batch);
      } catch (err) {
        log(`getObjectProperties failed for model ${modelId}, batch starting at ${i}`, err.message);
        continue;
      }

      for (const obj of propsList) {
        const sets = obj.properties || [];
        let assemblyVal = null;
        let partVal = null;

        for (const set of sets) {
          for (const p of set.properties || []) {
            if (!assemblyVal && p.name === PROPERTY_NAMES.assembly) assemblyVal = normalizeValue(p.value);
            if (!partVal && p.name === PROPERTY_NAMES.part) partVal = normalizeValue(p.value);
          }
        }

        if (assemblyVal) {
          if (!assemblyMap.has(assemblyVal)) assemblyMap.set(assemblyVal, []);
          assemblyMap.get(assemblyVal).push({ modelId, objectRuntimeId: obj.id });
        }
        if (partVal) {
          if (!partMap.has(partVal)) partMap.set(partVal, []);
          partMap.get(partVal).push({ modelId, objectRuntimeId: obj.id });
        }
      }

      checked += batch.length;
      el("loadingText").textContent = `Reading model objects... (${checked}/${totalObjects})`;
    }
  }

  state.assemblies = Array.from(assemblyMap.entries())
    .map(([value, entries]) => ({ value, entries }))
    .sort((a, b) => naturalCompare(a.value, b.value));

  state.parts = Array.from(partMap.entries())
    .map(([value, entries]) => ({ value, entries }))
    .sort((a, b) => naturalCompare(a.value, b.value));

  state.loaded = true;
  log(`Lists built. Checked ${checked} object(s). ${state.assemblies.length} assembly value(s), ${state.parts.length} part value(s).`);

  el("loadingState").hidden = true;
  renderActiveList();
}

/* ---------- Rendering (collapsible group tree) ---------- */

function renderActiveList() {
  const items = state.activeTab === "assembly" ? state.assemblies : state.parts;
  const listEl = state.activeTab === "assembly" ? el("assemblyList") : el("partList");
  const filter = el("filterInput").value.trim().toLowerCase();
  const expanded = state.expandedGroups[state.activeTab];

  const filtered = filter
    ? items.filter(it => it.value.toLowerCase().includes(filter))
    : items;

  listEl.innerHTML = "";

  if (!filtered.length) {
    el("emptyState").hidden = false;
    el("emptyState").textContent = items.length
      ? "No matches for that filter."
      : `No ${state.activeTab === "assembly" ? "Assembly/Cast unit position" : "PART Position"} values found in this model.`;
    el("assemblyCount").textContent = state.assemblies.length ? `(${state.assemblies.length})` : "";
    el("partCount").textContent = state.parts.length ? `(${state.parts.length})` : "";
    return;
  }
  el("emptyState").hidden = true;

  const groups = buildGroups(filtered);
  // While actively filtering, auto-expand every group that has a match so
  // results are visible without needing a manual click.
  const forceExpand = Boolean(filter);

  for (const groupData of groups) {
    const isExpanded = forceExpand || expanded.has(groupData.group);

    const groupLi = document.createElement("li");
    groupLi.className = "group-row";

    const arrow = document.createElement("span");
    arrow.className = "arrow" + (isExpanded ? " open" : "");
    arrow.textContent = "\u25b6";
    groupLi.appendChild(arrow);

    const label = document.createElement("span");
    label.className = "group-label";
    label.textContent = groupData.group;
    groupLi.appendChild(label);

    const countBadge = document.createElement("span");
    countBadge.className = "group-count";
    countBadge.textContent = groupData.items.length;
    groupLi.appendChild(countBadge);

    // Clicking the arrow toggles expand/collapse only.
    arrow.addEventListener("click", (e) => {
      e.stopPropagation();
      if (expanded.has(groupData.group)) {
        expanded.delete(groupData.group);
      } else {
        expanded.add(groupData.group);
      }
      renderActiveList();
    });

    // Clicking the group name/row selects & zooms to every item in the group.
    groupLi.addEventListener("click", () => selectAndZoomGroup(groupData));

    listEl.appendChild(groupLi);

    if (isExpanded) {
      const childList = document.createElement("ul");
      childList.className = "group-children";

      for (const item of groupData.items) {
        const li = document.createElement("li");
        li.className = "leaf-row";

        const leafLabel = document.createElement("span");
        leafLabel.textContent = item.value;
        li.appendChild(leafLabel);

        if (item.entries.length > 1) {
          const badge = document.createElement("span");
          badge.className = "dupe-badge";
          badge.textContent = `${item.entries.length}\u00d7`;
          li.appendChild(badge);
        }

        li.addEventListener("click", (e) => {
          e.stopPropagation();
          selectAndZoom(item);
        });
        childList.appendChild(li);
      }

      listEl.appendChild(childList);
    }
  }

  el("assemblyCount").textContent = state.assemblies.length ? `(${state.assemblies.length})` : "";
  el("partCount").textContent = state.parts.length ? `(${state.parts.length})` : "";
}

function clearSelectionHighlight() {
  document.querySelectorAll(".list li").forEach(li => li.classList.remove("selected"));
}

async function applySelector(entries, resultLabel) {
  const byModel = new Map();
  for (const e of entries) {
    if (!byModel.has(e.modelId)) byModel.set(e.modelId, []);
    byModel.get(e.modelId).push(e.objectRuntimeId);
  }
  const selector = {
    modelObjectIds: Array.from(byModel.entries()).map(([modelId, objectRuntimeIds]) => ({ modelId, objectRuntimeIds }))
  };

  try {
    await API.viewer.setSelection(selector, "set");
    await API.viewer.setCamera(selector, { animationTime: 800 });
    return true;
  } catch (err) {
    setResult("Found it, but couldn't select/zoom. Try again.", "error");
    log("setSelection/setCamera failed", err.message);
    return false;
  }
}

async function selectAndZoom(item) {
  clearSelectionHighlight();
  const ok = await applySelector(item.entries);
  if (!ok) return;

  if (item.entries.length > 1) {
    setResult(`\u26a0\ufe0f "${item.value}" appears on ${item.entries.length} objects \u2014 selected and zoomed to fit all of them.`, "warn");
  } else {
    setResult(`\u2705 Zoomed to "${item.value}".`, "ok");
  }
  log("Selection + zoom applied", { value: item.value, count: item.entries.length });
}

async function selectAndZoomGroup(groupData) {
  clearSelectionHighlight();
  const ok = await applySelector(groupData.entries);
  if (!ok) return;

  setResult(`\u2705 Selected and zoomed to all ${groupData.items.length} item(s) in "${groupData.group}" (${groupData.entries.length} object(s) total).`, "ok");
  log("Group selection + zoom applied", { group: groupData.group, itemCount: groupData.items.length, objectCount: groupData.entries.length });
}

/* ---------- Tabs / filter / refresh ---------- */

function setActiveTab(tab) {
  state.activeTab = tab;
  el("tabAssemblies").classList.toggle("active", tab === "assembly");
  el("tabParts").classList.toggle("active", tab === "part");
  el("assemblyList").hidden = tab !== "assembly";
  el("partList").hidden = tab !== "part";
  el("filterInput").value = "";
  renderActiveList();
}

function setupUI() {
  el("tabAssemblies").addEventListener("click", () => setActiveTab("assembly"));
  el("tabParts").addEventListener("click", () => setActiveTab("part"));
  el("filterInput").addEventListener("input", renderActiveList);
  el("refreshButton").addEventListener("click", () => {
    if (!API) {
      setResult("Still connecting \u2014 try again in a moment.", "error");
      return;
    }
    buildLists();
  });
}

/* ---------- Connection ---------- */

async function connectToTrimble() {
  try {
    if (!window.TrimbleConnectWorkspace) {
      setConnectionBanner("Couldn't load the Trimble connection. Try refreshing the page.", "error");
      log("TrimbleConnectWorkspace object missing.");
      return;
    }

    API = await TrimbleConnectWorkspace.connect(window.parent, (event, data) => {
      log("Workspace event: " + event, data);
    });

    setConnectionBanner("Connected", "ok");
    log("Connected to Workspace API.");

    try {
      const project = await API.project.getProject();
      el("projectInfo").textContent = JSON.stringify(project, null, 2);
      log("Project loaded", project);
    } catch (projectErr) {
      el("projectInfo").textContent = "Could not read project yet: " + projectErr.message;
      log("Project read failed", projectErr.message);
    }

    await buildLists();
  } catch (err) {
    setConnectionBanner("Couldn't connect to Trimble Connect. Try refreshing the page.", "error");
    log("Workspace API connection failed", err.message);
  }
}

(async function main() {
  el("debugLog").textContent = "Starting 4EST Part & Assembly Browser...";
  setupUI();
  await connectToTrimble();
})();
