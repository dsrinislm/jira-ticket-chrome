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
    // ServiceNow is API-first: the sys_id in the details URL drives the
    // same-origin Table API (see scrapeInPage's sparkIncidentApiPath). These
    // selectors are only the fallback — when the API can't be reached from
    // the page context (401, blocked fetch, non-ServiceNow frame), the flow
    // reads the incident form directly instead of failing outright.
    idSelector: 'input[name="incident.number"]',
    titleSelectors: 'input[name="incident.short_description"]',
    editorSelector: 'textarea[name="incident.description"]',
    attachmentSelector: ".attachment_list_items .content_editable",
  },
];

export function getSite(name) {
  return SITES.find((site) => site.name === name) || null;
}

// Runs in the tab's page context: returns the name of the first site whose
// details page this is, or null. Both sites are deduced from their URL alone:
// Octane from the SPA workspace param in ?p= (the entity-id header element is
// never present on the listing page, so detection must not depend on the DOM),
// and Spark from an incident.do URL carrying a sys_id — no form fields involved.
function detectInPage(sites) {
  const octane = sites.find((s) => s.name === "Octane");
  if (octane && /[?&]p=[^&#/]+\/[^&#]+/.test(location.search || "")) {
    return "Octane";
  }

  const spark = sites.find((s) => s.name === "Spark");
  if (spark) {
    const searchAndHash = (location.search || "") + (location.hash || "");
    const isIncidentUrl = /incident\.do/.test(
      (location.pathname || "") + searchAndHash,
    );
    if (isIncidentUrl && /[?&]sys_id=[^&#]/.test(searchAndHash)) {
      return "Spark";
    }
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

export async function getCurrentTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs.length) throw new Error("No active tab found.");
  return tabs[0];
}

// NOTE: functions passed to chrome.scripting.executeScript (func:) must NOT
// be `export`-prefixed. Function.prototype.toString() keeps the `export`
// keyword on module-level exported functions in some Chrome builds, and the
// injected source is then evaluated as a classic script → "Unexpected token
// 'export'". They're exported via the export{} list at the bottom instead.
async function scrapeInPage(site, options = {}) {
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
      // Request the same explicit field set the picker uses — Octane's
      // default attachment fields aren't guaranteed to include `name`, and
      // without it every file is dropped by the `kept` filter below.
      const fields = "id,name,description,client_lock_stamp,size,exists";
      let attachments = [];
      try {
        const listResponse = await fetch(
          `${apiBase}/attachments?fields=${encodeURIComponent(fields)}&query=${encodeURIComponent(`"${query}"`)}`,
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

  // Runs in the page context, so it must be self-contained (no module imports).
  // Fetches one incident's details entirely through the ServiceNow Table API —
  // no DOM. Returns null when the page can't provide an API context (no sys_id
  // in the URL, a non-ServiceNow frame, an API error, or no record).
  async function sparkIncidentApiPath() {
    const searchMatch = /[?&]sys_id=([^&]+)/.exec(location.search || "");
    const hashMatch = /sys_id=([^&]+)/.exec(location.hash || "");
    const sysId = (searchMatch && searchMatch[1]) || (hashMatch && hashMatch[1]);
    if (!sysId) return null;

    // ServiceNow Table API, authenticated the same way the page itself does:
    // the session cookie plus the page's CSRF token (window.g_ck) sent as
    // X-UserToken. This instance enforces the token on API calls, so it's
    // required even for GETs. Runs in the MAIN world (scrapeTab) so the page
    // global is visible.
    const userToken =
      (typeof window !== "undefined" && window.g_ck) ||
      document.querySelector('meta[name="X-UserToken"]')?.content ||
      document.querySelector('input[name="X-UserToken"]')?.value ||
      "";
    const apiHeaders = { Accept: "application/json" };
    if (userToken) apiHeaders["X-UserToken"] = userToken;

    // Bounded retry for transient failures — a flaky network dropping a
    // fetch shouldn't fail the export.
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
          lastError = new Error(`Spark API ${response.status}`);
          continue;
        }
        return response;
      }
      throw lastError || new Error("Spark API fetch failed");
    }

    // Downloads a file to a data URL over the same session+CSRF. Resolves to
    // null when the fetch fails — a bad file is dropped rather than aborting.
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

    // Strips markup to plain text (mirrors the bulk path's plainText).
    const plainText = (value) => {
      if (!value) return "";
      return new DOMParser()
        .parseFromString(String(value), "text/html")
        .body.textContent.replace(/\s+/g, " ")
        .trim();
    };

    // The description comes back as plain text (escaped for htmlToADF) or rich
    // HTML whose embedded images follow captureEmbeddedImages on their own —
    // inline content, independent of the attachments checkbox.
    async function captureDescription(raw) {
      const images = [];
      const source = String(raw || "");
      if (!/<[a-zA-Z][^>]*>/.test(source)) {
        const escaped = source.replace(/[&<>"']/g, (c) => ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c]);
        return { html: escaped, images };
      }
      const doc = new DOMParser().parseFromString(source, "text/html");
      if (captureEmbeddedImages) {
        let next = 0;
        for (const imgEl of Array.from(doc.querySelectorAll("img"))) {
          if (!imgEl.src) {
            imgEl.remove();
            continue;
          }
          const placeholder = `__JIRA_IMG_${next++}__`;
          const dataUrl = await sparkFetchToDataUrl(
            new URL(imgEl.src, location.href).href,
          );
          if (dataUrl) {
            images.push({ placeholder, dataUrl });
            imgEl.replaceWith(doc.createTextNode(placeholder));
          } else {
            imgEl.remove();
          }
        }
      }
      return { html: doc.body ? doc.body.innerHTML : "", images };
    }

    const recordResponse = await fetchWithRetry(
      `${location.origin}/api/now/table/incident/${encodeURIComponent(sysId)}?sysparm_fields=number,short_description,description&sysparm_display_value=false`,
      { credentials: "include", headers: apiHeaders },
    );
    if (!recordResponse.ok) {
      console.error(
        `[jira-ext] Spark incident API ${recordResponse.status} for ${sysId}`,
        location.href,
      );
      return null;
    }
    const json = await recordResponse.json().catch(() => null);
    const record = Array.isArray(json?.result) ? json.result[0] : json?.result;
    if (!record) return null;

    const number = String(record.number || "").trim();
    const shortDescription = plainText(record.short_description);
    if (!shortDescription && !number) return null;

    const { html, images } = await captureDescription(record.description);
    const jiraTitle = ["SPARK", number, shortDescription]
      .filter(Boolean)
      .join(" | ");

    // The incident's sys_attachment rows (what the details page shows under
    // the attachment section), listed through the Table API and downloaded as
    // data URLs. includeAttachments is the master switch; the picker's
    // selection narrows the files; captureAttachments === false is the cheap
    // metadata pass (names only, no bytes).
    if (includeAttachments) {
      const attResponse = await fetchWithRetry(
        `${location.origin}/api/now/table/sys_attachment?sysparm_query=table_sys_id=${encodeURIComponent(sysId)}&sysparm_fields=sys_id,file_name,content_type&sysparm_display_value=false&sysparm_limit=1000`,
        { credentials: "include", headers: apiHeaders },
      );
      let rows = [];
      if (attResponse.ok) {
        const attJson = await attResponse.json().catch(() => null);
        rows = Array.isArray(attJson?.result) ? attJson.result : [];
      }
      const selected = selectedAttachments
        ? new Set(selectedAttachments)
        : null;
      let next = images.length;
      for (const att of rows) {
        if (!att?.sys_id || !att?.file_name) continue;
        const name = String(att.file_name).trim();
        if (!name || (selected && !selected.has(name))) continue;
        if (captureAttachments === false) {
          // Metadata pass — names only, no byte downloads.
          images.push({ name });
          continue;
        }
        const dataUrl = await sparkFetchToDataUrl(
          `${location.origin}/api/now/attachment/${encodeURIComponent(att.sys_id)}/file`,
          "*/*",
        );
        if (dataUrl) {
          images.push({
            placeholder: `__JIRA_IMG_${next++}__`,
            dataUrl,
            name,
          });
        }
      }
    }

    return {
      title: jiraTitle,
      id: number,
      source: site.name,
      url: `${location.origin}/nav_to.do?uri=incident.do?sys_id=${encodeURIComponent(sysId)}`,
      html,
      text: plainText(record.description),
      images,
    };
  }

  // DOM fallback for sparkIncidentApiPath — reads the incident form directly
  // when the Table API can't be reached from the page context. Mirrors the
  // old pre-API single-ticket path: the number/short_description inputs, the
  // description textarea (escaped for htmlToADF), and the attachment section's
  // links (name-only in the metadata pass, bytes on capture). Returns null
  // when the form isn't present.
  async function sparkIncidentDomPath() {
    const readText = (selector) => {
      const el = document.querySelector(selector);
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
      return String(raw ?? "").replace(/\s+/g, " ").trim() || null;
    };

    const id = readText(site.idSelector);
    const title = readText(site.titleSelectors);
    if (!id && !title) return null;

    const editor = document.querySelector(site.editorSelector);
    let text = "";
    let html = "";
    if (editor) {
      text = String(editor.value ?? "");
      html = text.replace(/[&<>"']/g, (c) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c]);
    }

    const images = [];
    if (includeAttachments && site.attachmentSelector) {
      const selected = selectedAttachments
        ? new Set(selectedAttachments)
        : null;
      let next = 0;
      for (const container of Array.from(
        document.querySelectorAll(site.attachmentSelector),
      )) {
        const href = container.getAttribute?.("href");
        if (!href) continue;
        const name = (container.textContent || "").trim();
        if (!name || (selected && !selected.has(name))) continue;
        if (captureAttachments === false) {
          images.push({ name });
          continue;
        }
        try {
          let downloadUrl;
          try {
            downloadUrl = new URL(href, location.href).href;
          } catch {
            // Malformed href — drop this file rather than aborting.
            continue;
          }
          const response = await fetch(downloadUrl, {
            credentials: "include",
          });
          const blob = await response.blob();
          const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
          const placeholder = `__JIRA_IMG_${next++}__`;
          images.push({ placeholder, dataUrl, name });
          html += `<p>${placeholder}</p>`;
        } catch {
          // Couldn't fetch this file — drop it rather than aborting.
        }
      }
    }

    return {
      title: [site.name.toUpperCase(), id, title].filter(Boolean).join(" | "),
      id: id || "",
      source: site.name,
      url: location.href,
      html,
      text,
      images,
    };
  }

  // --- Spark (ServiceNow): same-origin Table API path ------------------------
  // Spark's details page is a form, but reading its fields out of the DOM
  // (input[name="incident.number"], input[name="incident.short_description"],
  // textarea[name="incident.description"], .attachment_list_items
  // .content_editable) is brittle: fields can live in frames, and journal
  // entries are collapsed. The sys_journal_field / incident / sys_attachment
  // Table APIs (the same endpoints the details page is driven from) are the
  // primary source. All the id ever provides is the incident's sys_id, pulled
  // from the details URL — the number, short description, description, and
  // attachments all come down over the API. The DOM path below is only the
  // fallback: when the API can't be reached from the page context (401,
  // blocked fetch, non-ServiceNow frame), the form itself is read instead so
  // the flow keeps working.
  if (site.name === "Spark") {
    const viaApi = await sparkIncidentApiPath().catch((err) => {
      console.error("[jira-ext] Spark incident API path failed:", err);
      return null;
    });
    if (viaApi?.title) return viaApi;

    const viaDom = await sparkIncidentDomPath();
    if (viaDom?.title) return viaDom;

    return {
      title: "",
      id: "",
      source: site.name,
      url: location.href,
      html: "",
      text: "",
      images: [],
    };
  }
}

// Runs in the tab's own page context — same constraints as scrapeInPage.
// Lists each attachment's name, download url, type and (when available) size
// WITHOUT fetching the file bytes. This cheap metadata pass feeds the popup's
// attachment picker, so the user picks which files to upload before the slow
// byte-by-byte capture ever runs. Octane lists through the REST API (no DOM);
// Spark lists through the ServiceNow sys_attachment Table API (no DOM either).
async function listTicketAttachmentsInPage(site) {
  try {
  const VIDEO_EXTS = new Set([
    "mp4", "m4v", "mov", "avi", "mkv", "webm", "wmv", "flv", "mpeg", "mpg",
  ]);
  const IMAGE_EXTS = new Set([
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "tif", "tiff", "ico",
  ]);

  // Formats API-reported byte sizes into the picker's human-readable label.
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

    // The API reports byte sizes, so they flow straight through to the picker
    // (formatFileSize renders the label; sizeBytes feeds the upload cutoff).
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

  // Spark: list the incident's sys_attachment rows directly through the
  // ServiceNow Table API (the same endpoint the details page's attachment
  // section is driven from) — no DOM. The API supplies file_name, content_type,
  // and size_bytes, so name, type, and the byte-accurate size all come straight
  // through (the DOM only shows human-readable labels like "1.2 MB", which the
  // picker can't turn into byte math for the upload cutoff). When the API
  // can't be reached (no sys_id in the URL, a 401/error, or a non-ServiceNow
  // frame), the picker falls back to reading the attachment section's links
  // with their human-readable size labels, so the single-ticket flow still
  // lists files even without an API context.
  if (site.name === "Spark") {
    // DOM fallback: the attachment section's links. Labels only carry
    // human-readable sizes ("1.2 MB"), which feed the upload-cutoff math
    // through attachmentByteSize's label parser.
    const domItems = () => {
      const items = [];
      if (!site.attachmentSelector) return items;
      for (const container of Array.from(
        document.querySelectorAll(site.attachmentSelector),
      )) {
        const href = container.getAttribute?.("href");
        const name = (container.textContent || "").trim();
        if (!href || !name) continue;
        let url;
        try {
          url = new URL(href, location.href).href;
        } catch {
          // Malformed href — skip this file rather than failing the picker.
          continue;
        }
        const ext = (name.split(".").pop() || "").toLowerCase();
        const sizeLabel = (() => {
          const m = /([\d.]+\s*(?:KB|MB|GB))/i.exec(container.textContent || "");
          return m ? m[1] : "";
        })();
        items.push({
          name,
          url,
          type: VIDEO_EXTS.has(ext)
            ? "video"
            : IMAGE_EXTS.has(ext)
              ? "image"
              : "other",
          size: sizeLabel,
          sizeBytes: null,
        });
      }
      return items;
    };

    const searchMatch = /[?&]sys_id=([^&]+)/.exec(location.search || "");
    const hashMatch = /sys_id=([^&]+)/.exec(location.href.split("#")[1] || "");
    const sysId = (searchMatch && searchMatch[1]) || (hashMatch && hashMatch[1]);
    if (!sysId) return domItems();

    const userToken =
      (typeof window !== "undefined" && window.g_ck) ||
      document.querySelector('meta[name="X-UserToken"]')?.content ||
      document.querySelector('input[name="X-UserToken"]')?.value ||
      "";
    const headers = { Accept: "application/json" };
    if (userToken) headers["X-UserToken"] = userToken;

    try {
      const response = await fetch(
        `${location.origin}/api/now/table/sys_attachment?sysparm_query=table_sys_id=${encodeURIComponent(sysId)}&sysparm_fields=sys_id,file_name,content_type,size_bytes&sysparm_display_value=false&sysparm_limit=1000`,
        { credentials: "include", headers },
      );
      if (!response.ok) {
        console.error(
          `[jira-ext] Spark attachments API ${response.status} for ${sysId}`,
          location.href,
        );
        return domItems();
      }
      const json = await response.json();
      const items = [];
      for (const row of Array.isArray(json?.result) ? json.result : []) {
        const name = String(row?.file_name || "").trim();
        if (!name) continue;
        const ext = (name.split(".").pop() || "").toLowerCase();
        const type = VIDEO_EXTS.has(ext)
          ? "video"
          : IMAGE_EXTS.has(ext)
            ? "image"
            : "other";
        const sizeBytes = Number(row?.size_bytes);
        items.push({
          name,
          url: `${location.origin}/api/now/attachment/${encodeURIComponent(String(row.sys_id || ""))}/file`,
          type,
          size: formatFileSize(sizeBytes),
          sizeBytes:
            Number.isFinite(sizeBytes) && sizeBytes >= 0 ? sizeBytes : null,
        });
      }
      // The API answered but reported nothing — trust the rendered markup
      // (e.g. the sys_attachment table is empty for this user but the form
      // still shows files).
      if (items.length) return items;
      return domItems();
    } catch (err) {
      console.error("[jira-ext] Spark attachments API failed:", err);
      return domItems();
    }
  }

  return [];
  } catch (err) {
    console.error("[jira-ext] listTicketAttachmentsInPage failed:", err);
    return [];
  }
}


export async function listTicketAttachmentsInTab(siteName) {
  const site = getSite(siteName);
  if (!site) return [];

  const currentTab = await getCurrentTab();

  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: currentTab.id, allFrames: true },
      func: listTicketAttachmentsInPage,
      args: [site],
      // Spark sizes come from the ServiceNow Table API, which only authenticates
      // when the request is issued from the page's own context (MAIN world) —
      // an isolated-world native fetch gets a 401 Basic challenge and Chrome
      // then shows the Basic-auth dialog, which JS can't suppress. Octane's
      // cookie-only API works fine from the isolated world.
      world: siteName === "Spark" ? "MAIN" : "ISOLATED",
    });
  } catch (err) {
    // Injection refused (restricted frame/URL) — the picker shows empty
    // rather than failing the whole single-ticket flow.
    console.error("[jira-ext] Attachment listing injection failed:", err);
    return [];
  }

  // Prefer the frame that actually found attachments, then any result.
  return (
    results.map((r) => r.result).find((r) => r && r.length > 0) ||
    (results[0] && results[0].result) ||
    []
  );
}

// Lists the attachment files of many selected listing rows at once (metadata
// only — no bytes). Feeds the bulk-import picker so the user can check exactly
// which files to upload across every selected ticket. Returns an array of
// groups — { id, attachments: [{ name, size, sizeBytes, type }] } — one per
// requested id. Runs in the page context, so it must be self-contained.
async function listListingAttachmentsInPage(ids, siteName) {
  const VIDEO_EXTS = new Set([
    "mp4", "m4v", "mov", "avi", "mkv", "webm", "wmv", "flv", "mpeg", "mpg",
  ]);
  const IMAGE_EXTS = new Set([
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "tif", "tiff", "ico",
  ]);
  const idList = Array.isArray(ids) ? ids : [ids];

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

  const typeOf = (name) => {
    const ext = (name.split(".").pop() || "").toLowerCase();
    if (VIDEO_EXTS.has(ext)) return "video";
    if (IMAGE_EXTS.has(ext)) return "image";
    return "other";
  };

  const rowToItem = (name, bytes) => {
    const sizeBytes =
      Number.isFinite(Number(bytes)) && Number(bytes) >= 0 ? Number(bytes) : null;
    return { name, sizeBytes, size: formatFileSize(sizeBytes), type: typeOf(name) };
  };

  // Fetches one ticket's attachment metadata; resolves to its item array.
  // A failed fetch just yields an empty group (the picker then shows the
  // ticket without files rather than failing the whole listing).
  let fetchGroup;

  if (siteName === "Spark") {
    // ServiceNow Table API, authenticated by the page's session cookie plus
    // its CSRF token (X-UserToken) — runs in the MAIN world via the tab
    // wrapper, so window.g_ck is visible and no Basic-auth challenge fires.
    const userToken =
      (typeof window !== "undefined" && window.g_ck) ||
      document.querySelector('meta[name="X-UserToken"]')?.content ||
      document.querySelector('input[name="X-UserToken"]')?.value ||
      "";
    const headers = { Accept: "application/json" };
    if (userToken) headers["X-UserToken"] = userToken;

    fetchGroup = async (id) => {
      const attachments = [];
      try {
        const response = await fetch(
          `${location.origin}/api/now/table/sys_attachment?sysparm_query=table_sys_id=${encodeURIComponent(id)}&sysparm_fields=file_name,size_bytes&sysparm_display_value=false&sysparm_limit=1000`,
          { credentials: "include", headers },
        );
        if (response.ok) {
          const json = await response.json();
          for (const row of Array.isArray(json?.result) ? json.result : []) {
            const name = String(row?.file_name || "").trim();
            if (name) attachments.push(rowToItem(name, row?.size_bytes));
          }
        }
      } catch {
        // leave this ticket's group empty
      }
      return attachments;
    };
  } else {
    // Octane: same REST API the create path uses, cookie-only.
    const contextMatch = /[?&]p=([^&#/]+\/[^&#]+)/.exec(location.search || "");
    if (!contextMatch) return [];
    const [sharedSpace, workspace] = contextMatch[1].split("/");
    if (!sharedSpace || !workspace) return [];
    const apiBase = `${location.origin}/api/shared_spaces/${sharedSpace}/workspaces/${workspace}`;

    fetchGroup = async (id) => {
      const attachments = [];
      const query = `owner_work_item EQ {id EQ ${id}}`;
      const fields = "id,name,size,exists";
      try {
        const response = await fetch(
          `${apiBase}/attachments?fields=${encodeURIComponent(fields)}&query=${encodeURIComponent(`"${query}"`)}`,
          { credentials: "include" },
        );
        if (response.ok) {
          const body = await response.json();
          for (const att of Array.isArray(body?.data) ? body.data : []) {
            if (!att || att.exists === false) continue;
            const name = String(att?.name || "").trim();
            if (name) attachments.push(rowToItem(name, att?.size));
          }
        }
      } catch {
        // leave this ticket's group empty
      }
      return attachments;
    };
  }

  // Fetched in parallel but written back into their original slots so the
  // caller's position-based lookup still matches the requested ids.
  return Promise.all(
    idList.map(async (id) => ({ id, attachments: await fetchGroup(id) })),
  );
}

// Runs the multi-ticket listing above in the current tab. Spark executes in
// the MAIN world (its Table API only authenticates from the page's own
// context — see listTicketAttachmentsInTab); Octane stays isolated.
export async function listListingAttachmentsInTab(ids, siteName) {
  const currentTab = await getCurrentTab();

  const results = await chrome.scripting.executeScript({
    target: { tabId: currentTab.id, allFrames: true },
    func: listListingAttachmentsInPage,
    args: [ids, siteName],
    world: siteName === "Spark" ? "MAIN" : "ISOLATED",
  });

  // Prefer the frame that actually found attachments, then any result.
  const outs = results.map((r) => r.result).filter(Boolean);
  return (
    outs.find((r) => r.some((g) => g.attachments?.length > 0)) ||
    outs.find((r) => r.length > 0) ||
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
  // Spark runs in the MAIN world: its Table API only authenticates when the
  // request is issued from the page's own context (window.g_ck lives there) —
  // an isolated-world native fetch gets a 401 Basic challenge, and Chrome then
  // shows the Basic-auth dialog, which JS can't suppress.
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: scrapeInPage,
      args: [site, options],
      world: siteName === "Spark" ? "MAIN" : "ISOLATED",
    });
  } catch (err) {
    // Injection refused (restricted frame/URL) — treat as "no ticket open"
    // rather than failing the flow.
    console.error("[jira-ext] Scrape injection failed:", err);
    return null;
  }

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
function scrapeSelectedListingInPage() {
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

  // Same URL-only Spark signal as detectInPage — an incident.do URL carrying a
  // sys_id is a details page; no form fields are involved.
  const spark = sites.find((s) => s.name === "Spark");
  if (spark) {
    const searchAndHash = (location.search || "") + (location.hash || "");
    const isIncidentUrl = /incident\.do/.test(
      (location.pathname || "") + searchAndHash,
    );
    if (isIncidentUrl && /[?&]sys_id=[^&#]/.test(searchAndHash)) {
      site = "Spark";
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

  // Count the checked listing rows so the popup can tell a listing with
  // nothing selected from a non-listing tab (both drive the dropzone's clear
  // affordance, but only the former hides it).
  let selectedCount = 0;
  if (listing === "Octane") {
    document.querySelectorAll("div.slick-row").forEach((row) => {
      const checkbox = row.querySelector(
        'div[field-name="isSelected"] input[type="checkbox"]',
      );
      if (checkbox && checkbox.checked) selectedCount++;
    });
  } else if (listing === "Spark") {
    document.querySelectorAll("tr.list_row").forEach((row) => {
      const checkbox = row.querySelector('input[type="checkbox"]');
      if (checkbox && checkbox.checked) selectedCount++;
    });
  }

  return { site, listing, selectedCount };
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
    const found =
      results.map((r) => r.result).find((r) => r && r.listing) || null;
    return {
      site,
      listing: found ? found.listing : null,
      selectedCount: found ? found.selectedCount || 0 : 0,
    };
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
function scrapeSelectedSparkListingInPage() {
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

function fetchListingDetailsInPage(ids, site, options = {}) {
  const idList = Array.isArray(ids) ? ids : [ids];
  const includeAttachments = options.includeAttachments !== false;

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

    // The listing DOM already carries each row's number, short description,
    // and full description (as a tooltip) — no API involved. When the Table
    // API is ACL-blocked (the same restriction that hides journal entries),
    // this is the fallback that keeps the bulk import on the user's page
    // session with no REST call.
    const readRowDom = (sysId) => {
      let row = null;
      document.querySelectorAll("tr.list_row").forEach((r) => {
        if (row) return;
        const rowSysId =
          (r.getAttribute("sys_id") || "").trim() ||
          (r.querySelector('input[type="checkbox"]')?.getAttribute(
            "data-ux-metrics-sysid",
          ) || "").trim() ||
          (r.id || "").replace(/^row_[^_]+_/, "").trim();
        if (rowSysId && rowSysId === sysId) row = r;
      });
      if (!row) return null;

      const checkbox = row.querySelector('input[type="checkbox"]');
      const link = row.querySelector("a.linked.formlink");
      const number = link ? (link.textContent || "").trim() : "";
      const numberCell = link ? link.closest("td") : null;
      const shortDescCell = numberCell
        ? numberCell.nextElementSibling
        : null;
      const descCell = shortDescCell
        ? shortDescCell.nextElementSibling
        : null;
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
      return { row, checkbox, number, shortDescription, description };
    };

    // The description tooltip is plain text; escape it so it can flow
    // through htmlToADF exactly like the API path's plain-text description.
    const escapePlain = (value) =>
      String(value || "").replace(/[&<>"']/g, (c) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c]);

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
    // the details page shows under the attachment section. Only fetched when
    // the bulk picker is enabled; the picker's selection narrows the files
    // (an empty per-ticket selection means upload none, a missing entry is
    // treated as "everything" as a defensive default).
    async function fetchSparkAttachments(incidentSysId) {
      if (!includeAttachments) return [];
      try {
        const response = await fetchWithRetry(
          `${location.origin}/api/now/table/sys_attachment?sysparm_query=table_sys_id=${encodeURIComponent(incidentSysId)}&sysparm_fields=sys_id,file_name,content_type&sysparm_display_value=false&sysparm_limit=1000`,
          { credentials: "include", headers: apiHeaders },
        );
        if (!response.ok) return [];
        const json = await response.json();
        // The selection map is null when the picker was never loaded (include
        // everything as a defensive default); when present, a ticket's entry —
        // even an empty array — is authoritative: upload exactly its checked
        // names, so a ticket with every file over the upload cap uploads none.
        const selectionMap = options.selectedAttachments;
        const selected = selectionMap
          ? new Set(selectionMap[String(incidentSysId)] || [])
          : null;
        return (Array.isArray(json?.result) ? json.result : []).filter(
          (att) =>
            !selected ||
            selected.has(String(att?.file_name || "").trim()),
        );
      } catch {
        return [];
      }
    }

    fetchItem = async (id) => {
      let response;
      try {
        response = await fetchWithRetry(
          `${location.origin}/api/now/table/incident/${encodeURIComponent(id)}?sysparm_fields=number,short_description,description&sysparm_display_value=false`,
          { credentials: "include", headers: apiHeaders },
        );
      } catch (err) {
        response = null;
      }
      if (!response || !response.ok) {
        // API unavailable (ACL-blocked or 401) — fall back to the listing
        // row DOM so the bulk import still works on the page session.
        const dom = readRowDom(String(id));
        if (dom) {
          return {
            id: String(id),
            number: dom.number || "",
            name: dom.shortDescription || dom.number || String(id),
            description: escapePlain(dom.description),
            html: escapePlain(dom.description),
            images: [],
            url: itemUrl(id),
          };
        }
        throw new Error(
          `${apiName} ${response ? response.status : "network"} — row not in listing DOM`,
        );
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

      // The work item's attachment-list files, listed through the API and
      // downloaded as data URLs (only when the bulk picker is enabled; the
      // selection narrows which files). Their placeholders are appended to
      // the html as <p> so they upload as embedded Jira attachments, matching
      // the single-ticket Octane path.
      if (includeAttachments) {
        const query = `owner_work_item EQ {id EQ ${id}}`;
        const fields = "id,name,description,client_lock_stamp,size,exists";
        // Same authoritative-selection semantics as the Spark path: a null
        // map (picker never loaded) includes everything; a ticket's entry —
        // even empty — includes exactly its checked names.
        const selectionMap = options.selectedAttachments;
        const selected = selectionMap
          ? new Set(selectionMap[String(id)] || [])
          : null;
        let attachments = [];
        try {
          const listResponse = await fetchWithRetry(
            `${apiBase}/attachments?fields=${encodeURIComponent(fields)}&query=${encodeURIComponent(`"${query}"`)}`,
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
            (!selected || selected.has(String(att.name))),
        );
        let attImageIndex = images.length;
        let attIndex = 0;
        const worker = async () => {
          while (attIndex < kept.length) {
            const att = kept[attIndex++];
            const placeholder = `__JIRA_IMG_${attImageIndex++}__`;
            try {
              const blobResponse = await fetchWithRetry(
                `${apiBase}/attachments/${encodeURIComponent(att.id)}`,
                { credentials: "include" },
              );
              const blob = await blobResponse.blob();
              const dataUrl = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = reject;
                reader.readAsDataURL(blob);
              });
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
export async function fetchListingDetailsInTab(ids, site, options = {}) {
  const currentTab = await getCurrentTab();

  // Scan every frame and keep the one that answered for real: the shell frame
  // (wrong origin) yields items that all carry errors, so a result with at
  // least one healthy item is preferred, then any result with items, then the
  // first frame as a last resort.
  const results = await chrome.scripting.executeScript({
    target: { tabId: currentTab.id, allFrames: true },
    func: fetchListingDetailsInPage,
    args: [ids, site, options],
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

// Runs in the page context: fetches a Spark incident's journal entries (public
// comments + internal work notes) through the ServiceNow Table API — no DOM
// scraping. Journal entries are notoriously collapsed in the details DOM, so
// sys_journal_field (the same endpoint the details page is driven from) is the
// only reliable source. `ids` are the incidents' sys_ids; returns one group per
// id, [{ id, comments: [{ kind, author, createdAt, text }] }], with comments
// ordered oldest-first. A failed fetch yields an empty list for that incident
// rather than failing the caller.
async function fetchSparkCommentsInPage(ids) {
  const idList = Array.isArray(ids) ? ids : [ids];

  const userToken =
    (typeof window !== "undefined" && window.g_ck) ||
    document.querySelector('meta[name="X-UserToken"]')?.content ||
    document.querySelector('input[name="X-UserToken"]')?.value ||
    "";
  const headers = { Accept: "application/json" };
  if (userToken) headers["X-UserToken"] = userToken;

  // Splits the incident record's journal field value (delimited text of the
  // form "{date} - {author} ({label})\n{text}\n\n{next entry}...") into
  // individual { createdAt, author, text } entries. Continuation paragraphs
  // that don't start with a header get folded into the previous entry.
  const parseJournalText = (raw) => {
    const entries = [];
    const withLabel = /^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s+-\s+(.+?)\s+\(([^)]+)\)\s*$/;
    const withoutLabel = /^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s+-\s+(.+)$/;
    let current = null;
    for (const part of String(raw || "").split(/\n\n+/)) {
      const firstLine = part.split(/\r?\n/)[0];
      const m = withLabel.exec(firstLine) || withoutLabel.exec(firstLine);
      if (m) {
        if (current) entries.push(current);
        current = {
          createdAt: m[1].trim(),
          author: m[2].trim(),
          label: m[3]?.trim() || "",
          text: part.slice(firstLine.length).trim(),
        };
      } else if (current) {
        current.text = `${current.text}\n\n${part.trim()}`.trim();
      }
    }
    if (current) entries.push(current);
    return entries;
  };

  const fetchIncident = async (id) => {
    // Method 1: structured journal rows, one per entry.
    let entries = [];
    let journalNote = "";
    try {
      const response = await fetch(
        `${location.origin}/api/now/table/sys_journal_field?sysparm_query=element_id=${encodeURIComponent(id)}^ORDERBYsys_created_on&sysparm_fields=element,value,sys_created_by,sys_created_on&sysparm_display_value=true&sysparm_limit=1000`,
        { credentials: "include", headers },
      );
      if (response.ok) {
        const json = await response.json();
        const rows = Array.isArray(json?.result) ? json.result : [];
        const seenElements = new Set();
        for (const row of rows) {
          const rawElement = String(row?.element || "").trim();
          if (!rawElement) continue;
          seenElements.add(rawElement);
          const isPublic =
            rawElement === "comments" || rawElement === "additional_comments";
          const author = String(row?.sys_created_by || "").trim();
          const text = String(row?.value || "").trim();
          if (!text && !author) continue;
          entries.push({
            kind: isPublic ? "comments" : "work_notes",
            author,
            createdAt: String(row?.sys_created_on || "").trim(),
            text,
          });
        }
        journalNote = `journal_field=${entries.length} (${Array.from(seenElements).join(", ") || "no elements"})`;
      } else {
        journalNote = `journal_field HTTP ${response.status}`;
      }
    } catch (err) {
      journalNote = `journal_field threw (${String(err?.message || err).slice(0, 60)})`;
    }

    // Method 1b (GlideRecord): the REST Table API is ACL-blocked, but
    // client-side GlideRecord wraps GlideAjax and runs server-side with
    // elevated privileges — the same path the ServiceNow UI uses to render
    // the activity stream.
    if (!entries.length && typeof GlideRecord !== "undefined") {
      let grNote = "";
      try {
        await new Promise((resolve) => {
          const gr = new GlideRecord("sys_journal_field");
          gr.addQuery("element_id", id);
          gr.orderBy("sys_created_on");
          gr.setLimit(1000);
          console.log(
            `[jira-ext] glide_record: query element_id=${id}, hasQuery=${typeof gr.addQuery}, hasQueryFn=${typeof gr.query}, hasNext=${typeof gr.next}, hasGetVal=${typeof gr.getValue}`,
          );
          gr.query(function () {
            let count = 0;
            const seenElements = new Set();
            while (gr.next()) {
              count++;
              const rawElement = String(gr.getValue("element") || "").trim();
              if (!rawElement) continue;
              seenElements.add(rawElement);
              const isPublic =
                rawElement === "comments" ||
                rawElement === "additional_comments";
              const author = String(
                gr.getValue("sys_created_by") || "",
              ).trim();
              const text = String(gr.getValue("value") || "").trim();
              if (!text && !author) continue;
              entries.push({
                kind: isPublic ? "comments" : "work_notes",
                author,
                createdAt: String(
                  gr.getValue("sys_created_on") || "",
                ).trim(),
                text,
              });
            }
            console.log(
              `[jira-ext] glide_record: callback done, cursorHits=${count}, entries=${entries.length}, elements=[${Array.from(seenElements).join(", ")}]`,
            );
            grNote = `glide_record=${entries.length} (${Array.from(seenElements).join(", ") || "no elements"})`;
            resolve();
          });
        });
      } catch (err) {
        grNote = `glide_record threw (${String(err?.message || err).slice(0, 60)})`;
      }
      journalNote += `, ${grNote}`;
    }

    // Method 2 (fallback): the incident record's own journal fields carry the
    // full history as delimited text when sysparm_display_value=true
    // (ServiceNow KB0860915) — usable even where sys_journal_field is empty
    // for the session.
    let recordNote = "";
    if (!entries.length) {
      try {
        const response = await fetch(
          `${location.origin}/api/now/table/incident/${encodeURIComponent(id)}?sysparm_fields=comments,additional_comments,work_notes&sysparm_display_value=true`,
          { credentials: "include", headers },
        );
        if (response.ok) {
          const json = await response.json();
          const rec = json?.result;
          const seen = new Set();
          const fields = [
            "comments",
            "additional_comments",
            "work_notes",
            "comments_and_work_notes",
          ];
          for (const field of fields) {
            for (const entry of parseJournalText(rec?.[field])) {
              // For the combined field the kind comes from the "(Work notes)"
              // label; for the individual fields the field name decides.
              const isWork =
                field === "work_notes" ||
                (field === "comments_and_work_notes" &&
                  /work\s*notes?/i.test(entry.label || ""));
              const kind = isWork ? "work_notes" : "comments";
              const key = `${kind}|${entry.createdAt}|${entry.author}|${entry.text}`;
              if (seen.has(key)) continue;
              seen.add(key);
              entries.push({ kind, ...entry });
            }
          }
          entries.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
        } else {
          recordNote = `record HTTP ${response.status}`;
        }
      } catch (err) {
        recordNote = `record threw (${String(err?.message || err).slice(0, 60)})`;
      }
    }

    // Method 3 (DOM fallback): both API paths empty — journal entries are
    // visible in the ServiceNow UI but ACL-blocked over the REST API. This
    // function runs inside every frame (allFrames: true), so whichever frame
    // contains the incident form's Updates tab gets its entries scraped.
    if (!entries.length) {
      try {
        // Only journal entries (Work notes / Additional comments) carry
        // data-journal-id; emails, field changes, and image uploads don't.
        for (const li of document.querySelectorAll("li[data-journal-id]")) {
          const author =
            li.querySelector(".sn-card-component-createdby")?.textContent
              ?.trim() || "";
          const typeLabel =
            li.querySelector(".sn-card-component-time > span:first-child")
              ?.textContent?.trim() || "";
          const dateStr =
            li.querySelector(".date-calendar")?.textContent?.trim() || "";
          const text =
            li.querySelector(".sn-widget-textblock-body")?.textContent?.trim() ||
            "";
          if (!dateStr || !author) continue;
          if (
            !/work\s*notes?/i.test(typeLabel) &&
            !/additional\s*comments?/i.test(typeLabel)
          )
            continue;
          entries.push({
            kind: /work\s*notes?/i.test(typeLabel) ? "work_notes" : "comments",
            author,
            createdAt: dateStr,
            text,
          });
        }
        if (entries.length) {
          console.log(
            `[jira-ext] spark journal ${id}: DOM scrape found ${entries.length} journal entries`,
          );
        }
      } catch (err) {
        console.log(`[jira-ext] spark journal ${id} DOM scrape threw:`, err);
      }
    }

    // Method 4 (detail-page fetch): a listing page never renders the activity
    // stream — `li[data-journal-id]` only exists once the incident's own form
    // page is open. But that form HTML is reachable over the same session+CSRF
    // (no Table API, so no ACL restriction), so fetch it and parse the stream
    // out of the response instead of scraping the listing DOM.
    if (!entries.length) {
      let pageNote = "";
      try {
        const response = await fetch(
          `${location.origin}/incident.do?sys_id=${encodeURIComponent(id)}`,
          { credentials: "include", headers },
        );
        if (response.ok) {
          const html = await response.text();
          const doc = new DOMParser().parseFromString(html, "text/html");
          for (const li of doc.querySelectorAll("li[data-journal-id]")) {
            const author =
              li.querySelector(".sn-card-component-createdby")?.textContent
                ?.trim() || "";
            const typeLabel =
              li.querySelector(".sn-card-component-time > span:first-child")
                ?.textContent?.trim() || "";
            const dateStr =
              li.querySelector(".date-calendar")?.textContent?.trim() || "";
            const text =
              li.querySelector(".sn-widget-textblock-body")?.textContent
                ?.trim() || "";
            if (!dateStr || !author) continue;
            if (
              !/work\s*notes?/i.test(typeLabel) &&
              !/additional\s*comments?/i.test(typeLabel)
            )
              continue;
            entries.push({
              kind: /work\s*notes?/i.test(typeLabel)
                ? "work_notes"
                : "comments",
              author,
              createdAt: dateStr,
              text,
            });
          }
          pageNote = `page fetch=${entries.length} entries`;
        } else {
          pageNote = `page fetch HTTP ${response.status}`;
        }
      } catch (err) {
        pageNote = `page fetch threw (${String(err?.message || err).slice(0, 60)})`;
      }
      if (pageNote) {
        console.log(`[jira-ext] spark journal ${id}: ${pageNote}`);
      }
    }

    // Sort chronologically (oldest first) so Jira's comment list reads as a
    // history — comment #1 is the oldest journal entry. The ServiceNow DOM
    // lists newest-first, so without this sort Jira shows the newest entry
    // at the top. Handles the DOM's European DD/MM/YYYY dates and the API's
    // YYYY-MM-DD timestamps alike.
    const parseDate = (value) => {
      const m = /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/.exec(
        String(value || "").trim(),
      );
      if (m) return new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +m[6]);
      const t = Date.parse(String(value || "").replace(/\s/g, "T"));
      return Number.isFinite(t) ? new Date(t) : new Date(0);
    };
    entries.sort((a, b) => parseDate(a.createdAt) - parseDate(b.createdAt));

    console.log(
      `[jira-ext] spark journal ${id}: ${entries.length} entries — ${journalNote}${recordNote ? `, ${recordNote}` : ""}`,
    );
    return entries;
  };

  // Fetched in parallel but written back into their original slots so the
  // caller's position-based lookup still matches the requested ids.
  const groups = new Array(idList.length);
  let next = 0;
  const worker = async () => {
    while (next < idList.length) {
      const index = next++;
      groups[index] = {
        id: String(idList[index]),
        comments: await fetchIncident(idList[index]),
      };
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(4, idList.length) }, worker),
  );
  return groups;
}

// Runs fetchSparkCommentsInPage in the current tab. Spark's Table API only
// authenticates from the page's own context (MAIN world) — the CSRF token
// (window.g_ck) lives there, and an isolated-world fetch would fire the
// Basic-auth challenge. Prefers the frame that actually returned comments.
export async function fetchSparkCommentsInTab(ids) {
  const currentTab = await getCurrentTab();
  const idList = Array.isArray(ids) ? ids : [ids];

  const results = await chrome.scripting.executeScript({
    target: { tabId: currentTab.id, allFrames: true },
    func: fetchSparkCommentsInPage,
    args: [idList],
    world: "MAIN",
  });

  const outs = results.map((r) => r.result).filter(Boolean);
  const countComments = (groups) =>
    groups.reduce(
      (sum, g) => sum + (Array.isArray(g?.comments) ? g.comments.length : 0),
      0,
    );
  const best =
    outs
      .filter((g) => Array.isArray(g) && g.length > 0)
      .sort((a, b) => countComments(b) - countComments(a))[0] || [];
  console.log(
    `[jira-ext] fetchSparkCommentsInTab: ${outs.length} frames returned data, picked one with ${countComments(best)} comments`,
  );
  return best;
}

export {
  getPageData,
  detectSiteInTab,
  scrapeInPage,
  listTicketAttachmentsInPage,
  listListingAttachmentsInPage,
  scrapeSelectedListingInPage,
  scrapeSelectedSparkListingInPage,
  fetchListingDetailsInPage,
  fetchSparkCommentsInPage,
};
