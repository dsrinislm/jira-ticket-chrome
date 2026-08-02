import { setStatus } from "./ui.js";
import {
  uploadJiraAttachment,
  listIssueAttachments,
  updateJiraIssueDescription,
} from "./api.js";
import {
  dataUrlToBlob,
  fileMediaNode,
  insertUploadedImages,
} from "./adf.js";

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
export function imageUploadFilename(img) {
  return (
    img.name || `${img.placeholder}.${extensionForBlobType(dataUrlToBlob(img.dataUrl).type)}`
  );
}

// Lists the file names that failed to upload, for the error status line.
export function failedAttachmentNames(failedNames = []) {
  return failedNames.length ? ` (${failedNames.join(", ")})` : "";
}

// Byte size of a captured `data:` URL — computed from the base64 length
// without decoding (cheap even for large recordings, where a full atob copy
// would be wasteful).
function dataUrlSize(dataUrl) {
  if (!dataUrl) return 0;
  const idx = dataUrl.indexOf(",");
  const b64 = idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl;
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
}

// Cancellation for an in-flight upload batch: the Stop button aborts every
// live XHR and sets the flag so queued files are never started. Reset at the
// start of each uploadImages run.
let cancelRequested = false;
const activeXhrs = new Set();

export function requestUploadCancel() {
  cancelRequested = true;
  activeXhrs.forEach((xhr) => xhr.abort());
}

// Uploads a batch of images to a Jira issue through a small bounded pool
// (Jira has no bulk attachment endpoint — many small files are faster
// batched than strung one after another). Never touches the description.
// Returns the uploaded attachments by placeholder plus a failure report.
// `onProgress(uploadedBytes, totalBytes)` is called with the aggregate bytes
// sent so far vs. the batch total, so the UI can show "uploaded / remaining".
export async function uploadImages(jiraOrigin, issueKey, images, onProgress) {
  const byPlaceholder = {};
  const MAX_CONCURRENT = 4;
  let next = 0;
  let failed = 0;
  let firstError = "";
  const failedImages = [];

  cancelRequested = false;

  const totalBytes = images.reduce((sum, img) => sum + dataUrlSize(img.dataUrl), 0);
  let uploadedBytes = 0;

  const report = (loaded) => {
    if (typeof onProgress === "function") {
      onProgress(loaded ?? uploadedBytes, totalBytes);
    }
  };

  const uploadOne = async () => {
    while (next < images.length && !cancelRequested) {
      const img = images[next++];
      const filename = imageUploadFilename(img);
      // Concurrent workers each add their own in-flight bytes on top of the
      // aggregate captured when they started — a close approximation that
      // stays monotonic and lands exactly on totalBytes at the end.
      const fileBase = uploadedBytes;
      try {
        const attachment = await uploadJiraAttachment(
          jiraOrigin,
          issueKey,
          dataUrlToBlob(img.dataUrl),
          filename,
          (loaded) => report(fileBase + loaded),
          // Hand the live XHR to the Stop handler so a cancel aborts it.
          (xhr) => {
            activeXhrs.add(xhr);
            xhr.addEventListener("loadend", () => activeXhrs.delete(xhr));
          },
        );
        byPlaceholder[img.placeholder] = fileMediaNode(attachment);
      } catch (err) {
        if (cancelRequested) break; // stopped by the user — not a failure
        failed++;
        if (!firstError) firstError = err.message || String(err);
        failedImages.push(img);
        console.error("Image upload failed:", img.placeholder, filename, err);
      }
      uploadedBytes += dataUrlSize(img.dataUrl);
      report();
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(MAX_CONCURRENT, images.length) }, uploadOne),
  );

  report();
  return { byPlaceholder, failed, firstError, failedImages, cancelled: cancelRequested };
}

// Uploads the scraped page's captured images and swaps their placeholders
// in the description body for the real attachment media nodes.
// Returns how many uploads failed (and the first error) so callers can
// surface "image missed" instead of dropping it silently.
export async function attachImagesToIssue(jiraOrigin, issueKey, images, description, onProgress) {
  setStatus("Uploading images...", "loading");

  const { byPlaceholder, failed, firstError, failedImages, cancelled } =
    await uploadImages(jiraOrigin, issueKey, images, onProgress);

  // Whether stopped by the user or just partially failed, the description is
  // still finalized with whatever uploaded — insertUploadedImages drops the
  // placeholders that have no media node, so cancelled files simply don't
  // appear instead of leaking `__JIRA_IMG_n__` text.
  setStatus("Attaching images to ticket...", "loading");

  await updateJiraIssueDescription(
    jiraOrigin,
    issueKey,
    insertUploadedImages(description.content, byPlaceholder),
  );

  return {
    failed,
    firstError,
    failedNames: failedImages.map((img) => imageUploadFilename(img)),
    cancelled,
  };
}

// Retries the attachments of an already-created ticket: uploads only the
// images whose filename isn't already attached to the issue, so a retry
// never duplicates the uploads that already succeeded. The description is
// left untouched — it was finalized when the ticket was first created.
export async function uploadMissingAttachments(jiraOrigin, issueKey, images, onProgress) {
  const existing = new Set(await listIssueAttachments(jiraOrigin, issueKey));
  const missing = images.filter(
    (img) => !existing.has(imageUploadFilename(img)),
  );

  if (!missing.length) {
    return { failed: 0, firstError: "", skipped: images.length };
  }

  const { failed, firstError, failedImages, cancelled } = await uploadImages(
    jiraOrigin,
    issueKey,
    missing,
    onProgress,
  );
  return {
    failed,
    firstError,
    skipped: images.length - missing.length,
    failedNames: failedImages.map((img) => imageUploadFilename(img)),
    cancelled,
  };
}
