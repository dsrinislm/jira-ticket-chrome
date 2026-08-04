import { setStatus, showLoginButton } from "./ui.js";
import { isJiraLoggedIn, validateProject } from "./api.js";

export async function ensureJiraReady(jiraOrigin, projectKey) {
  setStatus("Checking Jira session...", "loading");
  if (!(await isJiraLoggedIn(jiraOrigin))) {
    setStatus(
      "Jira login required. Open Jira in a tab, log in, then retry.",
      "error",
    );
    showLoginButton(`${jiraOrigin}/browse/${projectKey}`);
    return false;
  }

  setStatus("Validating project access...", "loading");
  const projectValidation = await validateProject(jiraOrigin, projectKey);
  if (!projectValidation.success) {
    setStatus(projectValidation.message, "error");
    if (projectValidation.loginRequired) {
      showLoginButton(`${jiraOrigin}/browse/${projectKey}`);
    }
    return false;
  }

  return true;
}
