import {
  jiraBaseUrlInput,
  projectKeyInput,
  setSourceSite,
  getSourceSite,
  projectTagsContainer,
  escapeHtml,
} from "./ui.js";

// Single round trip to storage on popup open instead of two separate
// get() calls (settings + project history) racing independently.
export function loadInitialState() {
  chrome.storage.local.get(
    ["jiraBaseUrl", "projectKey", "sourceSite", "projectHistory"],
    (data) => {
      if (data.jiraBaseUrl) jiraBaseUrlInput.value = data.jiraBaseUrl;
      if (data.projectKey) projectKeyInput.value = data.projectKey;
      if (data.sourceSite) setSourceSite(data.sourceSite);
      // Don't validate/show errors here — the user hasn't touched the
      // field yet, so this only takes effect after blur.

      renderProjectHistory(data.projectHistory || []);

      // Accessibility: when no Jira details are configured yet, land focus on
      // the Base URL field so keyboard / screen-reader users start on the
      // first required input instead of the document body.
      if (!jiraBaseUrlInput.value.trim() && !projectKeyInput.value.trim()) {
        jiraBaseUrlInput.focus();
      }
    },
  );

  // "Include attachments" is a per-action choice: it must be (re)checked by
  // the user, so it's never persisted or restored. Drop any value a previous
  // version saved so it can't linger and silently re-enable.
  chrome.storage.local.remove("includeAttachments");
}

export function saveSettings() {
  chrome.storage.local.set({
    jiraBaseUrl: jiraBaseUrlInput.value.trim(),
    projectKey: projectKeyInput.value.trim(),
    sourceSite: getSourceSite(),
  });
}

export function removeProjectTag(projectKey) {
  chrome.storage.local.get(["projectHistory"], (data) => {
    const history = (data.projectHistory || []).filter(
      (item) => item !== projectKey,
    );

    chrome.storage.local.set({ projectHistory: history }, () =>
      renderProjectHistory(history),
    );
  });
}

export function renderProjectHistory(projects) {
  if (!projectTagsContainer) return;

  projectTagsContainer.innerHTML = "";

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
    // project keys are persisted user input — escape before injecting.
    tag.innerHTML = `
      <span class="tag-text">${escapeHtml(project)}</span>
      <span class="tag-close" title="Remove">✕</span>
    `;

    tag.addEventListener("click", () => {
      projectKeyInput.value = project;
      saveSettings();
    });

    tag.querySelector(".tag-close").addEventListener("click", (e) => {
      e.stopPropagation();
      removeProjectTag(project);
    });

    projectTagsContainer.appendChild(tag);
  });
}

export function saveProjectHistory(projectKey) {
  chrome.storage.local.get(["projectHistory"], (data) => {
    let history = data.projectHistory || [];
    history = history.filter((x) => x !== projectKey);
    history.unshift(projectKey);
    history = history.slice(0, 15);

    chrome.storage.local.set({ projectHistory: history }, () =>
      renderProjectHistory(history),
    );
  });
}
