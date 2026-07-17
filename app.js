const PROPERTY_NAMES = {
  assembly: "Assembly/Cast unit position",
  part: "PART Position"
};

const state = {
  activeTab: "assembly", // "assembly" | "part"
  assemblies: [],        // [{ value, entries: [{modelId, objectRuntimeId}] }] sorted
  parts: [],
  loaded: false
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

/* ---------- Rendering ---------- */

function renderActiveList() {
  const items = state.activeTab === "assembly" ? state.assemblies : state.parts;
  const listEl = state.activeTab === "assembly" ? el("assemblyList") : el("partList");
  const filter = el("filterInput").value.trim().toLowerCase();

  const filtered = filter
    ? items.filter(it => it.value.toLowerCase().includes(filter))
    : items;

  listEl.innerHTML = "";

  if (!filtered.length) {
    el("emptyState").hidden = false;
    el("emptyState").textContent = items.length
      ? "No matches for that filter."
      : `No ${state.activeTab === "assembly" ? "Assembly/Cast unit position" : "PART Position"} values found in this model.`;
    return;
  }
  el("emptyState").hidden = true;

  for (const item of filtered) {
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = item.value;
    li.appendChild(label);

    if (item.entries.length > 1) {
      const badge = document.createElement("span");
      badge.className = "dupe-badge";
      badge.textContent = `${item.entries.length}\u00d7`;
      li.appendChild(badge);
    }

    li.addEventListener("click", () => selectAndZoom(item));
    listEl.appendChild(li);
  }

  el("assemblyCount").textContent = state.assemblies.length ? `(${state.assemblies.length})` : "";
  el("partCount").textContent = state.parts.length ? `(${state.parts.length})` : "";
}

async function selectAndZoom(item) {
  document.querySelectorAll(".list li").forEach(li => li.classList.remove("selected"));

  const byModel = new Map();
  for (const e of item.entries) {
    if (!byModel.has(e.modelId)) byModel.set(e.modelId, []);
    byModel.get(e.modelId).push(e.objectRuntimeId);
  }
  const selector = {
    modelObjectIds: Array.from(byModel.entries()).map(([modelId, objectRuntimeIds]) => ({ modelId, objectRuntimeIds }))
  };

  try {
    await API.viewer.setSelection(selector, "set");
    await API.viewer.setCamera(selector, { animationTime: 800 });

    if (item.entries.length > 1) {
      setResult(`\u26a0\ufe0f "${item.value}" appears on ${item.entries.length} objects \u2014 selected and zoomed to fit all of them.`, "warn");
    } else {
      setResult(`\u2705 Zoomed to "${item.value}".`, "ok");
    }
    log("Selection + zoom applied", { value: item.value, count: item.entries.length });
  } catch (err) {
    setResult("Found it, but couldn't select/zoom. Try again.", "error");
    log("setSelection/setCamera failed", err.message);
  }
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
