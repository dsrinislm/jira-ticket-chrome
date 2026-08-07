import { listJiraComments, addJiraComment } from "./api.js";
import { isEntryFromJira } from "./comment-map.js";

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
