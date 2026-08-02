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
  abortImportBtn,
  lockBulkImport,
  unlockBulkImport,
  reorderBulkRowsAfterImport,
  addBulkRow,
  previewBody,
  selectAllLabel,
  listingImportBtn,
  listingImportLabel,
  setActiveListingSite,
  getActiveListingSite,
  getIncludeAttachments,
  state,
  escapeHtml,
  showLoginButton,
  redirectToLogin,
  smoothScrollToElement,
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
  listIssueAttachments,
} from "./components/api.js";
import {
  getPageData,
  detectSiteInTab,
  scrapeSelectedListingInTab,
  scrapeSelectedSparkListingInTab,
  detectTabState,
  fetchListingDetailsInTab,
} from "./components/scrape.js";
import { startGapArt } from "./components/gap-art.js";
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
startGapArt();

tabSingle.addEventListener("click", () => switchView("single"));
tabBulk.addEventListener("click", () => switchView("bulk"));
selectAllCheckbox.addEventListener("change", toggleSelectAll);
fileInput.addEventListener("change", handleFileSelected);
importBtn.addEventListener("click", runBulkImport);
listingImportBtn.addEventListener("click", () =>
  runListingImport(getActiveListingSite()),
);
exportBtn.addEventListener("click", downloadPreviewReport);

jiraBaseUrlInput.addEventListener("input", (e) => {
  // Never introduce a new error while typing — only clear one that's
  // already showing, the moment the value becomes valid again.
  // A pasted issue/board URL fills the base URL and project key in one
  // go; a plain base URL also works when the key is already filled. In
  // both cases, once a paste leaves both fields filled, hand focus
  // straight to the create-ticket CTA so the user can submit without
  // reaching for the button.
  extractJiraIssueDetailsFromBaseUrl();
  enforceJiraBaseUrlNoPath();
  clearJiraBaseUrlErrorIfNowValid();
  debouncedSaveSettings();
  if (
    e.inputType === "insertFromPaste" &&
    jiraBaseUrlInput.value.trim() &&
    projectKeyInput.value.trim()
  ) {
    createTicketBtn.focus();
  }
});

jiraBaseUrlInput.addEventListener("blur", () => {
  const result = validateJiraBaseUrlField();
  if (result?.valid) promptCreateTicketWhenReady();
});
projectKeyInput.addEventListener("blur", promptCreateTicketWhenReady);
projectKeyInput.addEventListener("input", debouncedSaveSettings);

// Once both Jira fields are filled (focus is out), swap the idle status
// message for a nudge toward the create-ticket CTA. Cleared back to the
// idle message whenever either field stops being filled.
function promptCreateTicketWhenReady() {
  if (!bulkView.hidden) return;
  if (!jiraBaseUrlInput.value.trim() || !projectKeyInput.value.trim()) {
    setStatus("Configure Jira details and create a ticket.", "info");
    return;
  }
  setStatus("All set - Export current ticket into JIRA", "info");
}

// On input we only ever clear the nudge — never introduce it mid-typing.
// The ready message itself appears once focus leaves a fully-filled field.
function resetSinglePromptIfIncomplete() {
  if (!bulkView.hidden) return;
  if (!jiraBaseUrlInput.value.trim() || !projectKeyInput.value.trim()) {
    setStatus("Configure Jira details and create a ticket.", "info");
  }
}

[jiraBaseUrlInput, projectKeyInput].forEach((input) =>
  input.addEventListener("input", () => {
    if (bulkView.hidden) {
      resetSinglePromptIfIncomplete();
    } else {
      updateBulkStatusMessage();
      debouncedValidateBulkProjectKey();
    }
  }),
);
createTicketBtn.addEventListener("click", createTicket);

// Lets the user stop an in-flight bulk import. Picked up by the worker
// pool between rows, so the current row's Jira calls finish first.
let abortRequested = false;

abortImportBtn.addEventListener("click", () => {
  abortRequested = true;
  abortImportBtn.disabled = true;
  setStatus("Stopping import after the current ticket…", "info");
});

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

// Auto-select the source site and show the listing CTA from the active tab's
// DOM in one all-frames scan. When a site's selectors fully match, the toggle
// is set and locked; when nothing matches (or detection fails) the source-site
// section is hidden entirely. The listing CTA only shows when the tab is a
// supported listing grid, and its label is tailored to the site detected.
async function applyDetectedState() {
  let site = null;
  let listing = null;
  try {
    ({ site, listing } = await detectTabState());
  } catch {
    setSourceSiteVisible(false);
    return;
  }

  const matched = site !== null;
  // Select first so the lock keeps the right site's button enabled.
  if (matched) setSourceSite(site);
  setSourceSiteVisible(matched);
  setSourceSiteLocked(matched);

  setActiveListingSite(listing);
  listingImportLabel.textContent = listing
    ? `Import selected ${listing} listing`
    : "Import selected listing";
  listingImportBtn.style.display = listing ? "block" : "none";
  if (!bulkView.hidden) updateBulkStatusMessage();
}

applyDetectedState();
// A tab switch/navigation can fire onActivated and onUpdated back-to-back
// (and rapid tab-swiping fires many activations in a row). Debounce so one
// navigation causes at most one all-frames scan of the final active tab.
const debouncedDetectState = debounce(applyDetectedState, 150);
chrome.tabs.onActivated.addListener(debouncedDetectState);
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // Re-evaluate on every URL change too, not just on full page loads —
  // SPA hash navigation can leave the grid DOM behind while still firing url.
  if (changeInfo.status === "complete" || changeInfo.url) {
    debouncedDetectState();
  }
});

function bulkCountsSummary({ created, skipped, failed }) {
  return `${created} created, ${skipped} already existed, ${failed} failed.`;
}

// Shared bulk-import pacing: a bounded worker pool over `total` items that
// updates the progress bar and paces each worker. `runItem(index, counters,
// progress)` mutates `counters` ({ created, skipped, failed }) and may read
// `progress.completed` for status text; the pool owns the progress bar and
// the per-item sleep so both flows stay consistent. Sequential imports take
// ~2 API calls + 250ms per row, so N rows cost ~2N serial round trips — a
// small pool keeps that pacing (and Jira's rate limits) intact while cutting
// wall time by roughly the pool size.
async function runBulkWorkerPool(total, runItem) {
  const counters = { created: 0, skipped: 0, failed: 0 };
  const progress = { completed: 0 };
  const MAX_CONCURRENT = 4;
  let next = 0;

  const worker = async () => {
    while (next < total && !abortRequested) {
      const index = next++;
      await runItem(index, counters, progress);
      progress.completed++;
      updateProgress(progress.completed, total);
      if (!abortRequested) await sleep(250);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(MAX_CONCURRENT, total) }, worker),
  );

  return { counters, completed: progress.completed };
}

// Shared bulk-import wrap-up: moves finished rows to the top, disables the
// CTA when nothing is selectable, saves project history on a full run, and
// reports the Stopped/Done summary. `doneMessage(selectableRemain, counters)`
// lets each flow tailor its success copy.
function finishBulkRun({ total, projectKey, counters, completed, doneMessage }) {
  updateProgress(total, total, "Import complete");

  reorderBulkRowsAfterImport();

  const selectableRemain = state.bulkRows.some(
    (r) =>
      r.statusEl.dataset.state !== "created" &&
      r.statusEl.dataset.state !== "exists",
  );
  if (selectableRemain) {
    unlockBulkImport();
  } else {
    lockBulkImport();
  }

  if (abortRequested) {
    updateProgress(completed, total, "Import stopped");
    setStatus(
      `Stopped. ${bulkCountsSummary(counters)}`,
      counters.failed ? "error" : "info",
    );
    return;
  }

  if (counters.created > 0 || counters.skipped > 0) {
    saveProjectHistory(projectKey);
  }
  // The finished preview rows are reportable just like the Excel flow.
  exportBtn.style.display = "block";

  setStatus(
    doneMessage(selectableRemain, counters),
    counters.failed ? "error" : "success",
  );
}

async function runBulkImport() {
  const ctx = getJiraContext();
  if (!ctx) return;

  const selectedRows = state.bulkRows.filter(
    (r) => r.checkbox.checked && !r.checkbox.disabled,
  );
  if (!selectedRows.length) {
    setStatus("Select at least one row to import.", "error");
    return;
  }

  const { jiraOrigin, projectKey } = ctx;
  saveSettings();

  hideLoginButtons();
  exportBtn.style.display = "none";
  setBulkBusy(true);

  abortRequested = false;
  abortImportBtn.disabled = false;
  abortImportBtn.style.display = "inline-flex";

  try {
    if (!(await ensureJiraReady(jiraOrigin, projectKey))) return;

    progressSection.style.display = "block";
    updateProgress(0, selectedRows.length, "Starting import…");

    const { counters, completed } = await runBulkWorkerPool(
      selectedRows.length,
      async (index, counters, progress) => {
        if (abortRequested) return;

        const row = selectedRows[index];
        setStatus(
          `Processing ${progress.completed + 1} of ${selectedRows.length}...`,
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
            counters.failed++;
          } else if (existing.issue) {
            const url = `${jiraOrigin}/browse/${existing.issue.key}`;
            setRowStatus(
              row,
              "exists",
              `Already exists — <a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(existing.issue.key)}</a>`,
            );
            counters.skipped++;
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
            counters.created++;
          }
        } catch (err) {
          setRowStatus(row, "error", escapeHtml(err.message || "Failed"));
          counters.failed++;
        }
      },
    );

    finishBulkRun({
      total: selectedRows.length,
      projectKey,
      counters,
      completed,
      doneMessage: (selectableRemain, c) =>
        selectableRemain
          ? `Done. ${bulkCountsSummary(c)}`
          : "Bulk import done! try different report",
    });
  } finally {
    abortImportBtn.style.display = "none";
    setBulkBusy(false);
    frameBulkView();
  }
}

// Glides back so the whole bulk view is framed from its top edge, with the
// result status still readable at the bottom of the viewport. The layout
// (buttons, status) has settled by the time an import's finally runs.
function frameBulkView() {
  const run = () => {
    if (bulkView.hidden) return;
    smoothScrollToElement(bulkView);
  };
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(run);
  } else {
    run();
  }
}

// Validates the Jira session and project access, showing the right error
// (and login CTA) when either fails. Returns true when imports can proceed.
async function ensureJiraReady(jiraOrigin, projectKey) {
  setStatus("Checking Jira session...", "loading");
  if (!(await isJiraLoggedIn(jiraOrigin))) {
    setStatus(
      "Jira login required. Open Jira in a tab, log in, then retry.",
      "error",
    );
    showLoginButton(`${jiraOrigin}/browse/${projectKey}`);
    return false;
  }

  setStatus("Validating project access...", "loading");
  const projectValidation = await validateProject(jiraOrigin, projectKey);
  if (!projectValidation.success) {
    setStatus(projectValidation.message, "error");
    if (projectValidation.loginRequired) {
      showLoginButton(`${jiraOrigin}/browse/${projectKey}`);
    }
    return false;
  }

  return true;
}

// Maps a blob's MIME sub-type to a safe file extension. BMPs are served by
// ServiceNow under several aliases (image/x-ms-bmp etc.) that would otherwise
// produce a bogus fallback filename like "img.x-ms-bmp".
function extensionForBlobType(blobType) {
  const sub = (String(blobType).split("/")[1] || "")
    .split("+")[0]
    .toLowerCase();
  return (
    { "x-ms-bmp": "bmp", "x-bmp": "bmp", "x-windows-bmp": "bmp" }[sub] ||
    sub ||
    "png"
  );
}

// The upload filename an image maps to on the Jira issue — shared by the
// uploader and the "upload only what's missing" retry so both agree on names.
function imageUploadFilename(img) {
  return (
    img.name || `${img.placeholder}.${extensionForBlobType(dataUrlToBlob(img.dataUrl).type)}`
  );
}

// Uploads a batch of images to a Jira issue through a small bounded pool
// (Jira has no bulk attachment endpoint — many small files are faster
// batched than strung one after another). Never touches the description.
// Returns the uploaded attachments by placeholder plus a failure report.
async function uploadImages(jiraOrigin, issueKey, images) {
  const byPlaceholder = {};
  const MAX_CONCURRENT = 4;
  let next = 0;
  let failed = 0;
  let firstError = "";
  const failedImages = [];

  const uploadOne = async () => {
    while (next < images.length) {
      const img = images[next++];
      const filename = imageUploadFilename(img);
      try {
        const attachment = await uploadJiraAttachment(
          jiraOrigin,
          issueKey,
          dataUrlToBlob(img.dataUrl),
          filename,
        );
        byPlaceholder[img.placeholder] = fileMediaNode(attachment);
      } catch (err) {
        failed++;
        if (!firstError) firstError = err.message || String(err);
        failedImages.push(img);
        console.error("Image upload failed:", img.placeholder, filename, err);
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(MAX_CONCURRENT, images.length) }, uploadOne),
  );

  return { byPlaceholder, failed, firstError, failedImages };
}

// Uploads the scraped page's captured images and swaps their placeholders
// in the description body for the real attachment media nodes.
// Returns how many uploads failed (and the first error) so callers can
// surface "image missed" instead of dropping it silently.
async function attachImagesToIssue(jiraOrigin, issueKey, images, description) {
  setStatus("Uploading images...", "loading");

  const { byPlaceholder, failed, firstError } = await uploadImages(
    jiraOrigin,
    issueKey,
    images,
  );

  setStatus("Attaching images to ticket...", "loading");

  await updateJiraIssueDescription(
    jiraOrigin,
    issueKey,
    insertUploadedImages(description.content, byPlaceholder),
  );

  return { failed, firstError };
}

// Retries the attachments of an already-created ticket: uploads only the
// images whose filename isn't already attached to the issue, so a retry
// never duplicates the uploads that already succeeded. The description is
// left untouched — it was finalized when the ticket was first created.
async function uploadMissingAttachments(jiraOrigin, issueKey, images) {
  const existing = new Set(await listIssueAttachments(jiraOrigin, issueKey));
  const missing = images.filter(
    (img) => !existing.has(imageUploadFilename(img)),
  );

  if (!missing.length) {
    return { failed: 0, firstError: "", skipped: images.length };
  }

  const { failed, firstError } = await uploadImages(
    jiraOrigin,
    issueKey,
    missing,
  );
  return { failed, firstError, skipped: images.length - missing.length };
}

// Bulk flow #2 — no report file needed. The user ticks rows on a supported
// listing page (Octane grid or Spark/ServiceNow incident list); each selected
// item's detail is fetched through the site's REST API (same-origin, reusing
// the logged-in session — no tabs are opened) and its ticket is created in
// Jira immediately.
async function runListingImport(site) {
  // Normalize defensively — a stray value (e.g. a DOM event from a listener)
  // must never leak into titles or API calls.
  const flowSite = site === "Spark" ? "Spark" : "Octane";
  const ctx = getJiraContext();
  if (!ctx) return;

  const { jiraOrigin, projectKey } = ctx;
  saveSettings();

  hideLoginButtons();
  exportBtn.style.display = "none";
  setBulkBusy(true);

  abortRequested = false;
  abortImportBtn.disabled = false;
  abortImportBtn.style.display = "inline-flex";

  try {
    if (!(await ensureJiraReady(jiraOrigin, projectKey))) return;

    setStatus(`Reading selected items from the ${flowSite} page...`, "loading");
    const items =
      flowSite === "Spark"
        ? await scrapeSelectedSparkListingInTab()
        : await scrapeSelectedListingInTab();
    if (!items.length) {
      setStatus(
        `No items selected on the ${flowSite} page. Tick the rows you want to import, then retry.`,
        "error",
      );
      return;
    }

    // The preview mirrors the bulk flow: every selected item is listed as a
    // row up front, then its status is filled in as its ticket is created.
    previewBody.innerHTML = "";
    state.bulkRows = [];
    selectAllLabel?.classList.remove("hidden");

    const rows = items.map((item) =>
      addBulkRow(
        {
          rowIndex: item.id,
          // Spark rows show the INC number as the ID text (linked to the
          // incident URL); Octane keeps its numeric id.
          idText:
            flowSite === "Spark" ? item.number || item.id : item.id,
          name: item.name,
          description: item.description,
          sourceUrl: item.url,
        },
        flowSite,
      ),
    );

    // Reveal the preview right away so the user sees the rows fill in live.
    frameBulkView();

    progressSection.style.display = "block";
    updateProgress(0, items.length, "Starting import…");

    // Both sites use the listing tab's session here: one batched same-origin
    // REST call. Octane's API accepts the cookie outright; the ServiceNow
    // Table API needs the page CSRF token (X-UserToken from the MAIN world)
    // alongside the cookie — see fetchListingDetailsInTab. No tabs, no Basic
    // prompt: the request carries the same session+CSRF the page itself uses.
    let details = [];
    if (flowSite === "Octane" || flowSite === "Spark") {
      try {
        details = await fetchListingDetailsInTab(items.map((i) => i.id), flowSite);
      } catch (err) {
        const message = err.message || `${flowSite} API fetch failed`;
        details = items.map((item) => ({
          id: item.id,
          name: item.name,
          description: "",
          html: "",
          images: [],
          url: item.url,
          error: message,
        }));
      }
    }

    const { counters, completed } = await runBulkWorkerPool(
      items.length,
      async (index, counters, progress) => {
        if (abortRequested) return;

        const row = rows[index];
        const detail = details[index];
        setStatus(
          `Processing ${progress.completed + 1} of ${items.length} (${items[index].id})...`,
          "loading",
        );

        // Both sites' details come from the batched same-origin API call
        // above; a failed record is surfaced on its row but doesn't stall
        // the rest of the import.
        if (!detail || detail.error) {
          setRowStatus(
            row,
            "error",
            escapeHtml(detail?.error || "Details didn't load"),
          );
          counters.failed++;
          return;
        }

        // Make the detail authoritative for the row: the INC number + short
        // description (from the details-page title, or the API record) replace
        // the list-seeded sys_id title so the summary matches the single-ticket
        // "SPARK | <number> | <description>" dedup format.
        if (flowSite === "Spark") {
          const titleParts = (detail.title || "").split(" | ");
          const number =
            titleParts.length >= 3 ? titleParts[1] : detail.number || "";
          const detailName =
            titleParts.length >= 3
              ? titleParts.slice(2).join(" | ")
              : detail.name || "";
          if (number && detailName) {
            const refinedTitle = `SPARK | ${number} | ${detailName}`;
            if (refinedTitle !== row.title) {
              row.title = refinedTitle;
              const span = row.titleEl.querySelector(".clamped");
              if (span) span.textContent = refinedTitle;
            }
            row.name = detailName;
          }
          // The details page yields raw text; the API path keeps the list seed.
          if (detail.text) row.description = detail.text;
        }

        setRowStatus(row, "checking", "Checking…");

        const existing = await findExistingJiraIssue(
          jiraOrigin,
          projectKey,
          row.title,
        );
        if (existing.error) {
          setRowStatus(row, "error", "Duplicate check failed");
          counters.failed++;
        } else if (existing.issue) {
          const url = `${jiraOrigin}/browse/${existing.issue.key}`;
          setRowStatus(
            row,
            "exists",
            `Already exists — <a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(existing.issue.key)}</a>`,
          );
          counters.skipped++;
        } else {
          setRowStatus(row, "creating", "Creating…");
          try {
            // Both sites converge here: html is rich Octane content or the
            // Spark description text escaped for htmlToADF.
            const bodyAdf = htmlToADF(detail.html || "");
            const issueDescription = {
              version: 1,
              type: "doc",
              content: [
                ...sourceUrlBlock(detail.url || row.sourceUrl),
                ...bodyAdf.content,
              ],
            };

            const issue = await createJiraIssue(
              jiraOrigin,
              projectKey,
              row.title,
              issueDescription,
            );

            let attachFailed = 0;
            if (detail.images?.length) {
              const attachReport = await attachImagesToIssue(
                jiraOrigin,
                issue.key,
                detail.images,
                issueDescription,
              );
              attachFailed = attachReport.failed;
            }

            const issueUrl = `${jiraOrigin}/browse/${issue.key}`;
            setRowStatus(
              row,
              "created",
              `<a href="${escapeHtml(issueUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(issue.key)}</a>${attachFailed ? ` — ${attachFailed} attachment(s) failed to upload` : ""}`,
            );
            counters.created++;
            setStatus(
              attachFailed
                ? `Created ${issue.key} (${attachFailed} attachment(s) failed to upload).`
                : `Created ${issue.key}.`,
              attachFailed ? "error" : "success",
            );
          } catch (err) {
            console.error(`${flowSite} import failed for`, items[index].id, err);
            setRowStatus(row, "error", escapeHtml(err.message || "Failed"));
            counters.failed++;
          }
        }
      },
    );

    finishBulkRun({
      total: items.length,
      projectKey,
      counters,
      completed,
      doneMessage: (_selectableRemain, c) => `Done. ${bulkCountsSummary(c)}`,
    });
  } finally {
    abortImportBtn.style.display = "none";
    setBulkBusy(false);
    frameBulkView();
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

    // Only scrape (and later upload) the ticket's attachments when the user
    // opted in — capturing every file from the attachments tab is the slow
    // part of an export, so a no-attachments ticket skips it entirely.
    const includeAttachments = getIncludeAttachments();

    setStatus("Reading active QA ticket...", "loading");

    let pageData;
    try {
      pageData = await getPageData(getSourceSite(), { includeAttachments });
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

      // A previous create may have left some attachments behind (e.g. a
      // transient 401 on one upload). Retrying should only upload what's
      // actually missing — never re-upload what's already on the issue.
      if (includeAttachments && pageData.images?.length) {
        setStatus(
          `Uploading missing attachments for ${existing.issue.key}...`,
          "loading",
        );
        const attachReport = await uploadMissingAttachments(
          jiraOrigin,
          existing.issue.key,
          pageData.images,
        );
        if (attachReport.failed > 0) {
          setStatus(
            `${attachReport.failed} attachment(s) still failed to upload (${attachReport.firstError}).`,
            "error",
          );
          renderTicketCard(existing.issue.key, issueUrl);
          saveProjectHistory(projectKey);
          return;
        }
        setStatus(
          attachReport.skipped > 0
            ? `Ticket already exists: ${existing.issue.key}. Attachments up to date.`
            : `Ticket already exists: ${existing.issue.key}. Missing attachments uploaded.`,
          "success",
        );
      } else {
        setStatus(`Ticket already exists: ${existing.issue.key}`, "success");
      }

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

    let attachReport = { failed: 0 };
    if (includeAttachments && pageData.images?.length) {
      attachReport = await attachImagesToIssue(
        jiraOrigin,
        issue.key,
        pageData.images,
        issueDescription,
      );
    }

    const issueUrl = `${jiraOrigin}/browse/${issue.key}`;
    if (attachReport.failed > 0) {
      setStatus(
        `Created ${issue.key}, but ${attachReport.failed} attachment(s) failed to upload (${attachReport.firstError}).`,
        "error",
      );
    } else {
      setStatus(`Created ${issue.key}.`, "success");
    }
    renderTicketCard(issue.key, issueUrl);
    saveProjectHistory(projectKey);
  } catch (error) {
    console.error(error);
    setStatus(error.message || "Failed to create ticket.", "error");
  } finally {
    setBusy(false);
  }
}

export { attachImagesToIssue, uploadMissingAttachments, uploadImages };
