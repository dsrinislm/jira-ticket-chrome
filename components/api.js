import { redirectToLogin } from "./ui.js";

async function jiraFetch(jiraBaseUrl, path, options = {}) {
  return fetch(`${jiraBaseUrl}${path}`, {
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });
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

  const response = await jiraFetch(jiraBaseUrl, "/rest/api/3/issue", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Atlassian-Token": "no-check",
    },
    body: JSON.stringify(payload),
  });

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

async function uploadJiraAttachment(jiraBaseUrl, issueKey, blob, filename) {
  const formData = new FormData();
  formData.append("file", blob, filename);

  const response = await fetch(
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

export {
  jiraFetch,
  isJiraLoggedIn,
  validateProject,
  findExistingJiraIssue,
  createJiraIssue,
  uploadJiraAttachment,
  updateJiraIssueDescription,
};
