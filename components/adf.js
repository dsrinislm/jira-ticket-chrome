

function textToADF(text) {
  const normalized = String(text ?? "")
    .replace(/\r\n/g, "\n")
    .trim();
  if (!normalized)
    return {
      version: 1,
      type: "doc",
      content: [{ type: "paragraph", content: [] }],
    };

  const blocks = normalized.split(/\n{2,}/);
  const content = blocks.map((block) => {
    const lines = block.split("\n");
    const inline = [];
    lines.forEach((line, i) => {
      if (i > 0) inline.push({ type: "hardBreak" });
      if (line.length) inline.push({ type: "text", text: line });
    });
    return { type: "paragraph", content: inline };
  });

  return { version: 1, type: "doc", content };
}

export function sourceUrlBlock(url) {
  return [
    {
      type: "heading",
      attrs: { level: 3 },
      content: [{ type: "text", text: "SOURCE TICKET URL" }],
    },
    {
      type: "paragraph",
      content: [
        {
          type: "text",
          text: url,
          marks: [{ type: "link", attrs: { href: url } }],
        },
      ],
    },
    { type: "paragraph", content: [] },
  ];
}

export function buildIssueDescription(sourceUrl, description) {
  const bodyAdf = textToADF(description);
  return {
    version: 1,
    type: "doc",
    content: [...(sourceUrl ? sourceUrlBlock(sourceUrl) : []), ...bodyAdf.content],
  };
}

function nodeText(node) {
  if (!node || typeof node !== "object") return "";
  if (typeof node.text === "string") return node.text;
  if (!Array.isArray(node.content)) return "";
  return node.content.map(nodeText).join("");
}

function findLinkInNode(node, depth = 0) {
  if (!node || typeof node !== "object" || depth > 8) return null;
  if (
    typeof node.text === "string" &&
    Array.isArray(node.marks) &&
    node.marks.some((m) => m?.type === "link")
  ) {
    const href = node.marks.find((m) => m.type === "link")?.attrs?.href;
    if (typeof href === "string" && /^https?:\/\//i.test(href)) return href;
  }
  if (!Array.isArray(node.content)) return null;
  for (const child of node.content) {
    const found = findLinkInNode(child, depth + 1);
    if (found) return found;
  }
  return null;
}

function findSourceUrlInDoc(doc) {
  if (!doc || doc.type !== "doc" || !Array.isArray(doc.content)) return null;
  const content = doc.content;
  for (let i = 0; i < content.length; i++) {
    const node = content[i];
    if (
      node.type === "heading" &&
      /source ticket url/i.test(nodeText(node))
    ) {
      for (let j = i + 1; j < content.length; j++) {
        const next = content[j];
        if (next.type === "heading") break;
        const link = findLinkInNode(next);
        if (link) return link;
      }
      return null;
    }
  }
  for (const node of content) {
    const link = findLinkInNode(node);
    if (link) return link;
  }
  return null;
}

export function extractSourceUrl(descriptionAdf) {
  const url = findSourceUrlInDoc(descriptionAdf);
  if (!url) return null;
  try {
    return new URL(url).href;
  } catch {
    return null;
  }
}

export function dataUrlToBlob(dataUrl) {
  const [header, base64] = dataUrl.split(",");
  const mime =
    /data:(.*?);base64/.exec(header)?.[1] || "application/octet-stream";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export function fileMediaNode(attachment) {
  return {
    type: "mediaSingle",
    attrs: { layout: "center" },
    content: [
      {
        type: "media",
        attrs: { type: "file", id: attachment.id, collection: "" },
      },
    ],
  };
}

export function insertUploadedImages(adfContent, byPlaceholder) {
  return adfContent.flatMap((node) => {
    if (
      node.type === "paragraph" &&
      node.content?.length === 1 &&
      node.content[0].type === "text"
    ) {
      const match = /^__JIRA_IMG_(\d+)__$/.exec(node.content[0].text.trim());
      if (match) {
        const media = byPlaceholder[`__JIRA_IMG_${match[1]}__`];
        return media ? [media] : [];
      }
    }
    if (Array.isArray(node.content)) {
      return [
        { ...node, content: insertUploadedImages(node.content, byPlaceholder) },
      ];
    }
    return [node];
  });
}
