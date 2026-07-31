import {
  jiraBaseUrlInput,
  jiraBaseUrlError,
  projectKeyInput,
  bulkView,
  setStatus,
} from "./ui.js";
import { validateProject } from "./api.js";
import { debounce } from "./util.js";

// Strips anything past the origin (path, query, hash) so the field can
// never actually hold more than a base URL — called live as the user
// types, rather than erroring after the fact.
export function stripPathFromJiraBaseUrl(value) {
  const value_ = value.trim();
  if (!value_) return value;

  let url;
  try {
    url = new URL(value_);
  } catch {
    return value; // not parseable yet (still mid-typing the host) — leave as-is
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
  jiraBaseUrlInput.setAttribute(
    "aria-invalid",
    showAsInvalid ? "true" : "false",
  );

  if (jiraBaseUrlError) {
    jiraBaseUrlError.textContent = showAsInvalid ? message : "";
    jiraBaseUrlError.style.display = showAsInvalid ? "block" : "none";
  }
}

// Called on blur: the only place a new error is allowed to appear.
// An empty field is still treated as "no error" here — required-ness
// is enforced on submit via createTicket(), not as an inline nag.
export function validateJiraBaseUrlField() {
  const result = validateJiraBaseUrl(jiraBaseUrlInput.value);
  const isEmpty = !jiraBaseUrlInput.value.trim();
  const showAsInvalid = !result.valid && !isEmpty;

  applyJiraBaseUrlErrorState(showAsInvalid, result.message);

  return result;
}

// Called on input: never introduces a new error, only clears an
// already-visible one the moment the value becomes valid.
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

// Validates the shared Jira fields for both the single-ticket and bulk
// flows. Shows the first error and returns null on failure.
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

  // Safe: validateJiraBaseUrlField() already confirmed this parses.
  const jiraOrigin = new URL(jiraBaseUrlInput.value.trim()).origin;
  return { jiraOrigin, projectKey };
}
