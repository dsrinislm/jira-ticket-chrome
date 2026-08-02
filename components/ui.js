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

// Shared mutable state across modules.
export const state = {
  bulkRows: [],
  importData: null,
  importExt: null,
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
}

export function setBusy(isBusy) {
  createTicketBtn.disabled = isBusy;
  createTicketBtn.dataset.loading = isBusy ? "true" : "false";
  jiraBaseUrlInput.disabled = isBusy;
  projectKeyInput.disabled = isBusy;
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

export function switchView(view) {
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

  (isBulk ? tabBulk : tabSingle)?.focus?.({ preventScroll: true });
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

export function updateSelectionCount() {
  const selected = state.bulkRows.filter(
    (r) => !r.checkbox.disabled && r.checkbox.checked,
  ).length;
  const processed = state.bulkRows.filter((r) =>
    ["created", "exists", "error"].includes(r.statusEl.dataset.state),
  ).length;

  if (selected === 0) {
    selectionCount.textContent = "";
  } else {
    const processedLabel = processed > 0 ? `Processed ${processed}, ` : "";
    selectionCount.textContent = `${processedLabel}Selected ${selected} of ${state.bulkRows.length}`;
  }

  // While an import is running the progress messages win; only refresh the
  // resting-state prompt when the user is free to tweak the selection.
  if (!state.bulkRows.length || importBtn.disabled) return;

  const selectable = state.bulkRows.filter((r) => !r.checkbox.disabled).length;
  if (selectable === 0) {
    setStatus("Bulk import done! try different report", "success");
  } else if (selected > 0) {
    setStatus("All set - Export selected tickets into JIRA", "info");
  } else {
    setStatus("Select the tickets to import.", "info");
  }
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

// After the preview renders, hide the "more" toggle on any cell whose text
// already fits within the 3-line clamp.
function updateClampToggles() {
  requestAnimationFrame(() => {
    document.querySelectorAll(".clamp-cell").forEach((cell) => {
      const span = cell.querySelector(".clamped");
      const toggle = cell.querySelector(".row-toggle");
      if (!span || !toggle) return;
      const overflows = span.scrollHeight > span.clientHeight + 1;
      toggle.style.display = overflows ? "inline-flex" : "none";
    });
  });
}

// Adds a single row to the bulk preview and returns it. Used both by
// loadBulkRows (Excel reports render all rows at once) and by the Octane
// page flow, which lists each scraped ticket as it is processed.
export function addBulkRow(record, site = "Octane") {
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
  previewBody.appendChild(tr);

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

  previewSection.style.display = "block";
  selectAllLabel?.classList.remove("hidden");
  updateSelectionCount();
  updateClampToggles();

  return row;
}

export function loadBulkRows(rows, site = "Octane") {
  previewBody.innerHTML = "";
  state.bulkRows = [];

  rows.forEach((record) => addBulkRow(record, site));

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

// Glides the popup's vertical scroll to `target` (a document-body scroll
// position) with a gentle ease-out curve, so the animation feels deliberate
// rather than a snap. The target is clamped to the scrollable range.
function smoothScrollTo(target, duration = 420) {
  const scroller = document.body;
  if (
    !scroller ||
    typeof scroller.scrollTop !== "number" ||
    typeof scroller.scrollHeight !== "number"
  ) {
    return;
  }
  const maxScroll = scroller.scrollHeight - scroller.clientHeight;
  if (!(maxScroll > 0)) return;

  const start = scroller.scrollTop;
  const distance = Math.min(Math.max(0, target), maxScroll) - start;
  if (!distance) return;

  const startTime = performance.now();
  const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
  const step = (now) => {
    const progress = Math.min(1, (now - startTime) / duration);
    scroller.scrollTop = start + distance * easeOutCubic(progress);
    if (progress < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// Glides the popup to its very bottom (past the status bar).
function smoothScrollToBottom() {
  const scroller = document.body;
  if (!scroller || typeof scroller.scrollTop !== "number") return;
  smoothScrollTo(scroller.scrollHeight - scroller.clientHeight);
}

// Glides the popup so `el`'s top edge sits at the top of the viewport. When
// the content above would push the bottom out of reach, it clamps so the
// status bar stays visible.
export function smoothScrollToElement(el, duration = 420) {
  const scroller = document.body;
  if (
    !el ||
    !scroller ||
    typeof scroller.scrollTop !== "number" ||
    typeof scroller.scrollHeight !== "number"
  ) {
    return;
  }
  const elTop = el.getBoundingClientRect().top + scroller.scrollTop;
  smoothScrollTo(elTop, duration);
}
