import {
  state,
  setStatus,
  setBulkBusy,
  hideLoginButtons,
  setRowStatus,
  updateProgress,
  escapeHtml,
  abortImportBtn,
  exportBtn,
  progressSection,
  previewBody,
  selectAllLabel,
  addBulkRow,
  reorderBulkRowsAfterImport,
  scrollBulkRowTop,
  scrollBulkTableTop,
  scrollBulkToFirstSelected,
  unlockBulkImport,
  lockBulkImport,
  setBulkRowsFromListing,
  updateSelectionCount,
  frameBulkView,
  getBulkIncludeAttachments,
  getBulkSelectedAttachments,
  markBulkAttachmentsSynced,
  setupBulkMediaProgress,
  startBulkMediaProgress,
  updateBulkMediaProgress,
  setBulkMediaProgressDone,
  hideBulkMediaProgress,
} from "./ui.js";
import { getJiraContext } from "./validation.js";
import { saveSettings, saveProjectHistory } from "./storage.js";
import {
  scrapeSelectedListingInTab,
  scrapeSelectedSparkListingInTab,
  fetchListingDetailsInTab,
} from "./scrape.js";
import { findExistingJiraIssue, createJiraIssue } from "./api.js";
import { buildIssueDescription, sourceUrlBlock } from "./adf.js";
import {
  attachImagesToIssue,
  uploadMissingAttachments,
  failedAttachmentNames,
} from "./attachments.js";
import { ensureJiraReady } from "./session.js";
import { sleep } from "./util.js";

// Abort flag shared by the bulk flows: set from the popup's Stop button and
// polled by the worker pool between rows so the current row's Jira calls
// finish first.
let abortRequested = false;

export function isAbortRequested() {
  return abortRequested;
}

export function requestAbort() {
  abortRequested = true;
}

export function resetAbort() {
  abortRequested = false;
}

function bulkCountsSummary({ created, skipped, failed }) {
  return `${created} created, ${skipped} already existed, ${failed} failed.`;
}

// Shared bulk-import pacing: processes items strictly one at a time so each
// ticket's attachment upload can be watched in real time (and Jira's rate
// limits stay intact). `runItem(index, counters, progress)` mutates
// `counters` ({ created, skipped, failed }) and may read `progress.completed`
// for status text; the caller owns the progress bar updates and the per-item
// sleep. Sequential imports take ~2 API calls + 250ms per row.
async function runBulkWorkerPool(total, runItem) {
  const counters = { created: 0, skipped: 0, failed: 0 };
  const progress = { completed: 0 };

  const worker = async () => {
    for (let index = 0; index < total && !abortRequested; index++) {
      await runItem(index, counters, progress);
      progress.completed++;
      updateProgress(progress.completed, total);
      if (!abortRequested) await sleep(250);
    }
  };

  await worker();

  return { counters, completed: progress.completed };
}

// Shared bulk-import wrap-up: moves finished rows to the top, disables the
// CTA when nothing is selectable, saves project history on a full run, and
// reports the Stopped/Done summary. `doneMessage(selectableRemain, counters)`
// lets each flow tailor its success copy.
function finishBulkRun({ total, projectKey, counters, completed, doneMessage }) {
  updateProgress(total, total, "Import complete");

  reorderBulkRowsAfterImport();
  // The sync tracked each created ticket by pinning it to the top of the
  // preview table; with everything finished, glide back to the first row.
  scrollBulkTableTop();

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
  // Let the resting-state logic take over: with rows still importable but
  // nothing new ticked, the CTA hides and the prompt becomes "Select new
  // items to continue create more".
  updateSelectionCount();
}

// Bulk flow #1 — an Excel report file. Each row is a ticket; a bounded pool
// creates the ones that don't already exist.
export async function runBulkImport() {
  const ctx = getJiraContext();
  if (!ctx) return;

  // Report-driven flow — the "Create selected tickets" CTA applies here, so
  // drop any listing-flow state left over from a previous run.
  setBulkRowsFromListing(false);
  // Report rows carry no attachments, so there's nothing to show in the
  // per-ticket media progress — clear any rows a listing run left behind.
  hideBulkMediaProgress();

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
  // Open the preview at the top of the selected batch (not the table's first
  // row) so the sync can follow each created ticket from there.
  scrollBulkToFirstSelected();

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
            // Keep the freshest created ticket pinned to the top of the
            // preview table while the sync runs (workers finish out of order).
            scrollBulkRowTop(row);
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

// Bulk flow #2 — no report file needed. The user ticks rows on a supported
// listing page (Octane grid or Spark/ServiceNow incident list); each selected
// item's detail is fetched through the site's REST API (same-origin, reusing
// the logged-in session — no tabs are opened) and its ticket is created in
// Jira immediately.
export async function runListingImport(site) {
  // Normalize defensively — a stray value (e.g. a DOM event from a listener)
  // must never leak into titles or API calls.
  const flowSite = site === "Spark" ? "Spark" : "Octane";
  const ctx = getJiraContext();
  if (!ctx) return;

  // Listing-driven flow: rows are scraped from the page, so re-running is
  // always through the "Sync selected … listing" CTA — never the report flow's
  // "Create selected tickets" button.
  setBulkRowsFromListing(true);

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
    // Open the preview at the top of the selected batch (all listing rows are
    // selected, so this lands on the first item) before the sync follows.
    scrollBulkToFirstSelected();

    progressSection.style.display = "block";
    updateProgress(0, items.length, "Starting import…");

    // Both sites use the listing tab's session here: one batched same-origin
    // REST call. Octane's API accepts the cookie outright; the ServiceNow
    // Table API needs the page CSRF token (X-UserToken from the MAIN world)
    // alongside the cookie — see fetchListingDetailsInTab. No tabs, no Basic
    // prompt: the request carries the same session+CSRF the page itself uses.
    // The "Include attachments" picker (default OFF) narrows which files each
    // ticket's detail downloads; when off, attachment files are skipped
    // entirely so the details pass only fetches the description.
    let details = [];
    if (flowSite === "Octane" || flowSite === "Spark") {
      try {
        details = await fetchListingDetailsInTab(
          items.map((i) => i.id),
          flowSite,
          {
            includeAttachments: getBulkIncludeAttachments(),
            selectedAttachments: getBulkSelectedAttachments() || undefined,
          },
        );
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

    const uploadedAttachments = {};

    // Tickets that will actually upload media (their detail has images) get a
    // per-ticket progress row; the rest are skipped. Each item index maps to
    // its row so a worker can update its own ticket's upload in real time.
    const mediaRowByItemIndex = new Map();
    const mediaLabels = [];
    items.forEach((item, index) => {
      if (!details[index]?.images?.length) return;
      mediaRowByItemIndex.set(index, mediaLabels.length);
      const idText = flowSite === "Spark" ? item.number || item.id : item.id;
      mediaLabels.push(item.name ? `${idText} · ${item.name}` : idText);
    });
    setupBulkMediaProgress(mediaLabels);

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
          const key = escapeHtml(existing.issue.key);
          const existsLink = `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${key}</a>`;
          let statusHtml = `Already exists — ${existsLink}`;

          // Re-running the import with "Include attachments" on is the bulk
          // resync: a ticket that already exists uploads only the files its
          // issue is actually missing (the bytes were captured in the batched
          // details fetch), mirroring the single-ticket sync. Skipped count
          // stays "already existed" — the row was still a duplicate.
          if (getBulkIncludeAttachments() && detail?.images?.length) {
            const mediaRow = mediaRowByItemIndex.get(index);
            if (mediaRow !== undefined) startBulkMediaProgress(mediaRow);
            try {
              const syncReport = await uploadMissingAttachments(
                jiraOrigin,
                existing.issue.key,
                detail.images,
                mediaRow !== undefined
                  ? (loaded, total) =>
                      updateBulkMediaProgress(mediaRow, loaded, total)
                  : undefined,
              );
              if (syncReport.uploadedNames?.length) {
                uploadedAttachments[String(items[index].id)] = (
                  uploadedAttachments[String(items[index].id)] || []
                ).concat(syncReport.uploadedNames);
              }
              if (syncReport.failed > 0) {
                statusHtml = `Already exists — ${existsLink} — ${syncReport.failed} attachment(s) failed to sync${failedAttachmentNames(syncReport.failedNames)}`;
              } else if (syncReport.uploaded > 0) {
                statusHtml = `Already exists — ${existsLink} — synced ${syncReport.uploaded} missing attachment(s)`;
              } else {
                statusHtml = `Already exists — ${existsLink} — attachments up to date`;
              }
            } catch (err) {
              console.error("Bulk resync failed for", items[index].id, err);
              statusHtml = `Already exists — ${existsLink} — couldn't sync attachments`;
            }
            // Whether files synced, were already up to date, or failed, this
            // ticket's media row is finished.
            if (mediaRow !== undefined) setBulkMediaProgressDone(mediaRow);
          }

          setRowStatus(row, "exists", statusHtml);
          // A resynced ticket is finished work too — keep it pinned at the
          // top of the preview table alongside freshly created ones.
          scrollBulkRowTop(row);
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
            let attachNames = [];
            let attachDescriptionError = "";
            if (detail.images?.length) {
              const mediaRow = mediaRowByItemIndex.get(index);
              if (mediaRow !== undefined) startBulkMediaProgress(mediaRow);
              const attachReport = await attachImagesToIssue(
                jiraOrigin,
                issue.key,
                detail.images,
                issueDescription,
                mediaRow !== undefined
                  ? (loaded, total) =>
                      updateBulkMediaProgress(mediaRow, loaded, total)
                  : undefined,
              );
              if (mediaRow !== undefined) setBulkMediaProgressDone(mediaRow);
              attachFailed = attachReport.failed;
              attachNames = attachReport.failedNames || [];
              attachDescriptionError = attachReport.descriptionError || "";
              if (attachReport.uploadedNames?.length) {
                uploadedAttachments[String(items[index].id)] = (
                  uploadedAttachments[String(items[index].id)] || []
                ).concat(attachReport.uploadedNames);
              }
            }

            const issueUrl = `${jiraOrigin}/browse/${issue.key}`;
            setRowStatus(
              row,
              "created",
              `<a href="${escapeHtml(issueUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(issue.key)}</a>${attachFailed ? ` — ${attachFailed} attachment(s) failed to upload${failedAttachmentNames(attachNames)}` : ""}${attachDescriptionError ? " — attachments uploaded, but inline image embed failed" : ""}`,
            );
            // Keep the freshest created ticket pinned to the top of the
            // preview table while the sync runs (workers finish out of order).
            scrollBulkRowTop(row);
            counters.created++;
            setStatus(
              attachFailed
                ? `Created ${issue.key} (${attachFailed} attachment(s) failed to upload${failedAttachmentNames(attachNames)}).`
                : attachDescriptionError
                  ? `Created ${issue.key} (attachments uploaded, but inline image embed failed).`
                  : `Created ${issue.key}.`,
              attachFailed || attachDescriptionError ? "error" : "success",
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

    // The attachments the run actually uploaded to Jira are now synced —
    // mark them checked + disabled in the open picker so a re-run doesn't
    // re-upload them.
    markBulkAttachmentsSynced(uploadedAttachments);
  } finally {
    abortImportBtn.style.display = "none";
    setBulkBusy(false);
    frameBulkView();
  }
}
