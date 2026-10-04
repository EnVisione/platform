import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { request } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../server/store.js";
import { AuthError } from "../server/discord.js";
import {
  websiteAccess,
  validateWebsite,
  websiteService,
  communityStatus,
} from "../server/website.js";
import {
  publicWebsiteRouter,
  websiteEditorRouter,
} from "../server/website-routes.js";
import { applicationRouter } from "../server/application-routes.js";
import { initialWebsite, newAnnouncement } from "../shared/website.js";
import { config as fixture } from "./fixture.js";
import { validateConfig } from "../server/config.js";

function requestSite(url, options = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      url,
      { method: options.method, headers: options.headers },
      (incoming) => {
        const chunks = [];
        incoming.on("data", (chunk) => chunks.push(chunk));
        incoming.on("end", () =>
          resolve(
            new Response(Buffer.concat(chunks), {
              status: incoming.statusCode,
              headers: incoming.headers,
            }),
          ),
        );
        incoming.on("error", reject);
      },
    );
    outgoing.on("error", reject);
    outgoing.end(options.body);
  });
}

const config = {
  ...fixture,
  website: {
    discordGuildId: "42",
    discordInvite: "https://discord.gg/community",
  },
  discordBotToken: "fixture",
};
const admin = { id: "staff", permissions: { dashboard: true }, roles: ["21"] };
const draft = () => ({ revision: 0, ...structuredClone(initialWebsite) });

test("website editing requires a current Admin or higher role and Dashboard access", () => {
  for (const rank of fixture.ranks)
    assert.equal(
      websiteAccess(config, { ...admin, roles: [rank.id] }),
      ["Founder", "Manager", "Admin"].includes(rank.name),
    );
  assert.equal(
    websiteAccess(config, { ...admin, permissions: { dashboard: false } }),
    false,
  );
  assert.equal(
    websiteAccess(config, {
      ...admin,
      roles: ["25"],
      capabilities: { "website.edit": true },
    }),
    false,
  );
});

test("website saves persist, hide drafts and reject conflicting editors without changing saved data", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "drakora-website-"));
  const key = randomBytes(32).toString("base64");
  let database = openStore(join(directory, "content.sqlite"), key);
  t.after(() => {
    database.store.close();
    rmSync(directory, { recursive: true });
  });
  let service = websiteService(config, database.store);
  const edit = service.read(admin);
  edit.rules.home =
    "Updated public rules.\n\n<script>Plain text only.</script>";
  edit.servers.push({
    ...edit.servers[0],
    slug: "hidden-world",
    published: false,
  });
  const saved = service.save(admin, edit);
  assert.equal(saved.revision, 1);
  assert.equal(saved.updatedBy, admin.id);
  assert.throws(() => service.save(admin, edit), {
    code: "website_content_changed",
    status: 409,
  });
  const lower = { ...admin, roles: ["22"] };
  assert.throws(
    () =>
      service.save(lower, {
        ...saved,
        rules: { ...saved.rules, home: "Unauthorized" },
      }),
    { code: "website_role_required", status: 403 },
  );
  assert.throws(() => service.read(lower), { code: "website_role_required" });
  database.store.close();
  database = openStore(join(directory, "content.sqlite"), key);
  service = websiteService(config, database.store);
  assert.deepEqual(service.read(admin), saved);
  const publicContent = service.publicContent();
  assert.equal(publicContent.servers.length, 2);
  assert.equal(publicContent.rules.home, edit.rules.home);
  for (const name of ["updatedBy", "updatedAt", "revision"])
    assert.equal(name in publicContent, false);
  assert.equal(publicContent.address, "play.drakora.org");
  service.save(admin, { ...saved, servers: [] });
  assert.deepEqual(service.publicContent().servers, []);
});

test("content validation rejects unsafe downloads, duplicate URLs and invalid addresses", () => {
  for (const value of [
    "http://example.com",
    "javascript:alert(1)",
    "https://user:pass@example.com",
    "not a URL",
  ]) {
    const edit = draft();
    edit.servers[0].downloadUrl = value;
    assert.throws(() => validateWebsite(edit), {
      code: "invalid_website_content",
    });
  }
  for (const value of ["../secret", "UPPERCASE", "a/b"]) {
    const edit = draft();
    edit.servers[0].slug = value;
    assert.throws(() => validateWebsite(edit), {
      code: "invalid_website_content",
    });
  }
  for (const value of [
    "host.invalid:99999",
    "host.invalid:0",
    "https://host.invalid",
    "host.invalid\nother",
  ]) {
    const edit = draft();
    edit.servers[0].address = value;
    assert.throws(() => validateWebsite(edit), {
      code: "invalid_website_content",
    });
  }
  const duplicate = draft();
  duplicate.servers[1].slug = duplicate.servers[0].slug;
  assert.throws(() => validateWebsite(duplicate), {
    code: "duplicate_server_slug",
  });
  const blank = draft();
  blank.rules.discord = " ";
  assert.throws(() => validateWebsite(blank), {
    code: "invalid_website_content",
  });
  const oversized = draft();
  oversized.servers[0].summary = "a".repeat(241);
  assert.throws(() => validateWebsite(oversized), {
    code: "invalid_website_content",
  });
  const accepted = draft();
  accepted.servers[0].downloadUrl = "https://example.com/download";
  accepted.servers[0].privateField = "hidden";
  assert.equal(
    validateWebsite(accepted).servers[0].downloadUrl,
    "https://example.com/download",
  );
  assert.equal("privateField" in validateWebsite(accepted).servers[0], false);
});

test("Home announcements migrate existing content, persist and publish only visible entries", (t) => {
  const database = openStore(":memory:", randomBytes(32).toString("base64"));
  t.after(() => database.store.close());
  const legacy = draft();
  delete legacy.home;
  legacy.revision = 7;
  legacy.rules.home = "Keep the existing rules.";
  legacy.servers[0].summary = "Keep the existing server description.";
  database.store.set(
    "website-content",
    "current",
    legacy,
    Number.MAX_SAFE_INTEGER,
  );
  const service = websiteService(config, database.store);
  const edit = service.read(admin);
  assert.deepEqual(edit.home, initialWebsite.home);
  assert.deepEqual(service.publicContent().home, initialWebsite.home);
  assert.equal(service.read(admin).revision, 7);
  edit.home.title = "Our community";
  edit.home.announcements = [
    {
      ...newAnnouncement(),
      title: "Community event",
      body: "First paragraph.\n\n<script>Escaped text.</script>",
      date: "2026-10-03",
      published: true,
    },
    {
      ...newAnnouncement(),
      title: "Private draft",
      body: "Not ready to share.",
    },
  ];
  const saved = service.save(admin, edit);
  assert.equal(saved.revision, 8);
  assert.equal(service.publicContent().home.announcements.length, 1);
  assert.deepEqual(
    service.publicContent().home.announcements[0],
    saved.home.announcements[0],
  );
  assert.deepEqual(saved.rules, legacy.rules);
  assert.deepEqual(saved.servers, legacy.servers);
  assert.deepEqual(service.read(admin), saved);
  const oldEditor = { ...saved };
  delete oldEditor.home;
  assert.deepEqual(service.save(admin, oldEditor).home, saved.home);
  const current = service.read(admin);
  current.home.announcements = [];
  service.save(admin, current);
  assert.deepEqual(service.publicContent().home.announcements, []);
  assert.throws(() => service.save(admin, saved), {
    code: "website_content_changed",
  });
  assert.deepEqual(service.publicContent().home.announcements, []);
});

test("legacy server cards receive pack logos and download links without replacing staff content", (t) => {
  const database = openStore(":memory:", randomBytes(32).toString("base64"));
  t.after(() => database.store.close());
  const legacy = draft();
  legacy.revision = 9;
  for (const [i, server] of legacy.servers.entries()) {
    delete server.logoUrl;
    server.artwork = i === 0 ? "castle" : "forest";
    server.downloadUrl = "";
  }
  legacy.servers[0].summary = "Keep our edited description.";
  legacy.servers[1].downloadUrl = "https://example.com/our-pack";
  legacy.servers.push({
    ...legacy.servers[0],
    slug: "custom-pack",
    pack: "Different pack",
    artwork: "forest",
  });
  database.store.set(
    "website-content",
    "current",
    legacy,
    Number.MAX_SAFE_INTEGER,
  );
  const service = websiteService(config, database.store);
  const migrated = service.read(admin);
  assert.equal(migrated.revision, 9);
  assert.deepEqual(migrated.home, legacy.home);
  assert.deepEqual(migrated.apply, legacy.apply);
  assert.deepEqual(migrated.rules, legacy.rules);
  assert.equal(migrated.servers[0].summary, legacy.servers[0].summary);
  assert.equal(migrated.servers[0].artwork, "prominence");
  assert.equal(
    migrated.servers[0].downloadUrl,
    initialWebsite.servers[0].downloadUrl,
  );
  assert.equal(migrated.servers[1].artwork, "restless-horizons");
  assert.equal(migrated.servers[1].downloadUrl, legacy.servers[1].downloadUrl);
  assert.equal(migrated.servers[2].artwork, "forest");
  assert.equal(migrated.servers[2].downloadUrl, "");
  assert.equal(service.publicContent().servers[0].artwork, "prominence");
  migrated.servers[0].logoUrl = "https://example.com/logo.png";
  const saved = service.save(admin, migrated);
  assert.equal(
    service.publicContent().servers[0].logoUrl,
    saved.servers[0].logoUrl,
  );
  const olderEditor = structuredClone(saved);
  delete olderEditor.servers[0].logoUrl;
  assert.equal(
    service.save(admin, olderEditor).servers[0].logoUrl,
    saved.servers[0].logoUrl,
  );
  const clearLogo = service.read(admin);
  clearLogo.servers[0].logoUrl = "";
  clearLogo.servers[0].downloadUrl = "";
  clearLogo.servers[0].artwork = "forest";
  service.save(admin, clearLogo);
  assert.equal(service.publicContent().servers[0].logoUrl, "");
  assert.equal(service.publicContent().servers[0].downloadUrl, "");
  assert.equal(service.publicContent().servers[0].artwork, "forest");
});

test("pack logos accept HTTPS URLs and reject unsafe URLs and unknown artwork", () => {
  for (const value of [
    "http://example.com/logo.png",
    "javascript:alert(1)",
    "data:image/png;base64,a",
    "https://user:pass@example.com/logo.png",
    "not a URL",
    "a".repeat(501),
  ]) {
    const edit = draft();
    edit.servers[0].logoUrl = value;
    assert.throws(() => validateWebsite(edit), {
      code: "invalid_website_content",
    });
  }
  const edit = draft();
  edit.servers[0].logoUrl = "https://example.com/logo.png";
  assert.equal(
    validateWebsite(edit).servers[0].logoUrl,
    edit.servers[0].logoUrl,
  );
  edit.servers[0].artwork = "unknown";
  assert.throws(() => validateWebsite(edit), {
    code: "invalid_website_content",
  });
});

test("announcement validation bounds content and rejects malformed dates and duplicate identifiers", () => {
  const base = draft();
  base.home.announcements = [
    { ...newAnnouncement(), title: "News", body: "Community news." },
  ];
  assert.equal(validateWebsite(base).home.announcements[0].date, "");
  for (const [field, value] of [
    ["title", " "],
    ["body", "a".repeat(6001)],
    ["date", "2026-02-30"],
    ["date", "invalid"],
    ["published", "yes"],
    ["id", "../news"],
  ]) {
    const edit = structuredClone(base);
    edit.home.announcements[0][field] = value;
    assert.throws(
      () => validateWebsite(edit),
      { code: "invalid_website_content" },
      field,
    );
  }
  const duplicate = structuredClone(base);
  duplicate.home.announcements.push({ ...duplicate.home.announcements[0] });
  assert.throws(() => validateWebsite(duplicate), {
    code: "invalid_website_content",
  });
  const oversized = structuredClone(base);
  oversized.home.announcements = Array.from({ length: 31 }, () => ({
    ...newAnnouncement(),
    title: "News",
    body: "Text",
  }));
  assert.throws(() => validateWebsite(oversized), {
    code: "invalid_website_content",
  });
  const invalidHome = structuredClone(base);
  invalidHome.home.title = "";
  assert.throws(() => validateWebsite(invalidHome), {
    code: "invalid_website_content",
  });
  base.home.announcements[0].privateField = "Exclude me";
  assert.equal(
    "privateField" in validateWebsite(base).home.announcements[0],
    false,
  );
});

test("Apply guidance migrates saved pages and older editors preserve published guidance", (t) => {
  const database = openStore(":memory:", randomBytes(32).toString("base64"));
  t.after(() => database.store.close());
  const legacy = draft();
  delete legacy.apply;
  legacy.revision = 9;
  legacy.home.title = "Keep our welcome";
  database.store.set(
    "website-content",
    "current",
    legacy,
    Number.MAX_SAFE_INTEGER,
  );
  const service = websiteService(config, database.store);
  const edit = service.read(admin);
  assert.deepEqual(edit.apply, initialWebsite.apply);
  assert.equal(edit.revision, 9);
  edit.apply.introduction = "Help our community.";
  edit.apply.answers = "Write honestly. <script>Plain text.</script>";
  edit.apply.privateField = "Do not publish";
  const saved = service.save(admin, edit);
  assert.equal(saved.revision, 10);
  assert.equal(
    service.publicContent().apply.introduction,
    "Help our community.",
  );
  assert.equal("privateField" in saved.apply, false);
  assert.deepEqual(saved.home, legacy.home);
  assert.deepEqual(saved.rules, legacy.rules);
  assert.deepEqual(saved.servers, legacy.servers);
  const olderEditor = { ...saved };
  delete olderEditor.apply;
  assert.deepEqual(service.save(admin, olderEditor).apply, saved.apply);
  assert.throws(() => service.save(admin, saved), {
    code: "website_content_changed",
  });
  assert.deepEqual(service.publicContent().apply, saved.apply);
});

test("Apply guidance rejects blank and oversized fields without changing saved pages", () => {
  for (const [field, value] of [
    ["title", " "],
    ["introduction", "a".repeat(1001)],
    ["qualities", "a".repeat(6001)],
    ["beforeApplying", null],
    ["answers", "bad\0text"],
  ]) {
    const edit = draft();
    edit.apply[field] = value;
    assert.throws(
      () => validateWebsite(edit),
      { code: "invalid_website_content" },
      field,
    );
  }
});

test("Discord counts share requests, respect rate limits and expire stale readings while players stay zero", async () => {
  let time = 0,
    calls = 0,
    mode = "success";
  const status = communityStatus(
    config,
    async (url, options) => {
      calls++;
      assert.equal(
        url,
        "https://discord.com/api/v10/guilds/42?with_counts=true",
      );
      assert.equal(options.headers.Authorization, "Bot fixture");
      if (mode === "limit")
        return new Response(null, {
          status: 429,
          headers: { "Retry-After": "120" },
        });
      if (mode === "failure") throw new Error("private detail");
      return Response.json({
        approximate_member_count: mode === "zero" ? 0 : 500,
        approximate_presence_count: 121,
        name: "private guild metadata",
      });
    },
    () => time,
  );
  const first = await Promise.all([status(), status(), status()]);
  assert.equal(calls, 1);
  assert.equal(first[0].discord.total, 500);
  assert.equal(first[0].players, 0);
  assert.equal("name" in first[0].discord, false);
  time = 59999;
  await status();
  assert.equal(calls, 1);
  mode = "limit";
  time = 60000;
  assert.equal((await status()).discord.stale, true);
  assert.equal(calls, 2);
  time = 179999;
  await status();
  assert.equal(calls, 2);
  mode = "zero";
  time = 180000;
  assert.equal((await status()).discord.total, 0);
  assert.equal(calls, 3);
  mode = "failure";
  time += 15 * 60000;
  assert.equal((await status()).discord.total, null);
  const empty = communityStatus(
    config,
    async () => Response.json({ approximate_member_count: -1 }),
    () => time,
  );
  assert.equal((await empty()).discord.total, null);
});

test("Help guidance migrates without replacing pages, persists and survives older editors", (t) => {
  const database = openStore(":memory:", randomBytes(32).toString("base64"));
  t.after(() => database.store.close());
  const legacy = draft();
  delete legacy.help;
  legacy.revision = 12;
  database.store.set(
    "website-content",
    "current",
    legacy,
    Number.MAX_SAFE_INTEGER,
  );
  const service = websiteService(config, database.store);
  const edit = service.read(admin);
  assert.equal(edit.revision, 12);
  assert.deepEqual(edit.help, initialWebsite.help);
  assert.deepEqual(service.publicContent().help, initialWebsite.help);
  edit.help.tickets =
    "Open a ticket in our support area. <script>Plain text.</script>";
  edit.help.privateField = "Not public";
  const saved = service.save(admin, edit);
  assert.equal(saved.revision, 13);
  assert.equal("privateField" in saved.help, false);
  for (const field of ["home", "apply", "rules", "servers"])
    assert.deepEqual(saved[field], legacy[field]);
  const oldEditor = { ...saved };
  delete oldEditor.help;
  assert.deepEqual(service.save(admin, oldEditor).help, saved.help);
  assert.throws(() => service.save(admin, saved), {
    code: "website_content_changed",
  });
  assert.deepEqual(service.publicContent().help, saved.help);
});

test("Help guidance rejects invalid fields without changing stored content", (t) => {
  const database = openStore(":memory:", randomBytes(32).toString("base64"));
  t.after(() => database.store.close());
  const service = websiteService(config, database.store);
  const original = service.publicContent();
  for (const [field, value] of [
    ["title", " "],
    ["introduction", "a".repeat(1001)],
    ["details", "a".repeat(6001)],
    ["tickets", null],
    ["joining", "bad\0text"],
  ]) {
    const edit = service.read(admin);
    edit.help[field] = value;
    assert.throws(
      () => service.save(admin, edit),
      { code: "invalid_website_content" },
      field,
    );
    assert.equal(service.read(admin).revision, 0);
    assert.deepEqual(service.publicContent(), original);
  }
});

test("public routes expose published pages without a session and the staff editor enforces authorization and mutations", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "drakora-website-routes-"));
  writeFileSync(join(directory, "public.html"), "Public Drakora website");
  writeFileSync(join(directory, "index.html"), "Staff dashboard");
  const database = openStore(":memory:", randomBytes(32).toString("base64"));
  const service = websiteService(config, database.store);
  const edit = service.read(admin);
  edit.servers.push({
    ...edit.servers[0],
    slug: "hidden-world",
    published: false,
  });
  service.save(admin, edit);
  const app = express();
  const publicRouter = publicWebsiteRouter(
    service,
    async () => ({ players: 0, discord: { active: 3 } }),
    directory,
  );
  const applications = applicationRouter({}, {}, directory);
  app.use((req, res, next) =>
    req.headers.host === "public.example"
      ? publicRouter(req, res, next)
      : next(),
  );
  app.use((req, res, next) =>
    req.headers.host === "public.example"
      ? applications(req, res, next)
      : next(),
  );
  app.use(
    websiteEditorRouter(
      service,
      (req) => {
        if (!req.headers["x-test-role"])
          throw new AuthError("login_required", 401);
        return { ...admin, roles: [req.headers["x-test-role"]] };
      },
      (req) => {
        if (req.headers["x-csrf-token"] !== "test-boundary")
          throw new AuthError("invalid_request");
      },
      directory,
    ),
  );
  app.use((_req, res) => res.status(404).end());
  app.use((error, _req, res, _next) =>
    res.status(error.status ?? 503).json({ error: error.code }),
  );
  const server = app.listen(0, "127.0.0.1");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    database.store.close();
    rmSync(directory, { recursive: true });
  });
  await new Promise((resolve) => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const path of [
    "/",
    "/apply",
    "/apply/",
    "/servers",
    "/help",
    "/help/",
    "/servers/prom2",
    "/rules",
    "/rules/home",
    "/rules/prom2",
    "/rules/restless-horizons",
    "/rules/discord",
  ]) {
    const response = await requestSite(origin + path, {
      headers: { Host: "public.example" },
    });
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(await response.text(), "Public Drakora website");
  }
  const form = await requestSite(origin + "/apply/start", {
    headers: { Host: "public.example" },
  });
  assert.equal(form.status, 200);
  assert.equal(await form.text(), "Staff dashboard");
  const legacyCallback = await requestSite(
    origin + "/apply?error=discord_cancelled",
    {
      headers: { Host: "public.example" },
    },
  );
  assert.equal(legacyCallback.status, 302);
  assert.equal(
    legacyCallback.headers.get("location"),
    "/apply/start?error=discord_cancelled",
  );
  for (const path of [
    "/servers/hidden-world",
    "/servers/missing",
    "/rules/missing",
    "/api/website",
    "/api/me",
    "/website",
    "/login",
  ])
    assert.equal(
      (
        await requestSite(origin + path, {
          headers: { Host: "public.example" },
        })
      ).status,
      404,
      path,
    );
  const discord = await requestSite(origin + "/discord", {
    headers: { Host: "public.example" },
    redirect: "manual",
  });
  assert.equal(discord.headers.get("location"), config.website.discordInvite);
  assert.equal((await requestSite(origin + "/api/website")).status, 401);
  assert.equal(
    (
      await requestSite(origin + "/api/website", {
        headers: { "X-Test-Role": "22" },
      })
    ).status,
    403,
  );
  const headers = { "X-Test-Role": "21", "Content-Type": "application/json" };
  assert.equal(
    (
      await requestSite(origin + "/api/website", {
        method: "PUT",
        headers,
        body: JSON.stringify(service.read(admin)),
      })
    ).status,
    403,
  );
  const response = await requestSite(origin + "/api/website", {
    method: "PUT",
    headers: { ...headers, "X-CSRF-Token": "test-boundary" },
    body: JSON.stringify(service.read(admin)),
  });
  assert.equal(response.status, 200);
  const savedRevision = service.read(admin).revision;
  for (const [body, status] of [
    ["{", 400],
    [JSON.stringify({ text: "a".repeat(256 * 1024) }), 413],
  ]) {
    assert.equal(
      (
        await requestSite(origin + "/api/website", {
          method: "PUT",
          headers: { ...headers, "X-CSRF-Token": "test-boundary" },
          body,
        })
      ).status,
      status,
    );
    assert.equal(service.read(admin).revision, savedRevision);
  }
  const content = await (
    await requestSite(origin + "/site/api/content", {
      headers: { Host: "public.example" },
    })
  ).json();
  assert.equal(content.servers.length, 2);
  assert.equal(content.updatedBy, undefined);
  assert.deepEqual(content.help, initialWebsite.help);
});

test("website configuration requires the separate public host and a valid Discord invite", () => {
  const valid = {
    ...config,
    office: undefined,
    staffOrigin: "https://staff.example.com",
    todoOrigin: "https://todo.example.com",
    discordClientId: "2",
    discordClientSecret: "fixture",
    sessionSecret: "fixture",
    oidcClientSecret: "fixture",
    hulySecret: "fixture",
    hulyOwner: "fixture",
    hulyWorkspace: "fixture",
    hulyAccounts: "fixture",
    hulyUpstream: "fixture",
    databaseKey: randomBytes(32).toString("base64"),
    applications: {
      publicOrigin: "https://public.example.com",
      databaseKey: randomBytes(32).toString("base64"),
      notificationChannelId: "9",
      specialistRoles: { builder: "51", artist: "52", developer: "25" },
    },
  };
  assert.equal(validateConfig(valid), valid);
  for (const value of [
    "http://discord.gg/community",
    "https://attacker.example/invite",
    "https://discord.gg/community?tracking=1",
    "https://user:pass@discord.gg/community",
  ]) {
    assert.throws(
      () =>
        validateConfig({
          ...valid,
          website: { ...valid.website, discordInvite: value },
        }),
      /HTTPS Discord invite/,
    );
  }
  assert.throws(
    () => validateConfig({ ...valid, applications: undefined }),
    /public applications/,
  );
});
