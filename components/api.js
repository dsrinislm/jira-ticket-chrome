import { redirectToLogin } from "./ui.js";
import { sleep } from "./util.js";

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

// Wraps fetch with a single bounded retry for transient failures: network
// drops (a TypeError — what browsers surface as "Failed to fetch") and the
// statuses that usually mean "try again" (rate limit, gateway hiccup). One
// retry keeps a genuinely dead server from stalling the import.
// `retryStatus` is off for non-idempotent writes (issue create, attachment
// upload) where a re-send could duplicate — those still retry the
// network-level rejection, which almost always means the request never
// reached the server.
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

async function searchByJql(jiraBaseUrl, jql, matches) {
  let response;
  try {
    // Jira deprecated GET /rest/api/3/search in favor of the enhanced
    // JQL search endpoint — use that here.
    response = await jiraFetch(jiraBaseUrl, "/rest/api/3/search/jql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jql, fields: ["summary"], maxResults: 50 }),
    });
  } catch {
    return { error: true, issue: null };
  }

  if (!response.ok) return { error: true, issue: null };

  const data = await response.json();
  const match = (data.issues || []).find((issue) =>
    matches(issue.fields?.summary),
  );

  return { error: false, issue: match || null };
}

// Duplicate detection. Single-ticket titles are "SITE | ID | description";
// the ID is the stable dedup key — the description part can drift between
// imports (e.g. a Spark ticket's short description edited in the meantime),
// which is why exact-title-only matching re-created Spark tickets.
//
// Strategy: exact summary match first; if the title is site-prefixed, also
// search by the source ID and accept an issue that carries both the site
// and the ID in its summary.
async function findExistingJiraIssue(jiraBaseUrl, projectKey, summary) {
  const target = String(summary ?? "").trim();
  if (!target) return { error: false, issue: null };

  const projectJql = `project = "${escapeJqlString(projectKey)}"`;
  const lower = target.toLowerCase();

  const exact = await searchByJql(
    jiraBaseUrl,
    `${projectJql} AND summary = "${escapeJqlString(target)}"`,
    (s) => String(s ?? "").trim().toLowerCase() === lower,
  );
  if (exact.issue) return exact;

  const prefixed = /^([A-Z]+) \| ([A-Z0-9][A-Z0-9._-]*) \|/i.exec(target);
  if (prefixed) {
    const siteToken = prefixed[1].toUpperCase();
    const id = prefixed[2].toUpperCase();

    const byId = await searchByJql(
      jiraBaseUrl,
      `${projectJql} AND summary ~ "${escapeJqlString(id)}"`,
      (s) => {
        const upper = String(s ?? "").toUpperCase();
        return upper.includes(siteToken) && upper.includes(id);
      },
    );
    if (byId.issue || byId.error) return byId;
  }

  return exact;
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
    // Re-sending a create could duplicate the issue if the server actually
    // processed the first attempt — retry the network drop, not HTTP errors.
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

// Jira decides each attachment's type from the multipart part's Content-Type
// and the filename's extension. QA sites frequently serve attachments (BMP
// images on ServiceNow, MP4/MOV videos on Octane) with a generic or missing
// Content-Type, so the blob carries e.g. `application/octet-stream` and Jira
// drops the file as unknown. When that happens, re-type the blob from the
// filename's extension.
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

async function uploadJiraAttachment(jiraBaseUrl, issueKey, blob, filename) {
  const ext = (String(filename).split(".").pop() || "").toLowerCase();
  const wantedType = FILE_TYPE_BY_EXT[ext];
  if (wantedType && (!blob.type || blob.type === "application/octet-stream")) {
    blob = new Blob([blob], { type: wantedType });
  }

  const formData = new FormData();
  formData.append("file", blob, filename);

  const response = await fetchWithRetry(
    `${jiraBaseUrl}/rest/api/3/issue/${issueKey}/attachments`,
    {
      method: "POST",
      credentials: "include",
      headers: {
        Accept: "application/json",
        "X-Atlassian-Token": "no-check",
        // No Content-Type — the browser must set the multipart boundary itself.
      },
      body: formData,
    },
    { retryStatus: false },
  );

  if (!response.ok)
    throw new Error(`Image upload failed (status ${response.status}).`);
  const data = await response.json();
  return data[0]; // { id, filename, ... }
}

async function updateJiraIssueDescription(jiraBaseUrl, issueKey, contentNodes) {
  const response = await jiraFetch(
    jiraBaseUrl,
    `/rest/api/3/issue/${issueKey}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fields: {
          description: { version: 1, type: "doc", content: contentNodes },
        },
      }),
    },
  );
  if (!response.ok)
    throw new Error(`Attaching images failed (status ${response.status}).`);
}

// Returns the filenames already attached to a Jira issue. Used when a
// partially-failed create is retried so only the attachments that are
// actually missing get uploaded — never re-uploading what's already there.
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

export {
  jiraFetch,
  isJiraLoggedIn,
  validateProject,
  findExistingJiraIssue,
  createJiraIssue,
  uploadJiraAttachment,
  updateJiraIssueDescription,
  listIssueAttachments,
};
