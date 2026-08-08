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

const OCTANE_STORAGE_KEY = "jiraOctaneCommentMap";

async function readOctaneMap() {
  const data = await chrome.storage.local.get(OCTANE_STORAGE_KEY);
  return data[OCTANE_STORAGE_KEY] || {};
}

async function writeOctaneMap(map) {
  await chrome.storage.local.set({ [OCTANE_STORAGE_KEY]: map });
}

export async function getMappedOctaneCommentIds(workItemId) {
  const map = await readOctaneMap();
  const entry = map[String(workItemId)];
  return entry ? new Set(Object.keys(entry)) : new Set();
}

export async function isEntryFromJiraOctane(workItemId, octaneCommentId) {
  if (!workItemId || !octaneCommentId) return false;
  const map = await readOctaneMap();
  const entry = map[String(workItemId)];
  if (!entry) return false;
  return Object.values(entry).includes(String(octaneCommentId));
}

export async function addOctaneCommentMappings(workItemId, pairs) {
  if (!workItemId || !Array.isArray(pairs) || !pairs.length) return;
  const map = await readOctaneMap();
  if (!map[String(workItemId)]) map[String(workItemId)] = {};
  for (const pair of pairs) {
    if (pair?.jiraCommentId && pair?.octaneCommentId) {
      map[String(workItemId)][String(pair.jiraCommentId)] = String(
        pair.octaneCommentId,
      );
    }
  }
  await writeOctaneMap(map);
}
