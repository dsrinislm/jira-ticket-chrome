const el = (id) => document.getElementById(id);

// DOM references, shared mutable state, and view/UI helpers. Imported by
// every module that touches the popup, so it must not import anything else.

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

// Both pickers' "Choose attachments" headers are collapsible: clicking the
// title hides the file list (and note) so the section stays slim during
// creation, without changing the stored selection. Collapsing is purely
// visual, so it's wired here at module scope alongside the refs.
for (const picker of [attachmentPicker, bulkAttachmentPicker]) {
  const collapseBtn = picker?.querySelector(".attachment-picker-collapse");
  collapseBtn?.addEventListener("click", () => {
    const collapsed = picker.classList.toggle("collapsed");
    collapseBtn.setAttribute("aria-expanded", String(!collapsed));
  });
}

// Re-expands a picker (fresh render after a re-enable should show the list,
// even if an earlier run auto-collapsed it). Skipped while the flow is busy
// so a slow async list arriving mid-creation can't pop the picker open again
// over the upload progress.
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

// The picker's selection: null means "not chosen / include everything" (the
// picker was never loaded, e.g. the user created the ticket before the list
// came back), an empty array means the user deselected every file, and a
// non-empty array holds the file names to upload.
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
  // Turning the picker off means the "fully synced" verdict no longer holds —
  // re-show the Create/Sync CTA and re-enable the toggle.
  syncedTicketFound = false;
  updateAttachmentIncludeSyncState();
}

// Shows/hides the inline spinner next to the "Include attachments" toggle.
// Used only while the popup is querying Jira for already-synced files.
export function setAttachmentSyncProgress(visible) {
  const el = document.getElementById("attachmentSyncProgress");
  if (!el) return;
  el.hidden = !visible;
}

// Set while the picker shows the "No attachments found." message — treated as
// "nothing to upload", so the include toggle gets marked checked + disabled.
let attachmentPickerHasNoAttachments = false;

// True while the picker knows the source ticket already exists on Jira (found
// by the handshake). Combined with "every listed attachment already synced",
// that means the Create/Sync CTA has nothing left to do — the UI hides the
// button and points the user at a fresh ticket instead.
let syncedTicketFound = false;

// True once the Create/Sync CTA has actually run and rendered the ticket card
// (renderTicketCard) for the current ticket session. The "fully synced" verdict
// only hides the CTA once the card is on screen — the include-toggle handshake
// alone finding the ticket isn't enough, because the user may still want to
// click the CTA to retrieve the existing ticket.
let ticketCardShown = false;

// Records whether the picker's handshake located the source ticket on Jira.
// Re-evaluates the include-toggle + Create/Sync CTA state right away so a
// fully-synced verdict can hide the button the moment it's known.
export function setSyncedTicketFound(found) {
  syncedTicketFound = Boolean(found);
  updateAttachmentIncludeSyncState();
}

// Marks the start of a fresh Create/Sync run or a navigation to a new ticket:
// clears the previous ticket card and forgets it was rendered, so the "fully
// synced" CTA-hide only re-applies once the new card is actually on screen.
export function resetTicketCard() {
  ticketCardShown = false;
  if (ticketResult) ticketResult.innerHTML = "";
  updateAttachmentIncludeSyncState();
}

// Jira Cloud's gateway rejects attachment uploads above ~25 MB with a 401
// (documented Atlassian bug JRACLOUD-75756), so the picker never lists files
// over this size — attempting them would only fail at upload time. The cutoff
// is 26 MB, not 25, because a 25 MB file can round up past the byte math and
// upload fine; only strictly-larger files are reliably rejected.
export const MAX_ATTACHMENT_UPLOAD_BYTES = 26 * 1024 * 1024;

// Byte size of a picker item: prefers the API-reported sizeBytes and falls
// back to parsing the formatted size string (listings that couldn't reach an
// API — e.g. a Spark page with no sys_id — only have the label).
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

// The picker note ("n files over 25 MB skipped…"); an empty message hides it.
export function setAttachmentNote(message) {
  if (!attachmentNote) return;
  attachmentNote.hidden = !message;
  attachmentNote.textContent = message || "";
}

// Refreshes the single-ticket idle status from the Jira fields. Shared by the
// popup's prompt/input handlers and storage's load so the message never goes
// stale (e.g. still saying "Configure Jira details…" after details load).
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

function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = n;
  let unit = "B";
  for (const u of units) {
    size /= 1024;
    unit = u;
    if (size < 1024) break;
  }
  return `${Number(size.toFixed(size < 10 ? 1 : 0))} ${unit}`;
}

// items: [{ name, size, sizeBytes, type }]; syncedNames: a Set of filenames
// already on Jira for this ticket. Already-synced files stay checked but
// disabled (grayed) and are left out of the selection — the sync only
// re-uploads what's actually missing. Mirrors renderBulkAttachmentPicker.
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
    title.textContent = `${ATTACHMENT_GROUP_LABELS[type]} (${list.length})${groupSize ? ` · ${groupSize}` : ""}`;
    group.appendChild(title);

    for (const item of list) {
      const alreadySynced = syncedNames.has(item.name);
      // Every rendered (non-synced) file starts checked — its name is part
      // of the selection from the start. The picker initializes the selection
      // to exactly these names; an empty array would mean "upload nothing".
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

// True while the single-ticket flow is running (setBusy). The select-all
// toggle is hidden during that whole run — choosing attachments mid-upload is
// pointless, and the picker is collapsed to keep progress front and center.
let singleBusy = false;

// Keeps the picker's global select-all in step with the attachment checkboxes,
// looking only at files that still need syncing (disabled ones are ignored).
// The toggle is hidden while a run is in flight and when there are no
// attachments, or when every attachment is already uploaded to Jira.
function updateAttachmentSelectAll() {
  if (!attachmentSelectAll) return;
  const allBoxes = attachmentGroups.querySelectorAll(
    ".attachment-item input[type='checkbox']",
  );

  const boxes = attachmentGroups.querySelectorAll(
    ".attachment-item:not(.attachment-item-synced) input[type='checkbox']",
  );
  // Nothing left to select — either a run is in flight, there are no
  // attachments at all, or every one is already uploaded (disabled). Drop the
  // Select-all toggle entirely.
  const toggle = attachmentSelectAll.closest(".attachment-picker-toggle");
  toggle?.classList.toggle("hidden", singleBusy || boxes.length === 0);
  let checked = 0;
  for (const box of boxes) if (box.checked) checked++;

  if (boxes.length === 0) {
    // Every attachment is already on Jira (or none exist) — keep the toggle
    // disabled+checked underneath so a later re-render starts consistent.
    attachmentSelectAll.checked = allBoxes.length > 0;
    attachmentSelectAll.disabled = allBoxes.length > 0;
    attachmentSelectAll.indeterminate = false;
    return;
  }
  attachmentSelectAll.disabled = false;
  attachmentSelectAll.checked = checked > 0 && checked === boxes.length;
  attachmentSelectAll.indeterminate = checked > 0 && checked < boxes.length;
}

// Reflects "everything already on Jira" back onto the Include-attachments
// toggle: when every listed attachment is already synced — found via the Jira
// handshake, or after a sync uploaded them — the toggle is marked checked +
// disabled. The picker is left in whatever collapsed/expanded state it's in:
// a run auto-collapses it for upload progress and it must NOT pop back open
// after completion. Otherwise the toggle is left enabled for the user.
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

  // When the CTA has already run and rendered the ticket card for a ticket
  // that's fully synced on Jira — the handshake found it AND every listed
  // attachment is already uploaded — there's nothing left to do. Hide the
  // whole button group (not just the button — an empty group keeps its
  // margin and would leave a gap) and tell the user to move on to a fresh
  // ticket. Until the card is actually on screen the CTA stays clickable so
  // the user can retrieve the existing ticket.
  const fullySyncedTicket = syncedTicketFound && allSynced && ticketCardShown;
  const buttonGroup = createTicketBtn?.closest(".button-group");
  if (buttonGroup) {
    buttonGroup.style.display = fullySyncedTicket ? "none" : "";
  }
  if (fullySyncedTicket) {
    setStatus("Ticket fully synced! try new one.", "success");
  }
}

// After a single-ticket sync uploads files, marks the attachment names that
// were actually uploaded to Jira as synced (checked + disabled) in the open
// picker, so a re-run reflects what the sync just did. Embedded description
// images are unaffected — their synthetic names never match a picker row.
// uploadedNames: [filename, ...].
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

// --- Bulk-import attachment picker ------------------------------------------
// One group per selected ticket; the user checks which files to upload across
// all of them. Selection is kept in state.bulkAttachmentSelection[ticketId] =
// [names], so runListingImport can pass exactly the checked files.

export function getBulkIncludeAttachments() {
  return Boolean(bulkIncludeAttachments?.checked);
}

// The bulk picker's selection map ({ [ticketId]: [names] }), or null when the
// picker was never loaded (toggle off / listing failed) — callers treat null
// as "include everything", matching the single-ticket semantics.
export function getBulkSelectedAttachments() {
  return state.bulkAttachmentSelection;
}

// The bulk attachment section only makes sense while a listing is detected
// (the Excel flow has no attachment source), so detection shows/hides it.
export function setBulkAttachmentSectionVisible(visible) {
  if (!bulkAttachmentSection) return;
  bulkAttachmentSection.style.display = visible ? "block" : "none";
  if (!visible) {
    if (bulkIncludeAttachments) bulkIncludeAttachments.checked = false;
    clearBulkAttachmentPicker();
    setBulkPreviewCollapsed(false);
  }
}

// Collapses the preview table while the bulk attachment picker is open (the
// toggle is checked) so the file picker stays front and center. The table
// re-expands the moment rows are added again — an import must show progress.
// The toolbar (and its manual collapse button) stays visible either way, and
// the button's aria-expanded mirrors the state.
export function setBulkPreviewCollapsed(collapsed) {
  if (!previewSection) return;
  previewSection.classList.toggle("preview-collapsed", Boolean(collapsed));
  previewCollapseBtn?.setAttribute("aria-expanded", String(!collapsed));
}

// Glides the preview table so `row.tr` sits at the top of its scroll area,
// just below the sticky column header. Used during a sync so the most
// recently created/synced ticket stays in view — the workers finish out of
// order, so this re-pins (smoothly) each freshly finished row.
export function scrollBulkRowTop(row, smooth = true) {
  if (!tableWrap || !row?.tr) return;
  const thead = tableWrap.querySelector("thead");
  const headerHeight = thead ? thead.offsetHeight : 0;
  tableWrap.scrollTo({
    top: Math.max(0, row.tr.offsetTop - headerHeight),
    behavior: smooth ? "smooth" : "auto",
  });
}

// Pins the preview table to the top item of the currently selected batch
// (the first ticked, importable row) — not the table's literal first row, so
// a selection that starts further down still opens at its own first item.
// Falls back to the table top when nothing is ticked.
export function scrollBulkToFirstSelected() {
  if (!tableWrap) return;
  const first = state.bulkRows.find(
    (r) => !r.checkbox.disabled && r.checkbox.checked,
  );
  if (first) scrollBulkRowTop(first, false);
  else scrollBulkTableTop();
}

// Scrolls the preview table back to its first row. Used at the start of a
// run (so the sync follows from the top) and when a sync finishes.
export function scrollBulkTableTop(smooth = false) {
  if (!tableWrap) return;
  tableWrap.scrollTo({ top: 0, behavior: smooth ? "smooth" : "auto" });
}

export function setBulkAttachmentNote(message) {
  if (!bulkAttachmentNote) return;
  bulkAttachmentNote.hidden = !message;
  bulkAttachmentNote.textContent = message || "";
}

// Shows/hides the inline spinner next to the "Include attachments" toggle.
// Used only while the popup is querying Jira for already-synced files.
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

// groups: [{ id, attachments: [{ name, size, sizeBytes, type }] }]; labels:
// { [id]: display text for the group title } (e.g. the INC number for Spark);
// syncedMap: { [id]: Set<name> } of attachment names already on Jira for that
// ticket. Already-synced files stay checked but disabled (grayed) and are left
// out of the selection — the import only re-uploads what's actually missing.
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
    // Only files that still need uploading are part of the selection.
    const selectable = files.filter((f) => !synced.has(f.name));
    state.bulkAttachmentSelection[ticketId] = selectable.map((f) => f.name);

    const block = document.createElement("div");
    block.className = "attachment-group";

    const totalBytes = files.reduce(
      (sum, f) => sum + (Number(f.sizeBytes) || 0),
      0,
    );
    const totalSize = formatBytes(totalBytes);

    // A checkbox on the ticket number checks/unchecks all of this ticket's
    // remaining files (already-synced ones stay disabled).
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
    titleText.textContent = `${labels[ticketId] || group.id} (${files.length})${totalSize ? ` · ${totalSize}` : ""}`;
    title.append(groupCheckbox, titleText);
    block.appendChild(title);

    // Keep the raw group data on the block so the title can be refreshed in
    // place when an import later marks some of its files as synced.
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

// Keeps the picker's global select-all in step with the per-ticket checkboxes,
// looking only at files that still need syncing (disabled ones are ignored).
// The toggle is hidden entirely when the selected tickets have no attachments,
// and shown checked when every attachment is already uploaded to Jira.
function updateBulkAttachmentSelectAll() {
  if (!bulkAttachmentSelectAll) return;
  const allBoxes = bulkAttachmentGroups.querySelectorAll(
    ".attachment-item input[type='checkbox']",
  );

  const boxes = bulkAttachmentGroups.querySelectorAll(
    ".attachment-item:not(.attachment-item-synced) input[type='checkbox']",
  );
  // Nothing left to select — either there are no attachments at all, or every
  // one is already uploaded (disabled). Drop the Select-all toggle entirely.
  const toggle = bulkAttachmentSelectAll.closest(".attachment-picker-toggle");
  toggle?.classList.toggle("hidden", boxes.length === 0);
  let checked = 0;
  for (const box of boxes) if (box.checked) checked++;

  if (boxes.length === 0) {
    // Every attachment is already on Jira (or none exist) — keep the toggle
    // disabled+checked underneath so a later re-render starts consistent.
    bulkAttachmentSelectAll.checked = allBoxes.length > 0;
    bulkAttachmentSelectAll.disabled = allBoxes.length > 0;
    bulkAttachmentSelectAll.indeterminate = false;
    return;
  }
  bulkAttachmentSelectAll.disabled = false;
  bulkAttachmentSelectAll.checked = checked > 0 && checked === boxes.length;
  bulkAttachmentSelectAll.indeterminate = checked > 0 && checked < boxes.length;
}

// Set while the picker shows the "No attachments found." message — treated as
// "nothing to upload", so the include toggle gets marked checked + disabled.
let bulkPickerHasNoAttachments = false;

// Reflects "everything already on Jira" back onto the Include-attachments
// toggle: when every listed attachment is already synced — found via the Jira
// handshake, or after an import uploaded them — the toggle is marked checked +
// disabled. Like the single-ticket picker, the panel is left in its current
// collapsed/expanded state — never re-opened after a run completes. Otherwise
// the toggle is left enabled for the user.
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
  // When the include toggle flips to the all-synced/disabled state, the
  // listing sync CTA should disappear (nothing left to attach or re-run).
  updateListingControls();
}

// Marks a ticket's select-all checkbox to match its child attachments: checked
// when every remaining file is checked, unchecked when none are, indeterminate
// in between — and disabled + checked when all of its attachments are already
// uploaded to Jira (nothing left to select).
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

// Re-syncs every ticket's select-all checkbox (used after the global select-all
// toggle flips all children at once).
export function updateBulkGroupChecks() {
  bulkAttachmentGroups
    .querySelectorAll(".attachment-group-check")
    .forEach((groupCheck) => updateGroupCheck(groupCheck.dataset.ticket));
}

// After a bulk run finishes, marks the attachment names that were actually
// uploaded to Jira as synced (checked + disabled) in the open picker, so a
// re-run reflects what the import just did without re-opening the handshake.
// uploadedMap: { [ticketId]: [filename, ...] }.
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

// Rebuilds a group's title ("label (N) · size") from the block's stored
// metadata — the synced count isn't shown, so the refresh just needs to keep
// the label/count/size consistent after an import marks files as synced.
function refreshBulkGroupTitle(ticketId) {
  const block = bulkAttachmentGroups.querySelector(
    `.attachment-group-check[data-ticket="${ticketId}"]`,
  )?.closest(".attachment-group");
  const titleText = block?.querySelector(".attachment-group-title span");
  if (!titleText) return;
  const count = Number(block.dataset.count || 0);
  const size = block.dataset.size || "";
  titleText.textContent = `${block.dataset.title || ticketId} (${count})${size ? ` · ${size}` : ""}`;
}

// After the import handshake, disables preview rows for tickets that already
// exist on Jira with every included attachment already uploaded — they'd be a
// no-op anyway. Purely cosmetic; the worker skips missing files by name.
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

// When the active tab fully matches a site, the source can't be switched
// manually. The selected site's button stays enabled (clicking it just
// re-selects the same site); only the other site's button and the switch
// are disabled.
export function setSourceSiteLocked(locked) {
  sourceSiteInput.disabled = locked;
  const current = getSourceSite();
  sourceSiteLabels.forEach((label) => {
    label.disabled = locked && label.dataset.site !== current;
  });
  document.querySelector(".site-toggle")?.classList.toggle("locked", locked);
}

// Hide the source-site section entirely when no site is detected on the tab;
// the gap left behind is where the decorative canvas lives, so it flips the
// other way.
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

// Manual collapse/expand toggle on the preview toolbar — works independently
// of the include-attachments auto-collapse so the table can be tucked away
// (or brought back) at any time. Wired here, after the refs, so the button
// exists before the listener attaches.
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

// Collapse/expand for the per-ticket media panel. Collapsed keeps only the
// active ticket's row visible (see refreshBulkMediaRowVisibility), trimming
// the panel to a single element; the user's choice survives across runs.
bulkMediaToggle?.addEventListener("click", () => {
  setBulkMediaCollapsed(bulkMediaProgress?.dataset.collapsed !== "true");
});

export const syncProgressSection = el("syncProgressSection");
export const syncProgressLabel = el("syncProgressLabel");
export const syncProgressPercent = el("syncProgressPercent");
export const syncProgressBar = el("syncProgressBar");
export const syncAbortBtn = el("syncAbortBtn");

// Shared mutable state across modules.
export const state = {
  bulkRows: [],
  importData: null,
  importExt: null,
  attachmentSelection: null,
  // Bulk picker selection: { [ticketId]: [selected file names] }. Empty when
  // the picker is closed; per-ticket arrays are empty when the user unchecked
  // everything for that ticket.
  bulkAttachmentSelection: null,
};

const HTML_ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

// Escapes text before it's interpolated into innerHTML. Project keys are
// user input (and project history is persisted across sessions), and the
// ticket key/url come back from the Jira API response — none of that
// should be trusted enough to inject as raw markup.
export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

// state: "info" | "loading" | "success" | "error"
export function setStatus(message, status = "info") {
  statusText.textContent = message;
  statusDiv.dataset.state = status;
  // In-flight status updates drive the shared status bar at the bottom of
  // the popup. Glide to the bottom so the user actually sees the progress
  // (and any follow-up rows/cards) instead of it happening below the fold.
  if (status === "loading") {
    smoothScrollToBottom();
  }
}

export function setBusy(isBusy) {
  singleBusy = Boolean(isBusy);
  createTicketBtn.disabled = isBusy;
  createTicketBtn.dataset.loading = isBusy ? "true" : "false";
  jiraBaseUrlInput.disabled = isBusy;
  projectKeyInput.disabled = isBusy;
  includeAttachmentsInput.disabled = isBusy;
  if (isBusy) collapseAttachmentPickers();
  updateAttachmentSelectAll();
  // After a run the busy guard is gone, so a sync that uploaded every
  // attachment can mark the include toggle checked + disabled again.
  if (!isBusy) updateAttachmentIncludeSyncState();
}

// Collapses any visible attachment picker so creation/progress is front and
// center; the user can re-expand via the header. The stored selection is
// unaffected — collapsing only hides the file list.
export function collapseAttachmentPickers() {
  for (const picker of [attachmentPicker, bulkAttachmentPicker]) {
    if (!picker || picker.hidden) continue;
    picker.classList.add("collapsed");
    picker
      .querySelector(".attachment-picker-collapse")
      ?.setAttribute("aria-expanded", "false");
  }
}

// When every row in the uploaded file has been created or already existed,
// the import CTA is hidden entirely — all work is done. If anything is
// still selectable (failed or unprocessed rows), it stays visible so the
// user can retry just those.
export function lockBulkImport() {
  importBtn.classList.add("hidden");
}

export function unlockBulkImport() {
  // In the listing flow the "Create selected tickets" CTA stays hidden —
  // re-running goes through the "Sync selected … listing" CTA instead.
  if (bulkRowsFromListing) return;
  importBtn.classList.remove("hidden");
  importBtn.disabled = false;
  importBtn.dataset.loading = "false";
}

// Tracks whether a bulk run is in flight. addBulkRow/loadBulkRows consult it
// so rows added mid-sync don't re-show the Select-all toggle the busy state
// just hid.
let bulkBusy = false;

// True while the current bulk preview rows came from a site listing
// (runListingImport) rather than an Excel report. In that flow the "Create
// selected tickets" CTA is never shown — re-running is always done through
// the "Sync selected … listing" CTA, which re-reads the ticked rows from the
// page. Cleared when a report is loaded or the upload is cleared.
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
  // While a bulk run is in progress the preview header keeps only the
  // "Processed N, Selected X of Y" count (right-aligned) — the "Preview
  // selected tickets" caption and the Select-all toggle would only crowd the
  // "Processing N of M" status label. Both come back once the run settles,
  // with Select-all only if anything is still selectable.
  previewCollapseBtn?.classList.toggle("hidden", isBusy);
  selectAllLabel?.classList.toggle("hidden", isBusy);
  if (!isBusy) {
    updateBulkSelectAllVisibility();
    // After a run the busy guard is gone, so an import that finished syncing
    // every attachment can now expand the picker and mark the include toggle.
    updateBulkIncludeSyncState();
  }
}

// Remembers each view's scroll offset so switching tabs restores the user's
// place instead of snapping to the top. Both views scroll inside the popup
// body (html has overflow hidden; body is the actual scroll container).
const viewScroll = { single: 0, bulk: 0 };

export function switchView(view, focusTab = true) {
  const isBulk = view === "bulk";
  const entering = isBulk ? "bulk" : "single";
  const leaving = isBulk ? "single" : "bulk";

  // Capture the outgoing view's scroll before hiding it, while it still has
  // height — a hidden view has none, so reading it there always returns 0.
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

  // Only user-initiated switches (the tab buttons) move focus onto the tab.
  // Automated switches (e.g. disabling the single tab on an unsupported page)
  // must leave focus where it is so the initial focus on the Base URL field
  // isn't stolen.
  if (focusTab) {
    (isBulk ? tabBulk : tabSingle)?.focus?.({ preventScroll: true });
  }

  // Put the entering view back where the user left it. Setting scrollTop is
  // synchronous, so this applies as soon as the new height is laid out.
  document.body.scrollTop = viewScroll[entering] || 0;
}

// The "Current Ticket" flow only works while the active tab is a detected
// Spark/Octane ticket. When the site can't be matched (e.g. an unsupported
// page), the tab is disabled so the user lands on Bulk Import instead.
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

// The site detected on the active tab's listing page (null when the tab isn't
// a supported listing) and whether that listing has at least one ticked row.
// Together they gate the listing-only controls: the "Sync selected … listing"
// CTA and the bulk "Include attachments" section appear only when a site
// import can actually run (listing detected AND something selected) — with
// nothing ticked the Excel flow is the only import path.
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

// True while an Excel report is loaded in the bulk view. The Excel flow has
// no attachment source and no listing page, so while it's active the
// listing-only controls — the "Sync selected … listing" CTA and the bulk
// "Include attachments" section — stay hidden. Clearing the upload restores
// them to whatever the active tab's listing state says.
let excelFlowActive = false;

export function isExcelFlowActive() {
  return excelFlowActive;
}

export function setExcelFlowActive(active) {
  excelFlowActive = Boolean(active);
  updateListingControls();
}

// True when a finished listing run has nothing left to do: every preview row
// was created/synced (checked + disabled), every attachment is already on
// Jira (the include toggle is checked + disabled), and the run's report is
// available to download. In that resting state the "Sync selected … listing"
// CTA is dropped — it would only re-run a no-op.
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

// The listing-only controls show only when the active tab is a supported
// listing with at least one ticked row AND no report is loaded. The sync CTA
// additionally disappears when the whole listing is already synced.
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

// Single entry point that folds the active tab's listing state (site +
// selection) into every listing-dependent control: the dropzone's clear
// affordance and the bulk "Include attachments" section + sync CTA.
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
  // An uploaded report means the Excel flow is the source of truth — the
  // listing CTA and include-attachments picker don't apply while it's loaded.
  setExcelFlowActive(true);
  setBulkRowsFromListing(false);
  // The clear affordance only helps while a site import could actually run —
  // an Octane or Spark listing with rows selected. Reflect the tab's last-known
  // listing state right away so the chip never flashes on when it isn't
  // applicable; the post-parse detection (excel.js) refines this once it
  // resolves.
  updateClearAffordance(activeListingSite, listingHasSelection ? 1 : 0);
}

export function resetDropzone() {
  dropzone.dataset.loaded = "false";
  dropzoneTitle.textContent = "Choose an Excel file";
  dropzoneIcon.innerHTML = DROPZONE_ICON_EXCEL;
  dropzoneHint.innerHTML =
    "Octane: ID/Name/Description<br/>Spark: Number/Short description/Description";
  clearFileBtn.hidden = true;
  // With the upload cleared, the listing-based controls come back (if the
  // active tab is a supported listing).
  setExcelFlowActive(false);
}

// Clears a loaded report and restores the bulk view to its idle state:
// dropzone reset, preview/progress/export cleared, and the listing controls
// (sync CTA + include attachments) re-enabled.
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

// The clear chip on the dropzone. Wired here (after the refs) so the button
// exists before the listener attaches; a click on it clears the upload
// instead of opening the file picker.
clearFileBtn?.addEventListener("click", clearFileUpload);

// The dropzone's clear affordance (the clear button and its "Click clear to
// switch to … importing" hint) is only useful while a site import could
// actually run — that's an Octane or Spark listing with at least one row
// selected. Anywhere else (no supported listing, or a listing with nothing
// ticked) the loaded report is the only viable source, so both stay hidden.
// Outside the Excel flow there's nothing to clear, so the chip stays hidden too.
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

// The count label and status prompt are recomputed on every row-state change,
// and a busy worker pool can land several in a single tick. Coalescing them
// into one rAF pass stops large imports from re-scanning the whole row list
// (and re-rendering the status text) once per row.
let selectionCountScheduled = false;

// The preview toolbar's title shows how many tickets are currently listed.
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

    // While an import is running the progress messages win; only refresh the
    // resting-state prompt when the user is free to tweak the selection.
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
      // Something is ticked again — the create CTA comes back and is ready
      // (Excel flow); in the listing flow the "Sync selected … listing" CTA
      // is the re-run path.
      unlockBulkImport();
      setStatus(
        bulkRowsFromListing
          ? "All set - Sync selected listing to continue"
          : "All set - Export selected tickets into JIRA",
        "info",
      );
    } else {
      // Rows remain but none are ticked. After a run the imported rows are
      // done and the rest needs a fresh pick — keep the CTA hidden until the
      // user selects new items (the Excel flow can batch-create in rounds).
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
    // The listing sync CTA reflects the resting state (hidden once a finished
    // run has nothing left to sync).
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

// Shows the Select-all toggle only when at least one row can still be chosen
// (anything not created/exists). Called after a run settles so an all-done
// table hides the toggle, mirroring reorderBulkRowsAfterImport.
export function updateBulkSelectAllVisibility() {
  if (!selectAllLabel) return;
  const hasSelectable = state.bulkRows.some((r) => !isBulkRowDone(r));
  selectAllLabel.classList.toggle("hidden", !hasSelectable);
}

// After an import, hoist rows that were created or already existed to the
// top of the preview and lock their checkboxes so they can't be re-imported.
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

  // With every row finished, the select-all toggle has nothing left to do
  // (and while the run is still busy it stays hidden regardless).
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

// --- Bulk per-ticket media upload progress ---------------------------------
// One row per ticket that has attachments to upload; tickets are processed one
// at a time, so the current row animates in real time while the rest wait.

// Collapsed mode keeps exactly one row visible — the ticket currently
// uploading (or the next one up, then the last one finished) — so the panel
// stays one element tall while a run is in progress. Expanded shows every row.
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

// Renders a row per label (the ticket's short id) and shows the section.
// An empty list hides the section — used when a run has no media to upload.
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

    // Per-ticket file count under the bar ("3 of 5 files uploaded…"),
    // filled in by updateBulkMediaFiles as files complete. Starts at "0 files"
    // so the hint line is present (and the row height fixed) from the start.
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

// Marks a row as the one currently uploading (resetting its bar to 0) and
// brings it into view — in expanded mode the list may be scrolled past it, so
// the active ticket stays on screen as it uploads.
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

// Real-time byte progress for a ticket's upload. `loaded`/`total` are bytes;
// an optional `label` overrides the default "formatted / formatted" bytes text.
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

// Marks a ticket's media upload as finished (100%, green) and finalizes the
// file-count hint: "N files uploaded" (or "N of M" when some failed).
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

// Per-ticket file progress for the hint under the bar. `uploaded`/`total` are
// file counts on this ticket; while still uploading it reads "X of N
// files…", and once the row is done setBulkMediaProgressDone rewrites it.
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

// Byte-level upload progress for the single-ticket flow (bulk flows track row
// counts via updateProgress instead). `loaded`/`total` are bytes; the caller
// formats the size label (ui.js imports nothing, so bytes stay raw here).
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

  // The card is now on screen — if this ticket is fully synced the CTA has
  // nothing left to do, so let the include-sync state re-evaluate and hide it.
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

// Builds a table cell whose text is clamped to 3 lines with a per-row
// "more"/"less" toggle for the overflow. The toggle stays hidden until the
// text actually overflows (measured once layout settles).
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

// Hides the "more" toggle on any cell whose text already fits within the
// 3-line clamp. addBulkRow requests this after every row, so a single
// pending flag coalesces a whole batch (Excel load, listing import) into
// one measurement pass instead of one rAF + full re-scan per row.
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

// Shift-click support for the preview table's row checkboxes. The last
// checkbox the user clicked becomes the anchor; a shift+click on another row
// then flips every checkbox between the two to the clicked row's state.
let shiftSelectAnchor = null;
// The change event doesn't carry modifier keys, so the click handler (a real
// MouseEvent) records whether shift was held for the toggle that follows.
let lastShiftClick = false;

// Builds a single preview row without touching the DOM tree, returning
// { tr, row }. addBulkRow appends it immediately (streaming listing flow);
// loadBulkRows collects the tr's into a fragment for one bulk append.
function buildBulkRow(record, site = "Octane") {
  const siteTag = String(site || "Octane").toUpperCase();
  const titleParts = [siteTag, record.idText, record.name].filter(Boolean);
  const title = record.title || titleParts.join(" | ");
  // Mirror the site's report schema in the id column header so the preview
  // matches what will be exported (and round-trip on re-import): INC
  // "Number" for Spark, numeric "ID" for Octane.
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
    // No link (e.g. a Spark export whose Number cell is plain text) — still
    // show the incident number instead of leaving the cell empty.
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

  // The click handler only records the modifier keys (change events don't
  // carry them); the change handler applies the range and refreshes counts.
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

// Adds a single row to the bulk preview and returns it. Used both by
// loadBulkRows (Excel reports render all rows at once) and by the Octane
// page flow, which lists each scraped ticket as it is processed.
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

  // One bulk append (via a fragment) instead of N separate ones — large
  // Excel reports render noticeably faster this way.
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

  // The freshly populated preview can push the import CTA and the status
  // message below the fold; glide all the way down so the whole status bar is
  // in view, then land focus on the action the user is ready to take.
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

// One in-flight glide at a time: rapid progress updates (a busy worker pool,
// per-row status lines) cancel the previous glide instead of stacking
// competing animations.
let scrollFrame = 0;

// Glides the popup's vertical scroll to `target` (a document-body scroll
// position) with a gentle ease-out curve, so the animation feels deliberate
// rather than a snap. The target is re-clamped to the scrollable range on
// every frame, so content that grows mid-glide (preview rows, ticket cards)
// still lands at the right spot instead of stopping short.
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

// Glides the popup to its very bottom (past the status bar). An unbounded
// target keeps the glide tracking the live bottom, so a document that is
// still growing finishes all the way at the end.
export function smoothScrollToBottom() {
  const scroller = document.body;
  if (!scroller || typeof scroller.scrollTop !== "number") return;
  smoothScrollTo(Infinity);
}

// Glides back to the bottom of the popup so the import progress bar and the
// shared status message are visible. The layout (buttons, status, rows) has
// settled by the time an import's finally runs, and the glide tracks the
// live document height, so it reaches the true end even as rows finish.
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

// Glides to the bottom of the popup so the freshly rendered ticket card and
// the shared status message are in view after a create finishes.
export function revealStatus() {
  const run = () => smoothScrollToBottom();
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(run);
  } else {
    run();
  }
}
