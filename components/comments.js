import { listJiraComments, addJiraComment } from "./api.js";
import {
  isEntryFromJira,
  isEntryFromJiraOctane,
} from "./comment-map.js";

export function sparkCommentHeader(entry) {
  const kind = entry?.kind === "work_notes" ? "work note" : "comment";
  return `[Spark ${kind}] ${entry.author} · ${entry.createdAt}`;
}

export function sparkCommentBody(entry) {
  const header = sparkCommentHeader(entry);
  return entry.text ? `${header}\n\n${entry.text}` : header;
}

export async function syncSparkComments(
  jiraOrigin,
  issueKey,
  entries,
  sparkSysId,
  existingBodies,
) {
  if (!jiraOrigin || !issueKey || !entries?.length) {
    return { added: 0, total: 0 };
  }
  try {
    const existing =
      existingBodies || (await listJiraComments(jiraOrigin, issueKey));
    const known = new Set(
      existing
        .map((body) => String(body || "").split("\n")[0].trim())
        .filter(Boolean),
    );
    const knownBodies = new Set(
      existing.map((body) => String(body || "").trim()).filter(Boolean),
    );
    let added = 0;
    for (const entry of entries) {
      const text = String(entry.text || "").trim();
      if (/^\[Jira comment\]/i.test(text)) {
        continue;
      }
      if (knownBodies.has(text)) {
        continue;
      }
      if (
        sparkSysId &&
        entry.sysId &&
        (await isEntryFromJira(sparkSysId, entry.sysId))
      ) {
        continue;
      }
      const header = sparkCommentHeader(entry);
      if (known.has(header)) {
        continue;
      }
      await addJiraComment(jiraOrigin, issueKey, sparkCommentBody(entry));
      known.add(header);
      added++;
    }
    return { added, total: entries.length };
  } catch {
    return { added: 0, total: entries.length };
  }
}

export function octaneCommentHeader(entry) {
  const author = entry.author || "Unknown";
  return entry.createdAt
    ? `[Octane comment] ${author} · ${entry.createdAt}`
    : `[Octane comment] ${author}`;
}

export function octaneCommentAdf(entry) {
  const content = [
    {
      type: "paragraph",
      content: [{ type: "text", text: octaneCommentHeader(entry) }],
    },
  ];
  const html = String(entry.html || "").trim();
  if (html && typeof htmlToADF === "function") {
    try {
      const converted = htmlToADF(html);
      if (Array.isArray(converted?.content) && converted.content.length) {
        content.push(...converted.content);
        return { version: 1, type: "doc", content };
      }
    } catch {}
  }
  const text = String(entry.text || "").trim();
  if (text) {
    for (const line of text.split("\n")) {
      content.push({
        type: "paragraph",
        content: line ? [{ type: "text", text: line }] : [],
      });
    }
  }
  return { version: 1, type: "doc", content };
}

export async function syncOctaneComments(
  jiraOrigin,
  issueKey,
  entries,
  workItemId,
  existingBodies,
) {
  if (!jiraOrigin || !issueKey || !entries?.length) {
    return { added: 0, total: 0 };
  }
  try {
    const existing =
      existingBodies || (await listJiraComments(jiraOrigin, issueKey));
    const known = new Set(
      existing
        .map((body) => String(body || "").split("\n")[0].trim())
        .filter(Boolean),
    );
    const knownBodies = new Set(
      existing.map((body) => String(body || "").trim()).filter(Boolean),
    );
    let added = 0;
    for (const entry of entries) {
      const text = String(entry.text || "").trim();
      if (/^\[Jira comment\]/i.test(text)) {
        continue;
      }
      if (knownBodies.has(text)) {
        continue;
      }
      if (
        workItemId &&
        entry.id &&
        (await isEntryFromJiraOctane(workItemId, entry.id))
      ) {
        continue;
      }
      const header = octaneCommentHeader(entry);
      if (known.has(header)) {
        continue;
      }
      await addJiraComment(jiraOrigin, issueKey, octaneCommentAdf(entry));
      known.add(header);
      added++;
    }
    return { added, total: entries.length };
  } catch {
    return { added: 0, total: entries.length };
  }
}

export async function syncSourceComments(
  site,
  jiraOrigin,
  issueKey,
  entries,
  sourceId,
  existingBodies,
) {
  if (site === "Spark") {
    return syncSparkComments(
      jiraOrigin,
      issueKey,
      entries,
      sourceId,
      existingBodies,
    );
  }
  if (site === "Octane") {
    return syncOctaneComments(
      jiraOrigin,
      issueKey,
      entries,
      sourceId,
      existingBodies,
    );
  }
  return { added: 0, total: entries?.length || 0 };
}
