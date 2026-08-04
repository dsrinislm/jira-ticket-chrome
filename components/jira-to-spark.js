import {
  listJiraCommentsDetailed,
  getJiraIssue,
} from "./api.js";
import { extractSourceUrl } from "./adf.js";
import {
  getCurrentTab,
  postJiraCommentsInSparkPage,
  fetchSparkCommentsInPage,
} from "./scrape.js";
import { syncSparkComments } from "./comments.js";

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
  const loginRedirect = /login\.do/i.test(html) && !/incident\.do/i.test(html);
  if (!isIncidentForm || loginRedirect) {
    return { ok: false, loginRequired: true, title, isIncidentForm };
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

function jiraCommentLink(origin, issueKey, commentId) {
  return `${origin}/browse/${issueKey}?focusedCommentId=${commentId}#comment-${commentId}`;
}

function markerOf(origin, issueKey, commentId) {
  return `${origin}/browse/${issueKey}?focusedCommentId=${commentId}`;
}

function jiraCommentText(origin, issueKey, comment) {
  return `[Jira comment] ${comment.author || "unknown"} · ${comment.created || ""}\n${jiraCommentLink(origin, issueKey, comment.id)}\n\n${comment.body}`;
}

async function postCommentsDirect(incidentUrl, page, comments, issueKey, jiraOrigin) {
  const headers = {
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
  };
  if (page.userToken) headers["X-UserToken"] = page.userToken;

  const pending = comments.filter(
    (c) => !page.existingTexts.some((t) => t.includes(markerOf(jiraOrigin, issueKey, c.id))),
  );
  const failedIds = new Set();
  const confirmations = new Set();

  for (const c of pending) {
    const text = jiraCommentText(jiraOrigin, issueKey, c);
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
      if (responseHtml.includes(markerOf(jiraOrigin, issueKey, c.id))) {
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
          !verified.existingTexts.some((t) =>
            t.includes(markerOf(jiraOrigin, issueKey, c.id)),
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

async function runInSparkTab({ sparkOrigin, sysId, issueKey, jiraOrigin, comments }) {
  const sourceUrl = `${sparkOrigin}/incident.do?sys_id=${encodeURIComponent(sysId)}`;
  const onOrigin = await chrome.tabs.query({ url: `${sparkOrigin}/*` });
  let tab = onOrigin.find((t) => (t.url || "").includes(sysId));
  let created = false;
  if (!tab) {
    tab = await chrome.tabs.create({ url: sourceUrl, active: false });
    created = true;
    await waitForTabComplete(tab.id);
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: postJiraCommentsInSparkPage,
      args: [{ sysId, jiraOrigin, issueKey, comments }],
      world: "MAIN",
    });

    const reports = (results || [])
      .map((r) => r.result)
      .filter((r) => r && typeof r === "object");
    const good = reports.find((r) => r.hasFields) || reports[0];
    const report = good || {
      posted: 0,
      failed: comments.length,
      skipped: 0,
      total: comments.length,
      hasFields: false,
      detail: "no frame reported a result",
    };
    if (!reports.find((r) => r.hasFields) && report.detail) {
      report.detail = `${report.detail} — no frame contained the incident form`;
    }
    return { ...report, mode: created ? "spark tab (opened)" : "spark tab" };
  } finally {
    if (created) {
      chrome.tabs.remove(tab.id).catch(() => {});
    }
  }
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

export async function syncJiraCommentsToSpark({ jiraOrigin, issueKey }) {
  const issue = await getJiraIssue(jiraOrigin, issueKey);
  const sourceUrl = extractSourceUrl(issue?.fields?.description);
  if (!sourceUrl) {
    throw new Error(
      `No source ticket URL found in the description of ${issueKey}.`,
    );
  }

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

  const all = await listJiraCommentsDetailed(jiraOrigin, issueKey);
  const comments = all
    .filter((c) => !/^\[Spark /i.test(c.body.trim()))
    .map((c) => ({ ...c, created: formatDate(c.created) }));

  const incidentUrl = `${sparkOrigin}/incident.do?sys_id=${encodeURIComponent(sysId)}`;
  const page = await readSparkPage(incidentUrl);

  let report;
  if (page.ok && page.isIncidentForm && page.userToken) {
    report = await postCommentsDirect(
      incidentUrl,
      page,
      comments,
      issueKey,
      jiraOrigin,
    );
  } else {
    report = await runInSparkTab({
      sparkOrigin,
      sysId,
      issueKey,
      jiraOrigin,
      comments,
    });
    if (!report.detail) {
      report.detail =
        "popup can't reach the authenticated ServiceNow form (cross-site session/CSRF blocked) — wrote from a Spark-origin tab";
    }
  }

  return { report, sourceUrl, issueKey };
}

async function fetchSparkEntriesInOrigin({ sparkOrigin, sysId }) {
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
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
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
  } finally {
    if (created) chrome.tabs.remove(tab.id).catch(() => {});
  }
}

export async function syncJiraUpdates({ jiraOrigin, issueKey }) {
  const issue = await getJiraIssue(jiraOrigin, issueKey);
  const sourceUrl = extractSourceUrl(issue?.fields?.description);
  if (!sourceUrl) {
    throw new Error(
      `No source ticket URL found in the description of ${issueKey}.`,
    );
  }

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

  const sparkEntries = await fetchSparkEntriesInOrigin({ sparkOrigin, sysId });
  const sparkToJira = await syncSparkComments(
    jiraOrigin,
    issueKey,
    sparkEntries,
  );

  const { report } = await syncJiraCommentsToSpark({ jiraOrigin, issueKey });

  return { report, sparkToJira, sourceUrl, issueKey };
}
