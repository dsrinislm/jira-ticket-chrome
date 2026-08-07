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
  singleView,
  createTicketBtn,
  createTicketLabel,
  singleAttachments,
  sourceSiteInput,
  sourceSiteLabels,
  setSourceSite,
  setSourceSiteLocked,
  setSourceSiteVisible,
  setSingleTabEnabled,
  setBusy,
  getBusy,
  setStatus,
  switchView,
  toggleSelectAll,
  updateBulkStatusMessage,
  abortImportBtn,
  listingImportBtn,
  getActiveListingSite,
  getSourceSite,
  getIncludeAttachments,
  getSelectedAttachments,
  setAttachmentPickerLoading,
  clearAttachmentPicker,
  renderAttachmentPicker,
  setAttachmentSyncProgress,
  setSyncedTicketFound,
  resetTicketCard,
  attachmentPickerTitle,
  attachmentGroups,
  attachmentSelectAll,
  includeAttachmentsInput,
  state,
  smoothScrollToBottom,
  syncAbortBtn,
  refreshSingleViewStatus,
  setAttachmentNote,
  attachmentByteSize,
  MAX_ATTACHMENT_UPLOAD_BYTES,
  getBulkIncludeAttachments,
  setBulkPreviewCollapsed,
  setBulkAttachmentPickerLoading,
  clearBulkAttachmentPicker,
  renderBulkAttachmentPicker,
  bulkAttachmentPickerTitle,
  setBulkAttachmentNote,
  setBulkAttachmentSyncProgress,
  markBulkRowsFullySynced,
  isExcelFlowActive,
  applyListingState,
  getListingHasSelection,
  scrollBulkToFirstSelected,
  bulkAttachmentGroups,
  bulkAttachmentSelectAll,
  bulkIncludeAttachments,
  jiraToSparkSyncBtn,
  setJiraToSparkVisible,
  setJiraSyncFlowActive,
} from "./components/ui.js";
import { debounce } from "./components/util.js";
import {
  listTicketAttachmentsInTab,
  listListingAttachmentsInTab,
  scrapeSelectedListingInTab,
  scrapeSelectedSparkListingInTab,
  detectTabState,
  scrapeTab,
  getCurrentTab,
} from "./components/scrape.js";
import { startGapArt } from "./components/gap-art.js";
import { handleFileSelected, downloadPreviewReport } from "./components/excel.js";
import { loadInitialState, saveSettings } from "./components/storage.js";
import {
  enforceJiraBaseUrlNoPath,
  clearJiraBaseUrlErrorIfNowValid,
  validateJiraBaseUrlField,
  debouncedValidateBulkProjectKey,
  extractJiraIssueDetailsFromBaseUrl,
  getJiraContext,
} from "./components/validation.js";
import {
  findExistingJiraIssue,
  findExistingJiraIssueFor,
  getJiraIssue,
  getJiraIssueWithAttachments,
  listIssueAttachments,
} from "./components/api.js";
import { extractSourceUrl } from "./components/adf.js";
import { createTicket } from "./components/single-ticket.js";
import {
  runBulkImport,
  runListingImport,
  requestAbort,
} from "./components/bulk-import.js";
import { requestUploadCancel } from "./components/attachments.js";
import {
  detectJiraIssueInTab,
  detectJiraPageInTab,
  syncJiraUpdates,
  getSyncAttachmentItems,
} from "./components/jira-to-spark.js";

const debouncedSaveSettings = debounce(saveSettings, 300);

let jiraFlowActive = false;
let detectionLocked = false;

loadInitialState();
startGapArt();

tabSingle.addEventListener("click", () => switchView("single"));
tabBulk.addEventListener("click", () => switchView("bulk"));
selectAllCheckbox.addEventListener("change", toggleSelectAll);
fileInput.addEventListener("change", handleFileSelected);
importBtn.addEventListener("click", () => {

  scrollBulkToFirstSelected();
  runBulkImport();
});
listingImportBtn.addEventListener("click", () =>
  runListingImport(getActiveListingSite()),
);
exportBtn.addEventListener("click", downloadPreviewReport);

jiraBaseUrlInput.addEventListener("input", (e) => {

  extractJiraIssueDetailsFromBaseUrl();
  enforceJiraBaseUrlNoPath();
  clearJiraBaseUrlErrorIfNowValid();
  debouncedSaveSettings();
  if (
    e.inputType === "insertFromPaste" &&
    jiraBaseUrlInput.value.trim() &&
    projectKeyInput.value.trim()
  ) {

    if (!bulkView.hidden) {
      if (!isExcelFlowActive() && getActiveListingSite() && getListingHasSelection()) {
        listingImportBtn.focus();
      } else {
        fileInput.focus();
      }
    } else {
      createTicketBtn.focus();
    }
  }
});

jiraBaseUrlInput.addEventListener("blur", () => {
  const result = validateJiraBaseUrlField();
  if (result?.valid) promptCreateTicketWhenReady();
});
projectKeyInput.addEventListener("blur", promptCreateTicketWhenReady);
projectKeyInput.addEventListener("input", debouncedSaveSettings);

function promptCreateTicketWhenReady() {
  refreshSingleViewStatus();
}

function resetSinglePromptIfIncomplete() {
  if (bulkView.hidden) {
    const configured =
      jiraBaseUrlInput.value.trim() && projectKeyInput.value.trim();
    if (!configured) {
      setStatus("Configure Jira details and create a ticket.", "info");
    }
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
createTicketBtn.addEventListener("click", () => {
  if (jiraFlowActive) {
    runSyncUpdates();
  } else {
    createTicket();
  }
});

jiraToSparkSyncBtn.addEventListener("click", runSyncUpdates);

async function runSyncUpdates() {
  const ctx = getJiraContext();
  const issue = await detectJiraIssueInTab().catch(() => null);
  if (!ctx) return;
  if (!issue?.key) {
    setStatus("Open a Jira ticket to sync its updates with Spark.", "info");
    return;
  }
  if (ctx.jiraOrigin !== issue.origin) {
    setStatus(
      `This Jira (${issue.origin}) doesn't match the configured base URL (${ctx.jiraOrigin}). Update the Jira base URL and retry.`,
      "error",
    );
    return;
  }

  setBusy(true);
  detectionLocked = true;
  try {
    setStatus(`Syncing updates for ${issue.key}...`, "loading");
    const { report, sparkToJira, attachments, attachmentsToSpark } =
      await syncJiraUpdates({
        jiraOrigin: ctx.jiraOrigin,
        issueKey: issue.key,
        includeAttachments: getIncludeAttachments(),
        selectedAttachments: getIncludeAttachments()
          ? getSelectedAttachments()
          : null,
      });
    const via = String(report.mode || "").startsWith("spark tab")
      ? " (via Spark tab)"
      : "";
    const bits = [];
    if (report.posted > 0) {
      bits.push(`${report.posted} Jira comment(s) synced to Spark`);
    } else if (report.failed > 0) {
      bits.push(`${report.failed} Jira comment(s) failed to sync to Spark`);
    } else {
      bits.push("Jira comments up to date in Spark");
    }
    if (sparkToJira?.added > 0) {
      bits.push(`${sparkToJira.added} Spark comment(s) synced to Jira`);
    } else {
      bits.push("Spark comments up to date in Jira");
    }
    if (attachments?.uploaded > 0) {
      bits.push(`${attachments.uploaded} attachment(s) synced to Jira`);
    } else if (attachments?.failed > 0) {
      bits.push(`${attachments.failed} attachment(s) failed to sync to Jira`);
    } else if (attachments?.skipped > 0) {
      bits.push("attachments up to date in Jira");
    }
    if (attachmentsToSpark?.uploaded > 0) {
      bits.push(`${attachmentsToSpark.uploaded} attachment(s) synced to Spark`);
    } else if (attachmentsToSpark?.failed > 0) {
      const names = (attachmentsToSpark.failedNames || []).join(", ");
      bits.push(
        `${attachmentsToSpark.failed} attachment(s) failed to sync to Spark${names ? `: ${names}` : ""}`,
      );
    } else if (attachmentsToSpark?.skipped > 0) {
      bits.push("attachments up to date in Spark");
    }
    const failed =
      report.failed > 0 ||
      attachments?.failed > 0 ||
      attachmentsToSpark?.failed > 0;
    if (!failed) {
      setStatus("Ticket fully synced! try new one.", "success");
      return;
    }
    const attachmentError = attachmentsToSpark?.firstError
      ? ` ${attachmentsToSpark.firstError}`
      : "";
    setStatus(
      `${issue.key}: ${bits.join("; ")}${via}.${attachmentError}${failed && report.detail ? ` ${report.detail}` : ""}`,
      failed ? "error" : "success",
    );
  } catch (error) {
    setStatus(error.message || "Failed to sync updates.", "error");
  } finally {
    setBusy(false);
    detectionLocked = false;
  }
}

function attachmentType(name) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (["mp4", "m4v", "mov", "avi", "mkv", "webm", "wmv", "flv", "mpeg", "mpg"].includes(ext)) {
    return "video";
  }
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "tif", "tiff", "ico"].includes(ext)) {
    return "image";
  }
  return "other";
}

includeAttachmentsInput.addEventListener("change", async () => {
  if (!getIncludeAttachments()) {
    clearAttachmentPicker();
    return;
  }

  setAttachmentPickerLoading();
  smoothScrollToBottom();
  detectionLocked = true;

  if (jiraFlowActive) {
    try {
      const ctx = getJiraContext();
      const issue = await detectJiraIssueInTab().catch(() => null);
      if (!ctx || !issue?.key) {
        clearAttachmentPicker();
        return;
      }
      const { items, syncedNames } = await getSyncAttachmentItems({
        jiraOrigin: ctx.jiraOrigin,
        issueKey: issue.key,
      });
      if (!getIncludeAttachments()) return;
      renderAttachmentPicker(items, syncedNames);
      setAttachmentNote("");
      smoothScrollToBottom();
    } catch {
      setSyncedTicketFound(false);
      attachmentGroups.innerHTML =
        '<div class="attachment-group-title">Couldn’t list attachments.</div>';
      if (attachmentPickerTitle) {
        attachmentPickerTitle.textContent = "Choose attachments to upload (0)";
      }
      smoothScrollToBottom();
    } finally {
      setAttachmentSyncProgress(false);
      detectionLocked = false;
    }
    return;
  }

  try {
    const items = await listTicketAttachmentsInTab(getSourceSite());
    if (!getIncludeAttachments()) return;

    let syncedNames = new Set();
    let jiraItems = [];
    let foundTicket = false;
    const ctx = getJiraContext();
    if (ctx) {
      const currentTab = await getCurrentTab();
      const pageData = await scrapeTab(currentTab.id, getSourceSite(), {
        includeAttachments: false,
        captureAttachments: false,
        captureEmbeddedImages: false,
      }).catch(() => null);
      if (pageData?.title) {
        const found = await findExistingJiraIssueFor(
          ctx.jiraOrigin,
          ctx.projectKey,
          pageData.title,
          pageData.url,
        );
        if (found.issue) {
          foundTicket = true;
          try {
            const combined = await getJiraIssueWithAttachments(
              ctx.jiraOrigin,
              found.issue.key,
            );
            jiraItems = combined.attachments;
          } catch {
            jiraItems = [];
          }
        }
      }
    }
    setSyncedTicketFound(foundTicket);
    if (!getIncludeAttachments()) return;

    const byName = new Map();
    for (const item of items) {
      byName.set(item.name, { ...item, source: "Spark" });
    }
    for (const j of jiraItems) {
      const size = Number(j.size);
      const normalized = {
        ...j,
        type: attachmentType(j.name),
        sizeBytes:
          Number.isFinite(size) && size >= 0 ? size : null,
        url: `${ctx?.jiraOrigin}/rest/api/3/attachment/content/${encodeURIComponent(j.id)}`,
      };
      if (byName.has(j.name)) {
        const spark = byName.get(j.name);
        const sparkSize = spark.sizeBytes ?? null;
        const sameSize =
          sparkSize == null || normalized.sizeBytes == null
            ? true
            : sparkSize === normalized.sizeBytes;
        byName.set(j.name, { ...spark, inJira: sameSize });
      } else {
        byName.set(j.name, { ...normalized, source: "Jira" });
      }
    }
    const mergedItems = Array.from(byName.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    syncedNames = new Set(
      mergedItems.filter((i) => i.inJira).map((i) => i.name),
    );
    const overLimitNames = new Set(
      items
        .filter((item) => attachmentByteSize(item) > MAX_ATTACHMENT_UPLOAD_BYTES)
        .map((item) => item.name),
    );
    const renderItems = mergedItems.filter(
      (item) =>
        item.inJira ||
        item.source !== "Spark" ||
        !overLimitNames.has(item.name),
    );
    const skipped = mergedItems.filter(
      (item) =>
        !item.inJira &&
        item.source === "Spark" &&
        overLimitNames.has(item.name),
    ).length;
    const note = skipped
      ? `${skipped} file(s) over 25 MB skipped — add them from the Jira UI.`
      : "";
    renderAttachmentPicker(renderItems, syncedNames);
    setAttachmentNote(note);
    smoothScrollToBottom();
  } catch {
    setSyncedTicketFound(false);
    attachmentGroups.innerHTML =
      '<div class="attachment-group-title">Couldn’t list attachments.</div>';
    if (attachmentPickerTitle) {
      attachmentPickerTitle.textContent = "Choose attachments to upload (0)";
    }
    smoothScrollToBottom();
  } finally {
    setAttachmentSyncProgress(false);
    detectionLocked = false;
  }
});

attachmentSelectAll.addEventListener("change", () => {
  const boxes = attachmentGroups.querySelectorAll(
    ".attachment-item input[type='checkbox']",
  );
  boxes.forEach((box) => {
    if (box.disabled) return;
    box.checked = attachmentSelectAll.checked;
  });
  state.attachmentSelection = attachmentSelectAll.checked
    ? Array.from(boxes)
        .filter((box) => !box.disabled)
        .map((box) => box.dataset.name)
    : [];
});

bulkIncludeAttachments.addEventListener("change", async () => {
  if (!getBulkIncludeAttachments()) {
    clearBulkAttachmentPicker();
    setBulkPreviewCollapsed(false);
    return;
  }

  setBulkPreviewCollapsed(true);

  const site = getActiveListingSite();
  if (!site) {
    setStatus("Open a Spark or Octane listing to choose attachments.", "error");
    clearBulkAttachmentPicker();
    return;
  }

  setBulkAttachmentPickerLoading();
  smoothScrollToBottom();

  try {
    const items =
      site === "Spark"
        ? await scrapeSelectedSparkListingInTab()
        : await scrapeSelectedListingInTab();
    if (!getBulkIncludeAttachments()) return;
    if (!items.length) {
      setStatus(
        `Tick the rows you want to import on the ${site} page, then enable attachments.`,
        "error",
      );
      bulkAttachmentGroups.innerHTML =
        '<div class="attachment-group-title">No rows selected on the listing page.</div>';
      if (bulkAttachmentPickerTitle) {
        bulkAttachmentPickerTitle.textContent = "Choose attachments to upload (0)";
      }
      smoothScrollToBottom();
      return;
    }

    const labels = {};
    for (const item of items) {
      labels[item.id] = site === "Spark" ? item.number || item.id : item.id;
    }

    const groups = await listListingAttachmentsInTab(
      items.map((i) => i.id),
      site,
    );
    if (!getBulkIncludeAttachments()) return;

    let skipped = 0;
    for (const group of groups) {
      const listable = (group.attachments || []).filter(
        (a) => attachmentByteSize(a) <= MAX_ATTACHMENT_UPLOAD_BYTES,
      );
      skipped += (group.attachments || []).length - listable.length;
      group.attachments = listable;
    }

    const note = skipped
      ? `${skipped} file(s) over 25 MB skipped — add them from the Jira UI.`
      : "";

    const syncedMap = await buildBulkSyncedMap(items, site);
    if (!getBulkIncludeAttachments()) return;

    renderBulkAttachmentPicker(groups, labels, syncedMap);
    setBulkAttachmentNote(note);
    markBulkRowsFullySynced(fullySyncedIds(groups, syncedMap));

    setStatus(
      "Attachments are checked against Jira during import — files already attached to existing tickets are skipped.",
      "info",
    );
    smoothScrollToBottom();
  } catch {
    setStatus("Couldn't list attachments for the selected rows.", "error");
    bulkAttachmentGroups.innerHTML =
      '<div class="attachment-group-title">Couldn’t list attachments.</div>';
    if (bulkAttachmentPickerTitle) {
      bulkAttachmentPickerTitle.textContent = "Choose attachments to upload (0)";
    }
    smoothScrollToBottom();
  } finally {
    setBulkAttachmentSyncProgress(false);
  }
});

async function buildBulkSyncedMap(items, site) {
  const ctx = getJiraContext();
  if (!ctx || !items.length) return {};
  const { jiraOrigin, projectKey } = ctx;
  const synced = {};
  let next = 0;
  const MAX_CONCURRENCY = 4;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      try {

        const title =
          site === "Spark"
            ? `SPARK | ${item.number || item.id} | ${item.name || ""}`
            : item.name || "";
        if (!title) continue;
        const found = await findExistingJiraIssue(jiraOrigin, projectKey, title);
        if (!found.issue) continue;
        const names = await listIssueAttachments(jiraOrigin, found.issue.key);
        synced[String(item.id)] = new Set(names);
      } catch {

      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(MAX_CONCURRENCY, items.length) }, worker),
  );
  return synced;
}

function fullySyncedIds(groups, syncedMap) {
  return new Set(
    groups
      .filter((group) => {
        const files = group.attachments || [];
        const set = syncedMap[String(group.id)];
        return set && files.length > 0 && files.every((f) => set.has(f.name));
      })
      .map((group) => group.id),
  );
}

bulkAttachmentSelectAll.addEventListener("change", () => {
  const checked = bulkAttachmentSelectAll.checked;
  const sel = {};
  bulkAttachmentGroups
    .querySelectorAll(".attachment-item input[type='checkbox']")
    .forEach((box) => {
      if (box.disabled) return;
      box.checked = checked;
      if (!sel[box.dataset.ticket]) sel[box.dataset.ticket] = [];
      if (checked) sel[box.dataset.ticket].push(box.dataset.name);
    });
  state.bulkAttachmentSelection = sel;

  bulkAttachmentGroups
    .querySelectorAll(".attachment-group-check")
    .forEach((groupCheck) => {
      const boxes = groupCheck.closest(".attachment-group").querySelectorAll(
        ".attachment-item:not(.attachment-item-synced) input[type='checkbox']",
      );
      let checkedCount = 0;
      for (const box of boxes) if (box.checked) checkedCount++;
      groupCheck.checked = checkedCount > 0 && checkedCount === boxes.length;
    });
});

abortImportBtn.addEventListener("click", () => {
  requestAbort();
  abortImportBtn.disabled = true;
});

syncAbortBtn.addEventListener("click", () => {
  requestUploadCancel();
  syncAbortBtn.disabled = true;
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

function syncJiraContextFromTab(info) {
  let changed = false;
  if (info.origin && jiraBaseUrlInput.value.trim() !== info.origin) {
    jiraBaseUrlInput.value = info.origin;
    changed = true;
  }
  const currentKey = projectKeyInput.value.trim().toUpperCase();
  if (info.projectKey && currentKey !== info.projectKey) {
    projectKeyInput.value = info.projectKey;
    changed = true;
  }
  if (changed) {
    clearJiraBaseUrlErrorIfNowValid();
    extractJiraIssueDetailsFromBaseUrl();
  }
}

async function applyDetectedState() {
  if (getBusy() || detectionLocked) return;

  setSyncedTicketFound(false);
  resetTicketCard();

  const jiraPage = await detectJiraPageInTab().catch(() => null);

  let site = null;
  let listing = null;
  let selectedCount = 0;
  if (!jiraPage) {
    try {
      ({ site, listing, selectedCount } = await detectTabState());
    } catch {
      setSourceSiteVisible(false);
      setSingleTabEnabled(false);
      setJiraToSparkVisible(false);
      createTicketBtn.hidden = false;
      applyListingState(null, 0);
      return;
    }
  }

  const matched = site !== null && listing === null;

  if (jiraPage) {
    syncJiraContextFromTab(jiraPage);
  }

  let onSyncFlow = false;
  if (jiraPage?.type === "filter") {
    onSyncFlow = true;
  } else if (jiraPage?.type === "ticket") {
    try {
      const issue = await getJiraIssue(jiraPage.origin, jiraPage.key);
      onSyncFlow = Boolean(extractSourceUrl(issue?.fields?.description));
    } catch {
      onSyncFlow = false;
    }
  }
  const isTicketContext = matched || onSyncFlow;
  tabSingle.hidden = !isTicketContext;
  setSingleTabEnabled(isTicketContext);

  if (jiraPage) {
    setSourceSiteVisible(false);
  } else {
    if (matched) setSourceSite(site);
    setSourceSiteVisible(matched);
    setSourceSiteLocked(matched);
  }

  setJiraToSparkVisible(false);
  jiraFlowActive = onSyncFlow;
  setJiraSyncFlowActive(jiraFlowActive);
  singleAttachments.hidden = Boolean(jiraPage) && !jiraFlowActive;
  if (jiraFlowActive) {
    includeAttachmentsInput.disabled = false;
  }
  createTicketLabel.textContent = "Sync Updates";
  createTicketBtn.hidden = Boolean(jiraPage) && !jiraFlowActive;
  if (jiraFlowActive && !bulkView.hidden) {
    switchView("single", false);
  }

  applyListingState(listing, selectedCount);
  if (jiraFlowActive && jiraPage?.type === "ticket") {
    setStatus("Sync updates with Spark", "info");
    createTicketBtn.focus();
  } else if (!bulkView.hidden) {
    updateBulkStatusMessage();
  } else if (jiraPage) {
    setStatus(
      jiraPage.type === "filter"
        ? "Jira filter detected — base URL set."
        : jiraPage.projectKey
          ? `Jira project ${jiraPage.projectKey} detected — base URL and project key set.`
          : "Jira page detected — base URL set.",
      "info",
    );
  } else {

    refreshSingleViewStatus();
  }
}

applyDetectedState().then(equalizeInitialViewHeights);

function equalizeInitialViewHeights() {
  const views = [singleView, bulkView];
  let tallest = 0;
  for (const view of views) {

    const wasHidden = view.hidden;
    view.hidden = false;
    tallest = Math.max(tallest, view.offsetHeight);
    view.hidden = wasHidden;
  }
  if (tallest > 0) {
    for (const view of views) {
      view.style.minHeight = `${tallest}px`;
    }
  }
}

const debouncedDetectState = debounce(applyDetectedState, 150);
chrome.tabs.onActivated.addListener(debouncedDetectState);
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {

  if (changeInfo.status === "complete" || changeInfo.url) {
    debouncedDetectState();
  }
});
