import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const GRAPHQL_ENDPOINT = "https://api.github.com/graphql";
const CARD_WIDTH = 860;
const CARD_HEIGHT = 260;
const DAY_IN_MS = 24 * 60 * 60 * 1000;

const PROFILE_QUERY = `
  query ProfileStats($login: String!, $from: DateTime!, $to: DateTime!, $after: String) {
    user(login: $login) {
      contributionsCollection(from: $from, to: $to) {
        contributionCalendar {
          totalContributions
        }
        restrictedContributionsCount
        totalIssueContributions
        totalPullRequestContributions
      }
      repositories(
        first: 100
        after: $after
        privacy: PUBLIC
        ownerAffiliations: OWNER
        orderBy: { field: UPDATED_AT, direction: DESC }
      ) {
        nodes {
          isArchived
          isFork
          isPrivate
          languages(first: 100, orderBy: { field: SIZE, direction: DESC }) {
            edges {
              size
              node {
                color
                name
              }
            }
          }
        }
        pageInfo {
          endCursor
          hasNextPage
        }
      }
    }
  }
`;

const THEMES = {
  light: {
    background: "#ffffff",
    border: "#d0d7de",
    text: "#1f2328",
    secondary: "#59636e",
    track: "#eaeef2",
  },
  dark: {
    background: "#0d1117",
    border: "#30363d",
    text: "#f0f6fc",
    secondary: "#8b949e",
    track: "#21262d",
  },
};

export function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function buildDateRange(now = new Date()) {
  const to = new Date(now);
  if (Number.isNaN(to.getTime())) {
    throw new TypeError("now must be a valid date");
  }

  const from = new Date(to.getTime() - 365 * DAY_IN_MS);
  return { from: from.toISOString(), to: to.toISOString() };
}

function requireNonNegativeNumber(value, field) {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative number`);
  }
  return value;
}

function languageColor(color, fallbackIndex) {
  if (typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color)) {
    return color;
  }

  const fallbacks = ["#3178c6", "#f1e05a", "#3572A5", "#663399", "#8b949e"];
  return fallbacks[fallbackIndex % fallbacks.length];
}

export function summarizeProfileData(data) {
  if (!data || typeof data !== "object") {
    throw new TypeError("profile data must be an object");
  }

  const contributionCalendarTotal = requireNonNegativeNumber(
    data.contributions?.contributionCalendar?.totalContributions,
    "contributionCalendar.totalContributions",
  );
  const restrictedContributions = requireNonNegativeNumber(
    data.contributions?.restrictedContributionsCount,
    "restrictedContributionsCount",
  );
  const pullRequests = requireNonNegativeNumber(
    data.contributions?.totalPullRequestContributions,
    "totalPullRequestContributions",
  );
  const issues = requireNonNegativeNumber(
    data.contributions?.totalIssueContributions,
    "totalIssueContributions",
  );

  if (!Array.isArray(data.repositories)) {
    throw new TypeError("repositories must be an array");
  }

  const repositories = data.repositories.filter(
    (repository) =>
      repository &&
      repository.isArchived === false &&
      repository.isFork === false &&
      repository.isPrivate === false,
  );

  const totals = new Map();
  for (const repository of repositories) {
    const edges = repository.languages?.edges;
    if (!Array.isArray(edges)) {
      continue;
    }

    for (const edge of edges) {
      const name = edge?.node?.name;
      const bytes = edge?.size;
      if (typeof name !== "string" || name.length === 0 || !Number.isFinite(bytes) || bytes <= 0) {
        continue;
      }

      const previous = totals.get(name) ?? { bytes: 0, color: edge.node.color };
      previous.bytes += bytes;
      if (!previous.color && edge.node.color) {
        previous.color = edge.node.color;
      }
      totals.set(name, previous);
    }
  }

  const languages = [...totals.entries()]
    .map(([name, value]) => ({ name, bytes: value.bytes, color: value.color }))
    .sort((left, right) => right.bytes - left.bytes || left.name.localeCompare(right.name));
  const totalLanguageBytes = languages.reduce((sum, language) => sum + language.bytes, 0);
  const topLanguages = languages.slice(0, 4);
  const remainingBytes = languages.slice(4).reduce((sum, language) => sum + language.bytes, 0);
  if (remainingBytes > 0) {
    topLanguages.push({ name: "Other", bytes: remainingBytes, color: "#8b949e" });
  }

  const languagesWithPercentages = topLanguages.map((language, index) => ({
    ...language,
    color: languageColor(language.color, index),
    percentage: totalLanguageBytes === 0 ? 0 : (language.bytes / totalLanguageBytes) * 100,
  }));

  return {
    activeRepositories: repositories.length,
    issues,
    languages: languagesWithPercentages,
    publicContributions: Math.max(0, contributionCalendarTotal - restrictedContributions),
    pullRequests,
  };
}

function formatInteger(value) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function truncate(value, maximumLength) {
  const characters = [...String(value)];
  return characters.length <= maximumLength
    ? characters.join("")
    : `${characters.slice(0, maximumLength - 1).join("")}…`;
}

function renderLanguageBar(languages, themeName, trackColor) {
  const x = 32;
  const y = 176;
  const width = 796;
  const height = 14;
  let offset = 0;

  const segments = languages.map((language, index) => {
    const segmentWidth =
      index === languages.length - 1
        ? Math.max(0, width - offset)
        : Math.max(0, Math.round((language.percentage / 100) * width));
    const segment = `<rect x="${x + offset}" y="${y}" width="${segmentWidth}" height="${height}" fill="${language.color}" />`;
    offset += segmentWidth;
    return segment;
  });

  return `
    <defs>
      <clipPath id="language-bar-${themeName}">
        <rect x="${x}" y="${y}" width="${width}" height="${height}" rx="7" />
      </clipPath>
    </defs>
    <rect x="${x}" y="${y}" width="${width}" height="${height}" rx="7" fill="${trackColor}" />
    <g clip-path="url(#language-bar-${themeName})">${segments.join("")}</g>`;
}

function renderLanguageLegend(languages, secondaryColor) {
  if (languages.length === 0) {
    return `<text x="32" y="224" fill="${secondaryColor}" font-size="13">No public language data</text>`;
  }

  const columnWidth = 796 / languages.length;
  return languages
    .map((language, index) => {
      const x = Number((32 + index * columnWidth).toFixed(1));
      const label = escapeXml(truncate(language.name, 14));
      const percentage = language.percentage.toFixed(1);
      return `
        <circle cx="${x + 5}" cy="220" r="5" fill="${language.color}" />
        <text x="${x + 16}" y="224" fill="${secondaryColor}" font-size="12.5">${label} ${percentage}%</text>`;
    })
    .join("");
}

export function renderCard(stats, { themeName, refreshedAt }) {
  const theme = THEMES[themeName];
  if (!theme) {
    throw new TypeError(`Unknown theme: ${themeName}`);
  }

  const refreshedDate = new Date(refreshedAt);
  if (Number.isNaN(refreshedDate.getTime())) {
    throw new TypeError("refreshedAt must be a valid date");
  }

  const metrics = [
    ["PUBLIC CONTRIBUTIONS", stats.publicContributions],
    ["PULL REQUESTS", stats.pullRequests],
    ["ISSUES", stats.issues],
    ["ACTIVE REPOSITORIES", stats.activeRepositories],
  ];
  const metricMarkup = metrics
    .map(([label, value], index) => {
      const x = 32 + index * 203;
      return `
        <text x="${x}" y="97" fill="${theme.text}" font-size="26" font-weight="600">${formatInteger(value)}</text>
        <text x="${x}" y="119" fill="${theme.secondary}" font-size="11" font-weight="600" letter-spacing="0.6">${label}</text>`;
    })
    .join("");

  const dateLabel = refreshedDate.toISOString().slice(0, 10);
  const languageBar = renderLanguageBar(stats.languages, themeName, theme.track);
  const languageLegend = renderLanguageLegend(stats.languages, theme.secondary);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}" role="img" aria-labelledby="title description">
  <title id="title">Public GitHub activity</title>
  <desc id="description">Public contributions, pull requests, issues, active repositories, and language distribution for the trailing 365 days.</desc>
  <rect x="0.5" y="0.5" width="859" height="259" rx="12" fill="${theme.background}" stroke="${theme.border}" />
  <text x="32" y="42" fill="${theme.text}" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="18" font-weight="600">Public GitHub activity</text>
  <text x="32" y="62" fill="${theme.secondary}" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="12.5">Trailing 365 days · refreshed ${dateLabel} UTC</text>
  <g font-family="-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif">${metricMarkup}
    <text x="32" y="158" fill="${theme.text}" font-size="13" font-weight="600">Languages across active public repositories</text>${languageBar}
    ${languageLegend}
  </g>
</svg>
`;
}

function validateSvg(svg) {
  if (
    typeof svg !== "string" ||
    !svg.startsWith("<svg") ||
    !svg.endsWith("</svg>\n") ||
    !svg.includes(`width="${CARD_WIDTH}"`) ||
    !svg.includes(`height="${CARD_HEIGHT}"`) ||
    svg.includes("NaN") ||
    svg.includes("undefined")
  ) {
    throw new Error("Generated SVG failed validation");
  }
}

async function requestGraphql({ token, variables, fetchImpl }) {
  const response = await fetchImpl(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "lefelps-profile-stats",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({ query: PROFILE_QUERY, variables }),
  });

  if (!response.ok) {
    throw new Error(`GitHub GraphQL request failed with HTTP ${response.status}`);
  }

  const payload = await response.json();
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    const messages = payload.errors.map((error) => error.message).join("; ");
    throw new Error(`GitHub GraphQL returned errors: ${messages}`);
  }

  if (!payload.data?.user) {
    throw new Error("GitHub user was not found or was not visible");
  }

  return payload.data.user;
}

export async function fetchProfileData({ token, user, now = new Date(), fetchImpl = fetch }) {
  if (typeof token !== "string" || token.length === 0) {
    throw new TypeError("GH_TOKEN is required");
  }
  if (typeof user !== "string" || user.length === 0) {
    throw new TypeError("GITHUB_USER must be a non-empty string");
  }

  const range = buildDateRange(now);
  const repositories = [];
  let after = null;
  let contributions;

  do {
    const profile = await requestGraphql({
      token,
      fetchImpl,
      variables: { login: user, from: range.from, to: range.to, after },
    });

    if (!profile.repositories || !Array.isArray(profile.repositories.nodes) || !profile.repositories.pageInfo) {
      throw new TypeError("GitHub returned malformed repository data");
    }

    contributions ??= profile.contributionsCollection;
    repositories.push(...profile.repositories.nodes);

    const { hasNextPage, endCursor } = profile.repositories.pageInfo;
    if (hasNextPage && (typeof endCursor !== "string" || endCursor.length === 0)) {
      throw new TypeError("GitHub returned an invalid repository cursor");
    }
    after = hasNextPage ? endCursor : null;
  } while (after !== null);

  return { contributions, repositories };
}

async function readExistingFile(filePath) {
  try {
    return await readFile(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function restoreFile(filePath, contents) {
  if (contents === null) {
    await rm(filePath, { force: true });
  } else {
    await writeFile(filePath, contents);
  }
}

async function writeSvgPair(outputDir, lightSvg, darkSvg) {
  await mkdir(outputDir, { recursive: true });
  validateSvg(lightSvg);
  validateSvg(darkSvg);

  const suffix = `${process.pid}-${Date.now()}`;
  const files = {
    light: path.join(outputDir, "github-stats-light.svg"),
    dark: path.join(outputDir, "github-stats-dark.svg"),
  };
  const temporaryFiles = {
    light: path.join(outputDir, `.github-stats-light.${suffix}.tmp`),
    dark: path.join(outputDir, `.github-stats-dark.${suffix}.tmp`),
  };
  const previous = {
    light: await readExistingFile(files.light),
    dark: await readExistingFile(files.dark),
  };

  try {
    await Promise.all([
      writeFile(temporaryFiles.light, lightSvg, "utf8"),
      writeFile(temporaryFiles.dark, darkSvg, "utf8"),
    ]);
    await rename(temporaryFiles.light, files.light);
    await rename(temporaryFiles.dark, files.dark);
  } catch (error) {
    await Promise.all([
      restoreFile(files.light, previous.light),
      restoreFile(files.dark, previous.dark),
    ]);
    throw error;
  } finally {
    await Promise.all([
      rm(temporaryFiles.light, { force: true }),
      rm(temporaryFiles.dark, { force: true }),
    ]);
  }
}

export async function generateProfileStats({
  token,
  user = "LeFelps",
  outputDir = "assets",
  now = new Date(),
  fetchImpl = fetch,
}) {
  const profileData = await fetchProfileData({ token, user, now, fetchImpl });
  const stats = summarizeProfileData(profileData);
  const lightSvg = renderCard(stats, { themeName: "light", refreshedAt: now });
  const darkSvg = renderCard(stats, { themeName: "dark", refreshedAt: now });

  await writeSvgPair(outputDir, lightSvg, darkSvg);
  return stats;
}

async function main() {
  const token = process.env.GH_TOKEN;
  const user = process.env.GITHUB_USER || "LeFelps";
  const outputDir = process.env.OUTPUT_DIR || "assets";

  const stats = await generateProfileStats({ token, user, outputDir });
  console.log(
    `Updated public profile statistics for ${user}: ${stats.publicContributions} contributions, ${stats.activeRepositories} active repositories.`,
  );
}

const entryPoint = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (entryPoint === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
