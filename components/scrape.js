// Site scraping for the single-ticket flow.
//
// The user picks the source site in the popup; the matching site config is
// scraped through chrome.scripting. All scrapers return a normalized shape:
// { title, id, source, url, html, images }.

// --- Site config ------------------------------------------------------------
// Each entry: name (must match the popup's source-site switch and is used
// for the Jira title prefix), plus DOM selectors for the ticket id, title
// (string or array — both are accepted), and the description editor.
const SITES = [
  {
    name: "Octane",
    idSelector: ".entity-form-document-view-header-entity-id-container",
    titleSelectors: [
      ".entity-form-document-view-header-name-field-container",
      ".document-view-header-entity-name--custom-label input",
    ],
    editorSelector: ".fr-element",
  },
  {
    name: "Spark",
    idSelector: 'input[name="incident.number"]',
    titleSelectors: 'input[name="incident.short_description"]',
    editorSelector: 'textarea[name="incident.description"]',
    attachmentSelector: ".attachment_list_items .content_editable",
    // Upload captured attachments without embedding placeholder text in the
    // description body.
    embedImages: false,
  },
];

function getSite(name) {
  return SITES.find((site) => site.name === name) || null;
}

// Runs in the tab's page context: returns the name of the first site whose
// idSelector and titleSelectors all match the DOM, or null.
function detectInPage(sites) {
  const matches = (selector) => !!document.querySelector(selector);

  for (const site of sites) {
    const idFound = matches(site.idSelector);
    const titleFound = [].concat(site.titleSelectors).some(matches);
    if (idFound && titleFound) return site.name;
  }

  return null;
}

async function detectSiteInTab() {
  const currentTab = await getCurrentTab();

  try {
    // Scan every frame — the site's form may live in an iframe (common in
    // QA apps), and document.querySelector only sees the current frame.
    const results = await chrome.scripting.executeScript({
      target: { tabId: currentTab.id, allFrames: true },
      func: detectInPage,
      args: [SITES],
    });

    // Main frame comes first in the results, so prefer its match.
    return results.map((r) => r.result).find(Boolean) || null;
  } catch {
    // Script can't run on this page (e.g. chrome://) — no detection.
    return null;
  }
}

async function getCurrentTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs.length) throw new Error("No active tab found.");
  return tabs[0];
}

// Runs in the tab's own page context — it can only reference built-in APIs
// plus the `site` object passed as an argument.
async function scrapeInPage(site) {
  const textOf = (el) =>
    el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
      ? el.value
      : el.textContent;
  const readText = (selector) => {
    const el = document.querySelector(selector);
    return el ? String(textOf(el)).replace(/\s+/g, " ").trim() : null;
  };

  const id = readText(site.idSelector);

  let title = "";
  let titleFound = false;
  for (const selector of [].concat(site.titleSelectors)) {
    const value = readText(selector);
    if (value !== null) {
      title = value;
      titleFound = true;
      break;
    }
  }

  // Validation: the selected site's idSelector and titleSelectors must
  // actually match the DOM. If not, this page isn't a ticket details page
  // on that QA site — return an empty result so the popup shows
  // "Open the selected site's ticket details page" instead of creating a
  // ticket from a random page.
  if (id === null || !titleFound) {
    return {
      title: "",
      id: "",
      source: site.name,
      url: location.href,
      html: "",
      images: [],
    };
  }

  const jiraTitle = [site.name.toUpperCase(), id, title].filter(Boolean).join(" | ");

  const images = [];
  let html = "";

  // Fetches an image URL as a data URL and records it under a placeholder.
  // Runs with the page's own cookies, so authenticated URLs work too.
  async function captureUrl(url, name) {
    const placeholder = `__JIRA_IMG_${images.length}__`;

    try {
      const response = await fetch(url, { credentials: "include" });
      const blob = await response.blob();
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });

      images.push({ placeholder, dataUrl, name: name || null });
      return placeholder;
    } catch {
      // Couldn't fetch this one — drop it rather than aborting the capture.
      return null;
    }
  }

  // Clones a container, swaps each <img> for a placeholder, and returns the
  // resulting fragment HTML.
  async function captureImages(container) {
    const clone = container.cloneNode(true);
    const imgEls = Array.from(clone.querySelectorAll("img"));

    for (const imgEl of imgEls) {
      const placeholder = await captureUrl(imgEl.src);
      if (placeholder) {
        imgEl.replaceWith(document.createTextNode(placeholder));
      } else {
        imgEl.remove();
      }
    }

    return clone.innerHTML;
  }

  const editor = document.querySelector(site.editorSelector);

  if (editor) {
    // Plain text fields (e.g. Spark's description textarea) hold no markup —
    // capture their value escaped as HTML, since innerHTML would be empty.
    if (editor instanceof HTMLInputElement || editor instanceof HTMLTextAreaElement) {
      html = String(editor.value ?? "").replace(/[&<>"']/g, (c) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c]);
    } else {
      // Rich-text editor (e.g. Octane's .fr-element) — extract images and
      // keep the markup.
      html = await captureImages(editor);
    }
  }

  // Separate attachment containers (e.g. Spark's media attachment list).
  // A container may be an <a> link whose href points at the image, or an
  // element holding <img> tags. Each captured image becomes its own
  // paragraph appended after the description.
  if (site.attachmentSelector) {
    const containers = Array.from(
      document.querySelectorAll(site.attachmentSelector),
    );
    for (const container of containers) {
      const href = container.getAttribute?.("href");
      if (href) {
        // The link's text content is the attachment's file name.
        const name = (container.textContent || "").trim() || null;
        const placeholder = await captureUrl(href, name);
        if (placeholder && site.embedImages !== false) {
          html += `<p>${placeholder}</p>`;
        }
      } else {
        const frag = await captureImages(container);
        if (site.embedImages !== false) {
          const placeholders = Array.from(
            frag.matchAll(/__JIRA_IMG_(\d+)__/g),
          );
          html += placeholders.map((m) => `<p>${m[0]}</p>`).join("");
        }
      }
    }
  }

  return {
    title: jiraTitle,
    id,
    source: site.name,
    url: location.href,
    html,
    images,
  };
}

async function getPageData(siteName) {
  const site = getSite(siteName);

  if (!site) {
    throw new Error("Select a source site (Octane or Spark).");
  }

  const currentTab = await getCurrentTab();

  // Scrape in every frame (the site's form may be in an iframe) and pick
  // the first frame where the site's selectors matched and produced a title.
  const results = await chrome.scripting.executeScript({
    target: { tabId: currentTab.id, allFrames: true },
    func: scrapeInPage,
    args: [site],
  });

  return (results.find((r) => r.result?.title) || results[0])?.result;
}

export { getPageData, detectSiteInTab, detectInPage, SITES };
