// Site scraping for the single-ticket flow.

const SITES = [
  {
    name: "Octane",
    // Octane is an SPA: the URL only pins the workspace (?p=), so the site is
    // deduced from that param alone on both the listing and detail views (no
    // DOM involved). The entity-id header element exists only on a ticket's
    // detail view and supplies the id that feeds the REST API, which provides
    // the name, description, and attachments (octaneApiPath).
    idSelector: ".entity-form-document-view-header-entity-id-container",
  },
  {
    name: "Spark",
    idSelector: 'input[name="incident.number"]',
    titleSelectors: 'input[name="incident.short_description"]',
    editorSelector: 'textarea[name="incident.description"]',
    attachmentSelector: ".attachment_list_items .content_editable",
    embedImages: false,
  },
];

export function getSite(name) {
  return SITES.find((site) => site.name === name) || null;
}

// Runs in the tab's page context: returns the name of the first site whose
// idSelector and titleSelectors all match the DOM, or null. Octane is deduced
// from its SPA URL alone (the workspace param in ?p=) — the entity-id header
// element is never present on the listing page, so detection must not depend
// on the DOM.
function detectInPage(sites) {
  const matches = (selector) =>
    selector ? !!document.querySelector(selector) : false;

  for (const site of sites) {
    if (!site.idSelector || !site.titleSelectors) continue;
    const idFound = matches(site.idSelector);
    const titleFound = [].concat(site.titleSelectors).some(matches);
    if (idFound && titleFound) return site.name;
  }

  const octane = sites.find((s) => s.name === "Octane");
  if (octane && /[?&]p=[^&#/]+\/[^&#]+/.test(location.search || "")) {
    return "Octane";
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

export async function scrapeInPage(site, options = {}) {
  const includeAttachments = options.includeAttachments !== false;
  const selectedAttachments = options.selectedAttachments || null;
  // When false, the scrape only LISTS the selected attachment names without
  // downloading any bytes. The popup uses this cheap pass to decide which
  // files a Jira ticket is actually missing before paying for the slow byte
  // downloads — files that already exist are never fetched.
  const captureAttachments = options.captureAttachments !== false;
  // When false, the description's embedded images are left untouched and NOT
  // downloaded (the popup's metadata pass and existing-ticket sync both pass
  // it, so they never pay for description-image bytes). When true — the
  // default — embedded images are captured and uploaded with placeholders
  // REGARDLESS of the attachments checkbox: they're inline description
  // content, not selectable attachment files.
  const captureEmbeddedImages = options.captureEmbeddedImages !== false;

  const textOf = (el) => {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      return el.value;
    }
    if (!String(el.textContent || "").trim()) {
      const nested = el.querySelector("input, textarea");
      if (nested) return textOf(nested);
    }
    return el.textContent;
  };
  const readText = (selector) => {
    const el = document.querySelector(selector);
    return el ? String(textOf(el)).replace(/\s+/g, " ").trim() : null;
  };

  // --- Octane: minimal-DOM id + REST API path --------------------------------
  // Octane is an SPA: the URL only pins the workspace (?p=<sharedSpace>/<workspace>),
  // never the ticket — a listing and its detail view can share the same
  // location. So the ticket id comes from the entity-id header element
  // (minimal DOM) and the name, description, and attachments are read through
  // the same-origin REST API (session cookie, identical to the listing
  // import). The id is never taken from the URL: the SPA can leave a stale id
  // in the hash on the listing page, so an absent element means "no ticket
  // open" and the flow returns empty rather than guessing. Runs in the page
  // context, so it must be self-contained (no module imports). Returns null
  // when the page can't be read this way.
  const octaneApiPath = async () => {
    const contextMatch = /[?&]p=([^&#/]+\/[^&#]+)/.exec(location.search || "");
    if (!contextMatch) return null;
    const [sharedSpace, workspace] = contextMatch[1].split("/");
    if (!sharedSpace || !workspace) return null;

    // Minimal DOM: the entity-id header element. Handles both a plain text
    // container and one wrapping an input, and extracts the numeric id.
    const itemId = (() => {
      if (!site.idSelector) return null;
      const el = document.querySelector(site.idSelector);
      if (!el) return null;
      let raw;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        raw = el.value;
      } else {
        raw = el.textContent;
        if (!String(raw || "").trim()) {
          const nested = el.querySelector("input, textarea");
          if (nested) raw = nested.value;
        }
      }
      const match = /\d+/.exec(String(raw || ""));
      return match ? match[0] : null;
    })();
    if (!itemId) return null;

    const apiBase = `${location.origin}/api/shared_spaces/${sharedSpace}/workspaces/${workspace}`;

    // Downloads a file over the same session and resolves to its data URL.
    const toDataUrl = async (url) => {
      const response = await fetch(url, { credentials: "include" });
      const blob = await response.blob();
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    };

    let response;
    try {
      response = await fetch(
        `${apiBase}/work_items/${itemId}?fields=id,name,description`,
        { credentials: "include" },
      );
    } catch {
      return null;
    }
    if (!response.ok) return null;

    const data = await response.json();
    if (!data || !String(data.name || "").trim()) return null;

    const raw = String(data.description || "");
    const plain = !/<[a-zA-Z][^>]*>/.test(raw);
    const images = [];
    let html;
    let text = "";
    if (plain) {
      // Plain text comes back escaped so it can flow through htmlToADF.
      text = raw;
      html = raw.replace(/[&<>"']/g, (c) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c]);
    } else {
      // Rich description — extract embedded images to data URLs and swap in
      // placeholders, mirroring the DOM path so htmlToADF sees the same shape.
      // Embedded images are inline description content, so they follow
      // `captureEmbeddedImages` on their own — independent of the attachments
      // checkbox (`includeAttachments`), which only governs the attachment
      // files listed in the picker.
      const doc = new DOMParser().parseFromString(raw, "text/html");
      if (captureEmbeddedImages) {
        let imgIndex = 0;
        for (const imgEl of Array.from(doc.querySelectorAll("img"))) {
          if (!imgEl.src) {
            imgEl.remove();
            continue;
          }
          const placeholder = `__JIRA_IMG_${imgIndex++}__`;
          try {
            const url = new URL(imgEl.src, location.href).href;
            const res = await fetch(url, { credentials: "include" });
            const blob = await res.blob();
            const dataUrl = await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result);
              reader.onerror = reject;
              reader.readAsDataURL(blob);
            });
            images.push({ placeholder, dataUrl });
            imgEl.replaceWith(doc.createTextNode(placeholder));
          } catch {
            imgEl.remove();
          }
        }
      }
      html = doc.body ? doc.body.innerHTML : "";
    }

    // The work item's attachments, listed through the API and downloaded as
    // data URLs. Each file gets a __JIRA_IMG_n__ placeholder appended to the
    // html (as <p>, like the DOM path) so the popup uploads it as a Jira
    // attachment; the optional picker selection narrows which files to take.
    if (includeAttachments) {
      const query = `owner_work_item EQ {id EQ ${itemId}}`;
      let attachments = [];
      try {
        const listResponse = await fetch(
          `${apiBase}/attachments?query=${encodeURIComponent(`"${query}"`)}`,
          { credentials: "include" },
        );
        if (listResponse.ok) {
          const body = await listResponse.json();
          attachments = Array.isArray(body?.data) ? body.data : [];
        }
      } catch {
        attachments = [];
      }

      const kept = attachments.filter(
        (att) =>
          att &&
          att.id != null &&
          att.exists !== false &&
          String(att.name || "").trim() &&
          (!selectedAttachments ||
            selectedAttachments.includes(String(att.name))),
      );

      if (captureAttachments === false) {
        // Metadata pass — names only, no byte downloads.
        for (const att of kept) images.push({ name: String(att.name) });
      } else {
        // Bounded pool over the selected files, keeping source order so each
        // placeholder still lines up with the file it was captured from.
        let attImageIndex = 0;
        let attIndex = 0;
        const worker = async () => {
          while (attIndex < kept.length) {
            const att = kept[attIndex++];
            const placeholder = `__JIRA_IMG_${attImageIndex++}__`;
            try {
              const dataUrl = await toDataUrl(
                `${apiBase}/attachments/${encodeURIComponent(att.id)}`,
              );
              images.push({ placeholder, dataUrl, name: String(att.name) });
              html += `<p>${placeholder}</p>`;
            } catch {
              // Couldn't fetch this file — drop it rather than aborting.
            }
          }
        };
        await Promise.all(
          Array.from({ length: Math.min(4, kept.length) }, worker),
        );
      }
    }

    const itemIdText = String(data.id ?? itemId);
    return {
      title: `${site.name.toUpperCase()} | ${itemIdText} | ${String(data.name).replace(/\s+/g, " ").trim()}`,
      id: itemIdText,
      source: site.name,
      url: location.href,
      html,
      text,
      images,
    };
  };

  if (site.name === "Octane") {
    const viaApi = await octaneApiPath();
    if (viaApi) return viaApi;
    return {
      title: "",
      id: "",
      source: site.name,
      url: location.href,
      html: "",
      images: [],
    };
  }

  // --- Spark (ServiceNow): DOM path -----------------------------------------
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

  // Downloads a file over the same session and resolves to its data URL.
  async function fetchDataUrl(url) {
    const response = await fetch(url, { credentials: "include" });
    const blob = await response.blob();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  // One bounded pool shared by every capture step, mirroring the bulk flow's
  // pacing: single-ticket exports used to fetch files strictly one-by-one,
  // so a many-attachment ticket took N serial round trips. A small pool
  // keeps the same session and per-file capture while cutting wall time by
  // roughly the pool size. Results keep source order so each placeholder
  // still lines up with the file it was captured from.
  const MAX_CAPTURE_PAR = 4;
  let nextImageIndex = 0;

  // Fetches `url` to a data URL, records it in `images`, and returns its
  // `__JIRA_IMG_n__` placeholder (or null when the fetch failed — a bad
  // file is dropped rather than aborting the whole capture).
  async function captureOne(url, name) {
    const placeholder = `__JIRA_IMG_${nextImageIndex++}__`;
    try {
      const dataUrl = await fetchDataUrl(url);
      images.push({ placeholder, dataUrl, name: name || null });
      return placeholder;
    } catch {
      return null;
    }
  }

  // Runs `sources` ({ url, name }[]) through the bounded pool, returning the
  // placeholders (null per failed source) in the same order as `sources`.
  async function captureAll(sources) {
    const out = new Array(sources.length).fill(null);
    let next = 0;
    const worker = async () => {
      while (next < sources.length) {
        const i = next++;
        out[i] = await captureOne(sources[i].url, sources[i].name);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(MAX_CAPTURE_PAR, sources.length) }, worker),
    );
    return out;
  }

  // Clones a container, swaps each <img> for a placeholder, and returns the
  // resulting fragment HTML.
  async function captureImages(container) {
    const clone = container.cloneNode(true);
    const imgEls = Array.from(clone.querySelectorAll("img"));

    const placeholders = await captureAll(
      imgEls.map((imgEl) => ({ url: imgEl.src, name: null })),
    );
    imgEls.forEach((imgEl, i) => {
      const placeholder = placeholders[i];
      if (placeholder) {
        imgEl.replaceWith(document.createTextNode(placeholder));
      } else {
        imgEl.remove();
      }
    });

    return clone.innerHTML;
  }

  const editor = document.querySelector(site.editorSelector);

  // Raw text of Spark's plain-text description textarea — kept alongside the
  // escaped html so callers can show it without markup.
  let text = "";

  if (editor) {
    // The textarea holds no markup — capture its value escaped as HTML, since
    // innerHTML would be empty.
    text = String(editor.value ?? "");
    html = text.replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[c]);
  }

  if (includeAttachments && site.attachmentSelector) {
    const containers = Array.from(
      document.querySelectorAll(site.attachmentSelector),
    );
    const sources = [];
    for (const container of containers) {
      const href = container.getAttribute?.("href");
      if (href) {
        // The link's text content is the attachment's file name.
        const name = (container.textContent || "").trim() || null;
        if (selectedAttachments && (!name || !selectedAttachments.includes(name))) {
          continue;
        }
        if (captureAttachments === false) {
          // Metadata pass — names only, no byte downloads.
          if (name) images.push({ name });
        } else {
          sources.push({ url: href, name });
        }
      } else {
        if (captureAttachments === false || captureEmbeddedImages === false) continue;
        // Embedded images have no attachment name to match against the
        // picker, so they follow the toggle rather than the name selection —
        // except an explicit "deselected everything" still means upload none.
        if (selectedAttachments && selectedAttachments.length === 0) continue;
        const frag = await captureImages(container);
        if (site.embedImages !== false) {
          const placeholders = Array.from(
            frag.matchAll(/__JIRA_IMG_(\d+)__/g),
          );
          html += placeholders.map((m) => `<p>${m[0]}</p>`).join("");
        }
      }
    }
    const placeholders = await captureAll(sources);
    if (site.embedImages !== false) {
      for (const placeholder of placeholders) {
        if (placeholder) html += `<p>${placeholder}</p>`;
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

// Runs in the tab's own page context — same constraints as scrapeInPage.
// Lists each attachment's name, download url, type and (when available) size
// WITHOUT fetching the file bytes. This cheap metadata pass feeds the popup's
// attachment picker, so the user picks which files to upload before the slow
// byte-by-byte capture ever runs. Octane lists through the REST API (no DOM);
// Spark reads its attachment-list markup.
export async function listTicketAttachmentsInPage(site) {
  const VIDEO_EXTS = new Set([
    "mp4", "m4v", "mov", "avi", "mkv", "webm", "wmv", "flv", "mpeg", "mpg",
  ]);
  const IMAGE_EXTS = new Set([
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "tif", "tiff", "ico",
  ]);

  const sizeOf = (container) => {
    const m = /([\d.]+\s*(?:KB|MB|GB))/i.exec(container.textContent || "");
    return m ? m[1] : "";
  };

  const typeOf = (container, name) => {
    // Octane tiles carry a data-aid like "video-attachment-tile-<name>".
    const aid = container.getAttribute?.("data-aid") || "";
    const byAid = /^(video|image|other)-attachment-tile/.exec(aid);
    if (byAid) return byAid[1];
    const ext = (name.split(".").pop() || "").toLowerCase();
    if (VIDEO_EXTS.has(ext)) return "video";
    if (IMAGE_EXTS.has(ext)) return "image";
    return "other";
  };

  // Octane: the SPA URL only pins the workspace, so the ticket id comes from
  // the entity-id header element (minimal DOM, never the URL/hash) and the
  // files are listed through the same REST API the create path uses. The
  // listing is metadata-only (no file bytes fetched), so the picker stays
  // cheap. The API supplies size (bytes) and description, so those come
  // straight through; type is derived from the file extension, and files the
  // API reports as missing (exists=false) are dropped.
  if (site.name === "Octane") {
    const contextMatch = /[?&]p=([^&#/]+\/[^&#]+)/.exec(location.search || "");
    if (!contextMatch) return [];
    const [sharedSpace, workspace] = contextMatch[1].split("/");
    if (!sharedSpace || !workspace) return [];

    let itemId = null;
    if (site.idSelector) {
      const el = document.querySelector(site.idSelector);
      let raw = "";
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        raw = el.value;
      } else if (el) {
        raw = el.textContent;
        if (!String(raw || "").trim()) {
          const nested = el.querySelector("input, textarea");
          if (nested) raw = nested.value;
        }
      }
      const match = /\d+/.exec(String(raw || ""));
      if (match) itemId = match[0];
    }
    if (!itemId) return [];

    const apiBase = `${location.origin}/api/shared_spaces/${sharedSpace}/workspaces/${workspace}`;
    const query = `owner_work_item EQ {id EQ ${itemId}}`;
    const fields = "id,name,description,client_lock_stamp,size,exists";
    let data = [];
    try {
      const response = await fetch(
        `${apiBase}/attachments?fields=${encodeURIComponent(fields)}&query=${encodeURIComponent(`"${query}"`)}`,
        { credentials: "include" },
      );
      if (response.ok) {
        const body = await response.json();
        data = Array.isArray(body?.data) ? body.data : [];
      }
    } catch {
      return [];
    }

    // The API reports byte sizes, so format them once here for the picker.
    const formatFileSize = (bytes) => {
      const n = Number(bytes);
      if (!Number.isFinite(n) || n < 0) return "";
      if (n < 1024) return `${n} B`;
      const units = ["KB", "MB", "GB", "TB"];
      let size = n;
      let unit = "B";
      for (const u of units) {
        size /= 1024;
        unit = u;
        if (size < 1024) break;
      }
      return `${Number(size.toFixed(size < 10 ? 1 : 0))} ${unit}`;
    };

    return data
      .filter(
        (att) =>
          att &&
          att.id != null &&
          att.exists !== false &&
          String(att?.name || "").trim(),
      )
      .map((att) => {
        const name = String(att.name);
        const ext = (name.split(".").pop() || "").toLowerCase();
        const type = VIDEO_EXTS.has(ext)
          ? "video"
          : IMAGE_EXTS.has(ext)
            ? "image"
            : "other";
        const sizeBytes = Number(att.size);
        return {
          name,
          url: `${apiBase}/attachments/${encodeURIComponent(att.id)}`,
          type,
          size: formatFileSize(sizeBytes),
          sizeBytes:
            Number.isFinite(sizeBytes) && sizeBytes >= 0 ? sizeBytes : null,
          description: String(att.description || "").trim(),
        };
      });
  }

  const items = [];

  if (site.attachmentSelector) {
    for (const container of Array.from(
      document.querySelectorAll(site.attachmentSelector),
    )) {
      const href = container.getAttribute?.("href");
      const name = (container.textContent || "").trim();
      if (!href || !name) continue;
      items.push({
        name,
        url: new URL(href, location.href).href,
        type: typeOf(container, name),
        size: sizeOf(container),
      });
    }
  }

  return items;
}


export async function listTicketAttachmentsInTab(siteName) {
  const site = getSite(siteName);
  if (!site) return [];

  const currentTab = await getCurrentTab();

  const results = await chrome.scripting.executeScript({
    target: { tabId: currentTab.id, allFrames: true },
    func: listTicketAttachmentsInPage,
    args: [site],
  });

  // Prefer the frame that actually found attachments, then any result.
  return (
    results.map((r) => r.result).find((r) => r && r.length > 0) ||
    (results[0] && results[0].result) ||
    []
  );
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
    if (!s.idSelector || !s.titleSelectors) continue;
    const idFound = matches(s.idSelector);
    const titleFound = [].concat(s.titleSelectors).some(matches);
    if (idFound && titleFound) {
      site = s.name;
      break;
    }
  }

  // Same URL-only Octane signal as detectInPage — the SPA never leaves the
  // ticket in the location, and the entity-id header element isn't present on
  // the listing page, so the workspace param alone marks Octane on both the
  // listing and detail views.
  if (!site && /[?&]p=[^&#/]+\/[^&#]+/.test(location.search || "")) {
    site = "Octane";
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

export { getPageData, detectSiteInTab };
