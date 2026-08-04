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
  sourceSiteInput,
  sourceSiteLabels,
  setSourceSite,
  setSourceSiteLocked,
  setSourceSiteVisible,
  setSingleTabEnabled,
  setStatus,
  switchView,
  toggleSelectAll,
  updateBulkStatusMessage,
  abortImportBtn,
  listingImportBtn,
  getActiveListingSite,
  getSourceSite,
  getIncludeAttachments,
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
  listIssueAttachments,
} from "./components/api.js";
import { createTicket } from "./components/single-ticket.js";
import {
  runBulkImport,
  runListingImport,
  requestAbort,
} from "./components/bulk-import.js";
import { requestUploadCancel } from "./components/attachments.js";

const debouncedSaveSettings = debounce(saveSettings, 300);

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
createTicketBtn.addEventListener("click", createTicket);

includeAttachmentsInput.addEventListener("change", async () => {
  if (!getIncludeAttachments()) {
    clearAttachmentPicker();
    return;
  }

  setAttachmentPickerLoading();
  smoothScrollToBottom();

  try {
    const items = await listTicketAttachmentsInTab(getSourceSite());
    if (!getIncludeAttachments()) return;

    const listable = items.filter(
      (item) => attachmentByteSize(item) <= MAX_ATTACHMENT_UPLOAD_BYTES,
    );
    const skipped = items.length - listable.length;
    const note = skipped
      ? `${skipped} file(s) over 25 MB skipped — add them from the Jira UI.`
      : "";

    let syncedNames = new Set();
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
        const found = await findExistingJiraIssue(
          ctx.jiraOrigin,
          ctx.projectKey,
          pageData.title,
        );
        if (found.issue) {
          foundTicket = true;
          syncedNames = new Set(
            await listIssueAttachments(ctx.jiraOrigin, found.issue.key),
          );
        }
      }
    }
    setSyncedTicketFound(foundTicket);
    if (!getIncludeAttachments()) return;

    renderAttachmentPicker(listable, syncedNames);
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

async function applyDetectedState() {

  setSyncedTicketFound(false);
  resetTicketCard();

  let site = null;
  let listing = null;
  let selectedCount = 0;
  try {
    ({ site, listing, selectedCount } = await detectTabState());
  } catch {
    setSourceSiteVisible(false);
    setSingleTabEnabled(false);
    applyListingState(null, 0);
    return;
  }

  const matched = site !== null && listing === null;
  setSingleTabEnabled(matched);

  if (matched) setSourceSite(site);
  setSourceSiteVisible(matched);
  setSourceSiteLocked(matched);

  applyListingState(listing, selectedCount);
  if (!bulkView.hidden) {
    updateBulkStatusMessage();
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
