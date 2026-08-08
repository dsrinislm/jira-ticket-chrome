import {
  listJiraCommentsDetailed,
  fetchJiraAttachmentDataUrl,
} from "./api.js";
import {
  getCurrentTab,
  fetchOctaneCommentsInPage,
  postOctaneCommentsInPage,
  uploadOctaneAttachmentInPage,
  listListingAttachmentsInTab,
} from "./scrape.js";
import {
  getMappedOctaneCommentIds,
  addOctaneCommentMappings,
} from "./comment-map.js";

function parseOctaneSourceUrl(sourceUrl) {
  let origin;
  try {
    origin = new URL(sourceUrl).origin;
  } catch {
    throw new Error("Couldn't parse the source ticket URL.");
  }
  const contextMatch = /[?&]p=([^&#/]+\/[^&#]+)/.exec(sourceUrl.split("#")[0]);
  if (!contextMatch) {
    throw new Error(
      "Couldn't find the Octane shared space/workspace in the source URL.",
    );
  }
  const [sharedSpace, workspace] = contextMatch[1].split("/");
  const idMatch =
    /entityType=work_item&id=(\d+)/.exec(sourceUrl) ||
    /[?&]id=(\d+)/.exec(sourceUrl.split("#")[0]);
  if (!idMatch) {
    throw new Error("Couldn't find the Octane work item id in the source URL.");
  }
  return {
    octaneOrigin: origin,
    sharedSpace,
    workspace,
    workItemId: idMatch[1],
    apiBase: `${origin}/api/shared_spaces/${sharedSpace}/workspaces/${workspace}`,
  };
}

function formatDate(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value || "");
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function executeInOctaneTab(fn, args) {
  const currentTab = await getCurrentTab();
  if (!currentTab?.id) throw new Error("No active tab found.");
  const results = await chrome.scripting.executeScript({
    target: { tabId: currentTab.id, allFrames: true },
    func: fn,
    args: [args],
    world: "ISOLATED",
  });
  return (results || [])
    .map((r) => r.result)
    .filter((r) => r !== undefined && r !== null);
}

export async function syncJiraCommentsToOctane({
  jiraOrigin,
  issueKey,
  comments,
  sourceUrl,
}) {
  const ctx = parseOctaneSourceUrl(sourceUrl);
  const all =
    comments || (await listJiraCommentsDetailed(jiraOrigin, issueKey));
  const filtered = all
    .filter((c) => !/^\[Octane /i.test(c.body.trim()))
    .map((c) => ({ ...c, created: formatDate(c.created) }));
  if (!filtered.length) {
    return {
      report: {
        posted: 0,
        failed: 0,
        skipped: 0,
        total: 0,
        mapping: [],
      },
      sourceUrl,
      issueKey,
    };
  }
  const mappedIds = await getMappedOctaneCommentIds(ctx.workItemId);
  let knownTexts = [];
  try {
    const outs = await executeInOctaneTab(fetchOctaneCommentsInPage, [
      ctx.workItemId,
    ]);
    const groups = outs
      .filter((g) => Array.isArray(g) && g.length > 0)
      .sort(
        (a, b) =>
          (b[0]?.comments?.length || 0) - (a[0]?.comments?.length || 0),
      );
    knownTexts = groups[0]?.[0]?.comments?.map((c) => c.text) || [];
  } catch {}

  const reports = await executeInOctaneTab(postOctaneCommentsInPage, {
    workItemId: ctx.workItemId,
    comments: filtered,
    knownTexts,
    mappedIds: [...mappedIds],
  });
  const report =
    reports.find((r) => r && r.hasFields && r.posted > 0) ||
    reports.find((r) => r && r.hasFields) ||
    reports.sort((a, b) => (b?.posted || 0) - (a?.posted || 0))[0] || {
      posted: 0,
      failed: filtered.length,
      skipped: 0,
      total: filtered.length,
      mapping: [],
    };

  if (Array.isArray(report.mapping) && report.mapping.length) {
    await addOctaneCommentMappings(ctx.workItemId, report.mapping);
  }
  return { report, sourceUrl, issueKey };
}

export async function syncOctaneAttachmentsInOrigin({
  jiraOrigin,
  sourceUrl,
  files,
  onProgress,
  onFileProgress,
  onFileState,
}) {
  const ctx = parseOctaneSourceUrl(sourceUrl);
  let existing = new Set();
  try {
    const groups = await listListingAttachmentsInTab(
      [ctx.workItemId],
      "Octane",
    );
    existing = new Set((groups[0]?.attachments || []).map((a) => a.name));
  } catch {}

  const outcomes = new Array(files.length);
  let next = 0;
  let uploadedCount = 0;
  let failedCount = 0;
  let completed = 0;
  const failedNames = [];
  const uploadedNames = [];
  let firstError = "";
  let uploadChain = Promise.resolve();

  const worker = async () => {
    while (next < files.length) {
      const index = next++;
      const file = files[index];
      if (existing.has(file.name)) {
        outcomes[index] = { file, ok: true, skipped: true };
        if (typeof onFileState === "function") {
          onFileState(index, "skipped", "Already on Octane");
        }
      } else {
        if (typeof onFileState === "function") {
          onFileState(index, "downloading", "Downloading from Jira…");
        }
        const result = await (uploadChain = uploadChain.then(async () => {
          let dataUrl;
          try {
            dataUrl = await fetchJiraAttachmentDataUrl(
              jiraOrigin,
              file.id,
              (loaded, total) => {
                if (typeof onFileProgress === "function") {
                  onFileProgress(index, loaded, total);
                }
                if (typeof onProgress === "function") {
                  onProgress(
                    index,
                    files.length,
                    `Downloading ${file.name}…`,
                  );
                }
              },
            );
          } catch (err) {
            return {
              ok: false,
              error: String((err && err.message) || err || "download failed"),
            };
          }
          if (typeof onFileState === "function") {
            onFileState(index, "uploading", "Uploading to Octane…");
          }
          try {
            const outs = await executeInOctaneTab(
              uploadOctaneAttachmentInPage,
              {
                workItemId: ctx.workItemId,
                name: file.name,
                dataUrl,
              },
            );
            return (
              outs.find((r) => r && typeof r === "object" && r.ok) ||
              outs.find((r) => r && typeof r === "object") || {
                ok: false,
                error: "no result",
              }
            );
          } catch (err) {
            return {
              ok: false,
              error: String((err && err.message) || err || "upload failed"),
            };
          }
        }));
        if (result.ok) {
          existing.add(file.name);
          uploadedCount++;
          uploadedNames.push(file.name);
          outcomes[index] = { file, ok: true };
        } else {
          failedCount++;
          failedNames.push(file.name);
          if (!firstError) firstError = result.error || "unknown";
          outcomes[index] = { file, ok: false };
        }
        if (typeof onFileState === "function") {
          onFileState(
            index,
            result.ok ? "done" : "failed",
            result.ok
              ? "Synced to Octane"
              : (result.error || "Upload to Octane failed").slice(0, 120),
          );
        }
      }
      completed++;
      if (typeof onProgress === "function") {
        onProgress(
          completed,
          files.length,
          `Synced ${completed} of ${files.length} attachments to Octane`,
        );
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(3, files.length) }, worker),
  );
  return {
    uploaded: uploadedCount,
    uploadedNames,
    failed: failedCount,
    failedNames,
    firstError,
    skipped: files.length - uploadedCount - failedCount,
  };
}
