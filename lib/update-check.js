import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const CACHE_PATH = join(homedir(), ".agentalk", "version-check.json");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const REMOTE_URL = "https://raw.githubusercontent.com/agent3-666/agentalk/main/package.json";

// Returns { latestVersion, isNewer } if an update is available, else null.
// Reads from cache — never blocks startup.
export function getCachedUpdateInfo(currentVersion) {
  try {
    if (!existsSync(CACHE_PATH)) return null;
    const cache = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
    if (!cache.latestVersion) return null;
    if (isNewer(cache.latestVersion, currentVersion)) {
      return { latestVersion: cache.latestVersion };
    }
  } catch {}
  return null;
}

// Fire-and-forget background check. Writes result to cache for next startup.
export function checkForUpdatesInBackground(currentVersion) {
  // Skip if cache is still fresh
  try {
    if (existsSync(CACHE_PATH)) {
      const cache = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
      if (cache.checkedAt && Date.now() - cache.checkedAt < CACHE_TTL_MS) return;
    }
  } catch {}

  // Async fetch — intentionally not awaited
  fetch(REMOTE_URL, { signal: AbortSignal.timeout(5000) })
    .then(r => r.json())
    .then(pkg => {
      if (pkg?.version) {
        writeFileSync(CACHE_PATH, JSON.stringify({ latestVersion: pkg.version, checkedAt: Date.now() }));
      }
    })
    .catch(() => {}); // silently ignore network errors
}

// Simple semver comparison: returns true if candidate > current
function isNewer(candidate, current) {
  const parse = v => (v || "").replace(/^v/, "").split(".").map(Number);
  const [caMaj, caMin, caPat] = parse(candidate);
  const [cuMaj, cuMin, cuPat] = parse(current);
  if (caMaj !== cuMaj) return caMaj > cuMaj;
  if (caMin !== cuMin) return caMin > cuMin;
  return caPat > cuPat;
}
