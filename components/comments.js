import { listJiraComments, addJiraComment } from "./api.js";

// The exact first line of each synced Spark comment — the dedup fingerprint.
// Re-runs list the issue's existing comments and skip any entry whose header
// already appears, so a sync never creates a duplicate.
export function sparkCommentHeader(entry) {
  const kind = entry?.kind === "work_notes" ? "work note" : "comment";
  return `[Spark ${kind}] ${entry.author} · ${entry.createdAt}`;
}

export function sparkCommentBody(entry) {
  const header = sparkCommentHeader(entry);
  return entry.text ? `${header}\n\n${entry.text}` : header;
}

// Posts each Spark journal entry as its OWN Jira comment — never merged into
// one. `entries` are the { kind, author, createdAt, text } items from
// fetchSparkCommentsInPage; comments already present on the issue (matched by
// header line) are skipped so re-runs stay idempotent. Never throws — returns
// { added, total } so callers can surface "N comment(s) synced".
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
      const header = sparkCommentHeader(entry);
      if (known.has(header)) continue;
      await addJiraComment(jiraOrigin, issueKey, sparkCommentBody(entry));
      known.add(header);
      added++;
    }
    return { added, total: entries.length };
  } catch (err) {
    console.error("Comment sync failed:", err);
    return { added: 0, total: entries.length };
  }
}
