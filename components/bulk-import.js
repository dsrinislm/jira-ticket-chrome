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
  updateBulkMediaFiles,
  setBulkMediaProgressDone,
  hideBulkMediaProgress,
} from "./ui.js";
import { getJiraContext } from "./validation.js";
import { saveSettings, saveProjectHistory } from "./storage.js";
import {
  scrapeSelectedListingInTab,
  scrapeSelectedSparkListingInTab,
  fetchListingDetailsInTab,
  fetchSparkCommentsInTab,
  fetchOctaneCommentsInTab,
} from "./scrape.js";
import { syncSourceComments } from "./comments.js";
import {
  findExistingJiraIssueFor,
  createJiraIssue,
  getJiraIssueWithAttachments,
} from "./api.js";
import { buildIssueDescription, sourceUrlBlock } from "./adf.js";
import {
  attachImagesToIssue,
  uploadMissingAttachments,
  failedAttachmentNames,
} from "./attachments.js";
import {
  syncJiraCommentsToOctane,
  syncOctaneAttachmentsInOrigin,
} from "./jira-to-octane.js";
import { ensureJiraReady } from "./session.js";
import { sleep } from "./util.js";

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

async function runBulkWorkerPool(total, runItem) {
  const counters = { created: 0, skipped: 0, failed: 0 };
  const progress = { completed: 0 };
  let nextIndex = 0;

  const worker = async () => {
    while (!abortRequested) {
      const index = nextIndex++;
      if (index >= total) return;
      await runItem(index, counters, progress);
      progress.completed++;
      updateProgress(progress.completed, total);
      if (!abortRequested) await sleep(250);
    }
  };

  const POOL = 2;
  await Promise.all(
    Array.from({ length: Math.min(POOL, total) }, worker),
  );

  return { counters, completed: progress.completed };
}

function finishBulkRun({ total, projectKey, counters, completed, doneMessage }) {
  updateProgress(total, total, "Import complete");

  reorderBulkRowsAfterImport();

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

  exportBtn.style.display = "block";

  setStatus(
    doneMessage(selectableRemain, counters),
    counters.failed ? "error" : "success",
  );

  updateSelectionCount();
}

export async function runBulkImport() {
  const ctx = getJiraContext();
  if (!ctx) return;

  setBulkRowsFromListing(false);

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
          const existing = await findExistingJiraIssueFor(
            jiraOrigin,
            projectKey,
            row.title,
            row.sourceUrl,
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

export async function runListingImport(site) {

  const flowSite = site === "Spark" ? "Spark" : "Octane";
  const ctx = getJiraContext();
  if (!ctx) return;

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

    previewBody.innerHTML = "";
    state.bulkRows = [];
    selectAllLabel?.classList.remove("hidden");

    const rows = items.map((item) =>
      addBulkRow(
        {
          rowIndex: item.id,

          idText:
            flowSite === "Spark" ? item.number || item.id : item.id,
          name: item.name,
          description: item.description,
          sourceUrl: item.url,
        },
        flowSite,
      ),
    );

    frameBulkView();

    scrollBulkToFirstSelected();

    progressSection.style.display = "block";
    updateProgress(0, items.length, "Starting import…");

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

    const commentBySysId = new Map();
    if (flowSite === "Spark") {
      try {
        const groups = await fetchSparkCommentsInTab(
          items.map((i) => i.id),
        );
        groups.forEach((group) => {
          if (group?.comments?.length) {
            commentBySysId.set(String(group.id), group.comments);
          }
        });
      } catch {}
    } else if (flowSite === "Octane") {
      try {
        const groups = await fetchOctaneCommentsInTab(
          items.map((i) => i.id),
        );
        groups.forEach((group) => {
          if (group?.comments?.length) {
            commentBySysId.set(String(group.id), group.comments);
          }
        });
      } catch {}
    }

    const uploadedAttachments = {};

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

        if (!detail || detail.error) {
          setRowStatus(
            row,
            "error",
            escapeHtml(detail?.error || "Details didn't load"),
          );
          counters.failed++;
          return;
        }

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

          if (detail.text) row.description = detail.text;
        }

        setRowStatus(row, "checking", "Checking…");

        const existing = await findExistingJiraIssueFor(
          jiraOrigin,
          projectKey,
          row.title,
          detail.url || row.sourceUrl,
        );
        if (existing.error) {
          setRowStatus(row, "error", "Duplicate check failed");
          counters.failed++;
        } else if (existing.issue) {
          const url = `${jiraOrigin}/browse/${existing.issue.key}`;
          const key = escapeHtml(existing.issue.key);
          const existsLink = `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${key}</a>`;
          let statusHtml = `Already exists — ${existsLink}`;

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
                mediaRow !== undefined
                  ? (done, total) => updateBulkMediaFiles(mediaRow, done, total)
                  : undefined,
              );
              const syncedNames = [
                ...(syncReport.uploadedNames || []),
                ...(syncReport.skippedNames || []),
              ];
              if (syncedNames.length) {
                uploadedAttachments[String(items[index].id)] = (
                  uploadedAttachments[String(items[index].id)] || []
                ).concat(syncedNames);
              }
              if (syncReport.failed > 0) {
                statusHtml = `Already exists — ${existsLink} — ${syncReport.failed} attachment(s) failed to sync${failedAttachmentNames(syncReport.failedNames)}`;
              } else if (syncReport.uploaded > 0) {
                statusHtml = `Already exists — ${existsLink} — synced ${syncReport.uploaded} missing attachment(s)`;
              } else {
                statusHtml = `Already exists — ${existsLink} — attachments up to date`;
              }
            } catch {
              statusHtml = `Already exists — ${existsLink} — couldn't sync attachments`;
            }

            if (mediaRow !== undefined) setBulkMediaProgressDone(mediaRow);
          }

          const comments = commentBySysId.get(String(items[index].id));
          if (comments?.length) {
            const commentSync = await syncSourceComments(
              flowSite,
              jiraOrigin,
              existing.issue.key,
              comments,
              String(items[index].id),
            );
            if (commentSync.added > 0) {
              statusHtml = `${statusHtml} — ${commentSync.added} comment(s) synced`;
            }
          }

          if (flowSite === "Octane") {
            if (getBulkIncludeAttachments()) {
              try {
                const { attachments: jiraAttachments } =
                  await getJiraIssueWithAttachments(
                    jiraOrigin,
                    existing.issue.key,
                  );
                if (jiraAttachments.length) {
                  const octaneBack = await syncOctaneAttachmentsInOrigin({
                    jiraOrigin,
                    sourceUrl: detail.url || row.sourceUrl,
                    files: jiraAttachments,
                  });
                  if (octaneBack.uploaded > 0) {
                    statusHtml = `${statusHtml} — ${octaneBack.uploaded} Jira attachment(s) synced to Octane`;
                  } else if (octaneBack.failed > 0) {
                    statusHtml = `${statusHtml} — ${octaneBack.failed} Jira attachment(s) failed to sync to Octane${failedAttachmentNames(octaneBack.failedNames)}`;
                  }
                }
              } catch {}
            }
            try {
              const back = await syncJiraCommentsToOctane({
                jiraOrigin,
                issueKey: existing.issue.key,
                sourceUrl: detail.url || row.sourceUrl,
              });
              if (back.report.posted > 0) {
                statusHtml = `${statusHtml} — ${back.report.posted} Jira comment(s) synced back to Octane`;
              } else if (back.report.failed > 0) {
                statusHtml = `${statusHtml} — ${back.report.failed} Jira comment(s) failed to sync back to Octane`;
              }
            } catch {}
          }

          setRowStatus(row, "exists", statusHtml);

          scrollBulkRowTop(row);
          counters.skipped++;
        } else {
          setRowStatus(row, "creating", "Creating…");
          try {

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
                mediaRow !== undefined
                  ? (done, total) => updateBulkMediaFiles(mediaRow, done, total)
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

            const comments = commentBySysId.get(String(items[index].id));
            let commentSync = { added: 0 };
            if (comments?.length) {
              commentSync = await syncSourceComments(
                flowSite,
                jiraOrigin,
                issue.key,
                comments,
                String(items[index].id),
              );
            }

            setRowStatus(
              row,
              "created",
              `<a href="${escapeHtml(issueUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(issue.key)}</a>${attachFailed ? ` — ${attachFailed} attachment(s) failed to upload${failedAttachmentNames(attachNames)}` : ""}${attachDescriptionError ? " — attachments uploaded, but inline image embed failed" : ""}${commentSync.added ? ` — ${commentSync.added} comment(s) synced` : ""}`,
            );

            scrollBulkRowTop(row);
            counters.created++;
            setStatus(
              attachFailed
                ? `Created ${issue.key} (${attachFailed} attachment(s) failed to upload${failedAttachmentNames(attachNames)}).`
                : attachDescriptionError
                  ? `Created ${issue.key} (attachments uploaded, but inline image embed failed).`
                  : commentSync.added
                    ? `Created ${issue.key} — ${commentSync.added} comment(s) synced.`
                    : `Created ${issue.key}.`,
              attachFailed || attachDescriptionError ? "error" : "success",
            );
          } catch (err) {
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

    markBulkAttachmentsSynced(uploadedAttachments);
  } finally {
    abortImportBtn.style.display = "none";
    setBulkBusy(false);
    frameBulkView();
  }
}
