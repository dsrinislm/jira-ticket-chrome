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
    // Attachments live behind an "Attachments" tab that lazily renders an
    // attachments-view once activated. The tab element, the per-file tile,
    // the download link inside each tile, and the tile's name input.
    attachmentsTabSelector: '[tab-name="attachments"], [data-aid="mqm-tab-attachments"]',
    attachmentTileSelector: ".attachment-tile-container",
    attachmentLinkSelector: "a.download-attachment",
    attachmentNameSelector: 'input[ng-model="tile.attachment.name"]',
    // Upload captured attachments without embedding placeholder text in the
    // description body.
    embedImages: false,
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

export function getSite(name) {
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
// plus the `site` object passed as an argument. includeAttachments=false
// skips the attachment capture entirely, so a no-attachments export doesn't
// pay for clicking the attachments tab and fetching every file.
export async function scrapeInPage(site, options = {}) {
  const includeAttachments = options.includeAttachments !== false;
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

  // Raw text of a plain-text editor (e.g. Spark's description textarea) —
  // kept alongside the escaped html so callers can show it without markup.
  let text = "";

  if (editor) {
    // Plain text fields (e.g. Spark's description textarea) hold no markup —
    // capture their value escaped as HTML, since innerHTML would be empty.
    if (editor instanceof HTMLInputElement || editor instanceof HTMLTextAreaElement) {
      text = String(editor.value ?? "");
      html = text.replace(/[&<>"']/g, (c) => ({
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
  if (includeAttachments && site.attachmentSelector) {
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

  // Octane keeps attachments behind a lazy "Attachments" tab. The tiles only
  // render once that tab is activated, so click it, wait for the tiles to
  // appear, then capture each tile's download link as an attachment.
  if (includeAttachments && site.attachmentsTabSelector) {
    const tab = document.querySelector(site.attachmentsTabSelector);
    if (tab) {
      const tilesExist = () =>
        document.querySelector(site.attachmentTileSelector) !== null;
      if (!tilesExist()) {
        tab.click();
        // Poll for the attachments-view to finish rendering the tiles.
        for (let i = 0; i < 50 && !tilesExist(); i++) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }

      const containers = Array.from(
        document.querySelectorAll(site.attachmentTileSelector),
      );
      for (const container of containers) {
        const link = container.querySelector(site.attachmentLinkSelector);
        if (!link) continue;
        const href = link.getAttribute("href");
        if (!href) continue;
        const url = new URL(href, location.href).href;
        const nameInput = container.querySelector(site.attachmentNameSelector);
        const name =
          (nameInput && nameInput.value.trim()) ||
          decodeURIComponent(url.split("/").pop() || "") ||
          null;
        const placeholder = await captureUrl(url, name);
        if (placeholder && site.embedImages !== false) {
          html += `<p>${placeholder}</p>`;
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
    text,
    images,
  };
}

// Runs the site scraper against an arbitrary tab. Used by the single-ticket
// flow on the current tab and by the bulk flow on detail pages that are
// opened in background tabs.
export async function scrapeTab(tabId, siteName, options = {}) {
  const site = getSite(siteName);

  if (!site) {
    throw new Error(`Unknown site: ${siteName}`);
  }

  // Scrape in every frame (the site's form may be in an iframe) and pick
  // the first frame where the site's selectors matched and produced a title.
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: scrapeInPage,
    args: [site, options],
  });

  return (results.find((r) => r.result?.title) || results[0])?.result;
}

async function getPageData(siteName, options = {}) {
  if (!getSite(siteName)) {
    throw new Error("Select a source site (Octane or Spark).");
  }

  const currentTab = await getCurrentTab();
  return scrapeTab(currentTab.id, siteName, options);
}

// --- Octane listing page ------------------------------------------------------
// The "import from the current page" bulk flow reads the checkbox-selected
// rows out of the Octane listing grid (SlickGrid) and returns each selected
// item's detail-page URL so the extension can open + scrape it per ticket.

// Runs in the page context: collects the grid rows the user ticked.
export function scrapeSelectedListingInPage() {
  const items = [];

  document.querySelectorAll("div.slick-row").forEach((row) => {
    const checkbox = row.querySelector(
      'div[field-name="isSelected"] input[type="checkbox"]',
    );
    if (!checkbox || !checkbox.checked) return;

    const link = row.querySelector("a.alm-entity-grid-id-column");
    const href = link?.getAttribute("href") || "";
    const idMatch =
      /[?&]id=(\d+)/.exec(href) || /item-id-(\d+)/.exec(row.className);
    const id = idMatch ? idMatch[1] : "";

    if (!id || !href) return;

    const nameEl = row.querySelector('div[field-name="name"] .grid-cell-text');
    const descEl = row.querySelector('div[field-name="description"]');
    const text = (el) =>
      el ? String(el.textContent).replace(/\s+/g, " ").trim() : "";

    items.push({
      id,
      name: text(nameEl),
      description: text(descEl),
      url: location.href.split("#")[0] + href,
    });
  });

  return items;
}

// Collects the checkbox-selected rows from the listing page in the current
// tab. Returns [] when the tab isn't an Octane listing (or can't be read).
export async function scrapeSelectedListingInTab() {
  const currentTab = await getCurrentTab();

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: currentTab.id },
      func: scrapeSelectedListingInPage,
    });
    return results[0]?.result || [];
  } catch {
    return [];
  }
}

// Runs in the page context: returns the listing site name ("Octane"/"Spark")
// when the active tab shows that site's listing grid, else null.
export function detectListingInPage() {
  if (
    document.querySelector("div.slick-row") &&
    document.querySelector("a.alm-entity-grid-id-column")
  ) {
    return "Octane";
  }
  // ServiceNow incident list: rows are tr.list_row with a .formlink number link.
  const formlink = document.querySelector("a.linked.formlink");
  if (
    document.querySelector("tr.list_row") &&
    formlink &&
    /incident\.do/.test(formlink.getAttribute("href") || "")
  ) {
    return "Spark";
  }
  return null;
}

// Runs in the tab's page context: computes both the details-page site and the
// listing site in one pass.
function detectTabStateInPage(sites) {
  const matches = (selector) => {
    try {
      return !!document.querySelector(selector);
    } catch {
      return false;
    }
  };

  let site = null;
  for (const s of sites) {
    const idFound = matches(s.idSelector);
    const titleFound = [].concat(s.titleSelectors).some(matches);
    if (idFound && titleFound) {
      site = s.name;
      break;
    }
  }

  let listing = null;
  if (matches("div.slick-row") && matches("a.alm-entity-grid-id-column")) {
    listing = "Octane";
  } else {
    const formlink = document.querySelector("a.linked.formlink");
    if (
      matches("tr.list_row") &&
      formlink &&
      /incident\.do/.test(formlink.getAttribute("href") || "")
    ) {
      listing = "Spark";
    }
  }

  return { site, listing };
}

// One all-frames scan that detects both the details-page site and the listing
// site. The single-ticket and listing flows both re-run on every tab/URL
// change, so detecting them together halves the per-event page work. Tabs
// that can never host a site (chrome://, file://, new-tab, …) are skipped
// without injecting anything.
export async function detectTabState() {
  const currentTab = await getCurrentTab();
  const url = (currentTab?.url || "").trim();
  if (url && !/^https?:\/\//i.test(url)) {
    return { site: null, listing: null };
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: currentTab.id, allFrames: true },
      func: detectTabStateInPage,
      args: [SITES],
    });

    // The main frame comes first: prefer its site match. Listing markup can
    // live in a shell iframe, so take the first frame that found one.
    const site = results.map((r) => r.result?.site).find(Boolean) || null;
    const listing =
      results.map((r) => r.result?.listing).find(Boolean) || null;
    return { site, listing };
  } catch {
    return { site: null, listing: null };
  }
}

// --- Spark (ServiceNow) listing page -----------------------------------------
// Spark lists incidents in ServiceNow's list view. Each row is a tr.list_row
// carrying the sys_id (row attribute, checkbox, or row id), the incident
// number as a .formlink link, and the short description in the next column.
//
// The full description is taken straight from the list row DOM (the cell after
// the short description, whose `title` tooltip holds the complete value). That
// keeps the import on the user's active page session — no ServiceNow REST call,
// so no Basic-auth prompt can ever appear.

// Runs in the page context: collects the ServiceNow incident rows the user
// ticked. Each returns { id, number, name, description, url }.
export function scrapeSelectedSparkListingInPage() {
  const items = [];

  document.querySelectorAll("tr.list_row").forEach((row) => {
    const checkbox = row.querySelector('input[type="checkbox"]');
    if (!checkbox || !checkbox.checked) return;

    const sysId =
      (row.getAttribute("sys_id") || "").trim() ||
      (checkbox.getAttribute("data-ux-metrics-sysid") || "").trim() ||
      (row.id || "").replace(/^row_[^_]+_/, "").trim();
    if (!sysId) return;

    const link = row.querySelector("a.linked.formlink");
    const number = link ? (link.textContent || "").trim() : "";

    // The short description column sits right after the number link, and the
    // description column right after that. The description cell renders the
    // full value as a tooltip (newlines become tabs), so prefer its `title`
    // attribute and fall back to the visible text.
    const numberCell = link ? link.closest("td") : null;
    const shortDescCell = numberCell ? numberCell.nextElementSibling : null;
    const descCell = shortDescCell ? shortDescCell.nextElementSibling : null;

    const shortDescription = shortDescCell
      ? (shortDescCell.textContent || "").replace(/\s+/g, " ").trim()
      : "";

    const cellText = (cell) =>
      (cell.textContent || "").replace(/\s+/g, " ").trim();
    const description = descCell
      ? (descCell.getAttribute("title") || cellText(descCell))
          .replace(/\t/g, "\n")
          .replace(/[ \t]+/g, " ")
          .trim()
      : "";

    items.push({
      id: sysId,
      number,
      name: shortDescription || number || sysId,
      description: description || shortDescription,
      url: `${location.origin}/nav_to.do?uri=incident.do?sys_id=${sysId}`,
    });
  });

  return items;
}

// Collects the checkbox-selected incident rows from the listing page in the
// current tab. Returns [] when the tab isn't a Spark list (or can't be read).
export async function scrapeSelectedSparkListingInTab() {
  const currentTab = await getCurrentTab();

  try {
    // Scan every frame and use the one that actually holds selected rows —
    // the ServiceNow list may live in a shell iframe.
    const results = await chrome.scripting.executeScript({
      target: { tabId: currentTab.id, allFrames: true },
      func: scrapeSelectedSparkListingInPage,
    });
    return (
      results.map((r) => r.result).find((r) => Array.isArray(r) && r.length) ||
      []
    );
  } catch {
    return [];
  }
}

// --- Listing detail via the same-origin REST API ----------------------------

export function fetchListingDetailsInPage(ids, site) {
  const idList = Array.isArray(ids) ? ids : [ids];

  async function captureImages(html) {
    if (!html) return { html: "", images: [] };

    const images = [];
    const plain = !/<[a-zA-Z][^>]*>/.test(String(html));
    if (plain) {
      // Plain text comes back escaped so it can flow through htmlToADF.
      const escaped = String(html).replace(/[&<>"']/g, (c) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c]);
      return { html: escaped, images };
    }

    const doc = new DOMParser().parseFromString(String(html), "text/html");
    let next = 0;

    for (const imgEl of Array.from(doc.querySelectorAll("img"))) {
      if (!imgEl.src) {
        imgEl.remove();
        continue;
      }
      const placeholder = `__JIRA_IMG_${next++}__`;
      try {
        const url = new URL(imgEl.src, location.href).href;
        const response = await fetch(url, { credentials: "include" });
        const blob = await response.blob();
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
        images.push({ placeholder, dataUrl });
        imgEl.replaceWith(doc.createTextNode(placeholder));
      } catch {
        // Couldn't fetch this image — drop it rather than aborting.
        imgEl.remove();
      }
    }

    return { html: doc.body ? doc.body.innerHTML : "", images };
  }

  const plainText = (value) => {
    if (!value) return "";
    const text = new DOMParser()
      .parseFromString(String(value), "text/html")
      .body.textContent.replace(/\s+/g, " ")
      .trim();
    return text;
  };

  let fetchItem;
  let itemUrl;
  let apiName;

  // Bounded retry for transient failures — a flaky network dropping a detail
  // fetch shouldn't fail the row. Runs in the page context, so it must be
  // self-contained (no module imports). "Try again" statuses and every
  // fetch-level rejection are retried with growing backoff.
  async function fetchWithRetry(url, options, tries = 2) {
    let lastError;
    for (let attempt = 0; attempt < tries; attempt++) {
      if (attempt > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, 300 * attempt + Math.random() * 200),
        );
      }
      let response;
      try {
        response = await fetch(url, options);
      } catch (err) {
        lastError = err;
        continue;
      }
      if (
        response.status === 429 ||
        (response.status >= 500 && response.status <= 599)
      ) {
        lastError = new Error(`${apiName} ${response.status}`);
        continue;
      }
      return response;
    }
    throw lastError || new Error(`${apiName} fetch failed`);
  }

  if (site === "Spark") {
    apiName = "Spark API";
    itemUrl = (id) => `${location.origin}/nav_to.do?uri=incident.do?sys_id=${id}`;

    // Only the frame that actually renders the incident list is a valid API
    // context — any shell frames would just 404 on the wrong origin. Empty
    // out instead of firing per-id fetches so allFrames scans stay cheap.
    if (!document.querySelector("tr.list_row")) {
      return { items: [] };
    }

    // ServiceNow Table API, authenticated the same way the page itself does:
    // the session cookie plus the page's CSRF token (window.g_ck) sent as
    // X-UserToken. This instance enforces the token on API calls, so it's
    // required even for GETs. Runs in the MAIN world (fetchListingDetailsInTab)
    // so the page global is visible.
    const userToken =
      (typeof window !== "undefined" && window.g_ck) ||
      document.querySelector('meta[name="X-UserToken"]')?.content ||
      document.querySelector('input[name="X-UserToken"]')?.value ||
      "";

    const apiHeaders = { Accept: "application/json" };
    if (userToken) apiHeaders["X-UserToken"] = userToken;

    // Downloads a file to a data URL over the same session+CSRF.
    async function sparkFetchToDataUrl(url, accept) {
      const headers = userToken ? { "X-UserToken": userToken } : {};
      if (accept) headers.Accept = accept;
      try {
        const response = await fetchWithRetry(
          url,
          { credentials: "include", headers },
          2,
        );
        if (!response.ok) return null;
        const blob = await response.blob();
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
      } catch {
        return null;
      }
    }

    // The incident's attachment-list files (sys_attachment rows), e.g. what
    // the details page shows under the attachment section.
    async function fetchSparkAttachments(incidentSysId) {
      try {
        const response = await fetchWithRetry(
          `${location.origin}/api/now/table/sys_attachment?sysparm_query=table_sys_id=${encodeURIComponent(incidentSysId)}&sysparm_fields=sys_id,file_name,content_type&sysparm_display_value=false`,
          { credentials: "include", headers: apiHeaders },
        );
        if (!response.ok) return [];
        const json = await response.json();
        return Array.isArray(json?.result) ? json.result : [];
      } catch {
        return [];
      }
    }

    fetchItem = async (id) => {
      const response = await fetchWithRetry(
        `${location.origin}/api/now/table/incident/${encodeURIComponent(id)}?sysparm_fields=number,short_description,description&sysparm_display_value=false`,
        { credentials: "include", headers: apiHeaders },
      );
      if (!response.ok) {
        throw new Error(`${apiName} ${response.status}`);
      }
      const json = await response.json();
      const record = Array.isArray(json?.result) ? json.result[0] : json?.result;
      if (!record) {
        throw new Error("No incident record returned");
      }
      const { html, images } = await captureImages(record.description);

      // The details-page attachment list comes down too, mirroring the
      // single-ticket scrape. Their placeholders aren't in the description
      // HTML, so they upload as Jira attachments without being embedded.
      let next = images.length;
      const attachments = await fetchSparkAttachments(String(id));
      for (const att of attachments) {
        if (!att?.sys_id || !att?.file_name) continue;
        const dataUrl = await sparkFetchToDataUrl(
          `${location.origin}/api/now/attachment/${encodeURIComponent(att.sys_id)}/file`,
          "*/*",
        );
        if (dataUrl) {
          images.push({
            placeholder: `__JIRA_IMG_${next++}__`,
            dataUrl,
            name: att.file_name,
          });
        }
      }

      return {
        id: String(id),
        number: record.number || "",
        name: plainText(record.short_description) || record.number || String(id),
        description: html,
        html,
        images,
        url: itemUrl(id),
      };
    };
  } else {
    apiName = "Octane API";

    // The Octane UI carries the current workspace in the URL as ?p=<sharedSpace>/<workspace>.
    const contextMatch = /[?&]p=([^&#]+)/.exec(location.search || "");
    if (!contextMatch) {
      return {
        error: "Couldn't determine the Octane shared space/workspace from the page URL.",
      };
    }
    const [sharedSpace, workspace] = contextMatch[1].split("/");
    if (!sharedSpace || !workspace) {
      return {
        error: "Couldn't determine the Octane shared space/workspace from the page URL.",
      };
    }
    const apiBase = `${location.origin}/api/shared_spaces/${sharedSpace}/workspaces/${workspace}`;
    itemUrl = (id) => `${location.href.split("#")[0]}#/entity-navigation?entityType=work_item&id=${id}`;

    fetchItem = async (id) => {
      const response = await fetchWithRetry(
        `${apiBase}/work_items/${id}?fields=id,name,description`,
        { credentials: "include" },
      );
      if (!response.ok) {
        throw new Error(`${apiName} ${response.status}`);
      }
      const data = await response.json();
      const { html, images } = await captureImages(data.description);
      return {
        id: String(data.id ?? id),
        name: data.name || "",
        description: html,
        html,
        images,
        url: itemUrl(id),
      };
    };
  }

  // Runs in the page context, so it must return a plain (serializable) value.
  // Items are fetched through a small bounded pool, but written back into
  // their original slots so the caller's position-based lookup still matches
  // the requested ids.
  return (async () => {
    const items = new Array(idList.length);
    let next = 0;
    const MAX_PAR = 4;
    const worker = async () => {
      while (next < idList.length) {
        const index = next++;
        const id = idList[index];
        try {
          items[index] = await fetchItem(id);
        } catch (err) {
          items[index] = {
            id: String(id),
            name: "",
            description: "",
            html: "",
            images: [],
            url: itemUrl(id),
            error: err.message || `${apiName} fetch failed`,
          };
        }
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(MAX_PAR, idList.length) },
        worker,
      ),
    );
    return { items };
  })();
}

// Fetches the selected items' details from the listing tab. Returns one entry
// per id, each with an `error` string when that item couldn't load. Throws when
// the page can't provide an API context at all (e.g. no ?p= for Octane).
export async function fetchListingDetailsInTab(ids, site) {
  const currentTab = await getCurrentTab();

  // Scan every frame and keep the one that answered for real: the shell frame
  // (wrong origin) yields items that all carry errors, so a result with at
  // least one healthy item is preferred, then any result with items, then the
  // first frame as a last resort.
  const results = await chrome.scripting.executeScript({
    target: { tabId: currentTab.id, allFrames: true },
    func: fetchListingDetailsInPage,
    args: [ids, site],
    // Spark's Table API only authenticates when the request is issued from the
    // page's own context (MAIN world) — the listing session is carried that
    // way. An isolated-world native fetch gets a 401 Basic challenge, and
    // Chrome then shows the Basic-auth dialog, which JS can't suppress.
    world: site === "Spark" ? "MAIN" : "ISOLATED",
  });
  const outs = results.map((r) => r.result).filter(Boolean);
  const out =
    outs.find((o) => (o.items || []).some((i) => !i.error)) ||
    outs.find((o) => (o.items || []).length > 0) ||
    outs[0];
  if (!out) return [];
  if (out.error) throw new Error(out.error);
  return out.items || [];
}

export {
  getPageData,
  detectSiteInTab,
  detectInPage,
  SITES,
};
