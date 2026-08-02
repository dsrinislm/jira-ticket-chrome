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
  listingImportLabel,
  setActiveListingSite,
  getActiveListingSite,
  getSourceSite,
  getIncludeAttachments,
  setAttachmentPickerLoading,
  clearAttachmentPicker,
  renderAttachmentPicker,
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
} from "./components/ui.js";
import { debounce } from "./components/util.js";
import {
  listTicketAttachmentsInTab,
  detectTabState,
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
} from "./components/validation.js";
import { createTicket } from "./components/single-ticket.js";
import {
  runBulkImport,
  runListingImport,
  requestAbort,
} from "./components/bulk-import.js";
import { requestUploadCancel } from "./components/attachments.js";

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
    // After a paste fills both Jira fields, move focus to the next actionable
    // control for the active view: the upload dropzone when bulk-importing
    // (e.g. no Spark/Octane ticket open), otherwise the create-ticket CTA.
    if (!bulkView.hidden) {
      fileInput.focus();
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

// Once both Jira fields are filled (focus is out), swap the idle status
// message for a nudge toward the create-ticket CTA. Cleared back to the
// idle message whenever either field stops being filled.
function promptCreateTicketWhenReady() {
  refreshSingleViewStatus();
}

// On input we only ever clear the nudge — never introduce it mid-typing.
// The ready message itself appears once focus leaves a fully-filled field.
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

// "Include attachments" toggles the picker: the ticket's attachments are
// listed (metadata only — no file bytes are fetched yet) so the user can
// check exactly which ones to upload. Turning the toggle back off clears the
// picker so a later re-enable starts from a fresh selection.
includeAttachmentsInput.addEventListener("change", async () => {
  if (!getIncludeAttachments()) {
    clearAttachmentPicker();
    return;
  }

  setAttachmentPickerLoading();
  smoothScrollToBottom();

  try {
    const items = await listTicketAttachmentsInTab(getSourceSite());
    if (!getIncludeAttachments()) return; // toggled off while listing

    // Files over the uploadable size are never listed — they'd only fail with
    // Jira Cloud's 401 large-upload gateway error. The cutoff is 26 MB (a
    // 25 MB file can still upload); the note still says "over 25 MB" so the
    // warning matches the gateway's real ~25 MB ceiling.
    const listable = items.filter(
      (item) => attachmentByteSize(item) <= MAX_ATTACHMENT_UPLOAD_BYTES,
    );
    const skipped = items.length - listable.length;
    const note = skipped
      ? `${skipped} file(s) over 25 MB skipped — add them from the Jira UI.`
      : "";

    if (!listable.length) {
      attachmentGroups.innerHTML =
        '<div class="attachment-group-title">No attachments found.</div>';
      setAttachmentNote(note);
      smoothScrollToBottom();
      return;
    }
    renderAttachmentPicker(listable);
    setAttachmentNote(note);
    smoothScrollToBottom();
  } catch (err) {
    console.error(err);
    attachmentGroups.innerHTML =
      '<div class="attachment-group-title">Couldn’t list attachments.</div>';
    smoothScrollToBottom();
  }
});

attachmentSelectAll.addEventListener("change", () => {
  const boxes = attachmentGroups.querySelectorAll(
    ".attachment-item input[type='checkbox']",
  );
  boxes.forEach((box) => {
    box.checked = attachmentSelectAll.checked;
  });
  state.attachmentSelection = attachmentSelectAll.checked
    ? Array.from(boxes).map((box) => box.dataset.name)
    : [];
});

// Lets the user stop an in-flight bulk import. Picked up by the worker
// pool between rows, so the current row's Jira calls finish first.
abortImportBtn.addEventListener("click", () => {
  requestAbort();
  abortImportBtn.disabled = true;
});

// Lets the user stop an in-flight single-ticket attachment upload: aborts
// every live XHR and flags the pool to skip the remaining files.
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
    setSingleTabEnabled(false);
    return;
  }

  const matched = site !== null;
  // The single-ticket flow needs a Spark/Octane ticket in the active tab;
  // otherwise the "Current Ticket" tab is disabled and only bulk import works.
  setSingleTabEnabled(matched);
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

applyDetectedState().then(equalizeInitialViewHeights);
// Chrome sizes the popup window to the body's layout height, so switching
// between the (differently sized) single and bulk tabs at initial load would
// resize the window. Measure both views' natural heights and pin each view's
// min-height to the taller one — the single view's gap-art canvas and the
// bulk view's .view-fill then absorb the extra space, so both tabs open at
// the same window size.
function equalizeInitialViewHeights() {
  const views = [singleView, bulkView];
  let tallest = 0;
  for (const view of views) {
    // A hidden view reports 0 — show it briefly (synchronously, so nothing
    // paints) to capture its natural height, then restore the toggle.
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
