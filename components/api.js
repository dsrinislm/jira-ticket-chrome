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

// Jira deprecated GET /rest/api/3/search in favor of the enhanced
// JQL search endpoint — use that here.
async function findExistingJiraIssue(jiraBaseUrl, projectKey, summary) {
  const jql = `project = "${escapeJqlString(projectKey)}" AND summary ~ "${escapeJqlString(summary)}"`;

  let response;
  try {
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
  const target = summary.trim().toLowerCase();
  const match = (data.issues || []).find(
    (issue) => issue.fields?.summary?.trim().toLowerCase() === target,
  );

  return { error: false, issue: match || null };
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
      // Jira Server/Data Center rejects cookie-authenticated POSTs
      // without this unless the caller opts out of XSRF checking.
      // Jira Cloud ignores the header, so it's safe to send always.
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

async function getCurrentTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs.length) throw new Error("No active tab found.");
  return tabs[0];
}

async function getPageData() {
  const currentTab = await getCurrentTab();

  const results = await chrome.scripting.executeScript({
    target: { tabId: currentTab.id },
    func: async () => {
      const octaneID = String(
        document.querySelector(
          ".entity-form-document-view-header-entity-id-container",
        )?.textContent ?? "",
      )
        .replace(/\s+/g, " ")
        .trim();
      const title =
        document
          .querySelector(".entity-form-document-view-header-name-field-container")
          ?.textContent.replace(/\s+/g, " ")
          .trim() ||
        document.querySelector(
          ".document-view-header-entity-name--custom-label input",
        )?.value ||
        "";

      const jiraTitle = ["OCTANE", octaneID, title]
        .filter(Boolean)
        .join(" | ");

      const editor = document.querySelector(".fr-element");
      const images = [];
      let html = "";

      if (editor) {
        // Work on a clone so we never touch the live editor content.
        const container = editor.cloneNode(true);
        const imgEls = Array.from(container.querySelectorAll("img"));

        for (let i = 0; i < imgEls.length; i++) {
          const imgEl = imgEls[i];
          const placeholder = `__JIRA_IMG_${i}__`;

          try {
            // imgEl.src is the browser-resolved absolute URL (resolved
            // against THIS page's origin), and this fetch runs with the
            // page's own cookies — so it works even for relative paths
            // and authenticated Octane attachment URLs.
            const response = await fetch(imgEl.src, { credentials: "include" });
            const blob = await response.blob();
            const dataUrl = await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result);
              reader.onerror = reject;
              reader.readAsDataURL(blob);
            });

            images.push({ placeholder, dataUrl });
            imgEl.replaceWith(document.createTextNode(placeholder));
          } catch {
            // Couldn't fetch this one — drop it rather than aborting
            // the whole capture.
            imgEl.remove();
          }
        }

        html = container.innerHTML;
      }

      return {
        title: jiraTitle,
        octaneID,
        url: location.href,
        html,
        images,
      };
    },
  });

  return results[0].result;
}

export {
  jiraFetch,
  isJiraLoggedIn,
  validateProject,
  findExistingJiraIssue,
  createJiraIssue,
  uploadJiraAttachment,
  updateJiraIssueDescription,
  getCurrentTab,
  getPageData,
};
