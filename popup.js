import {
  tabSingle,
  tabBulk,
  selectAllCheckbox,
  fileInput,
  importBtn,
  exportBtn,
  jiraBaseUrlInput,
  projectKeyInput,
  bulkView,
  createTicketBtn,
  ticketResult,
  sourceSiteInput,
  sourceSiteLabels,
  getSourceSite,
  setSourceSite,
  setSourceSiteLocked,
  setSourceSiteVisible,
  setStatus,
  setBusy,
  setBulkBusy,
  switchView,
  toggleSelectAll,
  updateBulkStatusMessage,
  hideLoginButtons,
  setRowStatus,
  updateProgress,
  renderTicketCard,
  progressSection,
  state,
  escapeHtml,
  showLoginButton,
  redirectToLogin,
} from "./components/ui.js";
import { debounce, sleep } from "./components/util.js";
import {
  sourceUrlBlock,
  buildIssueDescription,
  dataUrlToBlob,
  fileMediaNode,
  insertUploadedImages,
} from "./components/adf.js";
import {
  isJiraLoggedIn,
  validateProject,
  createJiraIssue,
  findExistingJiraIssue,
  uploadJiraAttachment,
  updateJiraIssueDescription,
} from "./components/api.js";
import { getPageData, detectSiteInTab } from "./components/scrape.js";
import { handleFileSelected, downloadPreviewReport } from "./components/excel.js";
import {
  loadInitialState,
  saveSettings,
  saveProjectHistory,
} from "./components/storage.js";
import {
  enforceJiraBaseUrlNoPath,
  clearJiraBaseUrlErrorIfNowValid,
  validateJiraBaseUrlField,
  debouncedValidateBulkProjectKey,
  getJiraContext,
  extractJiraIssueDetailsFromBaseUrl,
} from "./components/validation.js";

// The script loads at the end of <body>, so the DOM is already parsed —
// no need to wait for DOMContentLoaded.
const debouncedSaveSettings = debounce(saveSettings, 300);

loadInitialState();

tabSingle.addEventListener("click", () => switchView("single"));
tabBulk.addEventListener("click", () => switchView("bulk"));
selectAllCheckbox.addEventListener("change", toggleSelectAll);
fileInput.addEventListener("change", handleFileSelected);
importBtn.addEventListener("click", runBulkImport);
exportBtn.addEventListener("click", downloadPreviewReport);

jiraBaseUrlInput.addEventListener("input", () => {
  // Never introduce a new error while typing — only clear one that's
  // already showing, the moment the value becomes valid again.
  extractJiraIssueDetailsFromBaseUrl();
  enforceJiraBaseUrlNoPath();
  clearJiraBaseUrlErrorIfNowValid();
  debouncedSaveSettings();
});

jiraBaseUrlInput.addEventListener("blur", validateJiraBaseUrlField);
projectKeyInput.addEventListener("input", debouncedSaveSettings);

[jiraBaseUrlInput, projectKeyInput].forEach((input) =>
  input.addEventListener("input", () => {
    if (!bulkView.hidden) {
      updateBulkStatusMessage();
      debouncedValidateBulkProjectKey();
    }
  }),
);
createTicketBtn.addEventListener("click", createTicket);

sourceSiteInput.addEventListener("change", () => {
  setSourceSite(getSourceSite());
  debouncedSaveSettings();
});

sourceSiteLabels.forEach((label) =>
  label.addEventListener("click", () => {
    setSourceSite(label.dataset.site);
    debouncedSaveSettings();
  }),
);

// Auto-select the source site from the active tab's DOM. When a site's
// selectors fully match, the toggle is set and locked; when nothing matches
// (or detection fails) the source-site section is hidden entirely.
async function applyDetectedSite() {
  try {
    const detected = await detectSiteInTab();
    const matched = detected !== null;
    setSourceSiteVisible(matched);
    setSourceSiteLocked(matched);
    if (matched) setSourceSite(detected);
  } catch {
    setSourceSiteVisible(false);
  }
}

applyDetectedSite();
chrome.tabs.onActivated.addListener(() => applyDetectedSite());
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "complete") applyDetectedSite();
});

async function runBulkImport() {
  const ctx = getJiraContext();
  if (!ctx) return;

  const selectedRows = state.bulkRows.filter((r) => r.checkbox.checked);
  if (!selectedRows.length) {
    setStatus("Select at least one row to import.", "error");
    return;
  }

  const { jiraOrigin, projectKey } = ctx;
  saveSettings();

  hideLoginButtons();
  exportBtn.style.display = "none";
  setBulkBusy(true);

  try {
    setStatus("Checking Jira session...", "loading");
    if (!(await isJiraLoggedIn(jiraOrigin))) {
      setStatus(
        "Jira login required. Open Jira in a tab, log in, then retry.",
        "error",
      );
      showLoginButton(`${jiraOrigin}/browse/${projectKey}`);
      return;
    }

    setStatus("Validating project access...", "loading");
    const projectValidation = await validateProject(jiraOrigin, projectKey);
    if (!projectValidation.success) {
      setStatus(projectValidation.message, "error");
      if (projectValidation.loginRequired) {
        showLoginButton(`${jiraOrigin}/browse/${projectKey}`);
      }
      return;
    }

    let created = 0,
      skipped = 0,
      failed = 0;

    progressSection.style.display = "block";
    updateProgress(0, selectedRows.length, "Starting import…");

    // Process rows concurrently with a bounded pool — sequential imports
    // take ~2 API calls + 250ms per row, so N rows cost ~2N serial round
    // trips. A small pool keeps the per-worker pacing (and Jira's rate
    // limits) intact while cutting wall time by ~the pool size.
    const MAX_CONCURRENT = 4;
    let nextRow = 0;
    let completed = 0;

    const processRow = async (row) => {
      setStatus(
        `Processing ${completed + 1} of ${selectedRows.length}...`,
        "loading",
      );
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

      completed++;
      updateProgress(completed, selectedRows.length);
      await sleep(250);
    };

    const worker = async () => {
      while (nextRow < selectedRows.length) {
        await processRow(selectedRows[nextRow++]);
      }
    };

    await Promise.all(
      Array.from(
        { length: Math.min(MAX_CONCURRENT, selectedRows.length) },
        worker,
      ),
    );

    updateProgress(selectedRows.length, selectedRows.length, "Import complete");

    if (created > 0 || skipped > 0) saveProjectHistory(projectKey);
    exportBtn.style.display = "block";

    setStatus(
      `Done. ${created} created, ${skipped} already existed, ${failed} failed.`,
      failed ? "error" : "success",
    );
  } finally {
    setBulkBusy(false);
  }
}

async function createTicket() {
  setBusy(true);

  try {
    saveSettings();

    hideLoginButtons();
    ticketResult.innerHTML = "";

    const { jiraOrigin, projectKey } = getJiraContext() || {};
    if (!jiraOrigin || !projectKey) return;

    setStatus("Reading active QA ticket...", "loading");

    let pageData;
    try {
      pageData = await getPageData(getSourceSite());
    } catch {
      pageData = null;
    }

    if (!pageData?.title) {
      // Distinguish "this tab isn't a QA site" from "a QA site is open but
      // doesn't match the selected source".
      const detected = await detectSiteInTab().catch(() => null);

      setStatus(
        detected
          ? `Open the ${detected} ticket details page and try again.`
          : "Goto ticket details page",
        "error",
      );
      return;
    }

    setStatus("Checking Jira session...", "loading");
    const loggedIn = await isJiraLoggedIn(jiraOrigin);

    if (!loggedIn) {
      redirectToLogin(jiraOrigin, projectKey);
      return;
    }

    setStatus("Validating project access...", "loading");
    const projectValidation = await validateProject(jiraOrigin, projectKey);

    if (!projectValidation.success) {
      setStatus(projectValidation.message, "error");

      if (projectValidation.loginRequired) {
        redirectToLogin(jiraOrigin, projectKey);
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

    if (existing.error) {
      setStatus("Couldn't check for an existing ticket. Try again.", "error");
      return;
    }

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
      content: [...sourceUrlBlock(pageData.url), ...bodyAdf.content],
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
          const filename = img.name || `${img.placeholder}.${ext}`;
          const attachment = await uploadJiraAttachment(
            jiraOrigin,
            issue.key,
            blob,
            filename,
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
