import {
  jiraBaseUrlInput,
  jiraBaseUrlError,
  projectKeyInput,
  setStatus,
} from "./ui.js";
import { validateProject } from "./api.js";
import { debounce } from "./util.js";

function stripPathFromJiraBaseUrl(value) {
  const value_ = value.trim();
  if (!value_) return value;

  let url;
  try {
    url = new URL(value_);
  } catch {
    return value;
  }

  const hasExtra =
    (url.pathname && url.pathname !== "/") || url.search || url.hash;
  if (!hasExtra) return value;

  return url.origin;
}

export function enforceJiraBaseUrlNoPath() {
  const current = jiraBaseUrlInput.value;
  const stripped = stripPathFromJiraBaseUrl(current);

  if (stripped !== current) {
    jiraBaseUrlInput.value = stripped;

    const end = stripped.length;
    jiraBaseUrlInput.setSelectionRange(end, end);
  }
}

export function parseJiraIssueUrl(value) {
  const value_ = (value || "").trim();
  if (!value_) return null;

  let url;
  try {
    url = new URL(value_);
  } catch {
    return null;
  }

  if (url.protocol !== "https:") return null;

  const browse = /\/browse\/([A-Za-z0-9]+-\d+)(?:[/?#]|$)/i.exec(
    url.pathname,
  );
  if (browse) {
    const key = browse[1].toUpperCase();
    return {
      origin: url.origin,
      projectKey: key.replace(/-\d+$/, ""),
    };
  }

  const board = /\/projects\/([A-Za-z0-9]+)\/boards?\/(?:\d+|backlog)?(?:[/?#]|$)/i.exec(
    url.pathname,
  );
  if (board) {
    return {
      origin: url.origin,
      projectKey: board[1].toUpperCase(),
    };
  }

  const project = /\/projects\/([A-Za-z0-9]+)(?:[/?#]|$)/i.exec(
    url.pathname,
  );
  if (project) {
    return {
      origin: url.origin,
      projectKey: project[1].toUpperCase(),
    };
  }

  if (/\/secure\/RapidBoard\.jspa\b/i.test(url.pathname)) {
    const pk = /[?&]projectKey=([A-Za-z0-9]+)/i.exec(url.search);
    if (pk) {
      return {
        origin: url.origin,
        projectKey: pk[1].toUpperCase(),
      };
    }
  }

  const jiraHost =
    url.hostname.endsWith("atlassian.net") ||
    /(^|\.)jira[.\-]/.test(url.hostname) ||
    url.hostname === "jira";
  if (jiraHost && /\/issues\/?(?:[/?#]|$)/i.test(url.pathname)) {
    return { origin: url.origin, projectKey: null };
  }

  return null;
}

export function extractJiraIssueDetailsFromBaseUrl() {
  const parsed = parseJiraIssueUrl(jiraBaseUrlInput.value);
  if (!parsed) return false;

  jiraBaseUrlInput.value = parsed.origin;
  if (parsed.projectKey && projectKeyInput.value !== parsed.projectKey) {
    projectKeyInput.value = parsed.projectKey;
  }
  return true;
}

export function validateJiraBaseUrl(rawValue) {
  const value = (rawValue || "").trim();

  if (!value) {
    return { valid: false, message: "Base URL is required." };
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    return {
      valid: false,
      message: "Enter a valid URL, e.g. https://company.atlassian.net",
    };
  }

  if (url.protocol !== "https:") {
    return { valid: false, message: "Jira base URL must use https://" };
  }

  if (url.username || url.password) {
    return { valid: false, message: "Remove credentials from the URL." };
  }

  const hostname = url.hostname;
  const isLocalDev = hostname === "localhost" || hostname === "127.0.0.1";
  const looksLikeDomain =
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(
      hostname,
    );

  if (!isLocalDev && !looksLikeDomain) {
    return {
      valid: false,
      message: "Enter a valid Jira domain, e.g. https://company.atlassian.net",
    };
  }

  const hasExtraPath = url.pathname && url.pathname !== "/";
  if (hasExtraPath || url.search || url.hash) {

    return { valid: true, normalized: url.origin };
  }

  return { valid: true };
}

function applyJiraBaseUrlErrorState(showAsInvalid, message) {
  jiraBaseUrlInput.classList.toggle("invalid", showAsInvalid);
  jiraBaseUrlInput.setAttribute(
    "aria-invalid",
    showAsInvalid ? "true" : "false",
  );

  if (jiraBaseUrlError) {
    jiraBaseUrlError.textContent = showAsInvalid ? message : "";
    jiraBaseUrlError.style.display = showAsInvalid ? "block" : "none";
  }
}

export function validateJiraBaseUrlField() {
  const result = validateJiraBaseUrl(jiraBaseUrlInput.value);
  const isEmpty = !jiraBaseUrlInput.value.trim();
  const showAsInvalid = !result.valid && !isEmpty;

  applyJiraBaseUrlErrorState(showAsInvalid, result.message);

  return result;
}

export function clearJiraBaseUrlErrorIfNowValid() {
  if (!jiraBaseUrlInput.classList.contains("invalid")) return;

  const result = validateJiraBaseUrl(jiraBaseUrlInput.value);
  if (result.valid) {
    applyJiraBaseUrlErrorState(false);
  }
}

export async function validateBulkProjectKey() {
  const url = jiraBaseUrlInput.value.trim();
  const projectKey = projectKeyInput.value.trim().toUpperCase();
  if (!url || !projectKey) return;

  let origin;
  try {
    origin = new URL(url).origin;
  } catch {
    return;
  }

  const result = await validateProject(origin, projectKey);
  if (!result.success && !result.loginRequired) {
    setStatus(result.message, "error");
  }
}

export const debouncedValidateBulkProjectKey = debounce(
  validateBulkProjectKey,
  400,
);

export function getJiraContext() {
  const urlValidation = validateJiraBaseUrlField();
  if (!urlValidation.valid) {
    setStatus(urlValidation.message, "error");
    return null;
  }

  const projectKey = projectKeyInput.value.trim().toUpperCase();
  if (!projectKey) {
    setStatus("Please enter a project key.", "error");
    return null;
  }

  const jiraOrigin = new URL(jiraBaseUrlInput.value.trim()).origin;
  return { jiraOrigin, projectKey };
}
