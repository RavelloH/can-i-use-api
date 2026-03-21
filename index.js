const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const Rlog = require("rlog-js");

const execFileAsync = promisify(execFile);

const REPO_URL = "https://github.com/Fyrd/caniuse.git";
const DEFAULT_HISTORY_DEPTH = 300;
const DEFAULT_HISTORY_SCAN_COMMITS = 220;
const DEFAULT_TRENDING_LIMIT = 50;
const DEFAULT_HOT_LIMIT = 100;
const SOURCE_ROOT = process.env.CANIUSE_REPO_PATH
  ? path.resolve(process.env.CANIUSE_REPO_PATH)
  : path.join(process.cwd(), "cache", "caniuse-full");
const DATA_ROOT = path.join(process.cwd(), "data");
const FEATURE_ROOT = path.join(DATA_ROOT, "feature");
const LOG_ROOT = path.join(process.cwd(), "logs");
const TRENDING_LIMIT = parsePositiveInt(
  process.env.TRENDING_LIMIT,
  DEFAULT_TRENDING_LIMIT
);
const HOT_LIMIT = parsePositiveInt(process.env.HOT_LIMIT, DEFAULT_HOT_LIMIT);
const HISTORY_DEPTH = parsePositiveInt(
  process.env.CANIUSE_HISTORY_DEPTH,
  DEFAULT_HISTORY_DEPTH
);
const HISTORY_SCAN_COMMITS = parsePositiveInt(
  process.env.HISTORY_SCAN_COMMITS,
  DEFAULT_HISTORY_SCAN_COMMITS
);
const HOT_BROWSER_IDS = [
  "chrome",
  "edge",
  "firefox",
  "safari",
  "ios_saf",
  "opera",
  "samsung",
  "and_chr",
  "and_ff",
  "android",
];
const BASE_STATUS_SCORES = {
  y: 4,
  a: 3,
  p: 2,
  n: 0,
  u: 0,
};

fs.mkdirSync(LOG_ROOT, { recursive: true });

const rlog = new Rlog({
  enableColorfulOutput: true,
  logFilePath: path.join(LOG_ROOT, "generate.log"),
  timezone: "Asia/Shanghai",
});

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function round2(value) {
  return Number(Number(value || 0).toFixed(2));
}

function exists(targetPath) {
  try {
    fs.accessSync(targetPath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function ensureDirectory(dirPath) {
  await fsp.mkdir(dirPath, { recursive: true });
}

async function writeJsonFile(filePath, data) {
  await ensureDirectory(path.dirname(filePath));
  await fsp.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

async function runGit(args, options = {}) {
  const { cwd = process.cwd(), allowFailure = false } = options;

  try {
    const result = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 1024 * 1024 * 32,
      windowsHide: true,
    });

    return {
      ok: true,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
    };
  } catch (error) {
    const stdout = String(error.stdout || "").trim();
    const stderr = String(error.stderr || "").trim();

    if (allowFailure) {
      return {
        ok: false,
        stdout,
        stderr,
      };
    }

    const details = stderr || stdout || error.message;
    throw new Error(`git ${args.join(" ")} failed: ${details}`);
  }
}

async function ensureSourceRepo() {
  const gitDir = path.join(SOURCE_ROOT, ".git");

  if (!exists(gitDir)) {
    rlog.info(`Cloning caniuse repository into ${SOURCE_ROOT}`);
    await ensureDirectory(path.dirname(SOURCE_ROOT));
    await runGit(["clone", `--depth=${HISTORY_DEPTH}`, REPO_URL, SOURCE_ROOT]);
    return;
  }

  rlog.info(`Using cached caniuse repository at ${SOURCE_ROOT}`);

  const branchResult = await runGit(
    ["-C", SOURCE_ROOT, "rev-parse", "--abbrev-ref", "HEAD"],
    { allowFailure: true }
  );
  const branch = branchResult.ok && branchResult.stdout ? branchResult.stdout : "main";

  const updateResult = await runGit(
    ["-C", SOURCE_ROOT, "pull", "--ff-only", `--depth=${HISTORY_DEPTH}`, "origin", branch],
    { allowFailure: true }
  );

  if (!updateResult.ok) {
    const reason = updateResult.stderr || updateResult.stdout || "unknown error";
    rlog.warn(`Failed to update caniuse repository, continuing with cached data: ${reason}`);
    return;
  }

  if (updateResult.stdout && !/Already up to date/i.test(updateResult.stdout)) {
    rlog.success("Updated cached caniuse repository");
  }
}

async function getSourceHeadCommit() {
  const result = await runGit(["-C", SOURCE_ROOT, "rev-parse", "HEAD"]);
  return result.stdout;
}

async function loadCurrentDataset() {
  const filePath = path.join(SOURCE_ROOT, "fulldata-json", "data-2.0.json");
  const raw = await fsp.readFile(filePath, "utf8");
  const dataset = JSON.parse(raw);

  if (!dataset || typeof dataset !== "object" || !dataset.data || !dataset.agents) {
    throw new Error("Invalid caniuse fulldata dataset");
  }

  return dataset;
}

function tokenize(input) {
  return String(input || "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildKeywords(id, feature) {
  const values = new Set();

  for (const token of tokenize(id)) {
    values.add(token);
  }

  for (const token of tokenize(feature.title)) {
    values.add(token);
  }

  for (const category of feature.categories || []) {
    values.add(String(category).toLowerCase());
    for (const token of tokenize(category)) {
      values.add(token);
    }
  }

  for (const part of String(feature.keywords || "").split(",")) {
    const keyword = part.trim().toLowerCase();
    if (!keyword) {
      continue;
    }
    values.add(keyword);
    for (const token of tokenize(keyword)) {
      values.add(token);
    }
  }

  return Array.from(values).sort((left, right) => left.localeCompare(right));
}

function parseLogOutput(raw) {
  return raw
    .split("__COMMIT__\n")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((chunk) => {
      const lines = chunk.split(/\r?\n/).filter(Boolean);
      const [sha, parents, date, subject, ...files] = lines;

      return {
        sha,
        parent: parents ? parents.split(" ")[0] : null,
        date,
        subject,
        files,
      };
    });
}

function getBaseSupportScore(value) {
  const code = String(value || "").trim().charAt(0);
  return BASE_STATUS_SCORES[code] ?? 0;
}

function buildCommitUrl(sha) {
  return `https://github.com/Fyrd/caniuse/commit/${sha}`;
}

async function loadFeatureAtCommit(sha, filePath, cache) {
  const cacheKey = `${sha}:${filePath}`;
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey);
  }

  const result = await runGit(["-C", SOURCE_ROOT, "show", `${sha}:${filePath}`]);
  const parsed = JSON.parse(result.stdout);
  cache.set(cacheKey, parsed);
  return parsed;
}

function diffSupportChanges(beforeFeature, afterFeature) {
  const changes = [];
  const browsers = new Set([
    ...Object.keys(beforeFeature.stats || {}),
    ...Object.keys(afterFeature.stats || {}),
  ]);

  for (const browser of browsers) {
    const beforeVersions = beforeFeature.stats?.[browser] || {};
    const afterVersions = afterFeature.stats?.[browser] || {};
    const versions = new Set([
      ...Object.keys(beforeVersions),
      ...Object.keys(afterVersions),
    ]);

    for (const version of versions) {
      const previousValue = beforeVersions[version];
      const nextValue = afterVersions[version];

      if (getBaseSupportScore(nextValue) > getBaseSupportScore(previousValue)) {
        changes.push({
          browser,
          version,
          from: previousValue || null,
          to: nextValue || null,
        });
      }
    }
  }

  return changes;
}

function buildEventSummary(event, featureTitle) {
  if (event.type === "added") {
    if (event.subject === "data update") {
      return `Added ${featureTitle} to the caniuse dataset`;
    }
    return event.subject;
  }

  return event.subject;
}

async function buildLatestEventsByFeature(currentFeatures) {
  const result = await runGit([
    "-C",
    SOURCE_ROOT,
    "log",
    `--format=__COMMIT__%n%H%n%P%n%cI%n%s`,
    "--name-status",
    "-n",
    String(HISTORY_SCAN_COMMITS),
    "--",
    "features-json",
  ]);

  const commits = parseLogOutput(result.stdout);
  const featureEventMap = new Map();
  const fileCache = new Map();

  for (const commit of commits) {
    const featureLines = commit.files.filter((line) =>
      /^([AM])\tfeatures-json\/.+\.json$/.test(line)
    );

    if (featureLines.length === 0) {
      continue;
    }

    const addedCount = featureLines.filter((line) => line.startsWith("A\t")).length;

    for (const line of featureLines) {
      const status = line[0];
      const file = line.slice(2);
      const id = path.basename(file, ".json");

      if (!currentFeatures[id] || featureEventMap.has(id)) {
        continue;
      }

      if (status === "A") {
        if (addedCount > 50) {
          continue;
        }

        featureEventMap.set(id, {
          type: "added",
          date: commit.date,
          subject: commit.subject,
          sha: commit.sha,
          url: buildCommitUrl(commit.sha),
          improved_count: 0,
          changes: [],
        });
        continue;
      }

      if (commit.subject === "data update" || !commit.parent) {
        continue;
      }

      const beforeFeature = await loadFeatureAtCommit(commit.parent, file, fileCache);
      const afterFeature = await loadFeatureAtCommit(commit.sha, file, fileCache);
      const changes = diffSupportChanges(beforeFeature, afterFeature);

      if (changes.length === 0) {
        continue;
      }

      featureEventMap.set(id, {
        type: "support",
        date: commit.date,
        subject: commit.subject,
        sha: commit.sha,
        url: buildCommitUrl(commit.sha),
        improved_count: changes.length,
        changes,
      });
    }
  }

  return featureEventMap;
}

function findFirstVersion(statsByVersion, minimumScore) {
  for (const [version, status] of Object.entries(statsByVersion || {})) {
    if (getBaseSupportScore(status) >= minimumScore) {
      return version;
    }
  }
  return null;
}

function buildBrowserSupport(feature, agents) {
  return Object.entries(agents).map(([browserId, agent]) => {
    const stats = feature.stats?.[browserId] || {};
    const currentVersion = agent.current_version || null;
    const currentStatus =
      currentVersion && Object.prototype.hasOwnProperty.call(stats, currentVersion)
        ? stats[currentVersion]
        : null;
    const currentGlobalUsage =
      currentVersion && agent.usage_global
        ? round2(agent.usage_global[currentVersion] || 0)
        : 0;

    return {
      id: browserId,
      name: agent.long_name || agent.browser || browserId,
      short_name: agent.abbr || agent.browser || browserId,
      browser: agent.browser || browserId,
      type: agent.type || null,
      current_version: currentVersion,
      current_status: currentStatus,
      current_global_usage: currentGlobalUsage,
      first_partial_version: findFirstVersion(stats, 2),
      first_full_version: findFirstVersion(stats, 4),
      stats,
    };
  });
}

function countCurrentSupportedHotBrowsers(feature, agents) {
  let count = 0;

  for (const browserId of HOT_BROWSER_IDS) {
    const agent = agents[browserId];
    if (!agent || !agent.current_version) {
      continue;
    }

    const status = feature.stats?.[browserId]?.[agent.current_version] || null;
    if (getBaseSupportScore(status) >= 2) {
      count += 1;
    }
  }

  return count;
}

function getFreshnessScore(event) {
  if (!event) {
    return 0;
  }

  const ageInDays =
    (Date.now() - new Date(event.date).getTime()) / (1000 * 60 * 60 * 24);
  return round2(Math.max(0, 24 - ageInDays / 15));
}

function getMomentumScore(event) {
  if (!event || !event.improved_count) {
    return 0;
  }

  return round2(Math.min(8, Math.log2(event.improved_count + 1) * 2.5));
}

function buildHotRanking(features, agents, latestEventsByFeature) {
  const hotEntries = Object.entries(features).map(([id, feature]) => {
    const latestEvent = latestEventsByFeature.get(id) || null;
    const fullySupported = round2(feature.usage_perc_y || 0);
    const partiallySupported = round2(feature.usage_perc_a || 0);
    const currentSupportedBrowsers = countCurrentSupportedHotBrowsers(feature, agents);
    const freshnessScore = getFreshnessScore(latestEvent);
    const momentumScore = getMomentumScore(latestEvent);
    const addedScore = latestEvent && latestEvent.type === "added" ? 6 : 0;
    const coverageScore = round2(
      fullySupported * 0.5 + partiallySupported * 0.15
    );
    const breadthScore = round2(currentSupportedBrowsers * 2.5);
    const score = round2(
      coverageScore + breadthScore + freshnessScore + momentumScore + addedScore
    );

    return {
      id,
      title: feature.title,
      score,
      usage: {
        fully_supported: fullySupported,
        partially_supported: partiallySupported,
      },
      latest_event_type: latestEvent ? latestEvent.type : null,
      latest_event_at: latestEvent ? latestEvent.date : null,
      signals: {
        coverage_score: coverageScore,
        breadth_score: breadthScore,
        freshness_score: freshnessScore,
        momentum_score: momentumScore,
        added_score: addedScore,
        current_supported_browsers: currentSupportedBrowsers,
      },
    };
  });

  hotEntries.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    return left.id.localeCompare(right.id);
  });

  return hotEntries.map((entry, index) => ({
    rank: index + 1,
    ...entry,
  }));
}

async function generate() {
  await ensureSourceRepo();

  const sourceCommit = await getSourceHeadCommit();
  const dataset = await loadCurrentDataset();
  const features = dataset.data;
  const agents = dataset.agents;
  const featureIds = Object.keys(features).sort((left, right) =>
    left.localeCompare(right)
  );

  rlog.info(`Loaded ${featureIds.length} caniuse features from ${sourceCommit.slice(0, 12)}`);

  const latestEventsByFeature = await buildLatestEventsByFeature(features);
  rlog.info(`Collected ${latestEventsByFeature.size} recent material feature events`);

  const hotRanking = buildHotRanking(features, agents, latestEventsByFeature);
  const hotById = new Map(hotRanking.map((entry) => [entry.id, entry]));

  const searchIndex = featureIds.map((id) => ({
    id,
    title: features[id].title,
    keywords: buildKeywords(id, features[id]),
  }));

  const trendingEntries = Array.from(latestEventsByFeature.entries())
    .map(([id, event]) => ({
      id,
      title: features[id].title,
      type: event.type,
      date: event.date,
      summary: buildEventSummary(event, features[id].title),
      usage: {
        fully_supported: round2(features[id].usage_perc_y || 0),
        partially_supported: round2(features[id].usage_perc_a || 0),
      },
      commit: {
        sha: event.sha,
        url: event.url,
      },
      improved_count: event.improved_count || 0,
      changes: event.changes.slice(0, 12),
    }))
    .sort((left, right) => new Date(right.date) - new Date(left.date))
    .slice(0, TRENDING_LIMIT);

  await fsp.rm(DATA_ROOT, { recursive: true, force: true });
  await ensureDirectory(FEATURE_ROOT);

  await writeJsonFile(path.join(DATA_ROOT, "index.json"), searchIndex);
  await writeJsonFile(
    path.join(DATA_ROOT, "trending", "index.json"),
    trendingEntries
  );
  await writeJsonFile(
    path.join(DATA_ROOT, "hot", "index.json"),
    hotRanking.slice(0, HOT_LIMIT)
  );

  rlog.info("Writing feature detail APIs");

  for (const [index, id] of featureIds.entries()) {
    const feature = features[id];
    const keywords = buildKeywords(id, feature);
    const latestEvent = latestEventsByFeature.get(id) || null;
    const hotEntry = hotById.get(id) || null;

    const payload = {
      id,
      title: feature.title,
      description: feature.description || "",
      spec: feature.spec || null,
      status: feature.status || null,
      categories: Array.isArray(feature.categories) ? feature.categories : [],
      keywords,
      links: Array.isArray(feature.links) ? feature.links : [],
      notes: feature.notes || "",
      notes_by_num:
        feature.notes_by_num && typeof feature.notes_by_num === "object"
          ? feature.notes_by_num
          : {},
      parent: feature.parent || null,
      chrome_id: feature.chrome_id || null,
      usage: {
        fully_supported: round2(feature.usage_perc_y || 0),
        partially_supported: round2(feature.usage_perc_a || 0),
      },
      latest_event: latestEvent
        ? {
            type: latestEvent.type,
            date: latestEvent.date,
            summary: buildEventSummary(latestEvent, feature.title),
            commit: {
              sha: latestEvent.sha,
              url: latestEvent.url,
            },
            improved_count: latestEvent.improved_count || 0,
            changes: latestEvent.changes.slice(0, 20),
          }
        : null,
      hot: hotEntry
        ? {
            rank: hotEntry.rank,
            score: hotEntry.score,
            signals: hotEntry.signals,
          }
        : null,
      support: {
        browsers: buildBrowserSupport(feature, agents),
      },
      source: {
        repository: REPO_URL,
        commit: sourceCommit,
      },
    };

    await writeJsonFile(path.join(FEATURE_ROOT, id, "index.json"), payload);

    if ((index + 1) % 50 === 0 || index === featureIds.length - 1) {
      rlog.info(`Generated ${index + 1}/${featureIds.length} feature APIs`);
    }
  }

  rlog.success(`Generated APIs in ${DATA_ROOT}`);
}

generate().catch((error) => {
  const message =
    error && error.stack ? error.stack : String(error || "Unknown error");
  rlog.exit(message);
});
