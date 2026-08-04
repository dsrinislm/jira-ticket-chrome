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

export function imageUploadFilename(img) {
  return (
    img.name || `${img.placeholder}.${extensionForBlobType(dataUrlToBlob(img.dataUrl).type)}`
  );
}

export function failedAttachmentNames(failedNames = []) {
  return failedNames.length ? ` (${failedNames.join(", ")})` : "";
}

function dataUrlSize(dataUrl) {
  if (!dataUrl) return 0;
  const idx = dataUrl.indexOf(",");
  const b64 = idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl;
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
}

let cancelRequested = false;
const activeXhrs = new Set();

export function requestUploadCancel() {
  cancelRequested = true;
  activeXhrs.forEach((xhr) => xhr.abort());
}

export async function uploadImages(jiraOrigin, issueKey, images, onProgress, onFile) {
  const byPlaceholder = {};
  const MAX_CONCURRENT = 4;
  let next = 0;
  let failed = 0;
  let firstError = "";
  const failedImages = [];
  let uploadedFiles = 0;

  cancelRequested = false;

  const imageSizes = images.map((img) => dataUrlSize(img.dataUrl));
  const totalBytes = imageSizes.reduce((sum, size) => sum + size, 0);
  let uploadedBytes = 0;

  const report = (loaded) => {
    if (typeof onProgress === "function") {
      onProgress(loaded ?? uploadedBytes, totalBytes);
    }
  };

  const reportFiles = () => {
    if (typeof onFile === "function") {
      onFile(uploadedFiles, images.length);
    }
  };

  const uploadOne = async () => {
    while (next < images.length && !cancelRequested) {
      const index = next++;
      const img = images[index];
      const filename = imageUploadFilename(img);

      const fileBase = uploadedBytes;
      try {
        const attachment = await uploadJiraAttachment(
          jiraOrigin,
          issueKey,
          dataUrlToBlob(img.dataUrl),
          filename,
          (loaded) => report(fileBase + loaded),

          (xhr) => {
            activeXhrs.add(xhr);
            xhr.addEventListener("loadend", () => activeXhrs.delete(xhr));
          },
        );
        byPlaceholder[img.placeholder] = fileMediaNode(attachment);
        uploadedFiles++;
        reportFiles();
      } catch (err) {
        if (cancelRequested) break;
        failed++;
        if (!firstError) firstError = err.message || String(err);
        failedImages.push(img);
        }
      uploadedBytes += imageSizes[index];
      report();
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(MAX_CONCURRENT, images.length) }, uploadOne),
  );

  report();
  reportFiles();
  return { byPlaceholder, failed, firstError, failedImages, cancelled: cancelRequested };
}

export async function attachImagesToIssue(jiraOrigin, issueKey, images, description, onProgress, onFile) {
  setStatus("Uploading images...", "loading");

  const { byPlaceholder, failed, firstError, failedImages, cancelled } =
    await uploadImages(jiraOrigin, issueKey, images, onProgress, onFile);

  setStatus("Attaching images to ticket...", "loading");

  let descriptionError = "";
  try {
    await updateJiraIssueDescription(
      jiraOrigin,
      issueKey,
      insertUploadedImages(description.content, byPlaceholder),
    );
  } catch (err) {
    descriptionError = err.message || String(err);
    }

  const failedPlaces = new Set(failedImages.map((img) => img.placeholder));
  return {
    failed,
    firstError,
    failedNames: failedImages.map((img) => imageUploadFilename(img)),
    uploadedNames: images
      .filter((img) => img.name && !failedPlaces.has(img.placeholder))
      .map((img) => imageUploadFilename(img)),
    cancelled,
    descriptionError,
  };
}

export async function uploadMissingAttachments(jiraOrigin, issueKey, images, onProgress, onFile) {
  const existing = new Set(await listIssueAttachments(jiraOrigin, issueKey));
  const files = images.filter((img) => img.name);
  const missing = files.filter(
    (img) => !existing.has(imageUploadFilename(img)),
  );

  if (!missing.length) {
    return { failed: 0, firstError: "", uploaded: 0, uploadedNames: [], skipped: files.length };
  }

  const { failed, firstError, failedImages, cancelled } = await uploadImages(
    jiraOrigin,
    issueKey,
    missing,
    onProgress,
    onFile,
  );
  const failedPlaces = new Set(failedImages.map((img) => img.placeholder));
  return {
    failed,
    firstError,
    uploaded: missing.length - failed,
    uploadedNames: missing
      .filter((img) => !failedPlaces.has(img.placeholder))
      .map((img) => imageUploadFilename(img)),
    skipped: files.length - missing.length,
    failedNames: failedImages.map((img) => imageUploadFilename(img)),
    cancelled,
  };
}
