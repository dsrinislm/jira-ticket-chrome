import { formatBytes, escapeHtml } from "./util.js";

const el = (id) => document.getElementById(id);

export const statusDiv = el("status");
export const statusText = el("statusText");
export const ticketResult = el("ticketResult");
export const gapArt = el("gapArt");
export const gapArtBulk = el("gapArtBulk");
export const loginBtn = el("openWebsite");
export const bulkLoginBtn = el("bulkLoginBtn");
export const exportBtn = el("exportBtn");
export const jiraBaseUrlInput = el("jiraBaseUrl");
export const jiraBaseUrlError = el("jiraBaseUrlError");
export const projectKeyInput = el("projectKey");
export const createTicketBtn = el("createTicket");
export const createTicketLabel = el("createTicketLabel");
export const singleAttachments = el("singleAttachments");
export const jiraToSparkSyncBtn = el("jiraToSparkSync");
export const sourceSiteSwitch = el("sourceSiteSwitch");
export const sourceSiteInput = el("sourceSiteInput");
export const sourceSiteLabels = document.querySelectorAll(".site-toggle-label");
export const includeAttachmentsInput = el("includeAttachments");
export const attachmentPicker = el("attachmentPicker");
export const attachmentPickerTitle = el("attachmentPickerTitle");
export const attachmentGroups = el("attachmentGroups");
export const attachmentSelectAll = el("attachmentSelectAll");
export const attachmentNote = el("attachmentNote");
export const bulkAttachmentSection = el("bulkAttachmentSection");
export const bulkIncludeAttachments = el("bulkIncludeAttachments");
export const bulkAttachmentPicker = el("bulkAttachmentPicker");
export const bulkAttachmentPickerTitle = el("bulkAttachmentPickerTitle");
export const bulkAttachmentGroups = el("bulkAttachmentGroups");
export const bulkAttachmentSelectAll = el("bulkAttachmentSelectAll");
export const bulkAttachmentNote = el("bulkAttachmentNote");

for (const picker of [attachmentPicker, bulkAttachmentPicker]) {
  const collapseBtn = picker?.querySelector(".attachment-picker-collapse");
  collapseBtn?.addEventListener("click", () => {
    const collapsed = picker.classList.toggle("collapsed");
    collapseBtn.setAttribute("aria-expanded", String(!collapsed));
  });
}

function expandAttachmentPicker(picker) {
  if (!picker) return;
  const busy =
    picker === bulkAttachmentPicker
      ? Boolean(importBtn?.disabled)
      : Boolean(createTicketBtn?.disabled);
  if (busy) return;
  picker.classList.remove("collapsed");
  picker
    .querySelector(".attachment-picker-collapse")
    ?.setAttribute("aria-expanded", "true");
}

export function getIncludeAttachments() {
  return includeAttachmentsInput.checked;
}

export function setIncludeAttachments(checked) {
  includeAttachmentsInput.checked = Boolean(checked);
}

export function getSelectedAttachments() {
  return state.attachmentSelection;
}

export function setAttachmentPickerLoading() {
  attachmentPicker.hidden = false;
  expandAttachmentPicker(attachmentPicker);
  attachmentGroups.innerHTML = "";
  setAttachmentNote("");
  attachmentPickerHasNoAttachments = false;
  updateAttachmentSelectAll();
  updateAttachmentIncludeSyncState();
  setAttachmentSyncProgress(true);
  state.attachmentSelection = null;
}

export function clearAttachmentPicker() {
  attachmentPicker.hidden = true;
  attachmentGroups.innerHTML = "";
  setAttachmentNote("");
  attachmentPickerHasNoAttachments = false;
  setAttachmentSyncProgress(false);
  attachmentSelectAll.checked = true;
  state.attachmentSelection = null;

  syncedTicketFound = false;
  updateAttachmentIncludeSyncState();
}

export function setAttachmentSyncProgress(visible) {
  const el = document.getElementById("attachmentSyncProgress");
  if (!el) return;
  el.hidden = !visible;
}

let attachmentPickerHasNoAttachments = false;

let syncedTicketFound = false;

let ticketCardShown = false;

export function setSyncedTicketFound(found) {
  syncedTicketFound = Boolean(found);
  updateAttachmentIncludeSyncState();
}

export function resetTicketCard() {
  ticketCardShown = false;
  if (ticketResult) ticketResult.innerHTML = "";
  updateAttachmentIncludeSyncState();
}

export const MAX_ATTACHMENT_UPLOAD_BYTES = 26 * 1024 * 1024;

export function attachmentByteSize(item) {
  const bytes = Number(item?.sizeBytes);
  if (Number.isFinite(bytes) && bytes >= 0) return bytes;
  const m = /([\d.]+)\s*(KB|MB|GB)/i.exec(String(item?.size || ""));
  if (!m) return 0;
  const mult =
    m[2].toUpperCase() === "GB"
      ? 1024 ** 3
      : m[2].toUpperCase() === "MB"
        ? 1024 ** 2
        : 1024;
  return Number(m[1]) * mult;
}

export function setAttachmentNote(message) {
  if (!attachmentNote) return;
  attachmentNote.hidden = !message;
  attachmentNote.textContent = message || "";
}

export function refreshSingleViewStatus() {
  if (bulkView.hidden) {
    const configured =
      jiraBaseUrlInput.value.trim() && projectKeyInput.value.trim();
    setStatus(
      configured
        ? "All set - Export current ticket into JIRA"
        : "Configure Jira details and create a ticket.",
      "info",
    );
  }
}

const ATTACHMENT_GROUP_LABELS = { video: "Video", image: "Image", other: "Other" };

export function renderAttachmentPicker(items, syncedNames = new Set()) {
  attachmentPicker.hidden = false;
  expandAttachmentPicker(attachmentPicker);
  attachmentGroups.innerHTML = "";
  attachmentPickerHasNoAttachments = false;
  state.attachmentSelection = [];
  if (attachmentPickerTitle) {
    attachmentPickerTitle.textContent = `Choose attachments to upload (${items.length})`;
  }

  const grouped = { video: [], image: [], other: [] };
  for (const item of items) {
    const type =
      item.type === "video" || item.type === "image" ? item.type : "other";
    grouped[type].push(item);
  }

  let anyFiles = false;
  for (const [type, list] of Object.entries(grouped)) {
    if (!list.length) continue;
    anyFiles = true;
    const group = document.createElement("div");
    group.className = "attachment-group";

    const groupSize = formatBytes(
      list.reduce((sum, item) => sum + (Number(item.sizeBytes) || 0), 0),
    );

    const title = document.createElement("div");
    title.className = "attachment-group-title";
    title.textContent = `${ATTACHMENT_GROUP_LABELS[type]} (${list.length})${groupSize && groupSize !== "0 B" ? ` · ${groupSize}` : ""}`;
    group.appendChild(title);

    for (const item of list) {
      const alreadySynced = syncedNames.has(item.name);

      if (!alreadySynced) state.attachmentSelection.push(item.name);
      const row = document.createElement("label");
      row.className = "attachment-item" + (alreadySynced ? " attachment-item-synced" : "");

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = true;
      checkbox.dataset.name = item.name;
      if (alreadySynced) {
        checkbox.disabled = true;
        checkbox.title = "Already on Jira — will be skipped on sync";
      }
      checkbox.addEventListener("change", () => {
        if (alreadySynced) return;
        const selected = state.attachmentSelection || [];
        state.attachmentSelection = checkbox.checked
          ? [...selected, item.name]
          : selected.filter((n) => n !== item.name);
        updateAttachmentSelectAll();
      });

      const name = document.createElement("span");
      name.className = "attachment-item-name";
      name.textContent = item.name + (alreadySynced ? " · synced" : "");
      const tip = [];
      if (item.description) tip.push(item.description);
      if (item.size) tip.push(`Size: ${item.size}`);
      name.title = tip.join("\n") || item.name;

      const size = document.createElement("span");
      size.className = "attachment-item-size";
      size.textContent = item.size || "";

      row.append(checkbox, name, size);
      group.appendChild(row);
    }

    attachmentGroups.appendChild(group);
  }

  if (!anyFiles) {
    attachmentGroups.innerHTML =
      '<div class="attachment-group-title">No attachments found.</div>';
    attachmentPickerHasNoAttachments = true;
  }

  updateAttachmentSelectAll();
  updateAttachmentIncludeSyncState();
}

let singleBusy = false;

function updateAttachmentSelectAll() {
  if (!attachmentSelectAll) return;
  const allBoxes = attachmentGroups.querySelectorAll(
    ".attachment-item input[type='checkbox']",
  );

  const boxes = attachmentGroups.querySelectorAll(
    ".attachment-item:not(.attachment-item-synced) input[type='checkbox']",
  );

  const toggle = attachmentSelectAll.closest(".attachment-picker-toggle");
  toggle?.classList.toggle("hidden", singleBusy || boxes.length === 0);
  let checked = 0;
  for (const box of boxes) if (box.checked) checked++;

  if (boxes.length === 0) {

    attachmentSelectAll.checked = allBoxes.length > 0;
    attachmentSelectAll.disabled = allBoxes.length > 0;
    attachmentSelectAll.indeterminate = false;
    return;
  }
  attachmentSelectAll.disabled = false;
  attachmentSelectAll.checked = checked > 0 && checked === boxes.length;
  attachmentSelectAll.indeterminate = checked > 0 && checked < boxes.length;
}

function updateAttachmentIncludeSyncState() {
  if (!includeAttachmentsInput) return;
  const allBoxes = attachmentGroups.querySelectorAll(
    ".attachment-item input[type='checkbox']",
  );
  const boxes = attachmentGroups.querySelectorAll(
    ".attachment-item:not(.attachment-item-synced) input[type='checkbox']",
  );
  const allSynced =
    attachmentPickerHasNoAttachments ||
    (allBoxes.length > 0 && boxes.length === 0);
  if (allSynced) {
    includeAttachmentsInput.checked = true;
    includeAttachmentsInput.disabled = true;
  } else {
    includeAttachmentsInput.disabled = false;
  }

  const fullySyncedTicket = syncedTicketFound && allSynced && ticketCardShown;
  const buttonGroup = createTicketBtn?.closest(".button-group");
  if (buttonGroup) {
    buttonGroup.style.display = fullySyncedTicket ? "none" : "";
  }
  if (fullySyncedTicket) {
    setStatus("Ticket fully synced! try new one.", "success");
  }
}

export function markAttachmentsSynced(uploadedNames) {
  if (!attachmentGroups || !uploadedNames?.length) return;
  for (const name of uploadedNames) {
    const box = attachmentGroups.querySelector(
      `.attachment-item input[type='checkbox'][data-name="${CSS.escape(name)}"]`,
    );
    if (!box) continue;
    const row = box.closest(".attachment-item");
    if (row.classList.contains("attachment-item-synced")) continue;
    box.checked = true;
    box.disabled = true;
    box.title = "Already on Jira — will be skipped on sync";
    row.classList.add("attachment-item-synced");
    const nameEl = row.querySelector(".attachment-item-name");
    if (nameEl && !nameEl.textContent.includes("synced")) {
      nameEl.textContent = `${name} · synced`;
    }
    const selected = state.attachmentSelection || [];
    state.attachmentSelection = selected.filter((n) => n !== name);
  }
  updateAttachmentSelectAll();
  updateAttachmentIncludeSyncState();
}

export function getBulkIncludeAttachments() {
  return Boolean(bulkIncludeAttachments?.checked);
}

export function getBulkSelectedAttachments() {
  return state.bulkAttachmentSelection;
}

export function setBulkAttachmentSectionVisible(visible) {
  if (!bulkAttachmentSection) return;
  bulkAttachmentSection.style.display = visible ? "block" : "none";
  if (!visible) {
    if (bulkIncludeAttachments) bulkIncludeAttachments.checked = false;
    clearBulkAttachmentPicker();
    setBulkPreviewCollapsed(false);
  }
}

export function setBulkPreviewCollapsed(collapsed) {
  if (!previewSection) return;
  previewSection.classList.toggle("preview-collapsed", Boolean(collapsed));
  previewCollapseBtn?.setAttribute("aria-expanded", String(!collapsed));
}

export function scrollBulkRowTop(row, smooth = true) {
  if (!tableWrap || !row?.tr) return;
  const thead = tableWrap.querySelector("thead");
  const headerHeight = thead ? thead.offsetHeight : 0;
  tableWrap.scrollTo({
    top: Math.max(0, row.tr.offsetTop - headerHeight),
    behavior: smooth ? "smooth" : "auto",
  });
}

export function scrollBulkToFirstSelected() {
  if (!tableWrap) return;
  const first = state.bulkRows.find(
    (r) => !r.checkbox.disabled && r.checkbox.checked,
  );
  if (first) scrollBulkRowTop(first, false);
  else scrollBulkTableTop();
}

export function scrollBulkTableTop(smooth = false) {
  if (!tableWrap) return;
  tableWrap.scrollTo({ top: 0, behavior: smooth ? "smooth" : "auto" });
}

export function setBulkAttachmentNote(message) {
  if (!bulkAttachmentNote) return;
  bulkAttachmentNote.hidden = !message;
  bulkAttachmentNote.textContent = message || "";
}

export function setBulkAttachmentSyncProgress(visible) {
  const el = document.getElementById("bulkAttachmentSyncProgress");
  if (!el) return;
  el.hidden = !visible;
}

export function setBulkAttachmentPickerLoading() {
  if (!bulkAttachmentPicker) return;
  bulkAttachmentPicker.hidden = false;
  expandAttachmentPicker(bulkAttachmentPicker);
  bulkAttachmentGroups.innerHTML = "";
  setBulkAttachmentNote("");
  bulkPickerHasNoAttachments = false;
  updateBulkAttachmentSelectAll();
  updateBulkIncludeSyncState();
  setBulkAttachmentSyncProgress(true);
  state.bulkAttachmentSelection = null;
}

export function clearBulkAttachmentPicker() {
  if (bulkAttachmentPicker) bulkAttachmentPicker.hidden = true;
  if (bulkAttachmentGroups) bulkAttachmentGroups.innerHTML = "";
  setBulkAttachmentNote("");
  setBulkAttachmentSyncProgress(false);
  if (bulkAttachmentSelectAll) bulkAttachmentSelectAll.checked = true;
  state.bulkAttachmentSelection = null;
}

export function renderBulkAttachmentPicker(groups, labels = {}, syncedMap = {}) {
  if (!bulkAttachmentPicker) return;
  bulkAttachmentPicker.hidden = false;
  expandAttachmentPicker(bulkAttachmentPicker);
  bulkAttachmentGroups.innerHTML = "";
  bulkPickerHasNoAttachments = false;
  state.bulkAttachmentSelection = {};

  const totalFiles = groups.reduce(
    (sum, group) => sum + (group.attachments || []).length,
    0,
  );
  if (bulkAttachmentPickerTitle) {
    bulkAttachmentPickerTitle.textContent = `Choose attachments to upload (${totalFiles})`;
  }

  let anyFiles = false;
  for (const group of groups) {
    const files = group.attachments || [];
    if (!files.length) continue;
    anyFiles = true;

    const ticketId = String(group.id);
    const synced = syncedMap[ticketId] || new Set();

    const selectable = files.filter((f) => !synced.has(f.name));
    state.bulkAttachmentSelection[ticketId] = selectable.map((f) => f.name);

    const block = document.createElement("div");
    block.className = "attachment-group";

    const totalBytes = files.reduce(
      (sum, f) => sum + (Number(f.sizeBytes) || 0),
      0,
    );
    const totalSize = formatBytes(totalBytes);

    const title = document.createElement("div");
    title.className = "attachment-group-title";
    const groupCheckbox = document.createElement("input");
    groupCheckbox.type = "checkbox";
    groupCheckbox.className = "attachment-group-check";
    groupCheckbox.checked = selectable.length > 0;
    groupCheckbox.disabled = selectable.length === 0;
    groupCheckbox.dataset.ticket = ticketId;
    groupCheckbox.title =
      "Select all attachments of this ticket that aren't synced yet";
    groupCheckbox.addEventListener("change", () => {
      state.bulkAttachmentSelection[ticketId] = groupCheckbox.checked
        ? selectable.map((f) => f.name)
        : [];
      block
        .querySelectorAll(
          ".attachment-item:not(.attachment-item-synced) input[type='checkbox']",
        )
        .forEach((box) => {
          box.checked = groupCheckbox.checked;
        });
      updateBulkAttachmentSelectAll();
    });

    const titleText = document.createElement("span");
    titleText.textContent = `${labels[ticketId] || group.id} (${files.length})${totalSize && totalSize !== "0 B" ? ` · ${totalSize}` : ""}`;
    title.append(groupCheckbox, titleText);
    block.appendChild(title);

    block.dataset.title = labels[ticketId] || String(group.id);
    block.dataset.count = String(files.length);
    block.dataset.size = totalSize;

    for (const item of files) {
      const alreadySynced = synced.has(item.name);
      const row = document.createElement("label");
      row.className = "attachment-item" + (alreadySynced ? " attachment-item-synced" : "");

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = true;
      checkbox.dataset.name = item.name;
      checkbox.dataset.ticket = ticketId;
      if (alreadySynced) {
        checkbox.disabled = true;
        checkbox.title = "Already on Jira — will be skipped on import";
      }
      checkbox.addEventListener("change", () => {
        if (alreadySynced) return;
        const sel = state.bulkAttachmentSelection?.[ticketId] || [];
        state.bulkAttachmentSelection[ticketId] = checkbox.checked
          ? [...sel, item.name]
          : sel.filter((n) => n !== item.name);
        updateGroupCheck(ticketId);
        updateBulkAttachmentSelectAll();
      });

      const name = document.createElement("span");
      name.className = "attachment-item-name";
      name.textContent = item.name + (alreadySynced ? " · synced" : "");
      name.title = item.size ? `${item.name}\nSize: ${item.size}` : item.name;

      const size = document.createElement("span");
      size.className = "attachment-item-size";
      size.textContent = item.size || "";

      row.append(checkbox, name, size);
      block.appendChild(row);
    }

    bulkAttachmentGroups.appendChild(block);
    updateGroupCheck(ticketId);
  }

  if (!anyFiles) {
    bulkAttachmentGroups.innerHTML =
      '<div class="attachment-group-title">No attachments found.</div>';
    bulkPickerHasNoAttachments = true;
  }

  updateBulkAttachmentSelectAll();
  updateBulkIncludeSyncState();
}

function updateBulkAttachmentSelectAll() {
  if (!bulkAttachmentSelectAll) return;
  const allBoxes = bulkAttachmentGroups.querySelectorAll(
    ".attachment-item input[type='checkbox']",
  );

  const boxes = bulkAttachmentGroups.querySelectorAll(
    ".attachment-item:not(.attachment-item-synced) input[type='checkbox']",
  );

  const toggle = bulkAttachmentSelectAll.closest(".attachment-picker-toggle");
  toggle?.classList.toggle("hidden", boxes.length === 0);
  let checked = 0;
  for (const box of boxes) if (box.checked) checked++;

  if (boxes.length === 0) {

    bulkAttachmentSelectAll.checked = allBoxes.length > 0;
    bulkAttachmentSelectAll.disabled = allBoxes.length > 0;
    bulkAttachmentSelectAll.indeterminate = false;
    return;
  }
  bulkAttachmentSelectAll.disabled = false;
  bulkAttachmentSelectAll.checked = checked > 0 && checked === boxes.length;
  bulkAttachmentSelectAll.indeterminate = checked > 0 && checked < boxes.length;
}

let bulkPickerHasNoAttachments = false;

function updateBulkIncludeSyncState() {
  if (!bulkIncludeAttachments) return;
  const allBoxes = bulkAttachmentGroups.querySelectorAll(
    ".attachment-item input[type='checkbox']",
  );
  const boxes = bulkAttachmentGroups.querySelectorAll(
    ".attachment-item:not(.attachment-item-synced) input[type='checkbox']",
  );
  const allSynced =
    bulkPickerHasNoAttachments ||
    (allBoxes.length > 0 && boxes.length === 0);
  if (allSynced) {
    bulkIncludeAttachments.checked = true;
    bulkIncludeAttachments.disabled = true;
  } else {
    bulkIncludeAttachments.disabled = false;
  }

  updateListingControls();
}

function updateGroupCheck(ticketId) {
  const groupCheck = bulkAttachmentGroups.querySelector(
    `.attachment-group-check[data-ticket="${ticketId}"]`,
  );
  if (!groupCheck) return;
  const group = groupCheck.closest(".attachment-group");
  const allBoxes = group.querySelectorAll(
    ".attachment-item input[type='checkbox']",
  );
  if (!allBoxes.length) return;
  const boxes = group.querySelectorAll(
    ".attachment-item:not(.attachment-item-synced) input[type='checkbox']",
  );
  if (!boxes.length) {
    groupCheck.checked = true;
    groupCheck.disabled = true;
    groupCheck.indeterminate = false;
    return;
  }
  groupCheck.disabled = false;
  let checked = 0;
  for (const box of boxes) if (box.checked) checked++;
  groupCheck.checked = checked > 0 && checked === boxes.length;
  groupCheck.indeterminate = checked > 0 && checked < boxes.length;
}

export function updateBulkGroupChecks() {
  bulkAttachmentGroups
    .querySelectorAll(".attachment-group-check")
    .forEach((groupCheck) => updateGroupCheck(groupCheck.dataset.ticket));
}

export function markBulkAttachmentsSynced(uploadedMap) {
  if (!bulkAttachmentGroups || !uploadedMap) return;
  for (const [ticketId, names] of Object.entries(uploadedMap)) {
    if (!names || !names.length) continue;
    for (const name of names) {
      const box = bulkAttachmentGroups.querySelector(
        `.attachment-item input[type='checkbox'][data-ticket="${ticketId}"][data-name="${CSS.escape(name)}"]`,
      );
      if (!box) continue;
      const row = box.closest(".attachment-item");
      if (row.classList.contains("attachment-item-synced")) continue;
      box.checked = true;
      box.disabled = true;
      box.title = "Already on Jira — will be skipped on import";
      row.classList.add("attachment-item-synced");
      const nameEl = row.querySelector(".attachment-item-name");
      if (nameEl && !nameEl.textContent.includes("synced")) {
        nameEl.textContent = `${name} · synced`;
      }
      const sel = state.bulkAttachmentSelection?.[ticketId];
      if (sel) {
        state.bulkAttachmentSelection[ticketId] = sel.filter((n) => n !== name);
      }
    }
    updateGroupCheck(ticketId);
    refreshBulkGroupTitle(ticketId);
  }
  updateBulkAttachmentSelectAll();
  updateBulkIncludeSyncState();
}

function refreshBulkGroupTitle(ticketId) {
  const block = bulkAttachmentGroups.querySelector(
    `.attachment-group-check[data-ticket="${ticketId}"]`,
  )?.closest(".attachment-group");
  const titleText = block?.querySelector(".attachment-group-title span");
  if (!titleText) return;
  const count = Number(block.dataset.count || 0);
  const size = block.dataset.size || "";
  titleText.textContent = `${block.dataset.title || ticketId} (${count})${size && size !== "0 B" ? ` · ${size}` : ""}`;
}

export function markBulkRowsFullySynced(fullySyncedIds) {
  if (!fullySyncedIds) return;
  const ids = new Set(
    Array.from(fullySyncedIds, (id) => String(id)),
  );
  for (const row of state.bulkRows || []) {
    if (
      row.statusEl.dataset.state === "created" ||
      row.statusEl.dataset.state === "exists" ||
      row.checkbox.disabled
    ) {
      continue;
    }
    if (row.rowIndex != null && ids.has(String(row.rowIndex))) {
      row.checkbox.checked = true;
      row.checkbox.disabled = true;
      row.statusEl.dataset.state = "exists";
      row.statusEl.textContent = "Already exists — attachments up to date";
    }
  }
  updateSelectionCount();
}

export function getSourceSite() {
  return sourceSiteInput.checked ? "Spark" : "Octane";
}

export function setSourceSite(site) {
  sourceSiteInput.checked = site === "Spark";
  sourceSiteLabels.forEach((label) =>
    label.classList.toggle("active", label.dataset.site === site),
  );
}

export function setSourceSiteLocked(locked) {
  sourceSiteInput.disabled = locked;
  const current = getSourceSite();
  sourceSiteLabels.forEach((label) => {
    label.disabled = locked && label.dataset.site !== current;
  });
  document.querySelector(".site-toggle")?.classList.toggle("locked", locked);
}

export function setSourceSiteVisible(visible) {
  sourceSiteSwitch
    .closest(".field-block")
    ?.classList.toggle("hidden", !visible);
  gapArt?.classList.toggle("hidden", visible);
}
export const projectTagsContainer = el("projectTags");
export const singleView = el("singleView");
export const bulkView = el("bulkView");
export const tabSingle = el("tabSingle");
export const tabBulk = el("tabBulk");
export const fileInput = el("fileInput");
export const fileError = el("fileError");
export const fileSummary = el("fileSummary");
export const previewSection = el("previewSection");
export const previewBody = el("previewBody");
export const previewIdHeader = el("previewIdHeader");
export const previewTitle = el("previewTitle");
export const previewCollapseBtn = el("previewCollapseBtn");
export const tableWrap = document.querySelector(".table-wrap");
export const selectAllCheckbox = el("selectAllCheckbox");

previewCollapseBtn?.addEventListener("click", () => {
  setBulkPreviewCollapsed(
    !previewSection.classList.contains("preview-collapsed"),
  );
});
export const selectAllLabel = document.querySelector(".select-all");
export const selectionCount = el("selectionCount");
export const importBtn = el("importBtn");
export const listingImportBtn = el("listingImportBtn");
export const listingImportLabel = el("listingImportLabel");
export const dropzone = document.querySelector(".file-dropzone");
export const dropzoneTitle = el("dropzoneTitle");
export const dropzoneHint = el("dropzoneHint");
export const dropzoneIcon = el("dropzoneIcon");
export const clearFileBtn = el("clearFileBtn");
export const progressSection = el("progressSection");
export const progressLabel = el("progressLabel");
export const progressPercent = el("progressPercent");
export const progressBar = el("progressBar");
export const abortImportBtn = el("abortImportBtn");
export const bulkMediaProgress = el("bulkMediaProgress");
export const bulkMediaToggle = el("bulkMediaToggle");
export const bulkMediaProgressList = el("bulkMediaProgressList");
export const bulkMediaProgressCount = el("bulkMediaProgressCount");

bulkMediaToggle?.addEventListener("click", () => {
  setBulkMediaCollapsed(bulkMediaProgress?.dataset.collapsed !== "true");
});

export const syncProgressSection = el("syncProgressSection");
export const syncProgressLabel = el("syncProgressLabel");
export const syncProgressPercent = el("syncProgressPercent");
export const syncProgressBar = el("syncProgressBar");
export const syncAbortBtn = el("syncAbortBtn");

export const state = {
  bulkRows: [],
  importData: null,
  importExt: null,
  attachmentSelection: null,

  bulkAttachmentSelection: null,
};

export { escapeHtml } from "./util.js";

export function setStatus(message, status = "info") {
  statusText.textContent = message;
  statusDiv.dataset.state = status;

  if (status === "loading") {
    smoothScrollToBottom();
  }
}

export function setBusy(isBusy) {
  singleBusy = Boolean(isBusy);
  createTicketBtn.disabled = isBusy;
  createTicketBtn.dataset.loading = isBusy ? "true" : "false";
  jiraToSparkSyncBtn.disabled = isBusy;
  jiraToSparkSyncBtn.dataset.loading = isBusy ? "true" : "false";
  jiraBaseUrlInput.disabled = isBusy;
  projectKeyInput.disabled = isBusy;
  includeAttachmentsInput.disabled = isBusy;
  if (isBusy) collapseAttachmentPickers();
  updateAttachmentSelectAll();

  if (!isBusy) updateAttachmentIncludeSyncState();
}

export function collapseAttachmentPickers() {
  for (const picker of [attachmentPicker, bulkAttachmentPicker]) {
    if (!picker || picker.hidden) continue;
    picker.classList.add("collapsed");
    picker
      .querySelector(".attachment-picker-collapse")
      ?.setAttribute("aria-expanded", "false");
  }
}

export function lockBulkImport() {
  importBtn.classList.add("hidden");
}

export function unlockBulkImport() {

  if (bulkRowsFromListing) return;
  importBtn.classList.remove("hidden");
  importBtn.disabled = false;
  importBtn.dataset.loading = "false";
}

let bulkBusy = false;

let bulkRowsFromListing = false;

export function setBulkRowsFromListing(fromListing) {
  bulkRowsFromListing = Boolean(fromListing);
}

export function isBulkRowsFromListing() {
  return bulkRowsFromListing;
}

export function setBulkBusy(isBusy) {
  bulkBusy = Boolean(isBusy);
  importBtn.disabled = isBusy;
  importBtn.dataset.loading = isBusy ? "true" : "false";
  fileInput.disabled = isBusy;
  listingImportBtn.disabled = isBusy;
  if (isBusy) collapseAttachmentPickers();

  previewCollapseBtn?.classList.toggle("hidden", isBusy);
  selectAllLabel?.classList.toggle("hidden", isBusy);
  if (!isBusy) {
    updateBulkSelectAllVisibility();

    updateBulkIncludeSyncState();
  }
}

const viewScroll = { single: 0, bulk: 0 };

export function switchView(view, focusTab = true) {
  const isBulk = view === "bulk";
  const entering = isBulk ? "bulk" : "single";
  const leaving = isBulk ? "single" : "bulk";

  viewScroll[leaving] = document.body.scrollTop || 0;

  singleView.hidden = isBulk;
  bulkView.hidden = !isBulk;

  tabSingle.classList.toggle("active", !isBulk);
  tabSingle.setAttribute("aria-selected", String(!isBulk));
  tabBulk.classList.toggle("active", isBulk);
  tabBulk.setAttribute("aria-selected", String(isBulk));

  if (isBulk) {
    updateBulkStatusMessage();
  } else {
    const jiraConfigured =
      jiraBaseUrlInput.value.trim() && projectKeyInput.value.trim();
    setStatus(
      jiraConfigured
        ? "All set - Export current ticket into JIRA"
        : "Configure Jira details and create a ticket.",
      "info",
    );
  }

  if (focusTab) {
    (isBulk ? tabBulk : tabSingle)?.focus?.({ preventScroll: true });
  }

  document.body.scrollTop = viewScroll[entering] || 0;
}

export function setSingleTabEnabled(enabled) {
  const isEnabled = Boolean(enabled);
  tabSingle.disabled = !isEnabled;
  tabSingle.setAttribute("aria-disabled", String(!isEnabled));
  tabSingle.title = isEnabled
    ? ""
    : "Open a Spark or Octane ticket to use this.";
  if (!isEnabled && bulkView.hidden) {
    switchView("bulk", false);
  }
}

export function setJiraToSparkVisible(visible) {
  if (!jiraToSparkSyncBtn) return;
  jiraToSparkSyncBtn.style.display = visible ? "block" : "none";
}

export function updateBulkStatusMessage() {
  const jiraConfigured =
    jiraBaseUrlInput.value.trim() && projectKeyInput.value.trim();
  setStatus(
    jiraConfigured
      ? excelFlowActive || !activeListingSite || !listingHasSelection
        ? "Upload Octane or Spark report"
        : "Upload report or Sync selected listing"
      : "Configure Jira details and create a ticket.",
    "info",
  );
}

let activeListingSite = null;
let listingHasSelection = false;

export function setActiveListingSite(site) {
  activeListingSite = site || null;
}

export function getActiveListingSite() {
  return activeListingSite;
}

export function setListingHasSelection(hasSelection) {
  listingHasSelection = Boolean(hasSelection);
  updateListingControls();
}

export function getListingHasSelection() {
  return listingHasSelection;
}

let excelFlowActive = false;

export function isExcelFlowActive() {
  return excelFlowActive;
}

export function setExcelFlowActive(active) {
  excelFlowActive = Boolean(active);
  updateListingControls();
}

function listingSyncDoneState() {
  if (!bulkRowsFromListing || !state.bulkRows.length) return false;
  const allRowsDone = state.bulkRows.every(
    (r) => r.checkbox.checked && r.checkbox.disabled,
  );
  return (
    allRowsDone &&
    Boolean(bulkIncludeAttachments?.checked && bulkIncludeAttachments.disabled) &&
    exportBtn.style.display !== "none"
  );
}

function updateListingControls() {
  const show =
    !excelFlowActive && Boolean(activeListingSite) && listingHasSelection;
  setBulkAttachmentSectionVisible(show);
  listingImportBtn.style.display =
    show && !listingSyncDoneState() ? "block" : "none";
  if (show && !listingSyncDoneState()) {
    listingImportLabel.textContent = `Sync selected ${activeListingSite} listing`;
  }
}

export function applyListingState(listing, selectedCount) {
  setActiveListingSite(listing);
  setListingHasSelection(selectedCount > 0);
  updateClearAffordance(listing, selectedCount);
}

const DROPZONE_ICON_EXCEL =
  '<rect x="4" y="4" width="16" height="16" rx="2.5" stroke="currentColor" stroke-width="1.8"/><path d="M4 9.5h16M9.5 4v16M14.5 9.5V20" stroke="currentColor" stroke-width="1.8"/>';
const DROPZONE_ICON_CHECK =
  '<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8"/><path d="m8.5 12 2.5 2.5 4.5-5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>';

export function setDropzoneLoaded() {
  dropzone.dataset.loaded = "true";
  dropzoneTitle.textContent = "Upload Done";
  dropzoneIcon.innerHTML = DROPZONE_ICON_CHECK;

  setExcelFlowActive(true);
  setBulkRowsFromListing(false);

  updateClearAffordance(activeListingSite, listingHasSelection ? 1 : 0);
}

export function resetDropzone() {
  dropzone.dataset.loaded = "false";
  dropzoneTitle.textContent = "Choose an Excel file";
  dropzoneIcon.innerHTML = DROPZONE_ICON_EXCEL;
  dropzoneHint.innerHTML =
    "Octane: ID/Name/Description<br/>Spark: Number/Short description/Description";
  clearFileBtn.hidden = true;

  setExcelFlowActive(false);
}

export function clearFileUpload() {
  if (fileInput) fileInput.value = "";
  state.bulkRows = [];
  state.importData = null;
  state.importExt = null;
  if (previewBody) previewBody.innerHTML = "";
  if (previewSection) previewSection.style.display = "none";
  if (previewTitle) previewTitle.textContent = "Preview selected tickets";
  if (progressSection) progressSection.style.display = "none";
  hideBulkMediaProgress();
  if (exportBtn) exportBtn.style.display = "none";
  if (fileError) fileError.style.display = "none";
  if (fileSummary) fileSummary.textContent = "";
  selectAllLabel?.classList.add("hidden");
  unlockBulkImport();
  resetDropzone();
  setBulkRowsFromListing(false);
  updateSelectionCount();
}

clearFileBtn?.addEventListener("click", clearFileUpload);

export function updateClearAffordance(listing, selectedCount) {
  if (!isExcelFlowActive()) {
    setClearHintVisible(false);
    return;
  }
  setClearHintVisible(Boolean(listing) && selectedCount > 0);
}

function setClearHintVisible(visible) {
  clearFileBtn.hidden = !visible;
  const hint = dropzoneHint.querySelector(".dropzone-clear-hint");
  if (!hint) return;
  hint.style.display = visible ? "" : "none";
  const br = hint.previousSibling;
  if (br && br.nodeName === "BR") br.style.display = visible ? "" : "none";
}

let selectionCountScheduled = false;

function updatePreviewTitle() {
  if (!previewTitle) return;
  previewTitle.textContent = `Preview selected tickets (${state.bulkRows.length})`;
}

export function updateSelectionCount() {
  if (selectionCountScheduled) return;
  selectionCountScheduled = true;
  requestAnimationFrame(() => {
    selectionCountScheduled = false;

    let selected = 0;
    let processed = 0;
    let selectable = 0;
    for (const r of state.bulkRows) {
      if (!r.checkbox.disabled) {
        selectable++;
        if (r.checkbox.checked) selected++;
      }
      const rowState = r.statusEl.dataset.state;
      if (
        rowState === "created" ||
        rowState === "exists" ||
        rowState === "error"
      ) {
        processed++;
      }
    }

    if (selected === 0) {
      selectionCount.textContent = "";
    } else {
      const processedLabel = processed > 0 ? `Processed ${processed}, ` : "";
      selectionCount.textContent = `${processedLabel}Selected ${selected} of ${state.bulkRows.length}`;
    }

    if (!state.bulkRows.length || importBtn.disabled) return;

    if (selectable === 0) {
      lockBulkImport();
      setStatus(
        bulkRowsFromListing
          ? "Bulk import done! Select rows on the listing page to sync more"
          : "Bulk import done! try different report",
        "success",
      );
    } else if (selected > 0) {

      unlockBulkImport();
      setStatus(
        bulkRowsFromListing
          ? "All set - Sync selected listing to continue"
          : "All set - Export selected tickets into JIRA",
        "info",
      );
    } else {

      importBtn.classList.add("hidden");
      setStatus(
        processed > 0
          ? bulkRowsFromListing
            ? "Select new items on the listing page to sync more"
            : "Select new items to continue create more"
          : "Select the tickets to import.",
        "info",
      );
    }

    updateListingControls();
  });
}

export function toggleSelectAll() {
  state.bulkRows.forEach((r) => {
    if (!r.checkbox.disabled) r.checkbox.checked = selectAllCheckbox.checked;
  });
  updateSelectionCount();
}

const isBulkRowDone = (r) =>
  r.statusEl.dataset.state === "created" || r.statusEl.dataset.state === "exists";

export function updateBulkSelectAllVisibility() {
  if (!selectAllLabel) return;
  const hasSelectable = state.bulkRows.some((r) => !isBulkRowDone(r));
  selectAllLabel.classList.toggle("hidden", !hasSelectable);
}

export function reorderBulkRowsAfterImport() {
  const done = [];
  const rest = [];
  state.bulkRows.forEach((r) => (isBulkRowDone(r) ? done : rest).push(r));
  state.bulkRows = [...done, ...rest];

  const fragment = document.createDocumentFragment();
  state.bulkRows.forEach((r) => {
    if (isBulkRowDone(r)) {
      r.checkbox.disabled = true;
      r.checkbox.checked = true;
      r.tr.classList.add("row-done");
    }
    fragment.appendChild(r.tr);
  });
  previewBody.appendChild(fragment);

  const allDone = state.bulkRows.every(isBulkRowDone);
  selectAllLabel?.classList.toggle("hidden", bulkBusy || allDone);

  updateSelectionCount();
}

export function setRowStatus(row, rowState, html) {
  row.statusEl.dataset.state = rowState;
  row.statusEl.innerHTML = html;
  updateSelectionCount();
}

export function updateProgress(completed, total, label) {
  const pct =
    total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0;
  progressBar.style.width = `${pct}%`;
  progressBar.dataset.done = String(completed >= total && total > 0);
  progressPercent.textContent = `${pct}%`;
  progressSection.setAttribute("aria-valuenow", String(pct));
  progressLabel.textContent = label || `Importing ${completed} of ${total}…`;
}

export function setBulkMediaCollapsed(collapsed) {
  if (!bulkMediaProgress) return;
  bulkMediaProgress.dataset.collapsed = collapsed ? "true" : "false";
  bulkMediaToggle?.setAttribute("aria-expanded", String(!collapsed));
  refreshBulkMediaRowVisibility();
}

function refreshBulkMediaRowVisibility() {
  if (!bulkMediaProgressList) return;
  const collapsed = bulkMediaProgress?.dataset.collapsed === "true";
  const rows = [...bulkMediaProgressList.children];
  if (!collapsed) {
    rows.forEach((r) => (r.style.display = ""));
    return;
  }
  const active =
    rows.find((r) => r.dataset.state === "uploading") ||
    rows.find((r) => r.dataset.state === "pending") ||
    rows[rows.length - 1];
  rows.forEach((r) => (r.style.display = r === active ? "" : "none"));
}

export function setupBulkMediaProgress(labels) {
  if (!bulkMediaProgressList) return;
  bulkMediaProgressList.innerHTML = "";
  labels.forEach((label) => {
    const row = document.createElement("div");
    row.className = "bulk-media-row";
    row.dataset.state = "pending";

    const head = document.createElement("div");
    head.className = "bulk-media-row-head";

    const labelEl = document.createElement("span");
    labelEl.className = "bulk-media-row-label";
    labelEl.textContent = label;

    const pctEl = document.createElement("span");
    pctEl.className = "bulk-media-row-pct";
    pctEl.textContent = "0%";

    head.append(labelEl, pctEl);

    const track = document.createElement("div");
    track.className = "bulk-media-row-track";
    const bar = document.createElement("div");
    bar.className = "bulk-media-row-bar";
    track.appendChild(bar);

    const files = document.createElement("div");
    files.className = "bulk-media-row-files";
    files.textContent = "0 files";

    row.append(head, track, files);
    bulkMediaProgressList.appendChild(row);
  });
  if (bulkMediaProgress) bulkMediaProgress.style.display = labels.length ? "block" : "none";
  if (bulkMediaProgressCount) {
    bulkMediaProgressCount.textContent = labels.length
      ? `${labels.length} ticket(s) with media`
      : "";
  }
  refreshBulkMediaRowVisibility();
}

export function startBulkMediaProgress(rowIndex) {
  const row = bulkMediaProgressList?.children[rowIndex];
  if (!row) return;
  row.dataset.state = "uploading";
  const bar = row.querySelector(".bulk-media-row-bar");
  if (bar) bar.style.width = "0%";
  const pctEl = row.querySelector(".bulk-media-row-pct");
  if (pctEl) pctEl.textContent = "0%";
  row.scrollIntoView({ block: "nearest" });
  refreshBulkMediaRowVisibility();
}

export function updateBulkMediaProgress(rowIndex, loaded, total, label) {
  const row = bulkMediaProgressList?.children[rowIndex];
  if (!row) return;
  row.dataset.state = "uploading";
  const pct = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 100;
  const bar = row.querySelector(".bulk-media-row-bar");
  if (bar) bar.style.width = `${pct}%`;
  const pctEl = row.querySelector(".bulk-media-row-pct");
  if (pctEl) {
    const bytesText =
      total > 0
        ? `${formatBytes(loaded) || "0 B"} / ${formatBytes(total) || "0 B"}`
        : `${pct}%`;
    pctEl.textContent = label || bytesText;
  }
  if (total > 0 && loaded >= total) setBulkMediaProgressDone(rowIndex);
}

export function setBulkMediaProgressDone(rowIndex) {
  const row = bulkMediaProgressList?.children[rowIndex];
  if (!row) return;
  row.dataset.state = "done";
  const bar = row.querySelector(".bulk-media-row-bar");
  if (bar) bar.style.width = "100%";
  const pctEl = row.querySelector(".bulk-media-row-pct");
  if (pctEl) pctEl.textContent = "100%";
  const hint = row.querySelector(".bulk-media-row-files");
  const total = Number(row.dataset.filesTotal);
  const uploaded = Number(row.dataset.filesUploaded);
  if (hint && total > 0) {
    hint.textContent =
      uploaded < total
        ? `${uploaded} of ${total} file${total === 1 ? "" : "s"} uploaded`
        : `${total} file${total === 1 ? "" : "s"} uploaded`;
  }
  refreshBulkMediaRowVisibility();
}

export function updateBulkMediaFiles(rowIndex, uploaded, total) {
  const row = bulkMediaProgressList?.children[rowIndex];
  if (!row) return;
  row.dataset.filesUploaded = String(uploaded);
  row.dataset.filesTotal = String(total);
  const hint = row.querySelector(".bulk-media-row-files");
  if (!hint) return;
  if (row.dataset.state === "done") {
    hint.textContent =
      uploaded < total
        ? `${uploaded} of ${total} file${total === 1 ? "" : "s"} uploaded`
        : `${total} file${total === 1 ? "" : "s"} uploaded`;
  } else {
    hint.textContent = `Uploading ${uploaded} of ${total} file${total === 1 ? "" : "s"}…`;
  }
}

export function hideBulkMediaProgress() {
  if (bulkMediaProgress) bulkMediaProgress.style.display = "none";
  if (bulkMediaProgressList) bulkMediaProgressList.innerHTML = "";
}

export function updateSyncProgress(loaded, total, label) {
  const pct =
    total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
  syncProgressBar.style.width = `${pct}%`;
  syncProgressBar.dataset.done = String(loaded >= total && total > 0);
  syncProgressPercent.textContent = `${pct}%`;
  syncProgressSection.setAttribute("aria-valuenow", String(pct));
  syncProgressLabel.textContent = label || "Uploading attachments…";
}

export function setSyncProgressVisible(visible) {
  syncProgressSection.style.display = visible ? "block" : "none";
}

export function renderTicketCard(issueKey, issueUrl) {
  const safeKey = escapeHtml(issueKey);
  const safeUrl = escapeHtml(issueUrl);

  ticketResult.innerHTML = `
        <div class="ticket-card">
          <div class="ticket-key">
            <a id="jiraIssueLink" href="${safeUrl}" target="_blank" rel="noopener noreferrer">
              ${safeKey}
            </a>
          </div>
          <div class="ticket-url">
            <a id="jiraUrlLink" href="${safeUrl}" target="_blank" rel="noopener noreferrer">
              ${safeUrl}
            </a>
          </div>
        </div>
      `;

  ["jiraIssueLink", "jiraUrlLink"].forEach((id) => {
    const link = document.getElementById(id);
    link?.addEventListener("click", (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: issueUrl });
    });
  });

  ticketCardShown = true;
  updateAttachmentIncludeSyncState();
}

export function showLoginButton(url) {
  const btn = bulkView.hidden ? loginBtn : bulkLoginBtn;
  btn.style.display = "block";
  btn.onclick = () => {
    chrome.tabs.create({ url });
  };
}

export function hideLoginButtons() {
  loginBtn.style.display = "none";
  bulkLoginBtn.style.display = "none";
}

export function redirectToLogin(jiraBaseUrl, projectKey) {
  setStatus("Jira login required.", "error");
  showLoginButton(
    projectKey ? `${jiraBaseUrl}/browse/${projectKey}` : jiraBaseUrl,
  );
}

function createClampedCell(text, className) {
  const wrapper = document.createElement("div");
  wrapper.className = "clamp-cell";

  const span = document.createElement("span");
  span.className = `clamped ${className}`;
  span.textContent = text || "—";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "row-toggle";
  toggle.textContent = "more";
  toggle.style.display = "none";
  toggle.addEventListener("click", () => {
    const expanded = span.classList.toggle("expanded");
    wrapper.classList.toggle("expanded", expanded);
    toggle.textContent = expanded ? "less" : "more";
  });

  wrapper.append(span, toggle);
  return wrapper;
}

let clampUpdateScheduled = false;
function scheduleClampUpdate() {
  if (clampUpdateScheduled) return;
  clampUpdateScheduled = true;
  requestAnimationFrame(() => {
    clampUpdateScheduled = false;
    document.querySelectorAll(".clamp-cell").forEach((cell) => {
      const span = cell.querySelector(".clamped");
      const toggle = cell.querySelector(".row-toggle");
      if (!span || !toggle) return;
      const overflows = span.scrollHeight > span.clientHeight + 1;
      toggle.style.display = overflows ? "inline-flex" : "none";
    });
  });
}

let shiftSelectAnchor = null;

let lastShiftClick = false;

function buildBulkRow(record, site = "Octane") {
  const siteTag = String(site || "Octane").toUpperCase();
  const titleParts = [siteTag, record.idText, record.name].filter(Boolean);
  const title = record.title || titleParts.join(" | ");

  previewIdHeader.textContent = site === "Spark" ? "Number" : "ID";
  const tr = document.createElement("tr");

  const checkTd = document.createElement("td");
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = true;
  checkTd.appendChild(checkbox);

  const idTd = document.createElement("td");
  idTd.className = "row-id";
  if (record.sourceUrl) {
    const link = document.createElement("a");
    link.href = record.sourceUrl;
    link.title = record.sourceUrl;
    link.textContent = record.idText || record.sourceUrl;
    link.rel = "noopener noreferrer";
    link.addEventListener("click", (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: record.sourceUrl });
    });
    idTd.appendChild(link);
  } else if (record.idText) {

    idTd.textContent = record.idText;
  } else {
    idTd.textContent = "—";
  }

  const titleTd = document.createElement("td");
  const titleEl = createClampedCell(title, "row-title");
  titleTd.appendChild(titleEl);

  const descTd = document.createElement("td");
  descTd.appendChild(createClampedCell(record.description, "row-desc"));

  const statusTd = document.createElement("td");
  statusTd.className = "row-status";
  statusTd.dataset.state = "pending";
  statusTd.textContent = "Not started";

  tr.append(checkTd, idTd, titleTd, descTd, statusTd);

  const row = {
    rowIndex: record.rowIndex,
    title,
    name: record.name,
    description: record.description,
    sourceUrl: record.sourceUrl,
    idText: record.idText,
    site: String(site || "Octane"),
    checkbox,
    statusEl: statusTd,
    titleEl,
    tr,
  };
  state.bulkRows.push(row);

  row.checkbox.addEventListener("click", (e) => {
    lastShiftClick = e.shiftKey;
  });
  row.checkbox.addEventListener("change", () => {
    const rangeSelect = lastShiftClick;
    lastShiftClick = false;
    if (rangeSelect && shiftSelectAnchor && shiftSelectAnchor !== row) {
      const thisIndex = state.bulkRows.indexOf(row);
      const anchorIndex = state.bulkRows.indexOf(shiftSelectAnchor);
      if (thisIndex !== -1 && anchorIndex !== -1) {
        const start = Math.min(thisIndex, anchorIndex);
        const end = Math.max(thisIndex, anchorIndex);
        const checked = row.checkbox.checked;
        for (let i = start; i <= end; i++) {
          const r = state.bulkRows[i];
          if (!r.checkbox.disabled) r.checkbox.checked = checked;
        }
      }
    }
    shiftSelectAnchor = row;
    updateSelectionCount();
  });

  return { tr, row };
}

export function addBulkRow(record, site = "Octane") {
  const { tr, row } = buildBulkRow(record, site);
  previewBody.appendChild(tr);
  previewSection.style.display = "block";
  setBulkPreviewCollapsed(false);
  selectAllLabel?.classList.toggle("hidden", bulkBusy);
  updatePreviewTitle();
  updateSelectionCount();
  scheduleClampUpdate();

  return row;
}

export function loadBulkRows(rows, site = "Octane") {
  previewBody.innerHTML = "";
  state.bulkRows = [];
  shiftSelectAnchor = null;

  const fragment = document.createDocumentFragment();
  for (const record of rows) {
    fragment.appendChild(buildBulkRow(record, site).tr);
  }
  previewBody.appendChild(fragment);

  previewSection.style.display = "block";
  setBulkPreviewCollapsed(false);
  selectAllLabel?.classList.toggle("hidden", bulkBusy);
  updatePreviewTitle();
  updateSelectionCount();
  scheduleClampUpdate();

  const revealImport = () => {
    smoothScrollToBottom();
    const focusTarget = importBtn.disabled ? selectAllCheckbox : importBtn;
    focusTarget?.focus?.({ preventScroll: true });
  };
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(revealImport);
  } else {
    revealImport();
  }
}

let scrollFrame = 0;

function smoothScrollTo(target, duration = 420) {
  const scroller = document.body;
  if (
    !scroller ||
    typeof scroller.scrollTop !== "number" ||
    typeof scroller.scrollHeight !== "number"
  ) {
    return;
  }

  cancelAnimationFrame(scrollFrame);

  const start = scroller.scrollTop;
  const startTime = performance.now();
  const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

  const step = (now) => {
    const maxScroll = scroller.scrollHeight - scroller.clientHeight;
    if (!(maxScroll > 0)) return;
    const liveTarget = Math.min(Math.max(0, target), maxScroll);
    const progress = Math.min(1, (now - startTime) / duration);
    scroller.scrollTop = start + (liveTarget - start) * easeOutCubic(progress);
    if (progress < 1) scrollFrame = requestAnimationFrame(step);
  };
  scrollFrame = requestAnimationFrame(step);
}

export function smoothScrollToBottom() {
  const scroller = document.body;
  if (!scroller || typeof scroller.scrollTop !== "number") return;
  smoothScrollTo(Infinity);
}

export function frameBulkView() {
  const run = () => {
    if (bulkView.hidden) return;
    smoothScrollToBottom();
  };
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(run);
  } else {
    run();
  }
}

export function revealStatus() {
  const run = () => smoothScrollToBottom();
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(run);
  } else {
    run();
  }
}
