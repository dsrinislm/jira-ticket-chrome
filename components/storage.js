import {
  jiraBaseUrlInput,
  projectKeyInput,
  setSourceSite,
  getSourceSite,
  projectTagsContainer,
  escapeHtml,
  refreshSingleViewStatus,
} from "./ui.js";

export function loadInitialState() {
  chrome.storage.local.get(
    ["jiraBaseUrl", "projectKey", "sourceSite", "projectHistory"],
    (data) => {
      if (data.jiraBaseUrl) jiraBaseUrlInput.value = data.jiraBaseUrl;
      if (data.projectKey) projectKeyInput.value = data.projectKey;
      if (data.sourceSite) setSourceSite(data.sourceSite);

      renderProjectHistory(data.projectHistory || []);

      refreshSingleViewStatus();

      if (!jiraBaseUrlInput.value.trim() && !projectKeyInput.value.trim()) {
        jiraBaseUrlInput.focus();
      }
    },
  );

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
