const PROPERTY_NAMES = {
  assembly: "Assembly/Cast unit Mark",
  part: "Part Position",
  uniqueId: "Unique ID"
};

const state = {
  activeTab: "assembly",
  assemblies: [],
  parts: [],
  uniqueIds: [],
  loaded: false,
  expandedGroups: {
    assembly: new Set(),
    part: new Set(),
    uniqueId: new Set()
  },
  // Per-tab, per-group-name -> array of {modelId, objectRuntimeId, color}
  // currently applied. Used to know toggle state and to revert on turn-off.
  coloredGroups: {
    assembly: new Map(),
    part: new Map(),
    uniqueId: new Map()
  }
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
  banner.className = "banner " + (
    kind === "ok" ? "ok" :
    kind === "error" ? "error" :
    "muted"
  );

  if (kind === "ok") {
    setTimeout(() => {
      if (banner.textContent === "Connected") {
        banner.classList.add("fade");
      }
    }, 2000);
  }
}

function setResult(message, kind) {
  const status = el("zoomStatus");
  if (!status) return;

  status.textContent = message;
  status.className = "result " + (kind || "");
}

function normalizeValue(value) {
  return String(value === undefined || value === null ? "" : value).trim();
}

function naturalCompare(a, b) {
  return a.localeCompare(b, undefined, {
    numeric: true,
    sensitivity: "base"
  });
}

function getGroupKey(value) {
  const separatorMatch = value.match(/^(.+)[._-][^._-]+$/);
  if (separatorMatch) return separatorMatch[1];

  const alphaMatch = value.match(/^([A-Za-z]+)/);
  if (alphaMatch && alphaMatch[1].length < value.length) {
    return alphaMatch[1];
  }

  return value;
}

function buildGroups(items) {
  const map = new Map();

  for (const item of items) {
    const key = getGroupKey(item.value);

    if (!map.has(key)) {
      map.set(key, []);
    }

    map.get(key).push(item);
  }

  return Array.from(map.entries())
    .map(([group, groupItems]) => ({
      group,
      items: groupItems,
      entries: groupItems.flatMap((item) => item.entries)
    }))
    .sort((a, b) => naturalCompare(a.group, b.group));
}

/* ---------- Random per-assembly colouring ---------- */

function hslToRgb(h, s, l) {
  s /= 100;
  l /= 100;

  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) =>
    l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));

  return [
    Math.round(f(0) * 255),
    Math.round(f(8) * 255),
    Math.round(f(4) * 255)
  ];
}

function randomAssemblyColor() {
  const hue = Math.floor(Math.random() * 360);
  const saturation = 55 + Math.random() * 30; // 55-85%
  const lightness = 42 + Math.random() * 16; // 42-58%
  const [r, g, b] = hslToRgb(hue, saturation, lightness);

  return { r, g, b, a: 255 };
}

async function setEntryColor(entry, color) {
  try {
    await API.viewer.setObjectState(
      {
        modelObjectIds: [
          {
            modelId: entry.modelId,
            objectRuntimeIds: [entry.objectRuntimeId]
          }
        ]
      },
      { color }
    );
    return true;
  } catch (err) {
    log(
      `setObjectState (colour) failed for ${entry.modelId}/${entry.objectRuntimeId}`,
      err.message
    );
    return false;
  }
}

async function applyGroupColours(groupData) {
  // Each entry is one physical assembly instance (confirmed: normal,
  // non-duplicated assemblies list as exactly 1 entry - multi-part
  // assemblies are never exploded here). So one random colour per entry
  // gives every assembly in the dropdown its own colour, and duplicate
  // marks like "MRB01.03 (2x)" still get two different colours from
  // each other - all from the single click near MRB01.
  const assignments = groupData.entries.map((entry) => ({
    modelId: entry.modelId,
    objectRuntimeId: entry.objectRuntimeId,
    color: randomAssemblyColor()
  }));

  for (const assignment of assignments) {
    await setEntryColor(assignment, assignment.color);
  }

  state.coloredGroups[state.activeTab].set(groupData.group, assignments);

  log(`Applied random colours to "${groupData.group}"`, {
    assembliesColored: assignments.length
  });
}

async function clearGroupColours(groupName) {
  const assignments = state.coloredGroups[state.activeTab].get(groupName);
  if (!assignments) return;

  for (const assignment of assignments) {
    await setEntryColor(assignment, "reset");
  }

  state.coloredGroups[state.activeTab].delete(groupName);

  log(`Cleared colours for "${groupName}"`);
}

async function toggleGroupColour(groupData, on) {
  if (on) {
    setResult(`Applying random colours to "${groupData.group}"...`, "");
    await applyGroupColours(groupData);

    setResult(
      `✅ Coloured ${groupData.entries.length} assembly(ies) in "${groupData.group}".`,
      "ok"
    );
  } else {
    await clearGroupColours(groupData.group);
    setResult(`Colours cleared for "${groupData.group}".`, "");
  }
}

/* ---------- Colour popover ---------- */

let activeColourPopover = null;

function handleOutsideColourClick(event) {
  if (activeColourPopover && !activeColourPopover.contains(event.target)) {
    closeColourPopover();
  }
}

function closeColourPopover() {
  if (!activeColourPopover) return;

  activeColourPopover.remove();
  activeColourPopover = null;
  document.removeEventListener("click", handleOutsideColourClick, true);
}

function openColourPopover(anchorEl, groupData) {
  closeColourPopover();

  const popover = document.createElement("div");
  popover.className = "colour-popover";

  const title = document.createElement("div");
  title.className = "colour-popover-title";
  title.textContent = "Colour";
  popover.appendChild(title);

  const switchLabel = document.createElement("label");
  switchLabel.className = "switch";

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = state.coloredGroups[state.activeTab].has(
    groupData.group
  );

  const slider = document.createElement("span");
  slider.className = "slider";

  switchLabel.appendChild(checkbox);
  switchLabel.appendChild(slider);
  popover.appendChild(switchLabel);

  checkbox.addEventListener("click", (event) => {
    event.stopPropagation();
  });

  checkbox.addEventListener("change", async () => {
    checkbox.disabled = true;
    await toggleGroupColour(groupData, checkbox.checked);
    checkbox.disabled = false;
  });

  document.body.appendChild(popover);

  const rect = anchorEl.getBoundingClientRect();
  const top = rect.bottom + window.scrollY + 4;
  const left = Math.max(
    8,
    Math.min(
      rect.left + window.scrollX,
      window.innerWidth - popover.offsetWidth - 12
    )
  );

  popover.style.top = `${top}px`;
  popover.style.left = `${left}px`;

  activeColourPopover = popover;

  setTimeout(() => {
    document.addEventListener("click", handleOutsideColourClick, true);
  }, 0);
}

/* ---------- Full-model object enumeration ---------- */

async function getAllModelObjectIds() {
  function flattenRuntimeIds(objects) {
    if (!Array.isArray(objects)) return [];

    return objects.flatMap((item) => {
      if (typeof item === "number") return [item];
      if (!item || typeof item !== "object") return [];

      return [
        item.runtimeId,
        item.id,
        ...flattenRuntimeIds(item.children || [])
      ];
    });
  }

  function uniqueRuntimeIds(values) {
    return [
      ...new Set(
        values
          .map(Number)
          .filter((id) => Number.isFinite(id))
      )
    ];
  }

  // Full loaded model. {} explicitly means no selection filter.
  try {
    const modelObjects = await API.viewer.getObjects({});

    const fullModelResult = (modelObjects || [])
      .map((model) => ({
        modelId: model.modelId,
        objectRuntimeIds: uniqueRuntimeIds([
          ...(model.objectRuntimeIds || []),
          ...flattenRuntimeIds(model.objects || [])
        ])
      }))
      .filter((model) =>
        model.modelId &&
        model.objectRuntimeIds.length > 0
      );

    log(
      "Full-model getObjects({}) result",
      fullModelResult.map((model) => ({
        modelId: model.modelId,
        count: model.objectRuntimeIds.length
      }))
    );

    if (fullModelResult.length) {
      return fullModelResult;
    }
  } catch (err) {
    log("Full-model getObjects({}) failed", err.message);
  }

  // Full-model hierarchy fallback.
  try {
    const models = await API.viewer.getModels();
    const hierarchyResult = [];

    for (const model of models || []) {
      try {
        const hierarchy = await API.viewer.getHierarchyChildren(
          model.id,
          [],
          undefined,
          true
        );

        const ids = uniqueRuntimeIds(
          flattenRuntimeIds(hierarchy || [])
        );

        if (ids.length) {
          hierarchyResult.push({
            modelId: model.id,
            objectRuntimeIds: ids
          });

          log(`Hierarchy retrieved for ${model.name || model.id}`, {
            modelId: model.id,
            count: ids.length
          });
        }
      } catch (err) {
        log(
          `Hierarchy read failed for ${model.id}`,
          err.message
        );
      }
    }

    if (hierarchyResult.length) {
      return hierarchyResult;
    }
  } catch (err) {
    log("getModels() failed", err.message);
  }

  // Selection is used only if full-model enumeration is unavailable.
  try {
    const selection = await API.viewer.getSelection();

    const selectedResult = (selection || [])
      .map((model) => ({
        modelId: model.modelId,
        objectRuntimeIds: uniqueRuntimeIds(
          model.objectRuntimeIds || []
        )
      }))
      .filter((model) =>
        model.modelId &&
        model.objectRuntimeIds.length > 0
      );

    if (selectedResult.length) {
      log(
        "Using selected objects only as fallback",
        selectedResult
      );
      return selectedResult;
    }
  } catch (err) {
    log("getSelection() fallback failed", err.message);
  }

  return [];
}

/* ---------- Build lists ---------- */

async function buildLists() {
  el("loadingState").hidden = false;
  el("emptyState").hidden = true;
  setResult("");
  el("loadingText").textContent = "Reading complete model...";

  const modelObjectSets = await getAllModelObjectIds();

  const totalObjects = modelObjectSets.reduce(
    (sum, set) => sum + set.objectRuntimeIds.length,
    0
  );

  if (!totalObjects) {
    el("loadingState").hidden = true;
    el("emptyState").hidden = false;
    el("emptyState").textContent =
      "Couldn't read any objects from the complete model. " +
      "Open Advanced → Debug log and check the full-model refresh result.";
    return;
  }

  const assemblyMap = new Map();
  const partMap = new Map();
  const uniqueIdMap = new Map();

  const batchSize = 200;
  let checked = 0;

  for (const { modelId, objectRuntimeIds } of modelObjectSets) {
    for (let index = 0; index < objectRuntimeIds.length; index += batchSize) {
      const batch = objectRuntimeIds.slice(index, index + batchSize);
      let propsList;

      try {
        propsList = await API.viewer.getObjectProperties(modelId, batch);
      } catch (err) {
        log(
          `getObjectProperties failed for ${modelId}, batch ${index}`,
          err.message
        );
        continue;
      }

      for (const object of propsList || []) {
        const sets = object.properties || [];
        let assemblyValue = null;
        let partValue = null;
        let uniqueIdValue = null;

        for (const set of sets) {
          for (const property of set.properties || []) {
            if (
              !assemblyValue &&
              property.name === PROPERTY_NAMES.assembly
            ) {
              assemblyValue = normalizeValue(property.value);
            }

            if (
              !partValue &&
              property.name === PROPERTY_NAMES.part
            ) {
              partValue = normalizeValue(property.value);
            }

            if (
              !uniqueIdValue &&
              property.name === PROPERTY_NAMES.uniqueId
            ) {
              uniqueIdValue = normalizeValue(property.value);
            }
          }
        }

        if (assemblyValue) {
          if (!assemblyMap.has(assemblyValue)) {
            assemblyMap.set(assemblyValue, []);
          }

          assemblyMap.get(assemblyValue).push({
            modelId,
            objectRuntimeId: object.id
          });
        }

        if (partValue) {
          if (!partMap.has(partValue)) {
            partMap.set(partValue, []);
          }

          partMap.get(partValue).push({
            modelId,
            objectRuntimeId: object.id
          });
        }

        if (uniqueIdValue) {
          if (!uniqueIdMap.has(uniqueIdValue)) {
            uniqueIdMap.set(uniqueIdValue, []);
          }

          uniqueIdMap.get(uniqueIdValue).push({
            modelId,
            objectRuntimeId: object.id
          });
        }
      }

      checked += batch.length;
      el("loadingText").textContent =
        `Reading complete model... (${checked}/${totalObjects})`;
    }
  }

  state.assemblies = Array.from(assemblyMap.entries())
    .map(([value, entries]) => ({ value, entries }))
    .sort((a, b) => naturalCompare(a.value, b.value));

  state.parts = Array.from(partMap.entries())
    .map(([value, entries]) => ({ value, entries }))
    .sort((a, b) => naturalCompare(a.value, b.value));

  state.uniqueIds = Array.from(uniqueIdMap.entries())
    .map(([value, entries]) => ({ value, entries }))
    .sort((a, b) => naturalCompare(a.value, b.value));

  state.loaded = true;

  log(
    `Lists built. Checked ${checked} object(s).`,
    {
      assemblies: state.assemblies.length,
      parts: state.parts.length,
      uniqueIds: state.uniqueIds.length
    }
  );

  el("loadingState").hidden = true;
  renderActiveList();
}

/* ---------- Rendering ---------- */

function renderActiveList() {
  closeColourPopover();

  const items =
    state.activeTab === "assembly" ? state.assemblies :
    state.activeTab === "part" ? state.parts :
    state.uniqueIds;

  const listElement =
    state.activeTab === "assembly" ? el("assemblyList") :
    state.activeTab === "part" ? el("partList") :
    el("uniqueIdList");

  const filter = el("filterInput").value.trim().toLowerCase();
  const expanded = state.expandedGroups[state.activeTab];

  const filtered = filter
    ? items.filter((item) => item.value.toLowerCase().includes(filter))
    : items;

  listElement.innerHTML = "";

  if (!filtered.length) {
    el("emptyState").hidden = false;

    el("emptyState").textContent = items.length
      ? "No matches for that filter."
      : `No ${
          state.activeTab === "assembly"
            ? "Assembly/Cast unit position"
            : state.activeTab === "part"
              ? "PART Position"
              : "Unique ID"
        } values found in this model.`;

    el("assemblyCount").textContent = state.assemblies.length
      ? `(${state.assemblies.length})`
      : "";

    el("partCount").textContent = state.parts.length
      ? `(${state.parts.length})`
      : "";

    el("uniqueIdCount").textContent = state.uniqueIds.length
      ? `(${state.uniqueIds.length})`
      : "";

    return;
  }

  el("emptyState").hidden = true;

  const groups = buildGroups(filtered);
  const forceExpand = Boolean(filter);

  for (const groupData of groups) {
    const isExpanded =
      forceExpand || expanded.has(groupData.group);

    const groupItem = document.createElement("li");
    groupItem.className = "group-row";

    const arrow = document.createElement("span");
    arrow.className = "arrow" + (isExpanded ? " open" : "");
    arrow.textContent = "▶";
    groupItem.appendChild(arrow);

    const label = document.createElement("span");
    label.className = "group-label";
    label.textContent = groupData.group;
    groupItem.appendChild(label);

    const countBadge = document.createElement("span");
    countBadge.className = "group-count";
    countBadge.textContent = groupData.items.length;
    groupItem.appendChild(countBadge);

    const colourButton = document.createElement("button");
    colourButton.type = "button";
    colourButton.className = "colour-btn";
    colourButton.title = "Colour";
    colourButton.setAttribute("aria-label", "Colour");
    colourButton.textContent = "🎨";

    if (state.coloredGroups[state.activeTab].has(groupData.group)) {
      colourButton.classList.add("active");
    }

    colourButton.addEventListener("click", (event) => {
      event.stopPropagation();
      openColourPopover(colourButton, groupData);
    });

    groupItem.appendChild(colourButton);

    arrow.addEventListener("click", (event) => {
      event.stopPropagation();

      if (expanded.has(groupData.group)) {
        expanded.delete(groupData.group);
      } else {
        expanded.add(groupData.group);
      }

      renderActiveList();
    });

    groupItem.addEventListener("click", () => {
      selectAndZoomGroup(groupData);
    });

    listElement.appendChild(groupItem);

    if (isExpanded) {
      const childList = document.createElement("ul");
      childList.className = "group-children";

      for (const item of groupData.items) {
        const itemElement = document.createElement("li");
        itemElement.className = "leaf-row";

        const itemLabel = document.createElement("span");
        itemLabel.textContent = item.value;
        itemElement.appendChild(itemLabel);

        if (item.entries.length > 1) {
          const duplicateBadge = document.createElement("span");
          duplicateBadge.className = "dupe-badge";
          duplicateBadge.textContent = `${item.entries.length}×`;
          itemElement.appendChild(duplicateBadge);
        }

        itemElement.addEventListener("click", (event) => {
          event.stopPropagation();
          selectAndZoom(item);
        });

        childList.appendChild(itemElement);
      }

      listElement.appendChild(childList);
    }
  }

  el("assemblyCount").textContent = state.assemblies.length
    ? `(${state.assemblies.length})`
    : "";

  el("partCount").textContent = state.parts.length
    ? `(${state.parts.length})`
    : "";

  el("uniqueIdCount").textContent = state.uniqueIds.length
    ? `(${state.uniqueIds.length})`
    : "";
}

function clearSelectionHighlight() {
  document
    .querySelectorAll(".list li")
    .forEach((item) => item.classList.remove("selected"));
}

async function applySelector(entries) {
  const byModel = new Map();

  for (const entry of entries) {
    if (!byModel.has(entry.modelId)) {
      byModel.set(entry.modelId, []);
    }

    byModel.get(entry.modelId).push(entry.objectRuntimeId);
  }

  const selector = {
    modelObjectIds: Array.from(byModel.entries()).map(
      ([modelId, objectRuntimeIds]) => ({
        modelId,
        objectRuntimeIds
      })
    )
  };

  try {
    await API.viewer.setSelection(selector, "set");
    await API.viewer.setCamera(selector, {
      animationTime: 800
    });

    return true;
  } catch (err) {
    setResult(
      "Found it, but couldn't select or zoom. Try again.",
      "error"
    );

    log("setSelection/setCamera failed", err.message);
    return false;
  }
}

async function selectAndZoom(item) {
  clearSelectionHighlight();

  const ok = await applySelector(item.entries);
  if (!ok) return;

  if (item.entries.length > 1) {
    setResult(
      `⚠️ "${item.value}" appears on ${item.entries.length} objects — selected and zoomed to fit all of them.`,
      "warn"
    );
  } else {
    setResult(`✅ Zoomed to "${item.value}".`, "ok");
  }

  log("Selection and zoom applied", {
    value: item.value,
    count: item.entries.length
  });
}

async function selectAndZoomGroup(groupData) {
  clearSelectionHighlight();

  const ok = await applySelector(groupData.entries);
  if (!ok) return;

  setResult(
    `✅ Selected and zoomed to all ${groupData.items.length} item(s) in "${groupData.group}" (${groupData.entries.length} object(s) total).`,
    "ok"
  );

  log("Group selection and zoom applied", {
    group: groupData.group,
    itemCount: groupData.items.length,
    objectCount: groupData.entries.length
  });
}

/* ---------- Tabs, filter, refresh ---------- */

function setActiveTab(tab) {
  state.activeTab = tab;

  el("tabAssemblies").classList.toggle(
    "active",
    tab === "assembly"
  );

  el("tabParts").classList.toggle(
    "active",
    tab === "part"
  );

  el("tabUniqueId").classList.toggle(
    "active",
    tab === "uniqueId"
  );

  el("assemblyList").hidden = tab !== "assembly";
  el("partList").hidden = tab !== "part";
  el("uniqueIdList").hidden = tab !== "uniqueId";

  el("filterInput").value = "";
  renderActiveList();
}

function setupUI() {
  el("tabAssemblies").addEventListener("click", () => {
    setActiveTab("assembly");
  });

  el("tabParts").addEventListener("click", () => {
    setActiveTab("part");
  });

  el("tabUniqueId").addEventListener("click", () => {
    setActiveTab("uniqueId");
  });

  el("filterInput").addEventListener(
    "input",
    renderActiveList
  );

  el("refreshButton").addEventListener("click", () => {
    if (!API) {
      setResult(
        "Still connecting — try again in a moment.",
        "error"
      );
      return;
    }

    buildLists();
  });
}

/* ---------- Connection ---------- */

async function connectToTrimble() {
  try {
    if (!window.TrimbleConnectWorkspace) {
      setConnectionBanner(
        "Couldn't load the Trimble connection. Try refreshing the page.",
        "error"
      );

      log("TrimbleConnectWorkspace object missing.");
      return;
    }

    API = await TrimbleConnectWorkspace.connect(
      window.parent,
      (event, data) => {
        log("Workspace event: " + event, data);
      }
    );

    setConnectionBanner("Connected", "ok");
    log("Connected to Workspace API.");

    try {
      const project = await API.project.getProject();
      el("projectInfo").textContent = JSON.stringify(
        project,
        null,
        2
      );

      log("Project loaded", project);
    } catch (projectError) {
      el("projectInfo").textContent =
        "Could not read project yet: " + projectError.message;

      log("Project read failed", projectError.message);
    }

    await buildLists();
  } catch (err) {
    setConnectionBanner(
      "Couldn't connect to Trimble Connect. Try refreshing the page.",
      "error"
    );

    log("Workspace API connection failed", err.message);
  }
}

(async function main() {
  el("debugLog").textContent =
    "Starting 4EST Part & Assembly Browser...";

  setupUI();
  await connectToTrimble();
})();
