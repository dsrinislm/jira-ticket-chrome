

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
