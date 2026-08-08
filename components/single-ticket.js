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
  startSyncAttachmentProgress,
  addSyncAttachmentProgressRow,
  setSyncAttachmentProgress,
  setSyncAttachmentState,
  syncAbortBtn,
  finishSyncProgress,
  markAttachmentsSynced,
} from "./ui.js";
import { getJiraContext } from "./validation.js";
import { saveSettings, saveProjectHistory } from "./storage.js";
import {
  getPageData,
  detectSiteInTab,
  fetchSparkCommentsInTab,
  getCurrentTab,
} from "./scrape.js";
import {
  detectJiraIssueInTab,
  syncJiraCommentsToSpark,
  syncSparkAttachmentsInOrigin,
} from "./jira-to-spark.js";
import {
  isJiraLoggedIn,
  validateProject,
  findExistingJiraIssueFor,
  createJiraIssue,
  getJiraIssueWithAttachments,
  listJiraCommentsDetailed,
} from "./api.js";
import { syncSparkComments } from "./comments.js";
import { sourceUrlBlock } from "./adf.js";
import {
  imageUploadFilename,
  failedAttachmentNames,
  uploadMissingAttachments,
  attachImagesToIssue,
  dataUrlSize,
} from "./attachments.js";

async function syncSparkCommentsForTicket(jiraOrigin, issueKey, pageData, existingBodies) {
  if (getSourceSite() !== "Spark" || !issueKey || !pageData?.url) {
    return { added: 0, total: 0 };
  }
  const sysIdMatch = /[?&]sys_id=([^&]+)/.exec(pageData.url || "");
  if (!sysIdMatch) return { added: 0, total: 0 };
  const groups = await fetchSparkCommentsInTab([sysIdMatch[1]]).catch(() => {
    return [];
  });
  const entries = groups[0]?.comments || [];
  return syncSparkComments(
    jiraOrigin,
    issueKey,
    entries,
    sysIdMatch[1],
    existingBodies,
  );
}

export async function createTicket() {
  setBusy(true);

  try {
    saveSettings();

    hideLoginButtons();
    resetTicketCard();

    const { jiraOrigin, projectKey } = getJiraContext() || {};
    if (!jiraOrigin || !projectKey) return;

    const includeAttachments = getIncludeAttachments();
    const selectedAttachments = includeAttachments
      ? getSelectedAttachments()
      : undefined;

    let progressStarted = false;
    const ensureSyncProgress = () => {
      if (progressStarted) return;
      progressStarted = true;
      startSyncAttachmentProgress();
      syncAbortBtn.disabled = false;
    };

    setStatus("Reading active QA ticket...", "loading");

    let pageData;
    try {

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

      const detected = await detectSiteInTab().catch(() => null);
      const jiraIssue = await detectJiraIssueInTab().catch(() => null);
      if (jiraIssue?.key) {
        setStatus(
          `Jira issue ${jiraIssue.key} detected — use the "Sync Jira comments to Spark" button instead of Create Ticket.`,
          "info",
        );
        return;
      }

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

    const existing = await findExistingJiraIssueFor(
      jiraOrigin,
      projectKey,
      finalSummary,
      pageData.url,
    );

    if (existing.error) {
      setStatus("Couldn't check for an existing ticket. Try again.", "error");
      return;
    }

    if (existing.issue) {
      const issueUrl = `${jiraOrigin}/browse/${existing.issue.key}`;

      let finalStatus = "";
      let finalStatusType = "success";
      let jiraAttachments = [];

      if (includeAttachments && pageData.images?.length) {
        setStatus(
          `Checking ${existing.issue.key} attachments...`,
          "loading",
        );
        let missing = pageData.images;
        let existingNames = new Set();
        try {
          const combined = await getJiraIssueWithAttachments(
            jiraOrigin,
            existing.issue.key,
          );
          jiraAttachments = combined.attachments;
          existingNames = new Map(
            combined.attachments.map((a) => [a.name, Number(a.size) || null]),
          );
          missing = pageData.images.filter((img) => {
            const name = imageUploadFilename(img);
            if (!existingNames.has(name)) return true;
            const jiraSize = existingNames.get(name);
            if (jiraSize == null) return false;
            const imgSize = Number(
              img.sizeBytes ?? img.size ?? dataUrlSize(img.dataUrl) ?? NaN,
            );
            if (!Number.isFinite(imgSize)) return false;
            return imgSize !== jiraSize;
          });
        } catch {

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
            ensureSyncProgress();
            const namedImages = captured.images.filter((img) => img.name);
            namedImages.forEach((img) => {
              addSyncAttachmentProgressRow({
                label: imageUploadFilename(img),
                size: img.sizeBytes ?? img.size ?? dataUrlSize(img.dataUrl),
                hint: "Uploading to Jira…",
              });
            });
            const attachReport = await uploadMissingAttachments(
              jiraOrigin,
              existing.issue.key,
              namedImages,
              undefined,
              undefined,
              existingNames,
              (index, loaded, total) =>
                setSyncAttachmentProgress(index, loaded, total),
            );
            const skippedSet = new Set(attachReport.skippedNames || []);
            const failedSet = new Set(attachReport.failedNames || []);
            namedImages.forEach((img, i) => {
              const name = imageUploadFilename(img);
              if (skippedSet.has(name)) {
                setSyncAttachmentState(i, "skipped", "Already on Jira");
              } else if (failedSet.has(name)) {
                setSyncAttachmentState(i, "failed", "Upload to Jira failed");
              } else {
                setSyncAttachmentState(i, "done", "Synced to Jira");
              }
            });

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

      if (includeAttachments && jiraAttachments.length) {
        const selected = new Set(
          Array.isArray(selectedAttachments) ? selectedAttachments : [],
        );
        const jiraToSpark = selected.size
          ? jiraAttachments.filter((j) => selected.has(j.name))
          : jiraAttachments;
        if (jiraToSpark.length) {
          try {
            setStatus(
              `Syncing ${jiraToSpark.length} Jira attachment(s) to Spark...`,
              "loading",
            );
            ensureSyncProgress();
            let jiraRowStart = -1;
            jiraToSpark.forEach((item) => {
              const idx = addSyncAttachmentProgressRow({
                label: item.name,
                size: Number(item.size) || 0,
                hint: "Queued…",
              });
              if (jiraRowStart < 0) jiraRowStart = idx;
            });
            const sysIdMatch = /[?&]sys_id=([^&]+)/.exec(pageData.url || "");
            const currentTab = await getCurrentTab();
            const sparkBack = await syncSparkAttachmentsInOrigin({
              jiraOrigin,
              sparkOrigin: new URL(pageData.url).origin,
              sysId: sysIdMatch ? sysIdMatch[1] : "",
              files: jiraToSpark,
              tab: currentTab,
              onFileProgress: (index, loaded, total) =>
                setSyncAttachmentProgress(jiraRowStart + index, loaded, total),
              onFileState: (index, state, message) =>
                setSyncAttachmentState(jiraRowStart + index, state, message),
            });
            if (sparkBack.failed > 0) {
              finalStatus = `${finalStatus} ${sparkBack.failed} attachment(s) failed to sync to Spark${failedAttachmentNames(sparkBack.failedNames)}.`;
              finalStatusType = "error";
            } else if (sparkBack.uploaded > 0) {
              finalStatus = `${finalStatus} ${sparkBack.uploaded} Jira attachment(s) synced to Spark.`;
            }
            const failedSet = new Set(sparkBack.failedNames || []);
            markAttachmentsSynced(
              jiraToSpark
                .map((j) => j.name)
                .filter((n) => !failedSet.has(n)),
            );
          } catch {
            finalStatus = `${finalStatus} Couldn't sync Jira attachments to Spark.`;
          }
        }
      }

      let jiraComments = [];
      try {
        jiraComments = await listJiraCommentsDetailed(
          jiraOrigin,
          existing.issue.key,
        );
      } catch {}

      const commentSync = await syncSparkCommentsForTicket(
        jiraOrigin,
        existing.issue.key,
        pageData,
        jiraComments.map((c) => c.body),
      );
      if (commentSync.added > 0) {
        finalStatus = `${finalStatus} ${commentSync.added} comment(s) synced.`;
      }

      let backSyncText = "";
      try {
        setStatus(
          `Syncing ${existing.issue.key} comments back to Spark...`,
          "loading",
        );
        const { report } = await syncJiraCommentsToSpark({
          jiraOrigin,
          issueKey: existing.issue.key,
          comments: jiraComments,
          sourceUrl: pageData.url,
        });
        if (report.posted > 0) {
          backSyncText = ` ${report.posted} Jira comment(s) synced back to Spark.`;
        } else if (report.failed > 0) {
          backSyncText = ` ${report.failed} Jira comment(s) failed to sync back to Spark.`;
        }
      } catch {}

      setStatus(`${finalStatus}${backSyncText}`, finalStatusType);
      renderTicketCard(existing.issue.key, issueUrl);
      saveProjectHistory(projectKey);
      return;
    }

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
      ensureSyncProgress();
      capturedData.images.forEach((img) => {
        addSyncAttachmentProgressRow({
          label: imageUploadFilename(img),
          size: img.sizeBytes ?? img.size ?? dataUrlSize(img.dataUrl),
          hint: "Uploading to Jira…",
        });
      });
      attachReport = await attachImagesToIssue(
        jiraOrigin,
        issue.key,
        capturedData.images,
        issueDescription,
        undefined,
        undefined,
        (index, loaded, total) =>
          setSyncAttachmentProgress(index, loaded, total),
      );
      const failedSet = new Set(attachReport.failedNames || []);
      capturedData.images.forEach((img, i) => {
        const name = imageUploadFilename(img);
        if (failedSet.has(name)) {
          setSyncAttachmentState(i, "failed", "Upload to Jira failed");
        } else {
          setSyncAttachmentState(i, "done", "Synced to Jira");
        }
      });
    }

    markAttachmentsSynced(attachReport.uploadedNames);

    const issueUrl = `${jiraOrigin}/browse/${issue.key}`;

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
    setStatus(error.message || "Failed to create ticket.", "error");
  } finally {
    finishSyncProgress();
    setBusy(false);
    revealStatus();
  }
}
