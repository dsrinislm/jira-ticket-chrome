// jira-adf.js
//
// HTML (.fr-element) -> Atlassian Document Format (ADF) converter
//
// Supported:
// ✅ Paragraphs
// ✅ Headings (h1-h6)
// ✅ Text
// ✅ Bold
// ✅ Italic
// ✅ Underline
// ✅ Strike
// ✅ Links
// ✅ Inline code
// ✅ Code blocks
// ✅ Blockquotes
// ✅ Ordered lists
// ✅ Unordered lists
// ✅ Nested lists
// ✅ Tables
// ✅ Images
// ✅ Horizontal rules
//
// Browser:
//    htmlToADF(document.querySelector(".fr-element").innerHTML)
//
// Node:
//    const { htmlToADF } = require("./jira-adf");

(function () {
  function htmlToADF(html) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");

    return {
      version: 1,
      type: "doc",
      content: parseChildren(doc.body),
    };
  }

  function parseChildren(parent) {
    const result = [];

    Array.from(parent.childNodes).forEach((node) => {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = node.tagName.toLowerCase();

        // Images become top-level mediaSingle blocks
        if (tag === "img") {
          const img = image(node);

          if (img) {
            result.push(img);
          }
          return;
        }
      }

      const parsed = parseNode(node);

      if (!parsed) return;

      if (Array.isArray(parsed)) {
        result.push(...parsed);
      } else {
        result.push(parsed);
      }
    });

    return result;
  }

  function parseNode(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent;

      if (!text.trim()) return null;

      return textNode(text);
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return null;

    const tag = node.tagName.toLowerCase();

    switch (tag) {
      case "p":
        return paragraph(node);

      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6":
        return heading(node);

      case "blockquote":
        return blockquote(node);

      case "pre":
        return codeBlock(node);

      case "ul":
        return bulletList(node);

      case "ol":
        return orderedList(node);

      case "table":
        return table(node);

      case "hr":
        return {
          type: "rule",
        };

      case "img":
        return [];

      case "br":
        return textNode("\n");

      default:
        return paragraph(node);
    }
  }

  function paragraph(node) {
    const inline = [];
    const blocks = [];

    Array.from(node.childNodes).forEach((child) => {
      if (
        child.nodeType === Node.ELEMENT_NODE &&
        child.tagName.toLowerCase() === "img"
      ) {
        const img = image(child);
        if (img) blocks.push(img);
        return;
      }

      inline.push(...parseInlineNode(child));
    });

    const result = [];

    if (inline.length) {
      result.push({
        type: "paragraph",
        content: inline,
      });
    }

    result.push(...blocks);

    return result;
  }

  function heading(node) {
    return {
      type: "heading",
      attrs: {
        level: Number(node.tagName.substring(1)),
      },
      content: parseInline(node),
    };
  }

  function blockquote(node) {
    return {
      type: "blockquote",
      content: parseChildren(node),
    };
  }

  function codeBlock(node) {
    return {
      type: "codeBlock",
      attrs: {},
      content: [
        {
          type: "text",
          text: node.textContent,
        },
      ],
    };
  }

  function bulletList(node) {
    return {
      type: "bulletList",
      content: parseListItems(node),
    };
  }

  function orderedList(node) {
    return {
      type: "orderedList",
      attrs: {
        order: Number(node.getAttribute("start") || 1),
      },
      content: parseListItems(node),
    };
  }

  function parseListItems(list) {
    const items = [];

    Array.from(list.children).forEach((li) => {
      if (li.tagName.toLowerCase() !== "li") return;

      const content = [];

      const paragraphContent = [];

      Array.from(li.childNodes).forEach((child) => {
        if (
          child.nodeType === Node.ELEMENT_NODE &&
          ["ul", "ol"].includes(child.tagName.toLowerCase())
        ) {
          if (paragraphContent.length) {
            content.push({
              type: "paragraph",
              content: paragraphContent.splice(0),
            });
          }

          content.push(parseNode(child));
        } else {
          paragraphContent.push(...parseInlineNode(child));
        }
      });

      if (paragraphContent.length) {
        content.push({
          type: "paragraph",
          content: paragraphContent,
        });
      }

      items.push({
        type: "listItem",
        content,
      });
    });

    return items;
  }

  function table(node) {
    return {
      type: "table",
      attrs: {
        isNumberColumnEnabled: false,
        layout: "default",
      },
      content: Array.from(node.rows).map((row) => ({
        type: "tableRow",
        content: Array.from(row.cells).map((cell) => ({
          type:
            cell.tagName.toLowerCase() === "th" ? "tableHeader" : "tableCell",
          attrs: {},
          content: [
            {
              type: "paragraph",
              content: parseInline(cell),
            },
          ],
        })),
      })),
    };
  }

  // Building a mediaSingle node can throw (e.g. `new URL()` on a relative
  // or data: src) — that used to bubble all the way up and abort the
  // entire conversion over one bad image. Now it just drops that image
  // and the rest of the document still comes through.
  function image(node) {
    let url;
    try {
      url = new URL(node.src);
    } catch {
      return null;
    }

    if (url.protocol !== "https:") return null;

    return {
      type: "mediaSingle",
      attrs: {
        layout: "center",
      },
      content: [
        {
          type: "media",
          attrs: {
            type: "external",
            url: url.href,
          },
        },
      ],
    };
  }

  function parseInline(parent) {
    const result = [];

    Array.from(parent.childNodes).forEach((child) => {
      // block image -> handled by parseChildren()
      if (
        child.nodeType === Node.ELEMENT_NODE &&
        child.tagName.toLowerCase() === "img"
      ) {
        return;
      }

      result.push(...parseInlineNode(child));
    });

    return result.filter(
      (n) => !(n.type === "text" && (!n.text || /^\s*$/.test(n.text))),
    );
  }

  function parseInlineNode(node, marks = []) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (!node.textContent) return [];

      return [
        {
          type: "text",
          text: node.textContent,
          ...(marks.length && { marks }),
        },
      ];
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return [];

    const tag = node.tagName.toLowerCase();

    const newMarks = [...marks];

    switch (tag) {
      case "strong":
      case "b":
        newMarks.push({ type: "strong" });
        break;

      case "em":
      case "i":
        newMarks.push({ type: "em" });
        break;

      case "u":
        newMarks.push({ type: "underline" });
        break;

      case "s":
      case "strike":
      case "del":
        newMarks.push({ type: "strike" });
        break;

      case "code":
        if (node.parentElement?.tagName.toLowerCase() !== "pre") {
          newMarks.push({ type: "code" });
        }
        break;

      case "a":
        newMarks.push({
          type: "link",
          attrs: {
            href: node.href,
          },
        });
        break;

      case "br":
        return [
          {
            type: "text",
            text: "\n",
            ...(marks.length && { marks }),
          },
        ];

      case "img":
        return [];

      default:
        break;
    }

    let output = [];

    Array.from(node.childNodes).forEach((child) => {
      output = output.concat(parseInlineNode(child, newMarks));
    });

    return output;
  }

  function textNode(text) {
    return {
      type: "paragraph",
      content: [
        {
          type: "text",
          text,
        },
      ],
    };
  }

  if (typeof module !== "undefined") {
    module.exports = {
      htmlToADF,
    };
  } else {
    window.htmlToADF = htmlToADF;
  }
})();