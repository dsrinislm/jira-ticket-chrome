const statusDiv = document.getElementById("status");
const statusText = document.getElementById("statusText");
const ticketResult = document.getElementById("ticketResult");
const loginBtn = document.getElementById("openWebsite");
const jiraBaseUrlInput = document.getElementById("jiraBaseUrl");
const jiraBaseUrlError = document.getElementById("jiraBaseUrlError");
const projectKeyInput = document.getElementById("projectKey");
const createTicketBtn = document.getElementById("createTicket");
const projectTagsContainer = document.getElementById("projectTags");

document.addEventListener("DOMContentLoaded", () => {
  loadSettings();
  loadProjectHistory();

  jiraBaseUrlInput.addEventListener("input", () => {
    // Never introduce a new error while typing — only clear one that's
    // already showing, the moment the value becomes valid again.
    enforceJiraBaseUrlNoPath();
    clearJiraBaseUrlErrorIfNowValid();
    debouncedSaveSettings();
  });

  jiraBaseUrlInput.addEventListener("blur", validateJiraBaseUrlField);

  projectKeyInput.addEventListener("input", debouncedSaveSettings);
  createTicketBtn.addEventListener("click", createTicket);
});

const debouncedSaveSettings = debounce(saveSettings, 300);

function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

// Strips anything past the origin (path, query, hash) so the field can
// never actually hold more than a base URL — called live as the user
// types, rather than erroring after the fact.
function stripPathFromJiraBaseUrl(value) {
  const value_ = value.trim();
  if (!value_) return value;

  let url;
  try {
    url = new URL(value_);
  } catch {
    return value; // not parseable yet (still mid-typing the host) — leave as-is
  }

  const hasExtra = (url.pathname && url.pathname !== "/") || url.search || url.hash;
  if (!hasExtra) return value;

  return url.origin;
}

function enforceJiraBaseUrlNoPath() {
  const current = jiraBaseUrlInput.value;
  const stripped = stripPathFromJiraBaseUrl(current);

  if (stripped !== current) {
    jiraBaseUrlInput.value = stripped;
    // Cursor goes to the end — the removed part was always the tail.
    const end = stripped.length;
    jiraBaseUrlInput.setSelectionRange(end, end);
  }
}

/**
 * Validates that a string is a plausible Jira base URL:
 * - parses as an absolute URL
 * - uses https (Jira Cloud/Server never legitimately runs auth over http)
 * - has a real hostname (with at least one dot, e.g. company.atlassian.net,
 *   or "localhost" for local dev instances)
 * - is a "base" URL: no path/query/hash/credentials, since we build
 *   REST paths onto it later (jiraFetch appends /rest/api/3/...)
 *
 * Returns { valid: boolean, message?: string }
 */
function validateJiraBaseUrl(rawValue) {
  const value = (rawValue || "").trim();

  if (!value) {
    return { valid: false, message: "Base URL is required." };
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    return { valid: false, message: "Enter a valid URL, e.g. https://company.atlassian.net" };
  }

  if (url.protocol !== "https:") {
    return { valid: false, message: "Jira base URL must use https://" };
  }

  if (url.username || url.password) {
    return { valid: false, message: "Remove credentials from the URL." };
  }

  const hostname = url.hostname;
  const isLocalDev = hostname === "localhost" || hostname === "127.0.0.1";
  const looksLikeDomain = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(hostname);

  if (!isLocalDev && !looksLikeDomain) {
    return { valid: false, message: "Enter a valid Jira domain, e.g. https://company.atlassian.net" };
  }

  const hasExtraPath = url.pathname && url.pathname !== "/";
  if (hasExtraPath || url.search || url.hash) {
    // In practice this shouldn't happen anymore — the input listener
    // strips anything past the origin as the user types. Kept as a
    // defensive fallback (e.g. a stale value restored from storage)
    // that silently normalizes rather than erroring.
    return { valid: true, normalized: url.origin };
  }

  return { valid: true };
}

function applyJiraBaseUrlErrorState(showAsInvalid, message) {
  jiraBaseUrlInput.classList.toggle("invalid", showAsInvalid);
  jiraBaseUrlInput.setAttribute("aria-invalid", showAsInvalid ? "true" : "false");

  if (jiraBaseUrlError) {
    jiraBaseUrlError.textContent = showAsInvalid ? message : "";
    jiraBaseUrlError.style.display = showAsInvalid ? "block" : "none";
  }
}

// Called on blur: the only place a new error is allowed to appear.
// An empty field is still treated as "no error" here — required-ness
// is enforced on submit via createTicket(), not as an inline nag.
function validateJiraBaseUrlField() {
  const result = validateJiraBaseUrl(jiraBaseUrlInput.value);
  const isEmpty = !jiraBaseUrlInput.value.trim();
  const showAsInvalid = !result.valid && !isEmpty;

  applyJiraBaseUrlErrorState(showAsInvalid, result.message);

  return result;
}

// Called on input: never introduces a new error, only clears an
// already-visible one the moment the value becomes valid.
function clearJiraBaseUrlErrorIfNowValid() {
  if (!jiraBaseUrlInput.classList.contains("invalid")) return;

  const result = validateJiraBaseUrl(jiraBaseUrlInput.value);
  if (result.valid) {
    applyJiraBaseUrlErrorState(false);
  }
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
    // Don't validate/show errors here — jiraBaseUrlTouched is still
    // false, so this only takes effect after the user leaves the field.
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

    const urlValidation = validateJiraBaseUrlField();
    if (!urlValidation.valid) {
      setStatus(urlValidation.message, "error");
      return;
    }

    if (!projectKey) {
      setStatus("Please enter a project key.", "error");
      return;
    }


    // Safe: validateJiraBaseUrlField() already confirmed this parses.
    const jiraUrl = new URL(jiraBaseUrl);

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
    saveProjectHistory(projectKey);
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