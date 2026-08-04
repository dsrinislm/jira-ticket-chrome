import {
  setBusy,
  setStatus,
  hideLoginButtons,
  renderTicketCard,
  getSourceSite,
  getIncludeAttachments,
  getSelectedAttachments,
  redirectToLogin,
  resetTicketCard,
  revealStatus,
  updateSyncProgress,
  setSyncProgressVisible,
  syncAbortBtn,
  markAttachmentsSynced,
} from "./ui.js";
import { getJiraContext } from "./validation.js";
import { saveSettings, saveProjectHistory } from "./storage.js";
import { formatBytes } from "./util.js";
import { getPageData, detectSiteInTab, fetchSparkCommentsInTab } from "./scrape.js";
import {
  isJiraLoggedIn,
  validateProject,
  findExistingJiraIssue,
  createJiraIssue,
  listIssueAttachments,
} from "./api.js";
import { syncSparkComments } from "./comments.js";
import { sourceUrlBlock } from "./adf.js";
import {
  imageUploadFilename,
  failedAttachmentNames,
  uploadMissingAttachments,
  attachImagesToIssue,
  requestUploadCancel,
} from "./attachments.js";

// Fetches the open Spark incident's comments/work notes through the ServiceNow
// API (sys_journal_field — no DOM scraping) and posts each as its own Jira
// comment, deduped against the issue's existing comments. Spark only: Octane
// has no journal path, and without a sys_id in the details URL there's nothing
// to fetch. Best-effort — never throws.
async function syncSparkCommentsForTicket(jiraOrigin, issueKey, pageData) {
  if (getSourceSite() !== "Spark" || !issueKey || !pageData?.url) {
    return { added: 0, total: 0 };
  }
  const sysIdMatch = /[?&]sys_id=([^&]+)/.exec(pageData.url || "");
  if (!sysIdMatch) return { added: 0, total: 0 };
  const groups = await fetchSparkCommentsInTab([sysIdMatch[1]]).catch((err) => {
    console.error("[jira-ext] fetchSparkCommentsInTab failed:", err);
    return [];
  });
  const entries = groups[0]?.comments || [];
  console.log(
    `[jira-ext] syncSparkCommentsForTicket: sys_id=${sysIdMatch[1]} issue=${issueKey} groups=${groups.length} entries=${entries.length}`,
  );
  return syncSparkComments(jiraOrigin, issueKey, entries);
}

// Single-ticket flow: reads the active QA ticket from the current tab,
// creates (or syncs) its Jira ticket, and uploads the selected attachments.
export async function createTicket() {
  setBusy(true);

  try {
    saveSettings();

    hideLoginButtons();
    resetTicketCard();

    const { jiraOrigin, projectKey } = getJiraContext() || {};
    if (!jiraOrigin || !projectKey) return;

    // Only scrape (and later upload) the ticket's attachments when the user
    // opted in — capturing every file from the attachments tab is the slow
    // part of an export, so a no-attachments ticket skips it entirely. When
    // the picker has a selection, only the checked files are captured.
    const includeAttachments = getIncludeAttachments();
    const selectedAttachments = includeAttachments
      ? getSelectedAttachments()
      : undefined;

    setStatus("Reading active QA ticket...", "loading");

    let pageData;
    try {
      // Phase 1 lists the selected attachments WITHOUT downloading their
      // bytes. The slow byte downloads happen afterwards — only for the files
      // a Jira ticket is actually missing.
      pageData = await getPageData(getSourceSite(), {
        includeAttachments,
        selectedAttachments,
        captureAttachments: false,
        captureEmbeddedImages: false,
      });
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

      let finalStatus = "";
      let finalStatusType = "success";

      // A previous create may have left some attachments behind (e.g. a
      // transient 401 on one upload). When the ticket already exists, sync
      // only the files the issue is actually missing: list what's already
      // attached, then download bytes for just the missing ones — never the
      // files that are already up to date.
      if (includeAttachments && pageData.images?.length) {
        setStatus(
          `Checking ${existing.issue.key} attachments...`,
          "loading",
        );
        let missing = pageData.images;
        try {
          const existingNames = new Set(
            await listIssueAttachments(jiraOrigin, existing.issue.key),
          );
          missing = pageData.images.filter(
            (img) => !existingNames.has(imageUploadFilename(img)),
          );
        } catch {
          // Listing failed — fall back to capturing everything selected.
        }

        if (!missing.length) {
          finalStatus = `Ticket already exists: ${existing.issue.key}. Selected attachments up to date.`;
        } else {
          setStatus(
            `Downloading ${missing.length} attachment(s)...`,
            "loading",
          );
          const captured = await getPageData(getSourceSite(), {
            includeAttachments: true,
            selectedAttachments: missing.map((img) =>
              imageUploadFilename(img),
            ),
            // Sync only cares about the missing attachment files — the
            // description is left untouched, so skip embedded images.
            captureEmbeddedImages: false,
          }).catch(() => null);

          if (!captured?.images?.length) {
            finalStatus = `Couldn't capture the missing attachments for ${existing.issue.key}.`;
            finalStatusType = "error";
          } else {
            setStatus(
              `Uploading ${missing.length} missing attachment(s) with ${existing.issue.key}...`,
              "loading",
            );
            setSyncProgressVisible(true);
            syncAbortBtn.disabled = false;
            const attachReport = await uploadMissingAttachments(
              jiraOrigin,
              existing.issue.key,
              captured.images,
              (loaded, total) =>
                updateSyncProgress(
                  loaded,
                  total,
                  `Uploading ${formatBytes(loaded)} of ${formatBytes(total)}…`,
                ),
            );
            setSyncProgressVisible(false);
            // The files this run actually uploaded are now synced — mark
            // them checked + disabled in the open picker so a re-run
            // reflects it.
            markAttachmentsSynced(attachReport.uploadedNames);
            if (attachReport.cancelled) {
              finalStatus = `Upload stopped. ${existing.issue.key} attachments not synced.`;
              finalStatusType = "info";
            } else if (attachReport.failed > 0) {
              finalStatus = `${attachReport.failed} attachment(s) still failed to upload${failedAttachmentNames(attachReport.failedNames)} (${attachReport.firstError}).`;
              finalStatusType = "error";
            } else {
              finalStatus =
                attachReport.uploaded > 0
                  ? `Ticket already exists: ${existing.issue.key}. ${attachReport.uploaded} missing attachment(s) uploaded.`
                  : `Ticket already exists: ${existing.issue.key}. Selected attachments up to date.`;
            }
          }
        }
      } else {
        finalStatus = `Ticket already exists: ${existing.issue.key}`;
      }

      // Each Spark comment/work note becomes its own Jira comment (deduped),
      // whether this run created anything or not — a resync picks up any
      // journal entries added since the last export.
      const commentSync = await syncSparkCommentsForTicket(
        jiraOrigin,
        existing.issue.key,
        pageData,
      );
      if (commentSync.added > 0) {
        finalStatus = `${finalStatus} ${commentSync.added} comment(s) synced.`;
      }

      setStatus(finalStatus, finalStatusType);
      renderTicketCard(existing.issue.key, issueUrl);
      saveProjectHistory(projectKey);
      return;
    }

    // New ticket: produce the final description. Images embedded in the
    // description are inline content, so they're captured and uploaded with
    // placeholders regardless of the attachments checkbox — attachment files
    // still follow the checkbox and the picker selection. Phase 1 only
    // listed names, so the bytes are downloaded here.
    const hasEmbeddedImages = /<img[^>]*>/i.test(pageData.html || "");
    let capturedData = pageData;
    if (hasEmbeddedImages || (includeAttachments && pageData.images?.length)) {
      const captured = await getPageData(getSourceSite(), {
        includeAttachments,
        selectedAttachments,
      }).catch(() => null);
      if (captured) {
        capturedData = captured.images?.some((img) => img.dataUrl)
          ? captured
          : { ...captured, images: [] };
      } else {
        // Re-capture failed — keep the phase-1 data but drop the name-only
        // metadata so it's never mistaken for real captured bytes.
        capturedData = { ...pageData, images: [] };
      }
    }

    const bodyAdf = htmlToADF(capturedData.html);

    const issueDescription = {
      version: 1,
      type: "doc",
      content: [...sourceUrlBlock(capturedData.url), ...bodyAdf.content],
    };

    setStatus("Creating Jira ticket...", "loading");

    const issue = await createJiraIssue(
      jiraOrigin,
      projectKey,
      finalSummary,
      issueDescription,
    );

    let attachReport = { failed: 0 };
    if (capturedData.images?.length) {
      setSyncProgressVisible(true);
      syncAbortBtn.disabled = false;
      attachReport = await attachImagesToIssue(
        jiraOrigin,
        issue.key,
        capturedData.images,
        issueDescription,
        (loaded, total) =>
          updateSyncProgress(
            loaded,
            total,
            `Uploading ${formatBytes(loaded)} of ${formatBytes(total)}…`,
          ),
      );
    }
    // The files this run actually uploaded are now synced — mark them checked
    // + disabled in the open picker so a re-run reflects it.
    markAttachmentsSynced(attachReport.uploadedNames);

    const issueUrl = `${jiraOrigin}/browse/${issue.key}`;

    // Each Spark comment/work note becomes its own Jira comment (deduped).
    const commentSync = await syncSparkCommentsForTicket(
      jiraOrigin,
      issue.key,
      capturedData,
    );
    const commentSuffix =
      commentSync.added > 0 ? ` ${commentSync.added} comment(s) synced.` : "";

    if (attachReport.cancelled) {
      setStatus(
        `Created ${issue.key}, but attachment upload was stopped.${commentSuffix}`,
        "info",
      );
    } else if (attachReport.failed > 0) {
      setStatus(
        `Created ${issue.key}, but ${attachReport.failed} attachment(s) failed to upload${failedAttachmentNames(attachReport.failedNames)} (${attachReport.firstError}).${commentSuffix}`,
        "error",
      );
    } else if (attachReport.descriptionError) {
      setStatus(
        `Created ${issue.key} (attachments uploaded, but inline image embed failed).${commentSuffix}`,
        "info",
      );
    } else {
      setStatus(`Created ${issue.key}.${commentSuffix}`, "success");
    }
    renderTicketCard(issue.key, issueUrl);
    saveProjectHistory(projectKey);
  } catch (error) {
    console.error(error);
    setStatus(error.message || "Failed to create ticket.", "error");
  } finally {
    setSyncProgressVisible(false);
    setBusy(false);
    revealStatus();
  }
}
