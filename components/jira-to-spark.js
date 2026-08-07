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
  fetchSparkCommentsInPage,
  fetchSparkAttachmentsInPage,
  listSparkAttachmentItemsInPage,
  uploadSparkAttachmentsInPage,
} from "./scrape.js";
import { syncSparkComments } from "./comments.js";
import { uploadMissingAttachments } from "./attachments.js";
import {
  getMappedJiraCommentIds,
  addCommentMappings,
} from "./comment-map.js";
import { sleep } from "./util.js";

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

function extractUserToken(html) {
  const meta = /<meta[^>]+name=["']X-UserToken["'][^>]+content=["']([^"']+)["']/i.exec(
    html,
  );
  if (meta) return decodeURIComponent(meta[1]);
  const input = /<input[^>]+name=["']X-UserToken["'][^>]+value=["']([^"']*)["']/i.exec(
    html,
  );
  if (input) return decodeURIComponent(input[1]);
  const gck = /window\.g_ck\s*=\s*["']([^"']+)["']/i.exec(html);
  return gck ? decodeURIComponent(gck[1]) : "";
}

function parseJournalTexts(doc) {
  const texts = [];
  doc.querySelectorAll("li[data-journal-id]").forEach((li) => {
    const text = li
      .querySelector(".sn-widget-textblock-body")
      ?.textContent?.trim();
    if (text) texts.push(text);
  });
  return texts;
}

function detectFieldName(doc) {
  const textarea = doc.querySelector('textarea[name="comments"]');
  return textarea?.name || "comments";
}

async function readSparkPage(incidentUrl) {
  const response = await fetch(incidentUrl, {
    credentials: "include",
    headers: { Accept: "text/html" },
  });
  if (!response.ok) return { ok: false, status: response.status };
  const html = await response.text();
  const doc = new DOMParser().parseFromString(html, "text/html");
  const title = (doc.title || "").trim();
  const isIncidentForm = !!doc.querySelector(
    'input[name="incident.number"]',
  );
  const loginRedirect =
    !isIncidentForm &&
    (/login\.do|logon|signin|sign\.in|sso/i.test(html) ||
      /sign\s*in|log\s*in/i.test(title));
  if (!isIncidentForm || loginRedirect) {
    return { ok: false, loginRequired: loginRedirect, title, isIncidentForm };
  }
  return {
    ok: true,
    userToken: extractUserToken(html),
    fieldName: detectFieldName(doc),
    existingTexts: parseJournalTexts(doc),
    title,
    isIncidentForm,
  };
}

function jiraCommentBody(comment) {
  return String(comment.body || "").trim();
}

async function fetchSparkJournalEntries(sparkOrigin, sysId, userToken) {
  const headers = { Accept: "application/json" };
  if (userToken) headers["X-UserToken"] = userToken;
  const url = `${sparkOrigin}/api/now/table/sys_journal_field?sysparm_query=element_id=${encodeURIComponent(sysId)}^ORDERBYsys_created_on&sysparm_fields=element,value,sys_created_by,sys_created_on,sys_id&sysparm_display_value=true&sysparm_limit=1000`;
  const response = await fetch(url, { credentials: "include", headers });
  if (!response.ok) return [];
  const json = await response.json();
  return (Array.isArray(json?.result) ? json.result : [])
    .map((row) => ({
      sysId: String(row?.sys_id || "").trim(),
      value: String(row?.value || "").trim(),
    }))
    .filter((e) => e.sysId && e.value);
}

async function postCommentsDirect(incidentUrl, page, comments, mappedIds) {
  const headers = {
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
  };
  if (page.userToken) headers["X-UserToken"] = page.userToken;

  const pending = comments.filter(
    (c) =>
      !mappedIds.has(c.id) &&
      !page.existingTexts.some((t) => String(t).trim() === jiraCommentBody(c)),
  );
  const failedIds = new Set();
  const confirmations = new Set();

  for (const c of pending) {
    const text = jiraCommentBody(c);
    const body = new URLSearchParams();
    body.append(page.fieldName, text);
    try {
      const response = await fetch(incidentUrl, {
        method: "POST",
        credentials: "include",
        headers,
        body: body.toString(),
      });
      if (!response.ok) {
        failedIds.add(c.id);
        continue;
      }
      const responseHtml = await response.text();
      if (responseHtml.includes(text)) {
        confirmations.add(c.id);
      }
    } catch {
      failedIds.add(c.id);
    }
  }

  const unconfirmed = pending.filter(
    (c) => !failedIds.has(c.id) && !confirmations.has(c.id),
  );
  let entriesAfter = -1;
  let recheckLogin = false;
  let recheckTitle = "";
  if (unconfirmed.length) {
    const verified = await readSparkPage(incidentUrl);
    if (verified.ok) {
      entriesAfter = verified.existingTexts.length;
      recheckTitle = verified.title || "";
      for (const c of unconfirmed) {
        if (
          !verified.existingTexts.some(
            (t) => String(t).trim() === jiraCommentBody(c),
          )
        ) {
          failedIds.add(c.id);
        }
      }
    } else {
      recheckLogin = Boolean(verified.loginRequired);
      recheckTitle = verified.title || "";
      for (const c of unconfirmed) failedIds.add(c.id);
    }
  }

  const mapping = [];
  try {
    const sparkOrigin = new URL(incidentUrl).origin;
    const sysIdMatch = /[?&]sys_id=([^&]+)/.exec(incidentUrl);
    const sysId = sysIdMatch ? decodeURIComponent(sysIdMatch[1]) : null;
    if (sysId) {
      const entries = await fetchSparkJournalEntries(
        sparkOrigin,
        sysId,
        page.userToken,
      );
      for (const c of pending) {
        if (failedIds.has(c.id)) continue;
        const body = jiraCommentBody(c);
        const entry = entries.find((e) => e.value === body);
        if (entry) {
          mapping.push({
            jiraCommentId: c.id,
            sparkEntrySysId: entry.sysId,
          });
        }
      }
    }
  } catch {}

  const detail = [
    `field=${page.fieldName}`,
    `token=${page.userToken ? "yes" : "no"}`,
    `posted=${pending.length}`,
    `confirmed_in_post_response=${confirmations.size}`,
    `entries_after=${entriesAfter}`,
    `recheck_login=${recheckLogin}`,
    `recheck_title=${recheckTitle || page.title || "?"}`,
    `recheck_incident_form=${page.isIncidentForm ? "yes" : "no"}`,
  ].join(", ");

  return {
    posted: pending.length - failedIds.size,
    failed: failedIds.size,
    skipped: comments.length - pending.length,
    total: comments.length,
    mode: "direct",
    detail,
    mapping,
  };
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

async function useSparkTab({ sparkOrigin, sysId }, fn) {
  const sourceUrl = `${sparkOrigin}/incident.do?sys_id=${encodeURIComponent(sysId)}`;
  let tab = (await chrome.tabs.query({ url: `${sparkOrigin}/*` })).find((t) =>
    (t.url || "").includes(sysId),
  );
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
      if (reports.length === 0) {
        let tabUrl = "";
        try {
          tabUrl = (await chrome.tabs.get(activeTab.id))?.url || "";
        } catch {}
        report.detail = `no frame reported a result — the tab never showed the incident form (tab=${tabUrl || "not found"}${injectError ? `, inject_error=${injectError}` : ""})`;
      } else if (reports.some((r) => r.loginWall)) {
        report.detail = `Spark session expired — log in to ${sparkOrigin} in this browser and retry. ${report.detail}`;
      } else {
        report.detail = `${report.detail} — no frame contained the incident form`;
      }
    }

    return { ...report, mode: created ? "spark tab (opened)" : "spark tab" };
  };

  if (tab) return execute(tab, false);
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

  const incidentUrl = `${sparkOrigin}/incident.do?sys_id=${encodeURIComponent(sysId)}`;
  const page = await readSparkPage(incidentUrl);

  if (!page.ok && page.loginRequired) {
    throw new Error(
      `Please log in to ${sparkOrigin} in this browser, then retry the sync.`,
    );
  }

  let report;
  if (page.ok && page.isIncidentForm && page.userToken) {
    report = await postCommentsDirect(
      incidentUrl,
      page,
      filtered,
      mappedIds,
    );
  } else {
    report = await runInSparkTab({
      sparkOrigin,
      sysId,
      comments: filtered,
      mappedIds,
      tab,
    });
    if (!report.detail) {
      report.detail =
        "popup can't reach the authenticated ServiceNow form (cross-site session/CSRF blocked) — wrote from a Spark-origin tab";
    }
  }

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
  return useSparkTab({ sparkOrigin, sysId }, run);
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
  return useSparkTab({ sparkOrigin, sysId }, run);
}

async function fetchSparkAttachmentItemsInOrigin({ sparkOrigin, sysId, tab }) {
  const run = async (activeTab) => {
    const results = await chrome.scripting.executeScript({
      target: { tabId: activeTab.id, allFrames: true },
      func: listSparkAttachmentItemsInPage,
      args: [sysId],
      world: "MAIN",
    });
    const outs = (results || [])
      .map((r) => r.result)
      .filter((g) => Array.isArray(g) && g.length > 0);
    return (
      outs.sort(
        (a, b) => (b[0]?.items?.length || 0) - (a[0]?.items?.length || 0),
      )[0]?.[0]?.items || []
    );
  };
  if (tab) return run(tab);
  return useSparkTab({ sparkOrigin, sysId }, run);
}

export async function syncSparkAttachmentsInOrigin({ jiraOrigin, sparkOrigin, sysId, files, tab }) {
  const run = async (activeTab) => {
    const uploadOne = async (file) => {
      try {
        const dataUrl = await fetchJiraAttachmentDataUrl(jiraOrigin, file.id);
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
      } catch (err) {
        return {
          ok: false,
          error: String((err && err.message) || err || "unknown"),
        };
      }
    };
    const existing = new Map();
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
    } catch {}
    const outcomes = new Array(files.length);
    let nextIndex = 0;
    const worker = async () => {
      while (nextIndex < files.length) {
        const index = nextIndex++;
        const file = files[index];
        const sparkSize = existing.get(file.name);
        const same =
          sparkSize === undefined ||
          sparkSize === null ||
          file.size == null ||
          Number(sparkSize) === Number(file.size);
        if (existing.has(file.name) && same) {
          outcomes[index] = { file, result: { ok: true, skipped: true } };
          continue;
        }
        const result = await uploadOne(file);
        if (result.ok) existing.set(file.name, null);
        outcomes[index] = { file, result };
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
      failed: failedNames.length,
      failedNames,
      firstError,
      skipped: files.length - uploaded.length - failedNames.length,
    };
  };
  if (tab) return run(tab);
  return useSparkTab({ sparkOrigin, sysId }, run);
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

export async function getSyncAttachmentItems({ jiraOrigin, issueKey }) {
  const { issue, attachments } = await getJiraIssueWithAttachments(
    jiraOrigin,
    issueKey,
  );
  const sourceUrl = extractSourceUrl(issue?.fields?.description);
  if (!sourceUrl) {
    return { items: [], syncedNames: new Set() };
  }
  const { sparkOrigin, sysId } = parseSourceUrl(sourceUrl);
  const sparkItems = await fetchSparkAttachmentItemsInOrigin({
    sparkOrigin,
    sysId,
  }).catch(() => []);
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
      const sparkSize = spark.sizeBytes ?? null;
      const sameSize =
        sparkSize == null || normalized.sizeBytes == null
          ? true
          : sparkSize === normalized.sizeBytes;
      byName.set(item.name, { ...spark, inJira: sameSize });
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
  return { items, syncedNames };
}

export async function syncJiraUpdates({
  jiraOrigin,
  issueKey,
  includeAttachments = true,
  selectedAttachments,
}) {
  let issue;
  let jiraItems = [];

  if (includeAttachments) {
    const combined = await getJiraIssueWithAttachments(jiraOrigin, issueKey);
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

  return useSparkTab({ sparkOrigin, sysId }, async (tab) => {
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
        if (imagesToSync.length) {
          attachments = await uploadMissingAttachments(
            jiraOrigin,
            issueKey,
            imagesToSync,
            undefined,
            undefined,
            jiraNames,
          );
        }
        const jiraToSync = selected.size
          ? jiraItems.filter((item) => selected.has(item.name))
          : jiraItems;
        if (jiraToSync.length) {
          attachmentsToSpark = await syncSparkAttachmentsInOrigin({
            jiraOrigin,
            sparkOrigin,
            sysId,
            files: jiraToSync,
            tab,
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
      issueKey,
    };
  });
}
