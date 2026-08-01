const el = (id) => document.getElementById(id);

// DOM references, shared mutable state, and view/UI helpers. Imported by
// every module that touches the popup, so it must not import anything else.

export const statusDiv = el("status");
export const statusText = el("statusText");
export const ticketResult = el("ticketResult");
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
// manually — disable the toggle and its labels.
export function setSourceSiteLocked(locked) {
  sourceSiteInput.disabled = locked;
  sourceSiteLabels.forEach((label) => (label.disabled = locked));
  document.querySelector(".site-toggle")?.classList.toggle("locked", locked);
}

// Hide the source-site section entirely when no site is detected on the tab.
export function setSourceSiteVisible(visible) {
  sourceSiteSwitch
    .closest(".field-block")
    ?.classList.toggle("hidden", !visible);
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
export const selectAllCheckbox = el("selectAllCheckbox");
export const selectionCount = el("selectionCount");
export const importBtn = el("importBtn");
export const dropzone = document.querySelector(".file-dropzone");
export const dropzoneTitle = el("dropzoneTitle");
export const dropzoneHint = el("dropzoneHint");
export const progressSection = el("progressSection");
export const progressLabel = el("progressLabel");
export const progressPercent = el("progressPercent");
export const progressBar = el("progressBar");

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

export function setBulkBusy(isBusy) {
  importBtn.disabled = isBusy;
  importBtn.dataset.loading = isBusy ? "true" : "false";
  fileInput.disabled = isBusy;
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
    setStatus("Configure Jira details and create a ticket.", "info");
  }
}

export function updateBulkStatusMessage() {
  const jiraConfigured =
    jiraBaseUrlInput.value.trim() && projectKeyInput.value.trim();
  setStatus(
    jiraConfigured
      ? "Upload octane report"
      : "Configure Jira details and create a ticket.",
    "info",
  );
}

export function resetDropzone() {
  dropzone.dataset.loaded = "false";
  dropzoneTitle.textContent = "Choose an Excel file";
  dropzoneHint.textContent = "Needs ID, Name and Description columns";
}

export function updateSelectionCount() {
  const selected = state.bulkRows.filter((r) => r.checkbox.checked).length;
  selectionCount.textContent = `${selected} of ${state.bulkRows.length} selected`;
}

export function toggleSelectAll() {
  state.bulkRows.forEach((r) => (r.checkbox.checked = selectAllCheckbox.checked));
  updateSelectionCount();
}

export function setRowStatus(row, rowState, html) {
  row.statusEl.dataset.state = rowState;
  row.statusEl.innerHTML = html;
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

export function loadBulkRows(parsed) {
  previewBody.innerHTML = "";
  state.bulkRows = [];

  const fragment = document.createDocumentFragment();

  parsed.forEach((record) => {
    const titleParts = ["OCTANE", record.idText, record.name].filter(Boolean);
    const title = titleParts.join(" | ");
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
    } else {
      idTd.textContent = "—";
    }

    const titleTd = document.createElement("td");
    const titleSpan = document.createElement("span");
    titleSpan.className = "row-title";
    titleSpan.textContent = title;
    titleTd.appendChild(titleSpan);

    const descTd = document.createElement("td");
    descTd.className = "row-desc";
    descTd.title = record.description;
    descTd.textContent = record.description.slice(0, 100) || "—";

    const statusTd = document.createElement("td");
    statusTd.className = "row-status";
    statusTd.dataset.state = "pending";
    statusTd.textContent = "Not started";

    tr.append(checkTd, idTd, titleTd, descTd, statusTd);
    fragment.appendChild(tr);

    state.bulkRows.push({
      rowIndex: record.rowIndex,
      title,
      name: record.name,
      description: record.description,
      sourceUrl: record.sourceUrl,
      idText: record.idText,
      checkbox,
      statusEl: statusTd,
    });
  });

  previewBody.appendChild(fragment);
  previewSection.style.display = "block";
  updateSelectionCount();
}
