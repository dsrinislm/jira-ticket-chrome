const statusDiv = document.getElementById("status");
const statusText = document.getElementById("statusText");
const ticketResult = document.getElementById("ticketResult");
const loginBtn = document.getElementById("openWebsite");
const jiraBaseUrlInput = document.getElementById("jiraBaseUrl");
const jiraBaseUrlError = document.getElementById("jiraBaseUrlError");
const projectKeyInput = document.getElementById("projectKey");
const createTicketBtn = document.getElementById("createTicket");
const projectTagsContainer = document.getElementById("projectTags");
const singleView = document.getElementById("singleView");
const bulkView = document.getElementById("bulkView");
const tabSingle = document.getElementById("tabSingle");
const tabBulk = document.getElementById("tabBulk");
const fileInput = document.getElementById("fileInput");
const fileError = document.getElementById("fileError");
const fileSummary = document.getElementById("fileSummary");
const previewSection = document.getElementById("previewSection");
const previewBody = document.getElementById("previewBody");
const selectAllCheckbox = document.getElementById("selectAllCheckbox");
const selectionCount = document.getElementById("selectionCount");
const importBtn = document.getElementById("importBtn");
const dropzone = document.querySelector(".file-dropzone");
const dropzoneTitle = document.getElementById("dropzoneTitle");
const dropzoneHint = document.getElementById("dropzoneHint");
const progressSection = document.getElementById("progressSection");
const progressLabel = document.getElementById("progressLabel");
const progressPercent = document.getElementById("progressPercent");
const progressBar = document.getElementById("progressBar");

let bulkRows = [];

const debouncedSaveSettings = debounce(saveSettings, 300);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

// The script loads at the end of <body>, so the DOM is already parsed —
// no need to wait for DOMContentLoaded.
loadInitialState();

tabSingle.addEventListener("click", () => switchView("single"));
tabBulk.addEventListener("click", () => switchView("bulk"));
selectAllCheckbox.addEventListener("change", toggleSelectAll);
fileInput.addEventListener("change", handleFileSelected);
importBtn.addEventListener("click", runBulkImport);

jiraBaseUrlInput.addEventListener("input", () => {
  // Never introduce a new error while typing — only clear one that's
  // already showing, the moment the value becomes valid again.
  enforceJiraBaseUrlNoPath();
  clearJiraBaseUrlErrorIfNowValid();
  debouncedSaveSettings();
});

jiraBaseUrlInput.addEventListener("blur", validateJiraBaseUrlField);
projectKeyInput.addEventListener("input", debouncedSaveSettings);
createTicketBtn.addEventListener("click", createTicket);

function switchView(view) {
  const isBulk = view === "bulk";

  singleView.hidden = isBulk;
  bulkView.hidden = !isBulk;

  tabSingle.classList.toggle("active", !isBulk);
  tabSingle.setAttribute("aria-selected", String(!isBulk));
  tabBulk.classList.toggle("active", isBulk);
  tabBulk.setAttribute("aria-selected", String(isBulk));

  setStatus(
    isBulk
      ? "Select the file to import."
      : "Configure Jira details and create a ticket.",
    "info",
  );
}

// Plain-text Description column -> ADF. Blank lines separate paragraphs;
// single newlines become hard breaks (ADF has no bare "\n" semantics).
function textToADF(text) {
  const normalized = String(text ?? "")
    .replace(/\r\n/g, "\n")
    .trim();
  if (!normalized)
    return {
      version: 1,
      type: "doc",
      content: [{ type: "paragraph", content: [] }],
    };

  const blocks = normalized.split(/\n{2,}/);
  const content = blocks.map((block) => {
    const lines = block.split("\n");
    const inline = [];
    lines.forEach((line, i) => {
      if (i > 0) inline.push({ type: "hardBreak" });
      if (line.length) inline.push({ type: "text", text: line });
    });
    return { type: "paragraph", content: inline };
  });

  return { version: 1, type: "doc", content };
}

// ADF for bulk rows: the same SOURCE TICKET URL header the single-ticket
// flow adds, built from the Excel "ID" column, followed by the
// Description column as plain-text paragraphs. No ID -> description only.
function buildIssueDescription(sourceUrl, description) {
  const bodyAdf = textToADF(description);

  const sourceBlock = sourceUrl
    ? [
        {
          type: "heading",
          attrs: { level: 3 },
          content: [{ type: "text", text: "SOURCE TICKET URL" }],
        },
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: sourceUrl,
              marks: [{ type: "link", attrs: { href: sourceUrl } }],
            },
          ],
        },
        { type: "paragraph", content: [] },
      ]
    : [];

  return {
    version: 1,
    type: "doc",
    content: [...sourceBlock, ...bodyAdf.content],
  };
}

// Reads rows from the first worksheet as
// { name, description, sourceUrl, idText }. Columns are matched by header
// (case-insensitive, substring-tolerant) so variations like "Name", "ID",
// "Id", "Description" all work. For the ID column we keep both the display
// text (what the cell shows) and the hyperlink URL, since linked cells
// store the real address in cell.l.Target while SheetJS surfaces only the
// display text via cell.w / cell.v.
function parseSheetRows(sheet) {
  const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
  if (!aoa.length) return [];

  const headers = aoa[0].map((h) => String(h).trim().toLowerCase());
  const findCol = (needle) => {
    const exact = headers.indexOf(needle);
    if (exact !== -1) return exact;
    return headers.findIndex((h) => h.includes(needle));
  };

  const nameIdx = findCol("name");
  const descIdx = findCol("description");
  const idIdx = findCol("id");

  const parsed = [];
  for (let r = 1; r < aoa.length; r++) {
    const name = String(aoa[r][nameIdx] ?? "").trim();
    if (!name) continue;

    const idCell = readCell(sheet, r, idIdx);
    parsed.push({
      name,
      description: String(aoa[r][descIdx] ?? "").trim(),
      sourceUrl: idCell.url,
      idText: idCell.text,
    });
  }
  return parsed;
}

// Reads a cell's display text plus its hyperlink target. The URL falls
// back to the display text when the cell isn't linked.
function readCell(sheet, row, colIdx) {
  if (colIdx < 0) return { text: "", url: "" };
  const cell = sheet[XLSX.utils.encode_cell({ r: row, c: colIdx })];
  if (!cell) return { text: "", url: "" };
  const text = String(cell.w ?? cell.v ?? "").trim();
  const url = String(cell.l?.Target ?? "").trim();
  return { text, url: url || text };
}

function handleFileSelected() {
  const file = fileInput.files[0];
  fileError.style.display = "none";
  previewSection.style.display = "none";
  progressSection.style.display = "none";
  bulkRows = [];

  if (!file) return;

  dropzone.dataset.loaded = "true";
  dropzoneTitle.textContent = file.name;
  dropzoneHint.textContent = "Reading file…";

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const workbook = XLSX.read(e.target.result, { type: "array" });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const parsed = parseSheetRows(sheet);

      if (!parsed.length) {
        resetDropzone();
        fileError.textContent =
          'No usable rows found — check for a "Name" column.';
        fileError.style.display = "block";
        return;
      }

      loadBulkRows(parsed);
      dropzoneHint.textContent = "Click to choose a different file";
      fileSummary.textContent = `${parsed.length} row(s) loaded.`;
      setStatus("Select the tickets to import.", "info");
    } catch (err) {
      resetDropzone();
      fileError.textContent = `Couldn't read that file: ${err.message}`;
      fileError.style.display = "block";
    }
  };
  reader.onerror = () => {
    resetDropzone();
    fileError.textContent = "Failed to read the file.";
    fileError.style.display = "block";
  };
  reader.readAsArrayBuffer(file);
}

function resetDropzone() {
  dropzone.dataset.loaded = "false";
  dropzoneTitle.textContent = "Choose an Excel file";
  dropzoneHint.textContent = '.xlsx or .xls · a "Name" column is required';
}

function loadBulkRows(parsed) {
  previewBody.innerHTML = "";
  bulkRows = [];

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

    bulkRows.push({
      title,
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

function toggleSelectAll() {
  bulkRows.forEach((r) => (r.checkbox.checked = selectAllCheckbox.checked));
  updateSelectionCount();
}

function updateSelectionCount() {
  const selected = bulkRows.filter((r) => r.checkbox.checked).length;
  selectionCount.textContent = `${selected} of ${bulkRows.length} selected`;
}

function setRowStatus(row, state, html) {
  row.statusEl.dataset.state = state;
  row.statusEl.innerHTML = html;
}
function escapeJqlString(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// Jira deprecated GET /rest/api/3/search in favor of the enhanced
// JQL search endpoint — use that here.
async function findExistingJiraIssue(jiraBaseUrl, projectKey, summary) {
  const jql = `project = "${escapeJqlString(projectKey)}" AND summary ~ "${escapeJqlString(summary)}"`;

  let response;
  try {
    response = await jiraFetch(jiraBaseUrl, "/rest/api/3/search/jql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jql, fields: ["summary"], maxResults: 50 }),
    });
  } catch {
    return { error: true, issue: null };
  }

  if (!response.ok) return { error: true, issue: null };

  const data = await response.json();
  const target = summary.trim().toLowerCase();
  const match = (data.issues || []).find(
    (issue) => issue.fields?.summary?.trim().toLowerCase() === target,
  );

  return { error: false, issue: match || null };
}

function renderTicketCard(issueKey, issueUrl) {
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

async function runBulkImport() {
  const ctx = getJiraContext();
  if (!ctx) return;

  const selectedRows = bulkRows.filter((r) => r.checkbox.checked);
  if (!selectedRows.length) {
    setStatus("Select at least one row to import.", "error");
    return;
  }

  const { jiraOrigin, projectKey } = ctx;
  saveSettings();

  setBulkBusy(true);

  try {
    setStatus("Checking Jira session...", "loading");
    if (!(await isJiraLoggedIn(jiraOrigin))) {
      setStatus(
        "Jira login required. Open Jira in a tab, log in, then retry.",
        "error",
      );
      return;
    }

    setStatus("Validating project access...", "loading");
    const projectValidation = await validateProject(jiraOrigin, projectKey);
    if (!projectValidation.success) {
      setStatus(projectValidation.message, "error");
      return;
    }

    let created = 0,
      skipped = 0,
      failed = 0;

    progressSection.style.display = "block";
    updateProgress(0, selectedRows.length, "Starting import…");

    for (let i = 0; i < selectedRows.length; i++) {
      const row = selectedRows[i];
      setStatus(`Processing ${i + 1} of ${selectedRows.length}...`, "loading");
      setRowStatus(row, "checking", "Checking…");

      try {
        const existing = await findExistingJiraIssue(
          jiraOrigin,
          projectKey,
          row.title,
        );

        if (existing.error) {
          setRowStatus(row, "error", "Duplicate check failed");
          failed++;
        } else if (existing.issue) {
          const url = `${jiraOrigin}/browse/${existing.issue.key}`;
          setRowStatus(
            row,
            "exists",
            `Already exists — <a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(existing.issue.key)}</a>`,
          );
          skipped++;
        } else {
          setRowStatus(row, "creating", "Creating…");
          const issue = await createJiraIssue(
            jiraOrigin,
            projectKey,
            row.title,
            buildIssueDescription(row.sourceUrl, row.description),
          );
          const url = `${jiraOrigin}/browse/${issue.key}`;
          setRowStatus(
            row,
            "created",
            `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(issue.key)}</a>`,
          );
          created++;
        }
      } catch (err) {
        setRowStatus(row, "error", escapeHtml(err.message || "Failed"));
        failed++;
      }

      await sleep(250);
      updateProgress(i + 1, selectedRows.length);
    }

    updateProgress(selectedRows.length, selectedRows.length, "Import complete");

    setStatus(
      `Done. ${created} created, ${skipped} already existed, ${failed} failed.`,
      failed ? "error" : "success",
    );
  } finally {
    setBulkBusy(false);
  }
}

function updateProgress(completed, total, label) {
  const pct =
    total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0;
  progressBar.style.width = `${pct}%`;
  progressBar.dataset.done = String(completed >= total && total > 0);
  progressPercent.textContent = `${pct}%`;
  progressSection.setAttribute("aria-valuenow", String(pct));
  progressLabel.textContent = label || `Importing ${completed} of ${total}…`;
}
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
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

// Strips anything past the origin (path, query, hash) so the field can
// never actually hold more than a base URL — called live as the user
// types, rather than erroring after the fact.
function stripPathFromJiraBaseUrl(value) {
  const value_ = value.trim();
  if (!value_) return value;

  let url;
  try {
    url = new URL(value_);
  } catch {
    return value; // not parseable yet (still mid-typing the host) — leave as-is
  }

  const hasExtra =
    (url.pathname && url.pathname !== "/") || url.search || url.hash;
  if (!hasExtra) return value;

  return url.origin;
}

function enforceJiraBaseUrlNoPath() {
  const current = jiraBaseUrlInput.value;
  const stripped = stripPathFromJiraBaseUrl(current);

  if (stripped !== current) {
    jiraBaseUrlInput.value = stripped;
    // Cursor goes to the end — the removed part was always the tail.
    const end = stripped.length;
    jiraBaseUrlInput.setSelectionRange(end, end);
  }
}

/**
 * Validates that a string is a plausible Jira base URL:
 * - parses as an absolute URL
 * - uses https (Jira Cloud/Server never legitimately runs auth over http)
 * - has a real hostname (with at least one dot, e.g. company.atlassian.net,
 *   or "localhost" for local dev instances)
 * - is a "base" URL: no path/query/hash/credentials, since we build
 *   REST paths onto it later (jiraFetch appends /rest/api/3/...)
 *
 * Returns { valid: boolean, message?: string }
 */
function validateJiraBaseUrl(rawValue) {
  const value = (rawValue || "").trim();

  if (!value) {
    return { valid: false, message: "Base URL is required." };
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    return {
      valid: false,
      message: "Enter a valid URL, e.g. https://company.atlassian.net",
    };
  }

  if (url.protocol !== "https:") {
    return { valid: false, message: "Jira base URL must use https://" };
  }

  if (url.username || url.password) {
    return { valid: false, message: "Remove credentials from the URL." };
  }

  const hostname = url.hostname;
  const isLocalDev = hostname === "localhost" || hostname === "127.0.0.1";
  const looksLikeDomain =
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(
      hostname,
    );

  if (!isLocalDev && !looksLikeDomain) {
    return {
      valid: false,
      message: "Enter a valid Jira domain, e.g. https://company.atlassian.net",
    };
  }

  const hasExtraPath = url.pathname && url.pathname !== "/";
  if (hasExtraPath || url.search || url.hash) {
    // In practice this shouldn't happen anymore — the input listener
    // strips anything past the origin as the user types. Kept as a
    // defensive fallback (e.g. a stale value restored from storage)
    // that silently normalizes rather than erroring.
    return { valid: true, normalized: url.origin };
  }

  return { valid: true };
}

function applyJiraBaseUrlErrorState(showAsInvalid, message) {
  jiraBaseUrlInput.classList.toggle("invalid", showAsInvalid);
  jiraBaseUrlInput.setAttribute(
    "aria-invalid",
    showAsInvalid ? "true" : "false",
  );

  if (jiraBaseUrlError) {
    jiraBaseUrlError.textContent = showAsInvalid ? message : "";
    jiraBaseUrlError.style.display = showAsInvalid ? "block" : "none";
  }
}

// Called on blur: the only place a new error is allowed to appear.
// An empty field is still treated as "no error" here — required-ness
// is enforced on submit via createTicket(), not as an inline nag.
function validateJiraBaseUrlField() {
  const result = validateJiraBaseUrl(jiraBaseUrlInput.value);
  const isEmpty = !jiraBaseUrlInput.value.trim();
  const showAsInvalid = !result.valid && !isEmpty;

  applyJiraBaseUrlErrorState(showAsInvalid, result.message);

  return result;
}

// Called on input: never introduces a new error, only clears an
// already-visible one the moment the value becomes valid.
function clearJiraBaseUrlErrorIfNowValid() {
  if (!jiraBaseUrlInput.classList.contains("invalid")) return;

  const result = validateJiraBaseUrl(jiraBaseUrlInput.value);
  if (result.valid) {
    applyJiraBaseUrlErrorState(false);
  }
}

// state: "info" | "loading" | "success" | "error"
function setStatus(message, state = "info") {
  statusText.textContent = message;
  statusDiv.dataset.state = state;
}

function setBusy(isBusy) {
  createTicketBtn.disabled = isBusy;
  createTicketBtn.dataset.loading = isBusy ? "true" : "false";
  jiraBaseUrlInput.disabled = isBusy;
  projectKeyInput.disabled = isBusy;
}

function setBulkBusy(isBusy) {
  importBtn.disabled = isBusy;
  importBtn.dataset.loading = isBusy ? "true" : "false";
  fileInput.disabled = isBusy;
}

// Validates the shared Jira fields for both the single-ticket and bulk
// flows. Shows the first error and returns null on failure.
function getJiraContext() {
  const urlValidation = validateJiraBaseUrlField();
  if (!urlValidation.valid) {
    setStatus(urlValidation.message, "error");
    return null;
  }

  const projectKey = projectKeyInput.value.trim().toUpperCase();
  if (!projectKey) {
    setStatus("Please enter a project key.", "error");
    return null;
  }

  // Safe: validateJiraBaseUrlField() already confirmed this parses.
  const jiraOrigin = new URL(jiraBaseUrlInput.value.trim()).origin;
  return { jiraOrigin, projectKey };
}

// Single round trip to storage on popup open instead of two separate
// get() calls (settings + project history) racing independently.
function loadInitialState() {
  chrome.storage.local.get(
    ["jiraBaseUrl", "projectKey", "projectHistory"],
    (data) => {
      if (data.jiraBaseUrl) jiraBaseUrlInput.value = data.jiraBaseUrl;
      if (data.projectKey) projectKeyInput.value = data.projectKey;
      // Don't validate/show errors here — the user hasn't touched the
      // field yet, so this only takes effect after blur.

      renderProjectHistory(data.projectHistory || []);
    },
  );
}

function saveSettings() {
  chrome.storage.local.set({
    jiraBaseUrl: jiraBaseUrlInput.value.trim(),
    projectKey: projectKeyInput.value.trim(),
  });
}

function removeProjectTag(projectKey) {
  chrome.storage.local.get(["projectHistory"], (data) => {
    const history = (data.projectHistory || []).filter(
      (item) => item !== projectKey,
    );

    chrome.storage.local.set({ projectHistory: history }, () =>
      renderProjectHistory(history),
    );
  });
}

function renderProjectHistory(projects) {
  if (!projectTagsContainer) return;

  projectTagsContainer.innerHTML = "";

  if (projects.length === 0) {
    const empty = document.createElement("span");
    empty.className = "project-tags-empty";
    empty.textContent = "No recent projects yet.";
    projectTagsContainer.appendChild(empty);
    return;
  }

  projects.forEach((project) => {
    const tag = document.createElement("div");
    tag.className = "project-tag";
    // project keys are persisted user input — escape before injecting.
    tag.innerHTML = `
      <span class="tag-text">${escapeHtml(project)}</span>
      <span class="tag-close" title="Remove">✕</span>
    `;

    tag.querySelector(".tag-text").addEventListener("click", () => {
      projectKeyInput.value = project;
      saveSettings();
    });

    tag.querySelector(".tag-close").addEventListener("click", (e) => {
      e.stopPropagation();
      removeProjectTag(project);
    });

    projectTagsContainer.appendChild(tag);
  });
}

function saveProjectHistory(projectKey) {
  chrome.storage.local.get(["projectHistory"], (data) => {
    let history = data.projectHistory || [];
    history = history.filter((x) => x !== projectKey);
    history.unshift(projectKey);
    history = history.slice(0, 15);

    chrome.storage.local.set({ projectHistory: history }, () =>
      renderProjectHistory(history),
    );
  });
}

async function createTicket() {
  setBusy(true);

  try {
    saveSettings();

    loginBtn.style.display = "none";
    ticketResult.innerHTML = "";

    const { jiraOrigin, projectKey } = getJiraContext() || {};
    if (!jiraOrigin || !projectKey) return;

    setStatus("Reading active QA ticket...", "loading");

    let pageData;
    try {
      pageData = await getPageData();
    } catch {
      pageData = null;
    }

    if (!pageData?.octaneID) {
      setStatus(
        "Open the Octane ticket details page and try again.",
        "error",
      );
      return;
    }

    setStatus("Checking Jira session...", "loading");
    const loggedIn = await isJiraLoggedIn(jiraOrigin);

    if (!loggedIn) {
      redirectToLogin(jiraOrigin);
      return;
    }

    setStatus("Validating project access...", "loading");
    const projectValidation = await validateProject(jiraOrigin, projectKey);

    if (!projectValidation.success) {
      setStatus(projectValidation.message, "error");

      if (projectValidation.loginRequired) {
        redirectToLogin(jiraOrigin);
      }

      return;
    }

    const finalSummary = pageData.title || "Imported QA Ticket";

    setStatus("Checking for an existing ticket...", "loading");

    const existing = await findExistingJiraIssue(
      jiraOrigin,
      projectKey,
      finalSummary,
    );

    if (existing.issue) {
      const issueUrl = `${jiraOrigin}/browse/${existing.issue.key}`;
      setStatus(`Ticket already exists: ${existing.issue.key}`, "success");
      renderTicketCard(existing.issue.key, issueUrl);
      saveProjectHistory(projectKey);
      return;
    }

    const bodyAdf = htmlToADF(pageData.html);

    const issueDescription = {
      version: 1,
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 3 },
          content: [
            {
              type: "text",
              text: "SOURCE TICKET URL",
            },
          ],
        },
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: pageData.url,
              marks: [
                {
                  type: "link",
                  attrs: {
                    href: pageData.url,
                  },
                },
              ],
            },
          ],
        },
        // Add a separator paragraph
        { type: "paragraph", content: [] },
        // Append the converted rich HTML
        ...bodyAdf.content,
      ],
    };

    setStatus("Creating Jira ticket...", "loading");

    const issue = await createJiraIssue(
      jiraOrigin,
      projectKey,
      finalSummary,
      issueDescription,
    );

    if (pageData.images?.length) {
      setStatus("Uploading images...", "loading");

      const byPlaceholder = {};

      for (const img of pageData.images) {
        try {
          const blob = dataUrlToBlob(img.dataUrl);
          const ext = (blob.type.split("/")[1] || "png").split("+")[0];
          const attachment = await uploadJiraAttachment(
            jiraOrigin,
            issue.key,
            blob,
            `${img.placeholder}.${ext}`,
          );
          byPlaceholder[img.placeholder] = fileMediaNode(attachment);
        } catch (err) {
          console.error("Image upload failed:", img.placeholder, err);
        }
      }

      setStatus("Attaching images to ticket...", "loading");

      await updateJiraIssueDescription(
        jiraOrigin,
        issue.key,
        insertUploadedImages(issueDescription.content, byPlaceholder),
      );
    }

    const issueUrl = `${jiraOrigin}/browse/${issue.key}`;
    setStatus(`Created ${issue.key}.`, "success");
    renderTicketCard(issue.key, issueUrl);
    saveProjectHistory(projectKey);
  } catch (error) {
    console.error(error);
    setStatus(error.message || "Failed to create ticket.", "error");
  } finally {
    setBusy(false);
  }
}

async function getPageData() {
  const currentTab = await getCurrentTab();

  const results = await chrome.scripting.executeScript({
    target: { tabId: currentTab.id },
    func: async () => {
      const octaneID = String(
        document.querySelector(
          ".entity-form-document-view-header-entity-id-container",
        )?.textContent ?? "",
      )
        .replace(/\s+/g, " ")
        .trim();
      const title =
        document
          .querySelector(".entity-form-document-view-header-name-field-container")
          ?.textContent.replace(/\s+/g, " ")
          .trim() ||
        document.querySelector(
          ".document-view-header-entity-name--custom-label input",
        )?.value ||
        "";

      const jiraTitle = ["OCTANE", octaneID, title]
        .filter(Boolean)
        .join(" | ");

      const editor = document.querySelector(".fr-element");
      const images = [];
      let html = "";

      if (editor) {
        // Work on a clone so we never touch the live editor content.
        const container = editor.cloneNode(true);
        const imgEls = Array.from(container.querySelectorAll("img"));

        for (let i = 0; i < imgEls.length; i++) {
          const imgEl = imgEls[i];
          const placeholder = `__JIRA_IMG_${i}__`;

          try {
            // imgEl.src is the browser-resolved absolute URL (resolved
            // against THIS page's origin), and this fetch runs with the
            // page's own cookies — so it works even for relative paths
            // and authenticated Octane attachment URLs.
            const response = await fetch(imgEl.src, { credentials: "include" });
            const blob = await response.blob();
            const dataUrl = await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result);
              reader.onerror = reject;
              reader.readAsDataURL(blob);
            });

            images.push({ placeholder, dataUrl });
            imgEl.replaceWith(document.createTextNode(placeholder));
          } catch {
            // Couldn't fetch this one — drop it rather than aborting
            // the whole capture.
            imgEl.remove();
          }
        }

        html = container.innerHTML;
      }

      return {
        title: jiraTitle,
        octaneID,
        url: location.href,
        html,
        images,
      };
    },
  });

  return results[0].result;
}

// Converts a `data:` URL into a Blob for multipart upload.
function dataUrlToBlob(dataUrl) {
  const [header, base64] = dataUrl.split(",");
  const mime =
    /data:(.*?);base64/.exec(header)?.[1] || "application/octet-stream";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

async function uploadJiraAttachment(jiraBaseUrl, issueKey, blob, filename) {
  const formData = new FormData();
  formData.append("file", blob, filename);

  const response = await fetch(
    `${jiraBaseUrl}/rest/api/3/issue/${issueKey}/attachments`,
    {
      method: "POST",
      credentials: "include",
      headers: {
        Accept: "application/json",
        "X-Atlassian-Token": "no-check",
        // No Content-Type — the browser must set the multipart boundary itself.
      },
      body: formData,
    },
  );

  if (!response.ok)
    throw new Error(`Image upload failed (status ${response.status}).`);
  const data = await response.json();
  return data[0]; // { id, filename, ... }
}

function fileMediaNode(attachment) {
  return {
    type: "mediaSingle",
    attrs: { layout: "center" },
    content: [
      {
        type: "media",
        attrs: { type: "file", id: attachment.id, collection: "" },
      },
    ],
  };
}

// Swaps `__JIRA_IMG_n__` placeholder paragraphs for the real uploaded
// attachment's media node.
function insertUploadedImages(adfContent, byPlaceholder) {
  return adfContent.flatMap((node) => {
    if (
      node.type === "paragraph" &&
      node.content?.length === 1 &&
      node.content[0].type === "text"
    ) {
      const match = /^__JIRA_IMG_(\d+)__$/.exec(node.content[0].text.trim());
      if (match) {
        const media = byPlaceholder[`__JIRA_IMG_${match[1]}__`];
        return media ? [media] : [];
      }
    }
    if (Array.isArray(node.content)) {
      return [
        { ...node, content: insertUploadedImages(node.content, byPlaceholder) },
      ];
    }
    return [node];
  });
}

async function updateJiraIssueDescription(jiraBaseUrl, issueKey, contentNodes) {
  const response = await jiraFetch(
    jiraBaseUrl,
    `/rest/api/3/issue/${issueKey}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fields: {
          description: { version: 1, type: "doc", content: contentNodes },
        },
      }),
    },
  );
  if (!response.ok)
    throw new Error(`Attaching images failed (status ${response.status}).`);
}

async function jiraFetch(jiraBaseUrl, path, options = {}) {
  return fetch(`${jiraBaseUrl}${path}`, {
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });
}

async function isJiraLoggedIn(jiraBaseUrl) {
  try {
    const response = await jiraFetch(jiraBaseUrl, "/rest/api/3/myself");
    return response.ok;
  } catch {
    return false;
  }
}

async function validateProject(jiraBaseUrl, projectKey) {
  try {
    const response = await jiraFetch(
      jiraBaseUrl,
      `/rest/api/3/project/${projectKey}`,
    );

    if (response.ok) {
      return { success: true };
    }

    if (response.status === 401 || response.status === 403) {
      return {
        success: false,
        loginRequired: true,
        message: "Jira login required or session expired.",
      };
    }

    return {
      success: false,
      loginRequired: false,
      message: "Project not found or you don't have access.",
    };
  } catch (error) {
    return {
      success: false,
      loginRequired: false,
      message: error.message,
    };
  }
}

async function createJiraIssue(jiraBaseUrl, projectKey, summary, description) {
  const payload = {
    fields: {
      project: { key: projectKey },
      summary,
      issuetype: { name: "Bug" },
      description,
    },
  };

  const response = await jiraFetch(jiraBaseUrl, "/rest/api/3/issue", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Jira Server/Data Center rejects cookie-authenticated POSTs
      // without this unless the caller opts out of XSRF checking.
      // Jira Cloud ignores the header, so it's safe to send always.
      "X-Atlassian-Token": "no-check",
    },
    body: JSON.stringify(payload),
  });

  if (response.status === 401 || response.status === 403) {
    redirectToLogin(jiraBaseUrl);
    throw new Error("Jira session expired. Please login again.");
  }

  const responseData = await response.json();

  if (!response.ok) {
    const message =
      responseData?.errors?.project ||
      responseData?.errorMessages?.join(", ") ||
      "Issue creation failed.";

    throw new Error(message);
  }

  return responseData;
}

function redirectToLogin(jiraBaseUrl) {
  setStatus("Jira login required.", "error");
  loginBtn.style.display = "block";

  loginBtn.onclick = () => {
    chrome.tabs.create({ url: jiraBaseUrl });
  };
}

async function getCurrentTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs.length) throw new Error("No active tab found.");
  return tabs[0];
}
