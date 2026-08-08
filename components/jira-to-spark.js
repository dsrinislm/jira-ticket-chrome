import {
  listJiraCommentsDetailed,
  getJiraIssue,
  getJiraIssueWithAttachments,
  fetchJiraAttachmentDataUrl,
} from "./api.js";
import { extractSourceUrl } from "./adf.js";
import {
  getCurrentTab,
  postJiraCommentsInSparkPage,
  postJiraCommentsInOriginPage,
  fetchSparkCommentsInPage,
  fetchSparkAttachmentsInPage,
  listSparkAttachmentItemsInPage,
  uploadSparkAttachmentsInPage,
} from "./scrape.js";
import { syncSparkComments } from "./comments.js";
import {
  uploadMissingAttachments,
  dataUrlSize,
} from "./attachments.js";
import {
  startSyncAttachmentProgress,
  addSyncAttachmentProgressRow,
  setSyncAttachmentProgress,
  setSyncAttachmentState,
  syncAbortBtn,
} from "./ui.js";
import {
  getMappedJiraCommentIds,
  addCommentMappings,
} from "./comment-map.js";
import { sleep, formatBytes } from "./util.js";

function jiraPageInfoFromUrl(url) {
  const raw = String(url || "");
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return null;
  }

  const browse = /\/browse\/([A-Za-z0-9]+-\d+)(?:[/?#]|$)/.exec(
    parsed.pathname,
  );
  if (browse) {
    const key = browse[1].toUpperCase();
    return {
      origin: parsed.origin,
      type: "ticket",
      key,
      projectKey: key.replace(/-\d+$/, ""),
    };
  }

  const board = /\/projects\/([A-Za-z0-9]+)\/boards?\/(?:\d+|backlog)?(?:[/?#]|$)/.exec(
    parsed.pathname,
  );
  if (board) {
    return {
      origin: parsed.origin,
      type: "board",
      key: null,
      projectKey: board[1].toUpperCase(),
    };
  }

  const project = /\/projects\/([A-Za-z0-9]+)(?:[/?#]|$)/.exec(
    parsed.pathname,
  );
  if (project) {
    return {
      origin: parsed.origin,
      type: "project",
      key: null,
      projectKey: project[1].toUpperCase(),
    };
  }

  if (/\/secure\/RapidBoard\.jspa\b/i.test(parsed.pathname)) {
    const pk = /[?&]projectKey=([A-Za-z0-9]+)/i.exec(parsed.search);
    if (pk) {
      return {
        origin: parsed.origin,
        type: "board",
        key: null,
        projectKey: pk[1].toUpperCase(),
      };
    }
  }

  const hostname = parsed.hostname || "";
  const jiraHost =
    hostname.endsWith("atlassian.net") ||
    /(^|\.)jira[.\-]/.test(hostname) ||
    hostname === "jira";
  const jiraPath = /\/(?:jira|browse|projects|servicedesk|plugins|secure)\//i.test(
    parsed.pathname,
  );
  if (jiraHost && jiraPath) {
    return { origin: parsed.origin, type: "jira", key: null, projectKey: null };
  }

  if (jiraHost && /\/issues\/?(?:[/?#]|$)/i.test(parsed.pathname)) {
    return { origin: parsed.origin, type: "filter", key: null, projectKey: null };
  }

  return null;
}

function formatDate(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value || "");
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function waitForTabComplete(tabId, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const timeout = setTimeout(finish, timeoutMs);
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") finish();
    };
    function finish() {
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function useSparkTab({ sparkOrigin, sysId, requireTicket = true }, fn) {
  const sourceUrl = `${sparkOrigin}/incident.do?sys_id=${encodeURIComponent(sysId)}`;
  let tab = null;
  if (!requireTicket) {
    const tabs = await chrome.tabs.query({ url: `${sparkOrigin}/*` });
    tab = tabs[0] || null;
  } else {
    tab = (await chrome.tabs.query({ url: `${sparkOrigin}/*` })).find((t) =>
      (t.url || "").includes(sysId),
    );
  }
  let created = false;
  if (!tab) {
    tab = await chrome.tabs.create({ url: sourceUrl, active: false });
    created = true;
    await waitForTabComplete(tab.id);
  }
  try {
    return await fn(tab);
  } finally {
    if (created) chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function runInSparkTab({ sparkOrigin, sysId, comments, mappedIds, tab }) {
  const run = async (activeTab) => {
    const results = await chrome.scripting.executeScript({
      target: { tabId: activeTab.id, allFrames: true },
      func: postJiraCommentsInSparkPage,
      args: [{ sysId, comments, mappedIds: [...mappedIds] }],
      world: "MAIN",
    });
    return (results || [])
      .map((r) => r.result)
      .filter((r) => r && typeof r === "object");
  };

  const execute = async (activeTab, created) => {
    let reports = [];
    let attempts = 0;
    let injectError = "";
    while (attempts < 5 && reports.length === 0) {
      if (attempts > 0) await sleep(1500);
      try {
        reports = await run(activeTab);
      } catch (err) {
        injectError = String((err && err.message) || err || "injection failed");
      }
      attempts++;
    }

    const active = reports.filter((r) => !r.skippedByLock);
    const good =
      active.find((r) => r.hasFields) ||
      active
        .filter((r) => r.wnFields >= 0)
        .sort((a, b) => (b.wnFields || 0) - (a.wnFields || 0))[0] ||
      active[0] ||
      reports[0];

    const report = good || {
      posted: 0,
      failed: comments.length,
      skipped: 0,
      total: comments.length,
      hasFields: false,
      url: "",
      detail: "no frame reported a result",
    };

    if (!reports.some((r) => r.hasFields)) {
      const rawDebug = reports
        .map((r) => r.debug || r.detail)
        .filter(Boolean)
        .join(" | ");
      if (reports.length === 0) {
        let tabUrl = "";
        try {
          tabUrl = (await chrome.tabs.get(activeTab.id))?.url || "";
        } catch {}
        report.detail = "Spark tab never finished loading the incident form — open the incident in Spark and retry.";
        report.debug = `no frame reported a result (tab=${tabUrl || "not found"}${injectError ? `, inject_error=${injectError}` : ""})`;
      } else if (reports.some((r) => r.loginWall)) {
        report.detail = `Spark session expired — log in to ${sparkOrigin} in this browser and retry.`;
        report.debug = rawDebug;
      } else {
        report.detail = `Spark comments form not found — open the incident in ${sparkOrigin} and retry.`;
        report.debug = rawDebug;
      }
    } else {
      report.debug = reports.map((r) => r.debug || r.detail).filter(Boolean).join(" | ");
    }

    return { ...report, mode: created ? "spark tab (opened)" : "spark tab" };
  };

  const runApiOnly = async (activeTab) => {
    const results = await chrome.scripting.executeScript({
      target: { tabId: activeTab.id, allFrames: true },
      func: postJiraCommentsInOriginPage,
      args: [{ sysId, comments, mappedIds: [...mappedIds] }],
      world: "MAIN",
    });
    return (results || [])
      .map((r) => r.result)
      .filter((r) => r && typeof r === "object");
  };

  if (tab) {
    let isTicket = false;
    try {
      isTicket = ((await chrome.tabs.get(tab.id))?.url || "").includes(sysId);
    } catch {}
    if (!isTicket) {
      if (!comments || comments.length === 0) {
        return {
          posted: 0,
          failed: 0,
          skipped: 0,
          total: 0,
          hasFields: false,
          url: "",
          loginWall: false,
          detail: "",
          debug: "",
          mapping: [],
          mode: "spark tab",
        };
      }
      try {
        const apiReports = await runApiOnly(tab);
        const apiActive = apiReports.filter((r) => !r.skippedByLock);
        const apiReport =
          apiActive.find((r) => r.hasFields) ||
          apiActive.sort((a, b) => (b.posted || 0) - (a.posted || 0))[0] ||
          apiReports[0];
        if (apiReport) {
          if (apiReport.loginWall) {
            return { ...apiReport, mode: "spark tab", debug: apiReport.detail };
          }
          if (apiReport.failed === 0) {
            return {
              ...apiReport,
              mode: "spark tab",
              debug: apiReports
                .map((r) => r.detail)
                .filter(Boolean)
                .join(" | "),
            };
          }
        }
      } catch {}
      return useSparkTab({ sparkOrigin, sysId }, (t) => execute(t, true));
    }
    return execute(tab, false);
  }
  return useSparkTab({ sparkOrigin, sysId }, (t) => execute(t, true));
}

export async function detectJiraPageInTab() {
  const tab = await getCurrentTab();
  const info = jiraPageInfoFromUrl(tab?.url);
  if (!info) return null;
  return { ...info, url: tab?.url || "" };
}

export async function detectJiraIssueInTab() {
  const tab = await getCurrentTab();
  const page = jiraPageInfoFromUrl(tab?.url);
  return {
    key: page?.key || null,
    projectKey: page?.projectKey || null,
    url: tab?.url || "",
    origin: page?.origin || "",
  };
}

export async function syncJiraCommentsToSpark({
  jiraOrigin,
  issueKey,
  tab,
  issue,
  comments,
  sourceUrl,
}) {
  const theIssue =
    !sourceUrl && !issue ? await getJiraIssue(jiraOrigin, issueKey) : issue;
  const srcUrl = sourceUrl || extractSourceUrl(theIssue?.fields?.description);
  if (!srcUrl) {
    throw new Error(
      `No source ticket URL found in the description of ${issueKey}.`,
    );
  }

  let sparkOrigin;
  let sysId;
  try {
    sparkOrigin = new URL(srcUrl).origin;
    const match = /[?&]sys_id=([^&]+)/.exec(srcUrl);
    sysId = match ? decodeURIComponent(match[1]) : null;
  } catch {
    throw new Error("Couldn't parse the source ticket URL.");
  }
  if (!sysId) {
    throw new Error("Couldn't find the Spark ticket id in the source URL.");
  }

  const all =
    comments || (await listJiraCommentsDetailed(jiraOrigin, issueKey));
  const filtered = all
    .filter((c) => !/^\[Spark /i.test(c.body.trim()))
    .map((c) => ({ ...c, created: formatDate(c.created) }));
  const mappedIds = await getMappedJiraCommentIds(sysId);

  const report = await runInSparkTab({
    sparkOrigin,
    sysId,
    comments: filtered,
    mappedIds,
    tab,
  });

  if (Array.isArray(report.mapping) && report.mapping.length) {
    await addCommentMappings(sysId, report.mapping);
  }

  return { report, sourceUrl, issueKey };
}

async function fetchSparkEntriesInOrigin({ sparkOrigin, sysId, tab }) {
  const run = async (activeTab) => {
    const results = await chrome.scripting.executeScript({
      target: { tabId: activeTab.id, allFrames: true },
      func: fetchSparkCommentsInPage,
      args: [[sysId]],
      world: "MAIN",
    });
    const outs = (results || [])
      .map((r) => r.result)
      .filter((g) => Array.isArray(g) && g.length > 0);
    return outs.sort(
      (a, b) =>
        (b[0]?.comments?.length || 0) - (a[0]?.comments?.length || 0),
    )[0]?.[0]?.comments || [];
  };
  if (tab) return run(tab);
  return useSparkTab({ sparkOrigin, sysId, requireTicket: false }, run);
}

async function fetchSparkAttachmentsInOrigin({ sparkOrigin, sysId, tab }) {
  const run = async (activeTab) => {
    const results = await chrome.scripting.executeScript({
      target: { tabId: activeTab.id, allFrames: true },
      func: fetchSparkAttachmentsInPage,
      args: [sysId],
      world: "MAIN",
    });
    const outs = (results || [])
      .map((r) => r.result)
      .filter((g) => Array.isArray(g) && g.length > 0);
    return (
      outs.sort(
        (a, b) =>
          (b[0]?.attachments?.length || 0) - (a[0]?.attachments?.length || 0),
      )[0]?.[0]?.attachments || []
    );
  };
  if (tab) return run(tab);
  return useSparkTab({ sparkOrigin, sysId, requireTicket: false }, run);
}

async function fetchSparkAttachmentItemsInOrigin({ sparkOrigin, sysId, tab }) {
  const run = async (activeTab) => {
    let tabUrl = "";
    try {
      tabUrl = (await chrome.tabs.get(activeTab.id))?.url || "";
    } catch {}
    if (tabUrl && !tabUrl.startsWith(sparkOrigin)) {
      return { items: [], loginRequired: true };
    }
    const results = await chrome.scripting.executeScript({
      target: { tabId: activeTab.id, allFrames: true },
      func: listSparkAttachmentItemsInPage,
      args: [sysId],
      world: "MAIN",
    });    const groups = (results || []).map((r) => r.result);
    const outs = groups
      .filter((g) => Array.isArray(g) && g.length > 0);
    let loginRequired = false;
    for (const g of groups) {
      if (Array.isArray(g) && g.some((r) => r && r.loginRequired)) {
        loginRequired = true;
        break;
      }
    }
    if (!outs.length && loginRequired) return { items: [], loginRequired };
    const items =
      outs.sort(
        (a, b) => (b[0]?.items?.length || 0) - (a[0]?.items?.length || 0),
      )[0]?.[0]?.items || [];
    return { items, loginRequired };
  };
  if (tab) return run(tab);
  return useSparkTab({ sparkOrigin, sysId, requireTicket: false }, run);
}

export async function syncSparkAttachmentsInOrigin({ jiraOrigin, sparkOrigin, sysId, files, tab, onProgress, onFileProgress, onFileState, knownSparkNames }) {
  const run = async (activeTab) => {
    const executeUpload = async (file, dataUrl) => {
      const results = await chrome.scripting.executeScript({
        target: { tabId: activeTab.id, allFrames: true },
        func: uploadSparkAttachmentsInPage,
        args: [{ sysId, files: [{ name: file.name, dataUrl }] }],
        world: "MAIN",
      });
      const report = (results || [])
        .map((r) => r.result)
        .filter((r) => r && r.skipped !== true)
        .sort(
          (a, b) => (b?.uploaded?.length || 0) - (a?.uploaded?.length || 0),
        )[0];
      if (report?.uploaded?.length) return { ok: true };
      return {
        ok: false,
        error:
          report?.errors?.[file.name] || "Spark rejected the upload.",
      };
    };
    const existing = new Map();
    for (const name of knownSparkNames || []) {
      existing.set(String(name), null);
    }
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: activeTab.id, allFrames: true },
        func: listSparkAttachmentItemsInPage,
        args: [sysId],
        world: "MAIN",
      });
      const items =
        (results || [])
          .map((r) => r.result)
          .filter((g) => Array.isArray(g) && g.length > 0)
          .sort(
            (a, b) =>
              (b[0]?.items?.length || 0) - (a[0]?.items?.length || 0),
          )[0]?.[0]?.items || [];
      for (const item of items) existing.set(item.name, item.sizeBytes ?? null);
      if (!items.length && !(knownSparkNames && knownSparkNames.length)) {
        console.warn(
          "[joshub] Spark attachment listing returned empty — dedupe unavailable, all Jira attachments will be (re)uploaded.",
        );
      }
    } catch {}
    const outcomes = new Array(files.length);
    let nextIndex = 0;
    let completed = 0;
    let uploadChain = Promise.resolve();
    const totalBytes = files.reduce(
      (sum, f) => sum + (Number(f.size) || 0),
      0,
    );
    let bytesDownloaded = 0;
    let bytesUploaded = 0;
    const fileDownloaded = new Array(files.length).fill(0);
    const reportProgress = () => {
      if (typeof onProgress !== "function") return;
      if (totalBytes > 0) {
        onProgress(
          Math.min(bytesDownloaded + bytesUploaded, totalBytes * 2),
          totalBytes * 2,
          bytesUploaded > 0
            ? `Syncing ${formatBytes(bytesUploaded)} of ${formatBytes(totalBytes)} to Spark…`
            : `Downloading ${formatBytes(bytesDownloaded)} of ${formatBytes(totalBytes)} from Jira…`,
        );
      } else {
        onProgress(completed, files.length, `Syncing attachment ${completed} of ${files.length} to Spark…`);
      }
    };
    const worker = async () => {
      while (nextIndex < files.length) {
        const index = nextIndex++;
        const file = files[index];
        if (existing.has(file.name)) {
          const size = Number(file.size) || 0;
          bytesDownloaded += size;
          bytesUploaded += size;
          outcomes[index] = { file, result: { ok: true, skipped: true } };
          if (typeof onFileState === "function") {
            onFileState(index, "skipped", "Already synced on Spark");
          }
        } else {
          if (typeof onFileState === "function") {
            onFileState(index, "downloading", "Downloading from Jira…");
          }
          const dataUrlPromise = fetchJiraAttachmentDataUrl(
            jiraOrigin,
            file.id,
            (loaded) => {
              const delta = loaded - fileDownloaded[index];
              fileDownloaded[index] = loaded;
              bytesDownloaded += delta;
              reportProgress();
              if (typeof onFileProgress === "function") {
                onFileProgress(
                  index,
                  loaded,
                  Number(file.size) || loaded,
                );
              }
            },
          );
          const result = await (uploadChain = uploadChain.then(async () => {
            let dataUrl;
            try {
              dataUrl = await dataUrlPromise;
            } catch (err) {
              return {
                ok: false,
                error: String((err && err.message) || err || "unknown"),
              };
            }
            if (typeof onFileState === "function") {
              onFileState(index, "uploading", "Uploading to Spark…");
            }
            try {
              const res = await executeUpload(file, dataUrl);
              if (res.ok) bytesUploaded += Number(file.size) || 0;
              reportProgress();
              return res;
            } catch (err) {
              return {
                ok: false,
                error: String((err && err.message) || err || "unknown"),
              };
            }
          }));
          if (result.ok) existing.set(file.name, null);
          outcomes[index] = { file, result };
          if (typeof onFileState === "function") {
            onFileState(
              index,
              result.ok ? "done" : "failed",
              result.ok
                ? "Synced to Spark"
                : (result.error || "Spark rejected the upload.").slice(0, 120),
            );
          }
        }
        completed++;
        reportProgress();
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(3, files.length) }, worker),
    );
    const uploaded = [];
    const failedNames = [];
    let firstError = "";
    for (const { file, result } of outcomes) {
      if (result.ok) {
        if (!result.skipped) uploaded.push(file.name);
      } else {
        failedNames.push(file.name);
        if (!firstError) firstError = result.error || "unknown";
      }
    }
    return {
      uploaded: uploaded.length,
      uploadedNames: uploaded,
      failed: failedNames.length,
      failedNames,
      firstError,
      skipped: files.length - uploaded.length - failedNames.length,
    };
  };
  if (tab) return run(tab);
  return useSparkTab({ sparkOrigin, sysId, requireTicket: false }, run);
}

function parseSourceUrl(sourceUrl) {
  let sparkOrigin;
  let sysId;
  try {
    sparkOrigin = new URL(sourceUrl).origin;
    const match = /[?&]sys_id=([^&]+)/.exec(sourceUrl);
    sysId = match ? decodeURIComponent(match[1]) : null;
  } catch {
    throw new Error("Couldn't parse the source ticket URL.");
  }
  if (!sysId) {
    throw new Error("Couldn't find the Spark ticket id in the source URL.");
  }
  return { sparkOrigin, sysId };
}

export async function getSyncAttachmentItems({ jiraOrigin, issueKey, cachedJiraData }) {
  let issue;
  let attachments;
  const cachedMatches =
    cachedJiraData?.issue &&
    cachedJiraData.attachments &&
    cachedJiraData.issue?.key === issueKey &&
    String(cachedJiraData.issue?.self || "").startsWith(jiraOrigin);
  if (cachedMatches) {
    issue = cachedJiraData.issue;
    attachments = cachedJiraData.attachments;
  } else {
    ({ issue, attachments } = await getJiraIssueWithAttachments(
      jiraOrigin,
      issueKey,
    ));
  }
  const sourceUrl = extractSourceUrl(issue?.fields?.description);
  if (!sourceUrl) {
    return { items: [], syncedNames: new Set() };
  }
  const { sparkOrigin, sysId } = parseSourceUrl(sourceUrl);
  const { items: sparkItems, loginRequired } =
    await fetchSparkAttachmentItemsInOrigin({
      sparkOrigin,
      sysId,
    }).catch(() => ({ items: [], loginRequired: false }));
  const jiraItems = attachments;
  const typeOf = (name) => {
    const ext = (name.split(".").pop() || "").toLowerCase();
    if (
      ["mp4", "m4v", "mov", "avi", "mkv", "webm", "wmv", "flv", "mpeg", "mpg"].includes(ext)
    ) {
      return "video";
    }
    if (
      ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "tif", "tiff", "ico"].includes(ext)
    ) {
      return "image";
    }
    return "other";
  };
  const byName = new Map();
  for (const item of sparkItems) {
    byName.set(item.name, { ...item, source: "Spark" });
  }
  for (const item of jiraItems) {
    const size = Number(item.size);
    const normalized = {
      ...item,
      type: typeOf(item.name),
      sizeBytes: Number.isFinite(size) && size >= 0 ? size : null,
      url: `${jiraOrigin}/rest/api/3/attachment/content/${encodeURIComponent(item.id)}`,
    };
    if (byName.has(item.name)) {
      const spark = byName.get(item.name);
      const merged = { ...spark, inJira: true };
      if (merged.sizeBytes == null || merged.sizeBytes <= 0) {
        if (normalized.sizeBytes != null && normalized.sizeBytes > 0) {
          merged.sizeBytes = normalized.sizeBytes;
          merged.size = formatBytes(normalized.sizeBytes);
        }
      }
      byName.set(item.name, merged);
    } else {
      byName.set(item.name, { ...normalized, source: "Jira" });
    }
  }
  const items = Array.from(byName.values()).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const syncedNames = new Set(
    items.filter((i) => i.inJira).map((i) => i.name),
  );
  return { items, syncedNames, loginRequired, sparkOrigin, issue, attachments };
}

export async function syncJiraUpdates({
  jiraOrigin,
  issueKey,
  includeAttachments = true,
  selectedAttachments,
  cachedJiraData,
}) {
  let issue;
  let jiraItems = [];
  let knownSparkNames = [];

  const cachedMatches =
    cachedJiraData?.issue &&
    cachedJiraData.attachments &&
    cachedJiraData.issue?.key === issueKey &&
    String(cachedJiraData.issue?.self || "").startsWith(jiraOrigin);
  if (includeAttachments && cachedMatches) {
    issue = cachedJiraData.issue;
    jiraItems = cachedJiraData.attachments;
    knownSparkNames = cachedJiraData.syncedNames || [];
  } else if (includeAttachments) {
    const combined = await getJiraIssueWithAttachments(
      jiraOrigin,
      issueKey,
    );
    issue = combined.issue;
    jiraItems = combined.attachments;
  } else {
    issue = await getJiraIssue(jiraOrigin, issueKey);
  }

  const sourceUrl = extractSourceUrl(issue?.fields?.description);
  if (!sourceUrl) {
    throw new Error(
      `No source ticket URL found in the description of ${issueKey}.`,
    );
  }
  const { sparkOrigin, sysId } = parseSourceUrl(sourceUrl);
  const selected = new Set(
    Array.isArray(selectedAttachments) ? selectedAttachments : [],
  );

  return useSparkTab({ sparkOrigin, sysId, requireTicket: false }, async (tab) => {
    const jiraComments = await listJiraCommentsDetailed(jiraOrigin, issueKey);
    const sparkEntries = await fetchSparkEntriesInOrigin({ sparkOrigin, sysId, tab });
    const sparkToJira = await syncSparkComments(
      jiraOrigin,
      issueKey,
      sparkEntries,
      sysId,
      jiraComments.map((c) => c.body),
    );

    let attachments = { uploaded: 0, failed: 0, skipped: 0 };
    let attachmentsToSpark = {
      uploaded: 0,
      failed: 0,
      skipped: 0,
      failedNames: [],
      firstError: "",
    };
    if (includeAttachments) {
      try {
        const jiraNames = new Map(
          jiraItems.map((item) => [item.name, Number(item.size) || null]),
        );
        const images = await fetchSparkAttachmentsInOrigin({ sparkOrigin, sysId, tab });
        const imagesToSync = selected.size
          ? images.filter((img) => selected.has(img.name))
          : images;
        let progressReady = false;
        const ensureProgress = () => {
          if (progressReady) return;
          progressReady = true;
          startSyncAttachmentProgress();
          syncAbortBtn.disabled = false;
        };
        if (imagesToSync.length) {
          ensureProgress();
          imagesToSync.forEach((img) => {
            addSyncAttachmentProgressRow({
              label: img.name,
              size: img.sizeBytes ?? dataUrlSize(img.dataUrl),
              hint: "Uploading to Jira…",
            });
          });
          attachments = await uploadMissingAttachments(
            jiraOrigin,
            issueKey,
            imagesToSync,
            undefined,
            undefined,
            jiraNames,
            (index, loaded, total) =>
              setSyncAttachmentProgress(index, loaded, total),
          );
          const skippedSet = new Set(attachments.skippedNames || []);
          const failedSet = new Set(attachments.failedNames || []);
          imagesToSync.forEach((img, i) => {
            const name = String(img.name || "");
            if (skippedSet.has(name)) {
              setSyncAttachmentState(i, "skipped", "Already on Jira");
            } else if (failedSet.has(name)) {
              setSyncAttachmentState(i, "failed", "Upload to Jira failed");
            } else {
              setSyncAttachmentState(i, "done", "Synced to Jira");
            }
          });
        }
        const jiraToSync = selected.size
          ? jiraItems.filter((item) => selected.has(item.name))
          : jiraItems;
        if (jiraToSync.length) {
          ensureProgress();
          const offset = imagesToSync.length;
          jiraToSync.forEach((item) => {
            addSyncAttachmentProgressRow({
              label: item.name,
              size: Number(item.size) || 0,
              hint: "Queued…",
            });
          });
          attachmentsToSpark = await syncSparkAttachmentsInOrigin({
            jiraOrigin,
            sparkOrigin,
            sysId,
            files: jiraToSync,
            tab,
            knownSparkNames,
            onFileProgress: (index, loaded, total) =>
              setSyncAttachmentProgress(offset + index, loaded, total),
            onFileState: (index, state, message) =>
              setSyncAttachmentState(offset + index, state, message),
          });
        }
      } catch {}
    }

    const { report } = await syncJiraCommentsToSpark({
      jiraOrigin,
      issueKey,
      tab,
      issue,
      comments: jiraComments,
    });

    return {
      report,
      sparkToJira,
      attachments,
      attachmentsToSpark,
      sourceUrl,
      sparkOrigin,
      issueKey,
    };
  });
}
