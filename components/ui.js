const el = (id) => document.getElementById(id);

// DOM references, shared mutable state, and view/UI helpers. Imported by
// every module that touches the popup, so it must not import anything else.

export const statusDiv = el("status");
export const statusText = el("statusText");
export const ticketResult = el("ticketResult");
export const gapArt = el("gapArt");
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
export const attachmentGroups = el("attachmentGroups");
export const attachmentSelectAll = el("attachmentSelectAll");
export const attachmentNote = el("attachmentNote");

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
  attachmentGroups.innerHTML = "";
  setAttachmentNote("");
  state.attachmentSelection = null;
}

export function clearAttachmentPicker() {
  attachmentPicker.hidden = true;
  attachmentGroups.innerHTML = "";
  setAttachmentNote("");
  attachmentSelectAll.checked = true;
  state.attachmentSelection = null;
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

export function renderAttachmentPicker(items) {
  attachmentPicker.hidden = false;
  attachmentGroups.innerHTML = "";
  state.attachmentSelection = items.map((i) => i.name);

  const grouped = { video: [], image: [], other: [] };
  for (const item of items) {
    const type =
      item.type === "video" || item.type === "image" ? item.type : "other";
    grouped[type].push(item);
  }

  for (const [type, list] of Object.entries(grouped)) {
    if (!list.length) continue;
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
      const row = document.createElement("label");
      row.className = "attachment-item";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = true;
      checkbox.dataset.name = item.name;
      checkbox.addEventListener("change", () => {
        const selected = state.attachmentSelection || [];
        state.attachmentSelection = checkbox.checked
          ? [...selected, item.name]
          : selected.filter((n) => n !== item.name);
      });

      const name = document.createElement("span");
      name.className = "attachment-item-name";
      name.textContent = item.name;
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
export const selectAllCheckbox = el("selectAllCheckbox");
export const selectAllLabel = document.querySelector(".select-all");
export const selectionCount = el("selectionCount");
export const importBtn = el("importBtn");
export const listingImportBtn = el("listingImportBtn");
export const listingImportLabel = el("listingImportLabel");
export const dropzone = document.querySelector(".file-dropzone");
export const dropzoneTitle = el("dropzoneTitle");
export const dropzoneHint = el("dropzoneHint");
export const dropzoneIcon = el("dropzoneIcon");
export const progressSection = el("progressSection");
export const progressLabel = el("progressLabel");
export const progressPercent = el("progressPercent");
export const progressBar = el("progressBar");
export const abortImportBtn = el("abortImportBtn");

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
  createTicketBtn.disabled = isBusy;
  createTicketBtn.dataset.loading = isBusy ? "true" : "false";
  jiraBaseUrlInput.disabled = isBusy;
  projectKeyInput.disabled = isBusy;
  includeAttachmentsInput.disabled = isBusy;
}

// When every row in the uploaded file has been created or already existed,
// the import CTA is hidden entirely — all work is done. If anything is
// still selectable (failed or unprocessed rows), it stays visible so the
// user can retry just those.
export function lockBulkImport() {
  importBtn.classList.add("hidden");
}

export function unlockBulkImport() {
  importBtn.classList.remove("hidden");
  importBtn.disabled = false;
  importBtn.dataset.loading = "false";
}

export function setBulkBusy(isBusy) {
  importBtn.disabled = isBusy;
  importBtn.dataset.loading = isBusy ? "true" : "false";
  fileInput.disabled = isBusy;
  listingImportBtn.disabled = isBusy;
}

export function switchView(view, focusTab = true) {
  const isBulk = view === "bulk";

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
      ? activeListingSite
        ? "Upload report or Import selected listing"
        : "Upload Octane or Spark report"
      : "Configure Jira details and create a ticket.",
    "info",
  );
}

// The site detected on the active tab's listing page (null when the tab isn't
// a supported listing). Lets the bulk status message say "Import selected
// listing" only where that action actually exists.
let activeListingSite = null;

export function setActiveListingSite(site) {
  activeListingSite = site || null;
}

export function getActiveListingSite() {
  return activeListingSite;
}

const DROPZONE_ICON_EXCEL =
  '<rect x="4" y="4" width="16" height="16" rx="2.5" stroke="currentColor" stroke-width="1.8"/><path d="M4 9.5h16M9.5 4v16M14.5 9.5V20" stroke="currentColor" stroke-width="1.8"/>';
const DROPZONE_ICON_CHECK =
  '<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8"/><path d="m8.5 12 2.5 2.5 4.5-5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>';

export function setDropzoneLoaded() {
  dropzone.dataset.loaded = "true";
  dropzoneTitle.textContent = "Upload Done";
  dropzoneIcon.innerHTML = DROPZONE_ICON_CHECK;
}

export function resetDropzone() {
  dropzone.dataset.loaded = "false";
  dropzoneTitle.textContent = "Choose an Excel file";
  dropzoneIcon.innerHTML = DROPZONE_ICON_EXCEL;
  dropzoneHint.innerHTML =
    "Octane: ID/Name/Description<br/>Spark: Number/Short description/Description";
}

// The count label and status prompt are recomputed on every row-state change,
// and a busy worker pool can land several in a single tick. Coalescing them
// into one rAF pass stops large imports from re-scanning the whole row list
// (and re-rendering the status text) once per row.
let selectionCountScheduled = false;
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
      setStatus("Bulk import done! try different report", "success");
    } else if (selected > 0) {
      setStatus("All set - Export selected tickets into JIRA", "info");
    } else {
      setStatus("Select the tickets to import.", "info");
    }
  });
}

export function toggleSelectAll() {
  state.bulkRows.forEach((r) => {
    if (!r.checkbox.disabled) r.checkbox.checked = selectAllCheckbox.checked;
  });
  updateSelectionCount();
}

// After an import, hoist rows that were created or already existed to the
// top of the preview and lock their checkboxes so they can't be re-imported.
export function reorderBulkRowsAfterImport() {
  const isDone = (r) =>
    r.statusEl.dataset.state === "created" || r.statusEl.dataset.state === "exists";

  const done = [];
  const rest = [];
  state.bulkRows.forEach((r) => (isDone(r) ? done : rest).push(r));
  state.bulkRows = [...done, ...rest];

  const fragment = document.createDocumentFragment();
  state.bulkRows.forEach((r) => {
    if (isDone(r)) {
      r.checkbox.disabled = true;
      r.checkbox.checked = true;
      r.tr.classList.add("row-done");
    }
    fragment.appendChild(r.tr);
  });
  previewBody.appendChild(fragment);

  // With every row finished, the select-all toggle has nothing left to do.
  const allDone = state.bulkRows.every(isDone);
  selectAllLabel?.classList.toggle("hidden", allDone);

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
  checkbox.addEventListener("change", updateSelectionCount);
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

  return { tr, row };
}

// Adds a single row to the bulk preview and returns it. Used both by
// loadBulkRows (Excel reports render all rows at once) and by the Octane
// page flow, which lists each scraped ticket as it is processed.
export function addBulkRow(record, site = "Octane") {
  const { tr, row } = buildBulkRow(record, site);
  previewBody.appendChild(tr);
  previewSection.style.display = "block";
  selectAllLabel?.classList.remove("hidden");
  updateSelectionCount();
  scheduleClampUpdate();

  return row;
}

export function loadBulkRows(rows, site = "Octane") {
  previewBody.innerHTML = "";
  state.bulkRows = [];

  // One bulk append (via a fragment) instead of N separate ones — large
  // Excel reports render noticeably faster this way.
  const fragment = document.createDocumentFragment();
  for (const record of rows) {
    fragment.appendChild(buildBulkRow(record, site).tr);
  }
  previewBody.appendChild(fragment);

  previewSection.style.display = "block";
  selectAllLabel?.classList.remove("hidden");
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
