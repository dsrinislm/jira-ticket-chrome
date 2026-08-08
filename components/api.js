import { redirectToLogin, MAX_ATTACHMENT_UPLOAD_BYTES } from "./ui.js";
import { sleep } from "./util.js";

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

async function fetchWithRetry(
  url,
  options = {},
  { attempts = 2, retryStatus = true } = {},
) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(300 * attempt + Math.random() * 200);

    let response;
    try {
      response = await fetch(url, options);
    } catch (err) {
      lastError = err;
      continue;
    }

    if (retryStatus && RETRYABLE_STATUS.has(response.status)) {
      lastError = new Error(`HTTP ${response.status}`);
      continue;
    }
    return response;
  }

  if (lastError?.name === "TypeError") {
    throw new Error("Network error — check your connection and try again.");
  }
  throw lastError || new Error("Request failed.");
}

async function jiraFetch(jiraBaseUrl, path, options = {}, fetchOpts = {}) {
  return fetchWithRetry(
    `${jiraBaseUrl}${path}`,
    {
      credentials: "include",
      headers: {
        Accept: "application/json",
        ...(options.headers || {}),
      },
      ...options,
    },
    fetchOpts,
  );
}

async function isJiraLoggedIn(jiraBaseUrl) {
  try {
    const response = await jiraFetch(jiraBaseUrl, "/rest/api/3/myself");
    return response.ok;
  } catch {
    return false;
  }
}

async function validateProject(jiraBaseUrl, projectKey) {
  try {
    const response = await jiraFetch(
      jiraBaseUrl,
      `/rest/api/3/project/${projectKey}`,
    );

    if (response.ok) {
      return { success: true };
    }

    if (response.status === 401 || response.status === 403) {
      const sessionValid = await isJiraLoggedIn(jiraBaseUrl);

      if (sessionValid) {
        return {
          success: false,
          loginRequired: false,
          message: "Invalid project key or you don't have access.",
        };
      }

      return {
        success: false,
        loginRequired: true,
        message: "Jira login required or session expired.",
      };
    }

    return {
      success: false,
      loginRequired: false,
      message: "Project not found or you don't have access.",
    };
  } catch (error) {
    return {
      success: false,
      loginRequired: false,
      message: error.message,
    };
  }
}

function escapeJqlString(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function searchByJql(jiraBaseUrl, jql, matches, fields = ["summary"]) {
  let response;
  try {

    response = await jiraFetch(jiraBaseUrl, "/rest/api/3/search/jql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jql, fields, maxResults: 50 }),
    });
  } catch {
    return { error: true, issue: null };
  }

  if (!response.ok) return { error: true, issue: null };

  const data = await response.json();
  const match = (data.issues || []).find((issue) => matches(issue.fields));

  return { error: false, issue: match || null };
}

async function findExistingJiraIssue(jiraBaseUrl, projectKey, summary) {
  const target = String(summary ?? "").trim();
  if (!target) return { error: false, issue: null };

  const projectJql = `project = "${escapeJqlString(projectKey)}"`;

  const prefixed = /^([A-Z]+) \| ([A-Z0-9][A-Z0-9._-]*) \|/i.exec(target);
  if (prefixed) {
    const siteToken = prefixed[1].toUpperCase();
    const id = prefixed[2].toUpperCase();
    return searchByJql(
      jiraBaseUrl,
      `${projectJql} AND summary ~ "${escapeJqlString(id)}"`,
      (fields) => {
        const upper = String(fields?.summary ?? "").toUpperCase();
        return upper.includes(siteToken) && upper.includes(id);
      },
    );
  }

  const lower = target.toLowerCase();
  return searchByJql(
    jiraBaseUrl,
    `${projectJql} AND summary = "${escapeJqlString(target)}"`,
    (fields) => String(fields?.summary ?? "").trim().toLowerCase() === lower,
  );
}

async function findExistingJiraIssueByUrl(jiraBaseUrl, projectKey, sourceUrl) {
  const target = String(sourceUrl ?? "").trim();
  if (!target) return { error: false, issue: null };
  const sysIdMatch = /[?&]sys_id=([^&]+)/i.exec(target);
  const token = sysIdMatch ? decodeURIComponent(sysIdMatch[1]).trim() : "";
  if (!token) return { error: false, issue: null };

  const projectJql = `project = "${escapeJqlString(projectKey)}"`;
  return searchByJql(
    jiraBaseUrl,
    `${projectJql} AND description ~ "${escapeJqlString(token)}"`,
    (fields) =>
      JSON.stringify(fields?.description || {}).includes(token),
    ["description"],
  );
}

async function findExistingJiraIssueFor(
  jiraBaseUrl,
  projectKey,
  summary,
  sourceUrl,
) {
  return findExistingJiraIssueForUncached(
    jiraBaseUrl,
    projectKey,
    summary,
    sourceUrl,
  );
}

async function findExistingJiraIssueForUncached(
  jiraBaseUrl,
  projectKey,
  summary,
  sourceUrl,
) {
  const target = String(summary ?? "").trim();
  const sysIdMatch = sourceUrl
    ? /[?&]sys_id=([^&]+)/i.exec(String(sourceUrl).trim())
    : null;
  const token = sysIdMatch ? decodeURIComponent(sysIdMatch[1]).trim() : "";

  const prefixed = /^([A-Z]+) \| ([A-Z0-9][A-Z0-9._-]*) \|/i.exec(target);
  const siteToken = prefixed ? prefixed[1].toUpperCase() : "";
  const summaryId = prefixed ? prefixed[2].toUpperCase() : "";

  const conditions = [];
  if (token) conditions.push(`description ~ "${escapeJqlString(token)}"`);
  if (summaryId) conditions.push(`summary ~ "${escapeJqlString(summaryId)}"`);
  if (conditions.length) {
    const projectJql = `project = "${escapeJqlString(projectKey)}"`;
    return searchByJql(
      jiraBaseUrl,
      `${projectJql} AND (${conditions.join(" OR ")})`,
      (fields) => {
        if (
          token &&
          JSON.stringify(fields?.description || {}).includes(token)
        ) {
          return true;
        }
        if (
          summaryId &&
          String(fields?.summary ?? "").toUpperCase().includes(siteToken) &&
          String(fields?.summary ?? "").toUpperCase().includes(summaryId)
        ) {
          return true;
        }
        return false;
      },
      ["description", "summary"],
    );
  }
  return findExistingJiraIssue(jiraBaseUrl, projectKey, summary);
}

async function createJiraIssue(jiraBaseUrl, projectKey, summary, description) {
  const payload = {
    fields: {
      project: { key: projectKey },
      summary,
      issuetype: { name: "Bug" },
      description,
    },
  };

  const response = await jiraFetch(
    jiraBaseUrl,
    "/rest/api/3/issue",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Atlassian-Token": "no-check",
      },
      body: JSON.stringify(payload),
    },

    { retryStatus: false },
  );

  if (response.status === 401 || response.status === 403) {
    const sessionValid = await isJiraLoggedIn(jiraBaseUrl);

    if (sessionValid) {
      throw new Error("Invalid project key or you don't have access.");
    }

    redirectToLogin(jiraBaseUrl, projectKey);
    throw new Error("Jira session expired. Please login again.");
  }

  const responseData = await response.json();

  if (!response.ok) {
    const message =
      responseData?.errors?.project ||
      responseData?.errorMessages?.join(", ") ||
      "Issue creation failed.";

    throw new Error(message);
  }

  return responseData;
}

const FILE_TYPE_BY_EXT = {
  bmp: "image/bmp",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  tif: "image/tiff",
  tiff: "image/tiff",
  ico: "image/x-icon",
  mp4: "video/mp4",
  m4v: "video/x-m4v",
  mov: "video/quicktime",
  avi: "video/x-msvideo",
  mkv: "video/x-matroska",
  webm: "video/webm",
  wmv: "video/x-ms-wmv",
  flv: "video/x-flv",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  aac: "audio/aac",
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  zip: "application/zip",
  txt: "text/plain",
};

function xhrUpload(url, blob, filename, onProgress, onXhr) {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    formData.append("file", blob, filename);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.withCredentials = true;
    xhr.setRequestHeader("Accept", "application/json");
    xhr.setRequestHeader("X-Atlassian-Token", "no-check");
    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded, e.total);
    });
    if (onXhr) onXhr(xhr);
    xhr.onload = () => {
      let data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {}
      resolve({
        ok: xhr.status >= 200 && xhr.status < 300,
        status: xhr.status,
        data,
        raw: xhr.responseText,
      });
    };
    xhr.onerror = () => reject(new TypeError("Network error"));
    xhr.onabort = () => reject(new DOMException("Aborted", "AbortError"));
    xhr.send(formData);
  });
}

async function uploadJiraAttachment(jiraBaseUrl, issueKey, blob, filename, onProgress, onXhr) {
  const ext = (String(filename).split(".").pop() || "").toLowerCase();
  const wantedType = FILE_TYPE_BY_EXT[ext];
  if (wantedType && (!blob.type || blob.type === "application/octet-stream")) {
    blob = new Blob([blob], { type: wantedType });
  }

  const url = `${jiraBaseUrl}/rest/api/3/issue/${issueKey}/attachments`;

  let response;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      response = await xhrUpload(url, blob, filename, onProgress, onXhr);
      break;
    } catch (err) {

      if (err.name === "AbortError") throw err;
      if (attempt === 0) {
        await sleep(300 + Math.random() * 200);
        continue;
      }
      throw err.name === "TypeError"
        ? new Error("Network error — check your connection and try again.")
        : err;
    }
  }

  if (!response.ok) {
    if (response.status === 401) {

      const jiraMessage =
        response.data?.errorMessages?.[0] ||
        response.data?.error ||
        response.data?.message;
      if (jiraMessage) {
        throw new Error(
          `Jira rejected the upload (401): ${jiraMessage} — re-login to Jira and try again.`,
        );
      }
      if (blob.size >= MAX_ATTACHMENT_UPLOAD_BYTES) {
        throw new Error(
          "Jira Cloud rejected the upload (401): Atlassian's gateway refuses attachments over ~25-30 MB via the API. Upload this file from the Jira UI, or split/compress it.",
        );
      }
      throw new Error(
        "Jira Cloud rejected the upload (401): the Jira session likely expired. Re-login to Jira and try again.",
      );
    }
    throw new Error(`Image upload failed (status ${response.status}).`);
  }
  if (!Array.isArray(response.data) || !response.data[0]) {
    throw new Error("Image upload returned an unexpected response.");
  }
  return response.data[0];
}

async function updateJiraIssueDescription(jiraBaseUrl, issueKey, contentNodes) {
  const body = JSON.stringify({
    fields: {
      description: { version: 1, type: "doc", content: contentNodes },
    },
  });
  let response;
  for (let attempt = 0; attempt < 3; attempt++) {
    response = await jiraFetch(
      jiraBaseUrl,
      `/rest/api/3/issue/${issueKey}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body,
      },
    );
    if (response.ok) return response;
    if (attempt < 2) await sleep(600 + attempt * 500);
  }
  throw new Error(`Attaching images failed (status ${response.status}).`);
}

async function listIssueAttachments(jiraBaseUrl, issueKey) {
  const response = await jiraFetch(
    jiraBaseUrl,
    `/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=attachment`,
  );
  if (!response.ok) throw new Error(`Couldn't list attachments (status ${response.status}).`);
  const data = await response.json();
  const attachments = data?.fields?.attachment;
  return Array.isArray(attachments) ? attachments.map((a) => a.filename) : [];
}

async function listIssueAttachmentItems(jiraBaseUrl, issueKey) {
  const response = await jiraFetch(
    jiraBaseUrl,
    `/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=attachment`,
  );
  if (!response.ok) throw new Error(`Couldn't list attachments (status ${response.status}).`);
  const data = await response.json();
  const attachments = data?.fields?.attachment;
  return Array.isArray(attachments)
    ? attachments
        .map((a) => ({
          name: String(a.filename || "").trim(),
          id: String(a.id || "").trim(),
          size: Number(a.size),
          mimeType: String(a.mimeType || ""),
        }))
        .filter((a) => a.name && a.id)
    : [];
}

async function fetchJiraAttachmentDataUrl(jiraBaseUrl, attachmentId, onProgress) {
  const response = await jiraFetch(
    jiraBaseUrl,
    `/rest/api/3/attachment/content/${encodeURIComponent(attachmentId)}`,
    { headers: { Accept: "*/*" } },
  );
  if (!response.ok) {
    throw new Error(
      `Couldn't download Jira attachment (status ${response.status}).`,
    );
  }
  let blob;
  if (typeof onProgress === "function" && response.body) {
    const chunks = [];
    let loaded = 0;
    const total = Number(response.headers.get("Content-Length")) || 0;
    for await (const value of response.body) {
      chunks.push(value);
      loaded += value.byteLength;
      onProgress(loaded, total || loaded);
    }
    blob = new Blob(chunks, {
      type: response.headers.get("Content-Type") || "application/octet-stream",
    });
  } else {
    blob = await response.blob();
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Couldn't read Jira attachment."));
    reader.readAsDataURL(blob);
  });
}

function textToAdf(text) {
  if (typeof text !== "string") text = String(text ?? "");
  const lines = text.split("\n");
  const content = lines.map((line) => ({
    type: "paragraph",
    content: line ? [{ type: "text", text: line }] : [],
  }));
  return { version: 1, type: "doc", content };
}

function adfToText(node) {
  if (!node || typeof node !== "object") return "";
  if (typeof node.text === "string") return node.text;
  if (!Array.isArray(node.content)) return "";
  const isBlock =
    node.type === "doc" ||
    node.type === "paragraph" ||
    node.type === "heading" ||
    node.type === "codeBlock" ||
    node.type === "listItem";
  return node.content
    .map(adfToText)
    .filter(Boolean)
    .join(isBlock ? "\n" : "");
}

async function listJiraComments(jiraBaseUrl, issueKey) {
  const response = await jiraFetch(
    jiraBaseUrl,
    `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment?maxResults=5000`,
  );
  if (!response.ok) {
    throw new Error(`Couldn't list comments (status ${response.status}).`);
  }
  const data = await response.json();
  const comments = Array.isArray(data?.comments) ? data.comments : [];
  return comments.map((c) => {
    if (typeof c?.body === "string") return c.body;
    if (c?.body && typeof c.body === "object") return adfToText(c.body).trim();
    return "";
  });
}

async function listJiraCommentsDetailed(jiraBaseUrl, issueKey) {
  const response = await jiraFetch(
    jiraBaseUrl,
    `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment?maxResults=5000`,
  );
  if (!response.ok) {
    throw new Error(`Couldn't list comments (status ${response.status}).`);
  }
  const data = await response.json();
  const comments = Array.isArray(data?.comments) ? data.comments : [];
  return comments
    .map((c) => ({
      id: String(c?.id || ""),
      author: c?.author?.displayName || "",
      created: c?.created || "",
      body:
        typeof c?.body === "string"
          ? c.body
          : c?.body && typeof c.body === "object"
            ? adfToText(c.body).trim()
            : "",
    }))
    .filter((c) => c.id && c.body);
}

async function getJiraIssue(jiraBaseUrl, issueKey) {
  const response = await jiraFetch(
    jiraBaseUrl,
    `/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=description,summary`,
  );
  if (!response.ok) {
    throw new Error(`Couldn't fetch issue (status ${response.status}).`);
  }
  return response.json();
}

async function getJiraIssueWithAttachments(jiraBaseUrl, issueKey) {
  const response = await jiraFetch(
    jiraBaseUrl,
    `/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=description,summary,attachment`,
  );
  if (!response.ok) {
    throw new Error(`Couldn't fetch issue (status ${response.status}).`);
  }
  const data = await response.json();
  const attachments = Array.isArray(data?.fields?.attachment)
    ? data.fields.attachment
        .map((a) => ({
          name: String(a.filename || "").trim(),
          id: String(a.id || "").trim(),
          size: Number(a.size),
          mimeType: String(a.mimeType || ""),
        }))
        .filter((a) => a.name && a.id)
    : [];
  return { issue: data, attachments };
}

async function addJiraComment(jiraBaseUrl, issueKey, body) {
  const response = await jiraFetch(
    jiraBaseUrl,
    `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Atlassian-Token": "no-check",
      },
      body: JSON.stringify({ body: textToAdf(body) }),
    },
    { retryStatus: false },
  );

  if (response.status === 401 || response.status === 403) {
    const sessionValid = await isJiraLoggedIn(jiraBaseUrl);
    if (sessionValid) {
      throw new Error("Invalid project key or you don't have access.");
    }
    redirectToLogin(jiraBaseUrl, "");
    throw new Error("Jira session expired. Please login again.");
  }

  const responseData = await response.json().catch(() => null);

  if (!response.ok) {
    const message =
      responseData?.errorMessages?.join(", ") ||
      responseData?.errors?.body ||
      "Comment creation failed.";
    throw new Error(message);
  }

  return responseData;
}

export {
  isJiraLoggedIn,
  validateProject,
  findExistingJiraIssue,
  findExistingJiraIssueByUrl,
  findExistingJiraIssueFor,
  createJiraIssue,
  uploadJiraAttachment,
  updateJiraIssueDescription,
  listIssueAttachments,
  listIssueAttachmentItems,
  fetchJiraAttachmentDataUrl,
  listJiraComments,
  listJiraCommentsDetailed,
  getJiraIssue,
  getJiraIssueWithAttachments,
  addJiraComment,
};
