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
} from "./components/api.js";
import {
  getPageData,
  detectSiteInTab,
  scrapeSelectedListingInTab,
  scrapeSelectedSparkListingInTab,
  detectListingInTab,
  fetchListingDetailsInTab,
  fetchSparkDetailInTab,
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
  runListingImport(activeListingSite),
);
exportBtn.addEventListener("click", downloadPreviewReport);

jiraBaseUrlInput.addEventListener("input", (e) => {
  // Never introduce a new error while typing — only clear one that's
  // already showing, the moment the value becomes valid again.
  // A pasted issue/board URL fills the base URL and project key in one
  // go — hand focus straight to the create-ticket CTA so the user can
  // submit without reaching for the button.
  const extracted = extractJiraIssueDetailsFromBaseUrl();
  enforceJiraBaseUrlNoPath();
  clearJiraBaseUrlErrorIfNowValid();
  debouncedSaveSettings();
  if (extracted && e.inputType === "insertFromPaste") {
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

// Site detected on the active tab's listing, if any. Stored separately so the
// CTA click handler can pass it explicitly rather than the click event.
let activeListingSite = null;

// Shows the "Import selected from <site> listing" CTA only when the active tab
// is a listing grid with selectable rows on a supported site, and tailors the
// label to the site actually detected.
async function applyListingDetection() {
  const site = await detectListingInTab().catch(() => null);
  activeListingSite = site;
  listingImportLabel.textContent = site
    ? `Import selected ${site} listing`
    : "Import selected listing";
  listingImportBtn.style.display = site ? "block" : "none";
}

applyDetectedSite();
// The listing "import from the current page" CTA only makes sense while the
// active tab shows a listing grid, so show/hide it alongside site detection.
applyListingDetection();
chrome.tabs.onActivated.addListener(() => {
  applyDetectedSite();
  applyListingDetection();
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // Re-evaluate on every URL change too, not just on full page loads —
  // SPA hash navigation can leave the grid DOM behind while still firing url.
  if (changeInfo.status === "complete" || changeInfo.url) {
    applyDetectedSite();
    applyListingDetection();
  }
});

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
      if (abortRequested) return;
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
      if (!abortRequested) await sleep(250);
    };

    const worker = async () => {
      while (nextRow < selectedRows.length && !abortRequested) {
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

    // Finished rows move to the top with their checkboxes disabled. The
    // import CTA stays visible while anything is still selectable (failed
    // or unprocessed rows) and is hidden only when every row is done.
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
      updateProgress(completed, selectedRows.length, "Import stopped");
      setStatus(
        `Stopped. ${created} created, ${skipped} already existed, ${failed} failed.`,
        failed ? "error" : "info",
      );
      return;
    }

    if (created > 0 || skipped > 0) saveProjectHistory(projectKey);
    exportBtn.style.display = "block";

    if (selectableRemain) {
      setStatus(
        `Done. ${created} created, ${skipped} already existed, ${failed} failed.`,
        failed ? "error" : "success",
      );
    } else {
      setStatus("Bulk import done! try different report", "success");
    }
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

// Uploads the scraped page's captured images and swaps their placeholders
// in the description body for the real attachment media nodes.
async function attachImagesToIssue(jiraOrigin, issueKey, images, description) {
  setStatus("Uploading images...", "loading");

  const byPlaceholder = {};

  for (const img of images) {
    try {
      const blob = dataUrlToBlob(img.dataUrl);
      const ext = (blob.type.split("/")[1] || "png").split("+")[0];
      const filename = img.name || `${img.placeholder}.${ext}`;
      const attachment = await uploadJiraAttachment(
        jiraOrigin,
        issueKey,
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
    issueKey,
    insertUploadedImages(description.content, byPlaceholder),
  );
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

    const MAX_CONCURRENT = 4;
    let nextIndex = 0;
    let completed = 0;
    let created = 0;
    let skipped = 0;
    let failed = 0;

    const processItem = async (index) => {
      if (abortRequested) return;

      const row = rows[index];
      let detail = details[index];
      setStatus(
        `Processing ${completed + 1} of ${items.length} (${items[index].id})...`,
        "loading",
      );

      // Spark detail: the Table API is preferred — the same-origin session +
      // X-UserToken (CSRF) call, identical to Octane. Only if an item can't
      // resolve via the API does it fall back to the incident details page in
      // a background tab.
      if (flowSite === "Spark" && (!detail || detail.error)) {
        setRowStatus(row, "checking", "Opening incident page…");
        try {
          detail = await fetchSparkDetailInTab(items[index].url);
        } catch (err) {
          detail = {
            id: items[index].id,
            url: items[index].url,
            error: err.message || "Couldn't open the incident details page.",
          };
        }
      }

      // Detail is required for both sites: Octane from the API, Spark from
      // the details page.
      if (!detail || detail.error) {
        setRowStatus(
          row,
          "error",
          escapeHtml(detail?.error || "Details didn't load"),
        );
        failed++;
        completed++;
        updateProgress(completed, items.length);
        if (!abortRequested) await sleep(250);
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

          if (detail.images?.length) {
            await attachImagesToIssue(
              jiraOrigin,
              issue.key,
              detail.images,
              issueDescription,
            );
          }

          const issueUrl = `${jiraOrigin}/browse/${issue.key}`;
          setRowStatus(
            row,
            "created",
            `<a href="${escapeHtml(issueUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(issue.key)}</a>`,
          );
          created++;
          setStatus(`Created ${issue.key}.`, "success");
        } catch (err) {
          console.error(`${flowSite} import failed for`, items[index].id, err);
          setRowStatus(row, "error", escapeHtml(err.message || "Failed"));
          failed++;
        }
      }

      completed++;
      updateProgress(completed, items.length);
      if (!abortRequested) await sleep(250);
    };

    const worker = async () => {
      while (nextIndex < items.length && !abortRequested) {
        await processItem(nextIndex++);
      }
    };

    await Promise.all(
      Array.from(
        { length: Math.min(MAX_CONCURRENT, items.length) },
        worker,
      ),
    );

    updateProgress(items.length, items.length, "Import complete");

    // Finished rows move to the top with their checkboxes disabled; rows
    // that failed stay selectable so they can be retried with the same CTA.
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

    if (created > 0 || skipped > 0) saveProjectHistory(projectKey);

    if (abortRequested) {
      updateProgress(completed, items.length, "Import stopped");
      setStatus(
        `Stopped. ${created} created, ${skipped} already existed, ${failed} failed.`,
        failed ? "error" : "info",
      );
      return;
    }

    // The finished preview rows are reportable just like the Excel flow.
    exportBtn.style.display = "block";

    setStatus(
      `Done. ${created} created, ${skipped} already existed, ${failed} failed.`,
      failed ? "error" : "success",
    );
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
      await attachImagesToIssue(
        jiraOrigin,
        issue.key,
        pageData.images,
        issueDescription,
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
