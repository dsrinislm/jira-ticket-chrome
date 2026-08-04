

const SITES = [
  {
    name: "Octane",

    idSelector: ".entity-form-document-view-header-entity-id-container",
  },
  {
    name: "Spark",

    idSelector: 'input[name="incident.number"]',
    titleSelectors: 'input[name="incident.short_description"]',
    editorSelector: 'textarea[name="incident.description"]',
    attachmentSelector: ".attachment_list_items .content_editable",
  },
];

export function getSite(name) {
  return SITES.find((site) => site.name === name) || null;
}

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

    const results = await chrome.scripting.executeScript({
      target: { tabId: currentTab.id, allFrames: true },
      func: detectInPage,
      args: [SITES],
    });

    return results.map((r) => r.result).find(Boolean) || null;
  } catch {

    return null;
  }
}

export async function getCurrentTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs.length) throw new Error("No active tab found.");
  return tabs[0];
}

async function scrapeInPage(site, options = {}) {
  const includeAttachments = options.includeAttachments !== false;
  const selectedAttachments = options.selectedAttachments || null;

  const captureAttachments = options.captureAttachments !== false;

  const captureEmbeddedImages = options.captureEmbeddedImages !== false;

  const octaneApiPath = async () => {
    const contextMatch = /[?&]p=([^&#/]+\/[^&#]+)/.exec(location.search || "");
    if (!contextMatch) return null;
    const [sharedSpace, workspace] = contextMatch[1].split("/");
    if (!sharedSpace || !workspace) return null;

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

      text = raw;
      html = raw.replace(/[&<>"']/g, (c) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c]);
    } else {

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

    if (includeAttachments) {
      const query = `owner_work_item EQ {id EQ ${itemId}}`;

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

        for (const att of kept) images.push({ name: String(att.name) });
      } else {

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

  async function sparkIncidentApiPath() {
    const searchMatch = /[?&]sys_id=([^&]+)/.exec(location.search || "");
    const hashMatch = /sys_id=([^&]+)/.exec(location.hash || "");
    const sysId = (searchMatch && searchMatch[1]) || (hashMatch && hashMatch[1]);
    if (!sysId) return null;

    const userToken =
      (typeof window !== "undefined" && window.g_ck) ||
      document.querySelector('meta[name="X-UserToken"]')?.content ||
      document.querySelector('input[name="X-UserToken"]')?.value ||
      "";
    const apiHeaders = { Accept: "application/json" };
    if (userToken) apiHeaders["X-UserToken"] = userToken;

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

    const plainText = (value) => {
      if (!value) return "";
      return new DOMParser()
        .parseFromString(String(value), "text/html")
        .body.textContent.replace(/\s+/g, " ")
        .trim();
    };

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

  if (site.name === "Spark") {
    const viaApi = await sparkIncidentApiPath().catch(() => null);
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

async function listTicketAttachmentsInPage(site) {
  try {
  const VIDEO_EXTS = new Set([
    "mp4", "m4v", "mov", "avi", "mkv", "webm", "wmv", "flv", "mpeg", "mpg",
  ]);
  const IMAGE_EXTS = new Set([
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "tif", "tiff", "ico",
  ]);

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

  if (site.name === "Spark") {

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

      if (items.length) return items;
      return domItems();
    } catch {
      return domItems();
    }
  }

  return [];
  } catch {
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

      world: siteName === "Spark" ? "MAIN" : "ISOLATED",
    });
  } catch {

    return [];
  }

  return (
    results.map((r) => r.result).find((r) => r && r.length > 0) ||
    (results[0] && results[0].result) ||
    []
  );
}

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

  let fetchGroup;

  if (siteName === "Spark") {

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

      }
      return attachments;
    };
  } else {

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

      }
      return attachments;
    };
  }

  return Promise.all(
    idList.map(async (id) => ({ id, attachments: await fetchGroup(id) })),
  );
}

export async function listListingAttachmentsInTab(ids, siteName) {
  const currentTab = await getCurrentTab();

  const results = await chrome.scripting.executeScript({
    target: { tabId: currentTab.id, allFrames: true },
    func: listListingAttachmentsInPage,
    args: [ids, siteName],
    world: siteName === "Spark" ? "MAIN" : "ISOLATED",
  });

  const outs = results.map((r) => r.result).filter(Boolean);
  return (
    outs.find((r) => r.some((g) => g.attachments?.length > 0)) ||
    outs.find((r) => r.length > 0) ||
    []
  );
}

export async function scrapeTab(tabId, siteName, options = {}) {
  const site = getSite(siteName);

  if (!site) {
    throw new Error(`Unknown site: ${siteName}`);
  }

  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: scrapeInPage,
      args: [site, options],
      world: siteName === "Spark" ? "MAIN" : "ISOLATED",
    });
  } catch {

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

export function detectListingInPage() {
  if (
    document.querySelector("div.slick-row") &&
    document.querySelector("a.alm-entity-grid-id-column")
  ) {
    return "Octane";
  }

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

function detectTabStateInPage(sites) {
  const matches = (selector) => {
    try {
      return !!document.querySelector(selector);
    } catch {
      return false;
    }
  };

  let site = null;

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

export async function scrapeSelectedSparkListingInTab() {
  const currentTab = await getCurrentTab();

  try {

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

function fetchListingDetailsInPage(ids, site, options = {}) {
  const idList = Array.isArray(ids) ? ids : [ids];
  const includeAttachments = options.includeAttachments !== false;

  async function captureImages(html) {
    if (!html) return { html: "", images: [] };

    const images = [];
    const plain = !/<[a-zA-Z][^>]*>/.test(String(html));
    if (plain) {

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

    if (!document.querySelector("tr.list_row")) {
      return { items: [] };
    }

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

    const escapePlain = (value) =>
      String(value || "").replace(/[&<>"']/g, (c) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c]);

    const userToken =
      (typeof window !== "undefined" && window.g_ck) ||
      document.querySelector('meta[name="X-UserToken"]')?.content ||
      document.querySelector('input[name="X-UserToken"]')?.value ||
      "";

    const apiHeaders = { Accept: "application/json" };
    if (userToken) apiHeaders["X-UserToken"] = userToken;

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

    async function fetchSparkAttachments(incidentSysId) {
      if (!includeAttachments) return [];
      try {
        const response = await fetchWithRetry(
          `${location.origin}/api/now/table/sys_attachment?sysparm_query=table_sys_id=${encodeURIComponent(incidentSysId)}&sysparm_fields=sys_id,file_name,content_type&sysparm_display_value=false&sysparm_limit=1000`,
          { credentials: "include", headers: apiHeaders },
        );
        if (!response.ok) return [];
        const json = await response.json();

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
      } catch {
        response = null;
      }
      if (!response || !response.ok) {

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

      if (includeAttachments) {
        const query = `owner_work_item EQ {id EQ ${id}}`;
        const fields = "id,name,description,client_lock_stamp,size,exists";

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

export async function fetchListingDetailsInTab(ids, site, options = {}) {
  const currentTab = await getCurrentTab();

  const results = await chrome.scripting.executeScript({
    target: { tabId: currentTab.id, allFrames: true },
    func: fetchListingDetailsInPage,
    args: [ids, site, options],

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

async function fetchSparkCommentsInPage(ids) {
  const idList = Array.isArray(ids) ? ids : [ids];

  const userToken =
    (typeof window !== "undefined" && window.g_ck) ||
    document.querySelector('meta[name="X-UserToken"]')?.content ||
    document.querySelector('input[name="X-UserToken"]')?.value ||
    "";
  const headers = { Accept: "application/json" };
  if (userToken) headers["X-UserToken"] = userToken;

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
    const entries = [];
    try {
      const response = await fetch(
        `${location.origin}/api/now/table/sys_journal_field?sysparm_query=element_id=${encodeURIComponent(id)}^ORDERBYsys_created_on&sysparm_fields=element,value,sys_created_by,sys_created_on&sysparm_display_value=true&sysparm_limit=1000`,
        { credentials: "include", headers },
      );
      if (response.ok) {
        const json = await response.json();
        const rows = Array.isArray(json?.result) ? json.result : [];
        for (const row of rows) {
          const rawElement = String(row?.element || "").trim();
          if (!rawElement) continue;
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
      }
    } catch {}

    if (!entries.length && typeof GlideRecord !== "undefined") {
      try {
        await new Promise((resolve) => {
          const gr = new GlideRecord("sys_journal_field");
          gr.addQuery("element_id", id);
          gr.orderBy("sys_created_on");
          gr.setLimit(1000);
          gr.query(function () {
            while (gr.next()) {
              const rawElement = String(gr.getValue("element") || "").trim();
              if (!rawElement) continue;
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
            resolve();
          });
        });
      } catch {}
    }

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
        }
      } catch {}
    }

    if (!entries.length) {
      try {
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
      } catch {}
    }

    if (!entries.length) {
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
        }
      } catch (err) {
        String(err?.message || err);
      }
    }

    const parseDate = (value) => {
      const m = /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/.exec(
        String(value || "").trim(),
      );
      if (m) return new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +m[6]);
      const t = Date.parse(String(value || "").replace(/\s/g, "T"));
      return Number.isFinite(t) ? new Date(t) : new Date(0);
    };
    entries.sort((a, b) => parseDate(a.createdAt) - parseDate(b.createdAt));

    return entries;
  };

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
