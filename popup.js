const statusDiv = document.getElementById("status");
const statusText = document.getElementById("statusText");
const ticketResult = document.getElementById("ticketResult");
const loginBtn = document.getElementById("openWebsite");
const jiraBaseUrlInput = document.getElementById("jiraBaseUrl");
const projectKeyInput = document.getElementById("projectKey");
const createTicketBtn = document.getElementById("createTicket");
const projectTagsContainer = document.getElementById("projectTags");

document.addEventListener("DOMContentLoaded", () => {
  loadSettings();
  loadProjectHistory();

  jiraBaseUrlInput.addEventListener("input", debounce(saveSettings, 300));
  projectKeyInput.addEventListener("input", debounce(saveSettings, 300));
  createTicketBtn.addEventListener("click", createTicket);
});

function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

// state: "info" | "loading" | "success" | "error"
function setStatus(message, state = "info") {
  statusText.textContent = message;
  statusDiv.dataset.state = state;
}

function setBusy(isBusy) {
  createTicketBtn.disabled = isBusy;
  createTicketBtn.dataset.loading = isBusy ? "true" : "false";
  jiraBaseUrlInput.disabled = isBusy;
  projectKeyInput.disabled = isBusy;
}

function loadSettings() {
  chrome.storage.local.get(["jiraBaseUrl", "projectKey"], (data) => {
    if (data.jiraBaseUrl) jiraBaseUrlInput.value = data.jiraBaseUrl;
    if (data.projectKey) projectKeyInput.value = data.projectKey;
  });
}

function saveSettings() {
  chrome.storage.local.set({
    jiraBaseUrl: jiraBaseUrlInput.value.trim(),
    projectKey: projectKeyInput.value.trim(),
  });
}

function removeProjectTag(projectKey) {
  chrome.storage.local.get(["projectHistory"], (data) => {
    const history = (data.projectHistory || []).filter(
      (item) => item !== projectKey,
    );

    chrome.storage.local.set({ projectHistory: history }, loadProjectHistory);
  });
}

function loadProjectHistory() {
  if (!projectTagsContainer) return;

  chrome.storage.local.get(["projectHistory"], (data) => {
    projectTagsContainer.innerHTML = "";

    const projects = data.projectHistory || [];

    if (projects.length === 0) {
      const empty = document.createElement("span");
      empty.className = "project-tags-empty";
      empty.textContent = "No recent projects yet.";
      projectTagsContainer.appendChild(empty);
      return;
    }

    projects.forEach((project) => {
      const tag = document.createElement("div");
      tag.className = "project-tag";
      tag.innerHTML = `
        <span class="tag-text">${project}</span>
        <span class="tag-close" title="Remove">✕</span>
      `;

      tag.querySelector(".tag-text").addEventListener("click", () => {
        projectKeyInput.value = project;
        saveSettings();
      });

      tag.querySelector(".tag-close").addEventListener("click", (e) => {
        e.stopPropagation();
        removeProjectTag(project);
      });

      projectTagsContainer.appendChild(tag);
    });
  });
}

function saveProjectHistory(projectKey) {
  chrome.storage.local.get(["projectHistory"], (data) => {
    let history = data.projectHistory || [];
    history = history.filter((x) => x !== projectKey);
    history.unshift(projectKey);
    history = history.slice(0, 15);

    chrome.storage.local.set({ projectHistory: history }, loadProjectHistory);
  });
}

async function createTicket() {
  setBusy(true);

  try {
    saveSettings();

    loginBtn.style.display = "none";
    ticketResult.innerHTML = "";

    const jiraBaseUrl = jiraBaseUrlInput.value.trim();
    const projectKey = projectKeyInput.value.trim().toUpperCase();

    if (!jiraBaseUrl) {
      setStatus("Please enter a Jira base URL.", "error");
      return;
    }

    if (!projectKey) {
      setStatus("Please enter a project key.", "error");
      return;
    }

    saveProjectHistory(projectKey);

    let jiraUrl;
    try {
      jiraUrl = new URL(jiraBaseUrl);
    } catch {
      setStatus("Invalid Jira base URL.", "error");
      return;
    }

    setStatus("Reading active QA ticket...", "loading");
    const pageData = await getPageData();

    setStatus("Checking Jira session...", "loading");
    const loggedIn = await isJiraLoggedIn(jiraUrl.origin);

    if (!loggedIn) {
      redirectToLogin(jiraUrl.origin);
      return;
    }

    setStatus("Validating project access...", "loading");
    const projectValidation = await validateProject(jiraUrl.origin, projectKey);

    if (!projectValidation.success) {
      setStatus(projectValidation.message, "error");

      if (projectValidation.loginRequired) {
        redirectToLogin(jiraUrl.origin);
      }

      return;
    }

    const cleanTitle = pageData.title?.replace(/^OCTANE \|\s*$/, "").trim();
    const finalSummary = cleanTitle ? pageData.title : "Imported QA Ticket";

    const issueDescription = [
      "SOURCE TICKET URL",
      "",
      pageData.url,
      "",
      "SOURCE TICKET TITLE",
      "",
      pageData.title,
      "",
      "SOURCE TICKET DETAILS",
      "",
      pageData.bodyText,
    ].join("\n");

    setStatus("Creating Jira ticket...", "loading");
    const issue = await createJiraIssue(
      jiraUrl.origin,
      projectKey,
      finalSummary,
      issueDescription,
    );

    const issueUrl = `${jiraUrl.origin}/browse/${issue.key}`;

    setStatus(`Created ${issue.key}.`, "success");

    ticketResult.innerHTML = `
    <div class="ticket-card">
      <div class="ticket-key">
        <a id="jiraIssueLink" href="${issueUrl}" target="_blank" rel="noopener noreferrer">
          ${issue.key}
        </a>
      </div>

      <div class="ticket-url">
        <a id="jiraUrlLink" href="${issueUrl}" target="_blank" rel="noopener noreferrer">
          ${issueUrl}
        </a>
      </div>
    </div>
  `;

    ["jiraIssueLink", "jiraUrlLink"].forEach((id) => {
      const link = document.getElementById(id);
      link?.addEventListener("click", (e) => {
        e.preventDefault();
        chrome.tabs.create({ url: issueUrl });
      });
    });
  } catch (error) {
    console.error(error);
    setStatus(error.message || "Failed to create ticket.", "error");
  } finally {
    setBusy(false);
  }
}

async function getPageData() {
  const currentTab = await getCurrentTab();

  const results = await chrome.scripting.executeScript({
    target: { tabId: currentTab.id },
    func: () => {
      const title =
        document.querySelector(
          ".document-view-header-entity-name--custom-label",
        )?.textContent || "";

      const jiraTitle = `OCTANE | ${title
        .replace(/[\r\n\t]+/g, "")
        .replace(/\s*\|\s*/g, " | ")
        .replace(/\s+/g, " ")
        .trim()}`;

      return {
        title: jiraTitle,
        url: location.href,
        bodyText: document.body.innerText
          .replace(/\s+/g, " ")
          .trim()
          .substring(0, 30000),
      };
    },
  });

  return results[0].result;
}

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

async function createJiraIssue(jiraBaseUrl, projectKey, summary, description) {
  const payload = {
    fields: {
      project: { key: projectKey },
      summary,
      issuetype: { name: "Task" },
      description: {
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: description }],
          },
        ],
      },
    },
  };

  const response = await jiraFetch(jiraBaseUrl, "/rest/api/3/issue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (response.status === 401 || response.status === 403) {
    redirectToLogin(jiraBaseUrl);
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

function redirectToLogin(jiraBaseUrl) {
  setStatus("Jira login required.", "error");
  loginBtn.style.display = "block";

  loginBtn.onclick = () => {
    chrome.tabs.create({ url: jiraBaseUrl });
  };
}

function getCurrentTab() {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs.length) {
        reject(new Error("No active tab found."));
        return;
      }
      resolve(tabs[0]);
    });
  });
}