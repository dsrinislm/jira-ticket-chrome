import { listJiraComments, addJiraComment } from "./api.js";

export function sparkCommentHeader(entry) {
  const kind = entry?.kind === "work_notes" ? "work note" : "comment";
  return `[Spark ${kind}] ${entry.author} · ${entry.createdAt}`;
}

export function sparkCommentBody(entry) {
  const header = sparkCommentHeader(entry);
  return entry.text ? `${header}\n\n${entry.text}` : header;
}

export async function syncSparkComments(jiraOrigin, issueKey, entries) {
  if (!jiraOrigin || !issueKey || !entries?.length) {
    return { added: 0, total: 0 };
  }
  try {
    const existing = await listJiraComments(jiraOrigin, issueKey);
    const known = new Set(
      existing
        .map((body) => String(body || "").split("\n")[0].trim())
        .filter(Boolean),
    );
    let added = 0;
    for (const entry of entries) {
      if (/^\[Jira comment\]/i.test(String(entry.text || "").trim())) {
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
