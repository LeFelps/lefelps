import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildDateRange,
  escapeXml,
  fetchProfileData,
  generateProfileStats,
  renderCard,
  summarizeProfileData,
} from "../scripts/generate-github-stats.mjs";

const fixture = JSON.parse(
  await readFile(new URL("./fixtures/github-profile-data.json", import.meta.url), "utf8"),
);

test("summarizes public contributions and active public repositories", () => {
  const stats = summarizeProfileData(fixture);

  assert.equal(stats.publicContributions, 100);
  assert.equal(stats.pullRequests, 14);
  assert.equal(stats.issues, 7);
  assert.equal(stats.activeRepositories, 3);
});

test("aggregates the top four languages and groups the remainder", () => {
  const stats = summarizeProfileData(fixture);

  assert.deepEqual(
    stats.languages.map(({ name, bytes }) => [name, bytes]),
    [
      ["C<&", 700],
      ["TypeScript", 600],
      ["JavaScript", 200],
      ["Python", 100],
      ["Other", 75],
    ],
  );
  const percentageTotal = stats.languages.reduce((sum, language) => sum + language.percentage, 0);
  assert.ok(Math.abs(percentageTotal - 100) < 1e-10);
});

test("escapes external strings in generated SVGs", () => {
  const stats = summarizeProfileData(fixture);
  const svg = renderCard(stats, {
    themeName: "light",
    refreshedAt: new Date("2026-07-14T12:00:00.000Z"),
  });

  assert.equal(escapeXml('A<&>"\''), "A&lt;&amp;&gt;&quot;&apos;");
  assert.match(svg, /C&lt;&amp;/);
  assert.doesNotMatch(svg, />C<&/);
});

test("light and dark cards contain equivalent public metrics", () => {
  const stats = summarizeProfileData(fixture);
  const options = { refreshedAt: new Date("2026-07-14T12:00:00.000Z") };
  const light = renderCard(stats, { ...options, themeName: "light" });
  const dark = renderCard(stats, { ...options, themeName: "dark" });

  for (const expected of [">100<", ">14<", ">7<", ">3<", "2026-07-14 UTC"]) {
    assert.ok(light.includes(expected));
    assert.ok(dark.includes(expected));
  }
  assert.notEqual(light, dark);
  assert.match(light, /#ffffff/);
  assert.match(dark, /#0d1117/);
});

test("builds an exact rolling 365-day UTC range", () => {
  const now = new Date("2026-07-14T23:30:00-03:00");
  const range = buildDateRange(now);

  assert.equal(range.to, "2026-07-15T02:30:00.000Z");
  assert.equal(
    Date.parse(range.to) - Date.parse(range.from),
    365 * 24 * 60 * 60 * 1000,
  );
});

test("paginates public repositories", async () => {
  const requests = [];
  const fetchImpl = async (_url, options) => {
    const { variables } = JSON.parse(options.body);
    requests.push(variables);
    const secondPage = variables.after === "next-page";

    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          user: {
            contributionsCollection: fixture.contributions,
            repositories: {
              nodes: [fixture.repositories[secondPage ? 1 : 0]],
              pageInfo: secondPage
                ? { endCursor: null, hasNextPage: false }
                : { endCursor: "next-page", hasNextPage: true },
            },
          },
        },
      }),
    };
  };

  const data = await fetchProfileData({
    token: "test-token",
    user: "LeFelps",
    now: new Date("2026-07-14T12:00:00.000Z"),
    fetchImpl,
  });

  assert.equal(requests.length, 2);
  assert.equal(requests[0].after, null);
  assert.equal(requests[1].after, "next-page");
  assert.equal(data.repositories.length, 2);
});

test("API failure preserves existing SVG assets", async (context) => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "profile-stats-test-"));
  context.after(() => rm(outputDir, { recursive: true, force: true }));

  const lightPath = path.join(outputDir, "github-stats-light.svg");
  const darkPath = path.join(outputDir, "github-stats-dark.svg");
  await writeFile(lightPath, "existing light", "utf8");
  await writeFile(darkPath, "existing dark", "utf8");

  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ errors: [{ message: "simulated failure" }] }),
  });

  await assert.rejects(
    generateProfileStats({
      token: "test-token",
      outputDir,
      now: new Date("2026-07-14T12:00:00.000Z"),
      fetchImpl,
    }),
    /simulated failure/,
  );
  assert.equal(await readFile(lightPath, "utf8"), "existing light");
  assert.equal(await readFile(darkPath, "utf8"), "existing dark");
});

test("malformed data preserves existing SVG assets", async (context) => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "profile-stats-test-"));
  context.after(() => rm(outputDir, { recursive: true, force: true }));

  const lightPath = path.join(outputDir, "github-stats-light.svg");
  const darkPath = path.join(outputDir, "github-stats-dark.svg");
  await writeFile(lightPath, "existing light", "utf8");
  await writeFile(darkPath, "existing dark", "utf8");

  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      data: {
        user: {
          contributionsCollection: { ...fixture.contributions, restrictedContributionsCount: "private" },
          repositories: {
            nodes: [],
            pageInfo: { endCursor: null, hasNextPage: false },
          },
        },
      },
    }),
  });

  await assert.rejects(
    generateProfileStats({
      token: "test-token",
      outputDir,
      now: new Date("2026-07-14T12:00:00.000Z"),
      fetchImpl,
    }),
    /restrictedContributionsCount/,
  );
  assert.equal(await readFile(lightPath, "utf8"), "existing light");
  assert.equal(await readFile(darkPath, "utf8"), "existing dark");
});
