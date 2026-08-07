const STORAGE_KEY = "jiraSparkCommentMap";

async function readMap() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return data[STORAGE_KEY] || {};
}

async function writeMap(map) {
  await chrome.storage.local.set({ [STORAGE_KEY]: map });
}

export async function getMappedJiraCommentIds(sparkSysId) {
  const map = await readMap();
  const entry = map[sparkSysId];
  return entry ? new Set(Object.keys(entry)) : new Set();
}

export async function isEntryFromJira(sparkSysId, sparkEntrySysId) {
  if (!sparkSysId || !sparkEntrySysId) return false;
  const map = await readMap();
  const entry = map[sparkSysId];
  if (!entry) return false;
  return Object.values(entry).includes(String(sparkEntrySysId));
}

export async function addCommentMappings(sparkSysId, pairs) {
  if (!sparkSysId || !Array.isArray(pairs) || !pairs.length) return;
  const map = await readMap();
  if (!map[sparkSysId]) map[sparkSysId] = {};
  for (const pair of pairs) {
    if (pair?.jiraCommentId && pair?.sparkEntrySysId) {
      map[sparkSysId][String(pair.jiraCommentId)] = String(
        pair.sparkEntrySysId,
      );
    }
  }
  await writeMap(map);
}
