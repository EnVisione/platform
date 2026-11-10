import { botCommandsService, botCommandsAccess } from "./bot-commands.js";
import { botPackVersions } from "./bot-pack-versions.js";
import { botCommandRouter } from "./bot-command-routes.js";
import express from "express";
import { publicAssets } from "./public-assets.js";
import session from "express-session";
import { rateLimit } from "express-rate-limit";
import { Provider } from "oidc-provider";
import { createProxyMiddleware, fixRequestBody } from "http-proxy-middleware";
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual, generateKeyPairSync } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { openStore, hash } from "./store.js";
import { AuthError, discordClient } from "./discord.js";
import { hulyClient } from "./huly.js";
import { isPageRequest, requestPath } from "./navigation.js";
import {
  workspaceAllowed,
  workspacePath,
  workspaceHtmlProxy,
  workspaceFailureHtml,
  isWorkspacePage,
} from "./workspace.js";
import { workspaceSessions } from "./workspace-session.js";
import { discordOffice } from "./office.js";
import { discordRulesPanel } from "./rules-discord.js";
import { discordTodoSync } from "./todo-sync.js";
import { trackerAccessService } from "./tracker-access.js";
import { validateConfig } from "./config.js";
import { minecraftRegistry } from "./minecraft.js";
import {
  managementAccess,
  applicationReviewAccess,
  applicationDecisionAccess,
  mailAccess,
  staffCapability,
} from "./roles.js";
import { rolePermissions } from "./role-permissions.js";
import { roleAssignments } from "./role-assignment.js";
import {
  staffReviews,
  staffReviewAccess,
  reviewProgress,
} from "./staff-reviews.js";
import { staffReviewDiscord } from "./staff-review-discord.js";
import { staffReviewRouter } from "./staff-review-routes.js";
import { staffAccountRoster, staffDirectory } from "./staff-directory.js";
import { roleRouter } from "./role-routes.js";
import { memberActivity } from "./activity.js";
import { contactRanks } from "./contact-ranks.js";

import { applicationService } from "./applications.js";
import { applicationOnboarding } from "./application-onboarding.js";
import { applicationRouter } from "./application-routes.js";
import { minecraftSkinService } from "./minecraft-skins.js";
import { applicationFormRouter } from "./application-form-routes.js";
import { mailboxService } from "./mailbox.js";
import { mailRouter } from "./mail-routes.js";
import { timePreferences, timePreferenceRouter } from "./time-preferences.js";
import { overviewService } from "./overview.js";
import { websiteService, websiteAccess, communityStatus } from "./website.js";
import { publicWebsiteRouter, websiteEditorRouter } from "./website-routes.js";
import { ticketService } from "./tickets.js";
import { ticketDiscord } from "./ticket-discord.js";
import { partnershipContact } from "./partnership-contact.js";
import { ticketMail } from "./ticket-mail.js";
import { ticketNotices } from "./ticket-notices.js";
import { ticketRouter } from "./ticket-routes.js";
import { ticketMacros } from "./ticket-macros.js";
import { discordHoneypot } from "./honeypot-discord.js";
import { moderationHistory } from "./moderation.js";
import { moderationRouter } from "./moderation-routes.js";
import { playtimeCounter } from "./staff-review-metrics.js";
import { protectModerationStaff } from "./moderation-permissions.js";
import { staffNotes } from "./staff-notes.js";
import { moderationCases } from "./moderation-cases.js";
import { playerActivity } from "./players.js";
import { moderationDiscord } from "./moderation-discord.js";
import { moderationTargetResolver } from "./moderation-targets.js";
import { appealRouter, publicAppealSession } from "./appeal-routes.js";
import { appealAccounts } from "./appeal-accounts.js";
import { retentionService, privacyActivity } from "./retention.js";
import { legalRouter } from "./legal.js";
import { storefrontService, storefrontRouter } from "./storefront.js";
import { storePlusService } from "./store-plus.js";
import { storePurchaseService } from "./store-purchases.js";
import { tebexWebhookService, tebexWebhookRouter } from "./tebex-webhooks.js";
import { tebexEventService } from "./tebex-events.js";
import { storeCheckoutService } from "./store-checkout.js";
import { supporterCoinService } from "./supporter-coins.js";
import { rankAnnouncementService } from "./rank-announcements.js";
import { storeAccountService, storeSessionRequired } from "./store-account.js";
import {
  minecraftLinkService,
  proxyAuthenticator,
} from "./minecraft-bridge.js";
import { minecraftRankBridge } from "./minecraft-bridge-ranks.js";
import { minecraftRoleTransport } from "./minecraft-bridge-discord.js";
import { minecraftBridgeRouter } from "./minecraft-bridge-routes.js";
import { donatorAudiences } from "./donator-audiences.js";

const config = validateConfig(
  JSON.parse(
    readFileSync(process.env.CONFIG_PATH ?? "/run/secrets/config.json"),
  ),
);
const dataPath = process.env.DATA_PATH ?? "/data";
mkdirSync(dataPath, { recursive: true, mode: 0o700 });
const { store, sessions, createSessionStore, OidcAdapter } = openStore(
  `${dataPath}/staff.sqlite`,
  config.databaseKey,
);
const applicationPath = process.env.APPLICATION_DATA_PATH ?? "/applications";
if (config.applications)
  mkdirSync(applicationPath, { recursive: true, mode: 0o700 });
const applicationDatabase = config.applications
  ? openStore(
      `${applicationPath}/applications.sqlite`,
      config.applications.databaseKey,
    )
  : undefined;
const minecraft = minecraftRegistry(store);
const timeSettings = timePreferences(store);
const website = config.website ? websiteService(config, store) : undefined;
const shopService = config.website
  ? storefrontService(config.storefront)
  : undefined;
const storePlus = shopService
  ? storePlusService(store, config.storefront)
  : undefined;
const storePurchases = shopService
  ? storePurchaseService(store, config.storefront?.purchases)
  : undefined;
const storeAccount = shopService ? storeAccountService(store) : undefined;
const supporterCoins = supporterCoinService(store, config.storefront);
const donators = donatorAudiences(store, storePurchases);
const rankAnnouncements =
  config.storefront?.webhooks?.mode === "production"
    ? rankAnnouncementService(store, config.storefront.rankAnnouncements)
    : undefined;
let onboarding;
const applications = applicationDatabase
  ? applicationService(
      config,
      applicationDatabase.store,
      fetch,
      minecraft.get,
      (id) => store.get("user", id)?.avatar,
      (id, at) => privacyActivity(store, id, at),
      (record) => onboarding?.erase(record),
    )
  : undefined;
const minecraftSkins = minecraftSkinService({
  profile: applications?.minecraftProfile,
});
const rolePolicy = rolePermissions(config, store);
const botCommands = botCommandsService(config, store);
const packVersions = botPackVersions(config, store, botCommands);
const ticketPath = process.env.TICKET_DATA_PATH ?? "/tickets";
if (config.tickets) mkdirSync(ticketPath, { recursive: true, mode: 0o700 });
const ticketDatabase = config.tickets
  ? openStore(`${ticketPath}/tickets.sqlite`, config.tickets.databaseKey)
  : undefined;
const tickets = ticketDatabase
  ? ticketService(config, ticketDatabase.store, rolePolicy, {
      onActivity: (id, at) => privacyActivity(store, id, at),
    })
  : undefined;
const retention = retentionService(config, store, {
  tickets,
  applications,
  applicationStore: applicationDatabase?.store,
  plus: storePlus,
});
const ticketEmails = tickets ? ticketMail(config, tickets) : undefined;
const discord = discordClient(
  config,
  store,
  fetch,
  rolePolicy.apply,
  config.office
    ? {
        member: (id) => office.staffMember(id),
        ticketMember: (id) => office.ticketMember(id),
        available: () => office.staffAvailable(),
      }
    : undefined,
);
const sockets = new Set();
const mail = mailboxService(config, store);
const activity = memberActivity(store);
const huly = hulyClient(config, store);
const workspaceSession = workspaceSessions(store);
let workspaceAddress;
async function workspaceConfig() {
  if (!workspaceAddress) {
    workspaceAddress = huly
      .rpc("getWorkspaceInfo", { updateLastVisit: false })
      .then((workspace) => {
        if (
          typeof workspace.url !== "string" ||
          !workspace.url ||
          workspace.url.length > 200
        )
          throw new Error("Workspace address is unavailable");
        return { ...config, workspaceUrl: workspace.url };
      })
      .catch((error) => {
        workspaceAddress = undefined;
        throw error;
      });
  }
  return workspaceAddress;
}
const office = config.office
  ? discordOffice(config, store, { mail, rolePolicy })
  : undefined;
const rulesPanel =
  office && website
    ? discordRulesPanel(config, store, office.gateway, website)
    : undefined;
let minecraftLinks, minecraftRanks, minecraftProxyAuth, minecraftBridgeTimer;
let minecraftBridgeListener;
if (config.minecraftBridge?.enabled) {
  const transport = minecraftRoleTransport(config, office.gateway);
  minecraftLinks = minecraftLinkService(config, store, minecraft, {
    assertStaff: transport.assertStaff,
    onLinked: (value, kind, first) => minecraftRanks.linked(value, kind, first),
  });
  minecraftRanks = minecraftRankBridge(
    config,
    store,
    minecraftLinks,
    transport,
    office.roleSync,
    Date.now,
    storePlus,
  );
  void minecraftRanks
    .plusChanged()
    .catch(() => console.error("Minecraft Plus synchronization is pending."));
  minecraftProxyAuth = proxyAuthenticator(config.minecraftBridge, store);
  minecraftBridgeListener = (packet) =>
    void minecraftRanks
      .observe(packet)
      .catch(() => console.error("Minecraft rank observation is pending."));
  office.gateway.on("raw", minecraftBridgeListener);
  minecraftBridgeTimer = setInterval(
    () =>
      void minecraftRanks
        .retry()
        .catch(() =>
          console.error("Minecraft rank synchronization is pending."),
        ),
    60000,
  ).unref();
}
const honeypot = config.honeypot
  ? discordHoneypot(config, store, office.gateway, rolePolicy)
  : undefined;
const ticketTransport = tickets
  ? ticketDiscord(config, tickets, office.gateway, rolePolicy)
  : undefined;
const players = playerActivity(store);
const resolveMinecraftTarget = moderationTargetResolver(store);
const publicAppealAccounts = appealAccounts(store, {
  profile: (name) => resolveMinecraftTarget({ name }),
  owner: (uuid) => store.get("minecraft-owner", uuid),
  byDiscord: (id) => store.get("minecraft-discord-owner", id),
});
const connectedModeration = moderationCases(store, {
  staffOrigin: config.staffOrigin,
  publicOrigin: config.applications?.publicOrigin ?? "https://drakora.org",
  appealAccounts: publicAppealAccounts,
  resolveIP: (uuid) => players.ipFor(uuid),
  linkedDiscord: (uuid) => {
    const owner = uuid ? store.get("minecraft-owner", uuid) : null;
    return owner && (owner.memberLinked || owner.staffLinked)
      ? owner.discord?.id
      : undefined;
  },
  linkedMinecraft: (id) => {
    const linked = store.get("minecraft-discord-owner", id);
    const owner = linked?.uuid && store.get("minecraft-owner", linked.uuid);
    return owner &&
      owner.discord?.id === id &&
      (owner.memberLinked || owner.staffLinked)
      ? { uuid: owner.uuid, name: owner.name }
      : undefined;
  },
  protectIP: async (actor, ip) => {
    for (const target of players.alts(actor, { ip }).matches) {
      const owner = store.get("minecraft-owner", target.uuid);
      if (target.uuid === actor.uuid || owner?.discord?.id === actor.id)
        throw new AuthError("moderation_self_action_denied", 403);
      if (
        office &&
        owner?.discord?.id &&
        (owner.memberLinked || owner.staffLinked)
      )
        protectModerationStaff(
          config,
          actor,
          await office.staffMember(owner.discord.id),
        );
    }
  },
  resolveActor: async (uuid) => {
    const owner = store.get("minecraft-owner", uuid);
    if (
      !owner?.staffLinked ||
      !owner.discord?.id ||
      !store.get("user", owner.discord.id)
    )
      throw new AuthError("moderation_staff_link_required");
    const actor = await discord.check(owner.discord.id, true);
    if (!actor.staffMember) throw new AuthError("moderation_access_denied");
    return actor;
  },
  resolveTarget: async (platform, input) => {
    if (platform === "discord") {
      if (
        typeof input?.discordId !== "string" ||
        !/^\d{1,20}$/.test(input.discordId) ||
        !office
      )
        throw new AuthError("invalid_moderation_target", 400);
      const user = await office.gateway.users.fetch(input.discordId);
      return { discordId: user.id, name: user.globalName || user.username };
    }
    const profile = await resolveMinecraftTarget(input);
    const owner = profile.uuid
      ? store.get("minecraft-owner", profile.uuid)
      : null;
    return {
      ...profile,
      uuid: profile.uuid,
      name: profile.name,
      ...((owner?.memberLinked || owner?.staffLinked) && owner.discord?.id
        ? { discordId: owner.discord.id }
        : {}),
    };
  },
  protectTarget: async (actor, target) => {
    if (!target.discordId || !office) return;
    protectModerationStaff(
      config,
      actor,
      await office.staffMember(target.discordId),
    );
  },
});
const playerStaffNotes = staffNotes(store, { moderation: connectedModeration });

const moderationTransport = office
  ? moderationDiscord(config, connectedModeration, office.gateway, rolePolicy)
  : undefined;
let moderationRetry;
const moderationTimer = setInterval(() => {
  if (moderationRetry) return;
  moderationRetry = connectedModeration
    .retry()
    .catch(() => console.error("Moderation delivery is pending."))
    .finally(() => {
      moderationRetry = undefined;
    });
}, 15000).unref();
const ticketStaffNotices = tickets
  ? ticketNotices(config, tickets, ticketTransport)
  : undefined;
const partnerships =
  tickets && mail
    ? partnershipContact(tickets, mail, office.gateway)
    : undefined;
office?.onAccessChanged((packet) => {
  const access = discord.observe(packet);
  if (access) trackerAccess?.changed();
  if (access?.revoked)
    for (const socket of sockets)
      if (socket.userId === access.id) socket.destroy();
  if (access?.revoked || access?.ticketRevoked)
    tickets?.events.emit("staff-access-revoked", access.id);
  for (const id of access?.ticketRevokedIds ?? [])
    tickets?.events.emit("staff-access-revoked", id);
});
const overview = overviewService(config, {
  applications,
  tickets,
  mail,
  queues: office?.overviewQueues,
  players,
});
const assignments =
  office && config.roleSync
    ? roleAssignments(
        config,
        store,
        rolePolicy,
        office.roleAdministration,
        office.roleSync,
      )
    : undefined;
onboarding =
  applications && office
    ? applicationOnboarding(
        config,
        applicationDatabase.store,
        office,
        rolePolicy,
        assignments,
      )
    : undefined;
office?.onRolesChanged((id) => {
  void (id ? assignments?.reconcile(id) : assignments?.retry())?.catch(() =>
    console.error("Staff role assignment is pending."),
  );
});
async function reviewMember(id) {
  const raw = await office.staffMember(id);
  if (!raw) return null;
  return rolePolicy.apply({
    id,
    name: raw.nick || raw.user.global_name || raw.user.username,
    roles: raw.roles,
    bot: raw.user.bot,
    pending: raw.pending,
  });
}
const reviews =
  config.staffReviews && office && assignments
    ? staffReviews(config, store, {
        roster: () => office.staffRoster(),
        member: reviewMember,
        memberRanks: (id) =>
          office.staffRoster().find((person) => person.id === id)?.ranks || [],
        assignments,
        applicationStore: applicationDatabase?.store,
        progress: (id, from, to) => ({
          ...reviewProgress(store, tickets, id, from, to),
          lastActiveAt: activity.lastActiveAt(id),
        }),
        minecraft: minecraft.get,
        playtime: (id, at) => {
          const link = minecraft.get(id);
          const owner = link?.uuid && store.get("minecraft-owner", link.uuid);
          if (!owner?.staffLinked || owner.discord?.id !== id) return null;
          return playtimeCounter(store, link, at);
        },
      })
    : null;
if (reviews)
  reviews.setTransport(
    staffReviewDiscord(config, store, office, reviews, reviewMember),
  );
const publicStaffDirectory = office
  ? staffDirectory(config, () => office.staffRoster(), minecraft.get)
  : null;
const assignmentTimer = assignments
  ? setInterval(
      () =>
        void assignments
          .retry()
          .catch(() => console.error("Staff role assignment is pending.")),
      60000,
    )
  : undefined;
assignmentTimer?.unref();
const todoSync = config.todoForums
  ? discordTodoSync(config, store, huly)
  : undefined;
const trackerAccess = config.trackerProjects?.length
  ? trackerAccessService(config, store, huly, discord)
  : undefined;
office?.onTodoChanged(() => todoSync?.changed());
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
const staffHost = new URL(config.staffOrigin).host;
const todoHost = new URL(config.todoOrigin).host;
const applicationHost = config.applications
  ? new URL(config.applications.publicOrigin).host
  : undefined;
const storefrontHost = config.storefront
  ? new URL(config.storefront.origin).host
  : undefined;
const dist = resolve("dist");
const newToken = () => randomBytes(32).toString("base64url");
const safeEqual = (left, right) =>
  typeof left === "string" &&
  typeof right === "string" &&
  Buffer.byteLength(left) === Buffer.byteLength(right) &&
  timingSafeEqual(Buffer.from(left), Buffer.from(right));
const save = (req) =>
  new Promise((resolve, reject) =>
    req.session.save((error) => (error ? reject(error) : resolve())),
  );
const regenerate = (req) =>
  new Promise((resolve, reject) =>
    req.session.regenerate((error) => (error ? reject(error) : resolve())),
  );
const destroy = (req) =>
  new Promise((resolve, reject) =>
    req.session.destroy((error) => (error ? reject(error) : resolve())),
  );
const cookieOptions = {
  secure: true,
  httpOnly: true,
  sameSite: "lax",
  path: "/",
  maxAge: 43200000,
};
const makeSession = (name) =>
  session({
    name,
    store: sessions,
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: cookieOptions,
  });
const staffSession = makeSession("__Host-drakora_staff");
const todoSession = makeSession("__Host-drakora_todo");
const storeSession = makeSession("__Host-drakora_store");
const appealSession = publicAppealSession(config, createSessionStore());
const applicationSession = applicationDatabase
  ? session({
      name: "__Host-drakora_apply",
      store: applicationDatabase.sessions,
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: { ...cookieOptions, maxAge: 7 * 86400000 },
    })
  : undefined;
const ticketSession = ticketDatabase
  ? session({
      name: "__Host-drakora_ticket",
      store: ticketDatabase.sessions,
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: { ...cookieOptions, maxAge: 7 * 86400000 },
    })
  : undefined;

app.use((req, res, next) => {
  res.set({
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Strict-Transport-Security": "max-age=31536000",
  });
  if (req.path === "/health" && req.headers.host === "127.0.0.1:3000")
    return res.json({ ok: true });
  if (
    ![staffHost, todoHost, applicationHost, storefrontHost]
      .filter(Boolean)
      .includes(req.headers.host)
  )
    return res.status(421).end();
  if (req.headers["x-forwarded-proto"] !== "https")
    return res.redirect(
      308,
      `${req.headers.host === staffHost ? config.staffOrigin : req.headers.host === todoHost ? config.todoOrigin : req.headers.host === storefrontHost ? config.storefront.origin : config.applications.publicOrigin}${req.url}`,
    );
  next();
});
app.use((req, res, next) =>
  req.headers.host === applicationHost &&
  (req.path === "/appeal" || req.path.startsWith("/appeal/"))
    ? appealSession(req, res, next)
    : [applicationHost, storefrontHost].includes(req.headers.host) &&
        storeSessionRequired(req.path, config.minecraftBridge?.enabled)
      ? storeSession(req, res, next)
      : req.headers.host === storefrontHost
        ? next()
        : ticketSession &&
            req.headers.host === applicationHost &&
            (req.path.startsWith("/help/") || req.path.startsWith("/partners"))
          ? ticketSession(req, res, next)
          : config.website &&
              req.headers.host === applicationHost &&
              !req.path.startsWith("/apply")
            ? next()
            : (req.headers.host === todoHost
                ? todoSession
                : req.headers.host === applicationHost
                  ? applicationSession
                  : staffSession)(req, res, next),
);
app.use(
  ["/auth/discord", "/__staff/start"],
  rateLimit({
    windowMs: 60000,
    limit: 20,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  }),
);
app.use((req, res, next) => {
  if ([staffHost, applicationHost, storefrontHost].includes(req.headers.host))
    res.set(
      "Content-Security-Policy",
      req.headers.host === storefrontHost ||
        (req.headers.host === applicationHost &&
          (req.path.startsWith("/store") ||
            [
              "/network-ranks",
              "/network-ranks/",
              "/server-ranks",
              "/server-ranks/",
              "/compare",
              "/compare/",
              "/prefixes",
              "/prefixes/",
              "/plus",
              "/plus/",
              "/gift-cards",
              "/gift-cards/",
            ].includes(req.path)))
        ? "default-src 'self'; script-src 'self' https://js.tebex.io; style-src 'self' 'unsafe-inline' https://js.tebex.io; img-src 'self' https:; connect-src 'self' https://*.tebex.io; frame-src https://*.tebex.io; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://checkout.tebex.io https://pay.tebex.io"
        : `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' ${req.headers.host === applicationHost && config.website ? "https:" : "https://cdn.discordapp.com"}; connect-src 'self'; frame-src ${config.todoOrigin}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
    );
  next();
});

app.get("/robots.txt", (req, res, next) => {
  if ([staffHost, todoHost].includes(req.headers.host))
    return res.type("text/plain").send("User-agent: *\nDisallow: /\n");
  next();
});

const legalPages = legalRouter(config);
app.use((req, res, next) =>
  [staffHost, applicationHost, storefrontHost].includes(req.headers.host)
    ? legalPages(req, res, next)
    : next(),
);

if (minecraftLinks)
  app.use(
    minecraftBridgeRouter(
      config,
      minecraftLinks,
      minecraftRanks,
      minecraftProxyAuth,
      {
        signedIn,
        dist,
        plus: storePlus,
        supporterCoins,
        donators,
        purchases: storePurchases,
        moderation: connectedModeration,
        staffNotes: playerStaffNotes,
        players,
      },
    ),
  );
else
  app.post("/api/minecraft/proxy", (req, res, next) => {
    if (req.headers.host !== staffHost) return next();
    res.status(503).json({ ok: false, error: "minecraft_bridge_disabled" });
  });

app.use(
  appealRouter(config, connectedModeration, {
    dist,
    discordIdentity: (code, redirectUri) =>
      discord.storeIdentity(code, redirectUri),
  }),
);

if (website) {
  const events = tebexEventService(
    store,
    config.storefront ?? {},
    storePurchases,
    storePlus,
    { profile: applications?.minecraftProfile },
  );
  const webhook = tebexWebhookRouter(
    tebexWebhookService(config.storefront?.webhooks, async (event) => {
      const result = await events.handle(event);
      supporterCoins.handle(event);
      void minecraftRanks
        ?.plusChanged()
        .catch(() =>
          console.error("Minecraft Plus synchronization is pending."),
        );
      return result;
    }),
  );
  app.use((req, res, next) =>
    [applicationHost, storefrontHost].includes(req.headers.host)
      ? webhook(req, res, next)
      : next(),
  );
  const shop = storefrontRouter(
    shopService,
    [config.applications.publicOrigin, config.storefront?.origin].filter(
      Boolean,
    ),
    storeAccount,
    {
      staffOrigin: config.staffOrigin,
      minecraftProfile: applications?.minecraftProfile,
      plus: storePlus,
      skins: minecraftSkins,
      purchases: storePurchases,
      testBuyer: events.testBuyer,
      supporterCoins,
      store,
      checkout: storeCheckoutService(
        store,
        config.storefront ?? {},
        storePlus,
        events,
      ),
    },
  );
  app.use((req, res, next) =>
    [applicationHost, storefrontHost].includes(req.headers.host)
      ? shop(req, res, next)
      : next(),
  );
  const publicWebsite = publicWebsiteRouter(
    website,
    communityStatus(config, fetch, Date.now, overview.networkSnapshot),
    dist,
    publicStaffDirectory,
    config.applications.publicOrigin,
  );
  app.use((req, res, next) =>
    [applicationHost, storefrontHost].includes(req.headers.host)
      ? publicWebsite(req, res, next)
      : next(),
  );
}

app.use((req, res, next) =>
  req.headers.host === storefrontHost ? res.status(404).end() : next(),
);

if (tickets) {
  const publicTickets = ticketRouter(config, tickets, ticketTransport, {
    dist,
    database: ticketDatabase.store,
  });
  app.use((req, res, next) =>
    req.headers.host === applicationHost
      ? publicTickets(req, res, next)
      : next(),
  );
}

if (applications) {
  const publicApplications = applicationRouter(
    config,
    applications,
    dist,
    minecraftSkins,
  );
  app.use((req, res, next) =>
    req.headers.host === applicationHost ||
    (req.headers.host === staffHost &&
      ["GET", "HEAD"].includes(req.method) &&
      req.path.startsWith("/apply/api/head/"))
      ? publicApplications(req, res, next)
      : next(),
  );
}

function safeNext(value) {
  if (
    [
      "/",
      "/huly",
      "/settings",
      "/accounts",
      "/applications",
      "/applications/editor",
      "/email",
      "/roles",
      "/bot",
      "/website",
      "/office",
      "/tracker",
      "/calendar",
      "/tickets",
      "/logs",
      "/moderation",
      "/players",
      "/minecraft/link",
    ].includes(value)
  )
    return value;
  if (
    typeof value === "string" &&
    /^\/interaction\/[A-Za-z0-9_-]+$/.test(value)
  )
    return value;
  if (
    typeof value === "string" &&
    /^\/huly\/authorize\?challenge=[A-Za-z0-9_-]{43}$/.test(value)
  )
    return value;
  if (
    typeof value === "string" &&
    /^\/(applications|tickets|moderation|staff-reviews|players)\/[a-f0-9-]{36}$/.test(
      value,
    )
  )
    return value;
  return "/";
}

async function signedIn(
  req,
  { allowUnlinked = false, syncHuly = true, forceDiscord = false } = {},
) {
  if (!req.session.userId || req.session.until < Date.now())
    throw new AuthError("login_required", 401);
  if (req.headers.host === todoHost) {
    workspaceSession.validate(
      req.session.staffSessionId ?? "",
      req.session.userId,
    );
  }
  let user = await discord.check(req.session.userId, forceDiscord);
  if ((req.session.accessEpoch || 0) !== (user.accessEpoch || 0))
    throw new AuthError("login_required", 401);
  if (!user.staffMember) throw new AuthError("staff_server_required");
  if (!user.permissions.dashboard)
    throw new AuthError("dashboard_role_required");
  const link = minecraft.get(user.id);
  const path = requestPath(req);
  if (
    !["GET", "HEAD"].includes(req.method) ||
    (req.method === "GET" &&
      !path.startsWith("/api/") &&
      !path.startsWith("/huly/"))
  )
    retention.touch(user.id);
  if (!allowUnlinked && !link)
    throw new AuthError("minecraft_name_required", 428);
  if (
    syncHuly &&
    (!user.hulyAccount ||
      user.syncedAt !== user.checkedAt ||
      user.syncedPolicyRevision !== user.policyRevision)
  )
    user = await huly.sync(user);
  return rolePolicy.apply(user);
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    avatar: user.avatar,
    mail: mailAccess(config, user),
    capabilities: user.capabilities,
    rolesPanel: Boolean(user.capabilities["roles.view"]),
    bot: botCommandsAccess(user),
    website: Boolean(website && websiteAccess(config, user)),
    tickets: Boolean(tickets && user.capabilities["tickets.view"]),
    staffReviews: Boolean(reviews && staffReviewAccess(config, user)),
    logs: Boolean(
      (tickets && user.capabilities["logs.view"]) ||
        (reviews && staffReviewAccess(config, user)),
    ),
    returning: user.returning,
    minecraft: minecraft.get(user.id) ?? null,
    workspaceOrigin: config.todoOrigin,
    timePreferences: timeSettings.get(user.id),
    applications: Boolean(
      applications && applicationReviewAccess(config, user),
    ),
    applicationDecision: Boolean(
      applications && applicationDecisionAccess(config, user),
    ),
    applicationEdit: Boolean(
      applications && user.capabilities["applications.edit"],
    ),
    ...managementAccess(config, user),
    ...user.permissions,
  };
}

function requireMutation(req) {
  if (
    req.headers.origin !== config.staffOrigin ||
    !safeEqual(req.headers["x-csrf-token"], req.session.csrf)
  )
    throw new AuthError("invalid_request");
}

app.get("/logs", async (req, res, next) => {
  if (req.headers.host !== staffHost) return next();
  try {
    const user = await signedIn(req, {
      allowUnlinked: true,
      syncHuly: false,
      forceDiscord: true,
    });
    if (reviews && staffReviewAccess(config, user))
      return res.sendFile(`${dist}/index.html`);
    next();
  } catch (error) {
    if (error.status === 401) return res.redirect("/login?next=%2Flogs");
    next(error);
  }
});
if (tickets) {
  const staffTickets = ticketRouter(config, tickets, ticketTransport, {
    staffView: true,
    macros: ticketMacros(ticketDatabase.store, rolePolicy),
    authorize: async (req) => {
      if (!req.session.userId || req.session.until <= Date.now())
        throw new AuthError("login_required", 401);
      return signedIn(req, {
        allowUnlinked: true,
        syncHuly: false,
        forceDiscord: !["GET", "HEAD"].includes(req.method),
      });
    },
    mutation: requireMutation,
    dist,
    database: store,
  });
  app.use((req, res, next) =>
    req.headers.host === staffHost ? staffTickets(req, res, next) : next(),
  );
}

if (website) {
  const editor = websiteEditorRouter(
    website,
    (req) =>
      signedIn(req, {
        syncHuly: false,
        forceDiscord: !["GET", "HEAD"].includes(req.method),
      }),
    requireMutation,
    dist,
  );
  app.use((req, res, next) =>
    req.headers.host === staffHost ? editor(req, res, next) : next(),
  );
}

function accountFromToken(token) {
  if (!token || typeof token !== "string" || token.split(".").length !== 3)
    return undefined;
  try {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64url")).account;
  } catch {
    return undefined;
  }
}

function matchingHulyIdentity(req, user) {
  const url = new URL(req.url, config.todoOrigin);
  const candidates = [
    req.headers.authorization?.replace(/^Bearer /i, ""),
    url.searchParams.get("token"),
  ];
  candidates.push(
    ...url.pathname.split("/").map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return "";
      }
    }),
  );
  return candidates.every((token) => {
    const account = accountFromToken(token);
    return !account || account === user.hulyAccount;
  });
}

const officeRouter = express.Router();
officeRouter.use(async (req, res, next) => {
  if (!office) throw new AuthError("office_unavailable", 503);
  const user = await signedIn(req);
  if (!user.capabilities["office.view"])
    throw new AuthError("office_permission_required");
  req.officeUser = user;
  next();
});
officeRouter.get("/", async (req, res) => {
  if (!req.session.csrf) {
    req.session.csrf = newToken();
    await save(req);
  }
  res.json({ ...office.snapshot(req.officeUser), csrf: req.session.csrf });
});
officeRouter.get("/contact-ranks", (req, res) => {
  res.json(
    contactRanks(office.snapshot(req.officeUser), (id) =>
      store.get("user", id),
    ),
  );
});
officeRouter.post(
  "/:room/:action",
  rateLimit({ windowMs: 60000, limit: 8, legacyHeaders: false }),
  express.json({ limit: "1kb" }),
  async (req, res) => {
    const origin =
      req.headers.host === todoHost ? config.todoOrigin : config.staffOrigin;
    if (
      req.headers.origin !== origin ||
      !safeEqual(req.headers["x-csrf-token"], req.session.csrf)
    )
      throw new AuthError("invalid_request");
    const user = await discord.check(req.session.userId, true);
    if (!user.permissions.dashboard)
      throw new AuthError("dashboard_role_required");
    if (!user.capabilities["office.host"])
      throw new AuthError("meeting_host_required");
    if (!["start", "end"].includes(req.params.action))
      throw new AuthError("invalid_request", 404);
    await office.meetings[req.params.action](req.params.room, user);
    res.json({ ...office.snapshot(user), csrf: req.session.csrf });
  },
);
app.use(["/api/office", "/_drakora/api/office"], officeRouter);

const proxyOptions = {
  target: config.hulyUpstream,
  changeOrigin: false,
  on: {
    proxyReq(proxyReq, req, res) {
      const cookies = String(req.headers.cookie ?? "")
        .split(";")
        .filter((value) => !value.trim().startsWith("__Host-drakora_"))
        .join(";");
      proxyReq.setHeader("cookie", cookies);
      if (req.workspaceAccountToken && req.path.startsWith("/_accounts"))
        proxyReq.setHeader(
          "authorization",
          `Bearer ${req.workspaceAccountToken}`,
        );
      fixRequestBody(proxyReq, req, res);
    },
    error(_error, _req, response) {
      if (typeof response.writeHead === "function" && !response.headersSent)
        response.writeHead(502).end("Huly is temporarily unavailable.");
      else response.destroy();
    },
  },
};
const proxy = createProxyMiddleware(proxyOptions);
const htmlProxy = workspaceHtmlProxy(config, proxyOptions);

app.post("/_github/api/webhook", (req, res, next) => {
  if (
    req.headers.host !== todoHost ||
    !/^sha256=[0-9a-f]{64}$/.test(req.headers["x-hub-signature-256"] ?? "")
  )
    return res.status(403).end();
  proxy(req, res, next);
});

app.use(async (req, res, next) => {
  if (req.headers.host !== todoHost) return next();
  if (
    req.method === "GET" &&
    ["/__staff/workspace.js", "/__staff/workspace.css"].includes(req.path)
  )
    return res.sendFile(
      resolve(
        "server/workspace-assets",
        req.path.endsWith(".js") ? "workspace.js" : "workspace.css",
      ),
    );
  if (req.method === "GET" && req.path === "/__staff/attach") {
    const handoff = workspaceSession.take(req.query.code);
    let user = await discord.check(handoff.userId, true);
    if (!user.permissions.dashboard || !workspaceAllowed(user, handoff.view))
      throw new AuthError("staff_permission_required");
    if (!minecraft.get(user.id))
      throw new AuthError("minecraft_name_required", 428);
    user = await huly.sync(user);
    await regenerate(req);
    workspaceSession.validate(handoff.staffSession, handoff.userId);
    Object.assign(req.session, {
      userId: user.id,
      staffSessionId: handoff.staffSession,
      accessEpoch: user.accessEpoch || 0,
      until: handoff.until,
    });
    await save(req);
    return res.redirect(workspacePath(await workspaceConfig(), handoff.view));
  }
  if (req.path === "/__staff/start") {
    if (req.headers["sec-fetch-dest"] === "iframe")
      throw new AuthError("login_required", 401);
    await regenerate(req);
    const challenge = newToken();
    req.session.challenge = hash(challenge);
    store.set(
      "challenge",
      hash(challenge),
      { todoSession: req.sessionID },
      Date.now() + 600000,
    );
    await save(req);
    return res.redirect(
      `${config.staffOrigin}/huly/authorize?challenge=${challenge}`,
    );
  }
  if (req.path === "/__staff/complete") {
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const handoff = store.take("handoff", hash(code));
    if (!handoff || handoff.todoSession !== req.sessionID) {
      console.warn(
        "Huly handoff rejected:",
        !handoff ? "expired code" : "browser session changed",
      );
      throw new AuthError("invalid_handoff");
    }
    const parent = workspaceSession.validate(
      handoff.staffSession,
      handoff.userId,
    );
    const user = await discord.check(handoff.userId, true);
    if (!user.permissions.dashboard)
      throw new AuthError("dashboard_role_required");
    if (!minecraft.get(user.id))
      throw new AuthError("minecraft_name_required", 428);
    if (!user.permissions.todo)
      throw new AuthError("staff_permission_required");
    await regenerate(req);
    workspaceSession.validate(handoff.staffSession, handoff.userId);
    Object.assign(req.session, {
      userId: user.id,
      staffSessionId: handoff.staffSession,
      until: parent.until,
      accessEpoch: user.accessEpoch || 0,
    });
    await save(req);
    const inviteId = await huly.invite(user);
    return res.redirect(
      `/_accounts/auth/openid?inviteId=${encodeURIComponent(inviteId)}`,
    );
  }
  let user;
  try {
    user = await signedIn(req);
  } catch (error) {
    if (
      error.status === 401 &&
      (isPageRequest(req) || req.path.startsWith("/__staff/open/"))
    ) {
      if (req.headers["sec-fetch-dest"] === "iframe") throw error;
      return res.redirect("/__staff/start");
    }
    if (error.code === "minecraft_name_required" && isPageRequest(req))
      return res.redirect(`${config.staffOrigin}/minecraft?next=/huly`);
    throw error;
  }
  if (!user.permissions.todo) throw new AuthError("staff_permission_required");
  if (!matchingHulyIdentity(req, user))
    throw new AuthError("huly_account_mismatch");
  if (req.path.startsWith("/_accounts"))
    req.workspaceAccountToken = huly.accountToken(
      user.hulyAccount,
      req.session.until,
    );
  if (req.method === "GET" && req.path.startsWith("/__staff/open/")) {
    const view = req.path.slice("/__staff/open/".length);
    if (!workspacePath({ workspaceUrl: "" }, view))
      return res.status(404).end();
    if (!workspaceAllowed(user, view))
      throw new AuthError("staff_permission_required");
    return res.redirect(workspacePath(await workspaceConfig(), view));
  }
  if (req.method === "GET" && req.path === "/config.json") {
    const response = await fetch(`${config.hulyUpstream}/config.json`, {
      headers: { Host: todoHost, "X-Forwarded-Proto": "https" },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error("Huly configuration is unavailable");
    return res.json({
      ...(await response.json()),
      OFFICE_URL: undefined,
      STAFF_SSO_URL: "/__staff/start",
      STAFF_DASHBOARD_URL: config.staffOrigin,
      STAFF_CONTACT_RANKS_URL: "/_drakora/api/office/contact-ranks",
      HIDE_LOCAL_LOGIN: "true",
      DISABLE_SIGNUP: "true",
    });
  }
  if (
    req.method === "GET" &&
    (req.path === "/_drakora/office" ||
      /^\/workbench\/[^/]+\/love(?:\/|$)/.test(req.path))
  ) {
    return res.redirect(workspacePath(await workspaceConfig(), "tracker"));
  }
  if (req.path.startsWith("/__staff/assets/")) return next();
  if (req.path.replace(/\/+$/, "") === "/_accounts" && req.method === "POST") {
    return express.json({ limit: "128kb" })(req, res, (error) => {
      if (error) return next(error);
      if (
        [
          "login",
          "loginOtp",
          "validateOtp",
          "signUp",
          "join",
          "signUpJoin",
          "checkAutoJoin",
        ].includes(req.body?.method)
      )
        return res
          .status(403)
          .json({ error: "Use Discord login through the staff portal." });
      proxy(req, res, next);
    });
  }
  if (isWorkspacePage(req)) {
    req.workspaceUrl = (await workspaceConfig()).workspaceUrl;
    return htmlProxy(req, res, next);
  }
  return proxy(req, res, next);
});

app.get("/auth/discord", async (req, res) => {
  const state = newToken();
  const next = safeNext(req.query.next);
  if (req.query.purpose === "store") {
    if (!storeAccount?.challengeGet(req.query.challenge))
      throw new AuthError("invalid_login_state");
    req.session.storeOAuth = {
      challenge: req.query.challenge,
      state: hash(state),
      until: Date.now() + 600000,
    };
    await save(req);
    const authorize = new URL("https://discord.com/oauth2/authorize");
    authorize.search = new URLSearchParams({
      client_id: config.discordClientId,
      redirect_uri: `${config.staffOrigin}/auth/discord/callback`,
      response_type: "code",
      scope: "identify",
      prompt: "consent",
      state,
    });
    return res.redirect(authorize.href);
  }
  if (req.query.purpose === "ticket") {
    if (!tickets?.challengeGet(req.query.challenge))
      throw new AuthError("invalid_login_state");
    const identity =
      req.session.userId && req.session.until > Date.now()
        ? store.get("user", req.session.userId)
        : null;
    if (identity)
      return res.redirect(tickets.handoff(req.query.challenge, identity));
    req.session.ticketOAuth = {
      challenge: req.query.challenge,
      state: hash(state),
      until: Date.now() + 600000,
    };
    await save(req);
    const authorize = new URL("https://discord.com/oauth2/authorize");
    authorize.search = new URLSearchParams({
      client_id: config.discordClientId,
      redirect_uri: `${config.staffOrigin}/auth/discord/callback`,
      response_type: "code",
      scope: "identify email guilds.members.read",
      state,
    });
    return res.redirect(authorize.href);
  }
  if (req.query.purpose === "application") {
    const challenge = applications?.getChallenge(req.query.challenge);
    if (!challenge) throw new AuthError("invalid_login_state");
    if (
      challenge.useStaffSession !== false &&
      req.session.userId &&
      req.session.until > Date.now()
    ) {
      const user = await discord.check(req.session.userId, true);
      return res.redirect(
        applications.handoff(req.query.challenge, {
          id: user.id,
          name: user.name,
          username: user.username,
          avatar: user.avatar,
          email: user.email,
          roles: user.roles,
        }),
      );
    }
    req.session.applicationOAuth = {
      challenge: req.query.challenge,
      state: hash(state),
      until: Date.now() + 600000,
    };
    await save(req);
    const authorize = new URL("https://discord.com/oauth2/authorize");
    authorize.search = new URLSearchParams({
      client_id: config.discordClientId,
      redirect_uri: `${config.staffOrigin}/auth/discord/callback`,
      response_type: "code",
      scope: "identify email guilds.members.read",
      state,
    });
    return res.redirect(authorize.href);
  }
  await regenerate(req);
  Object.assign(req.session, {
    oauthState: hash(state),
    oauthUntil: Date.now() + 600000,
    next,
  });
  await save(req);
  const url = new URL("https://discord.com/oauth2/authorize");
  url.search = new URLSearchParams({
    client_id: config.discordClientId,
    redirect_uri: `${config.staffOrigin}/auth/discord/callback`,
    response_type: "code",
    scope: "identify email guilds.members.read",
    state,
    prompt: "consent",
  });
  res.redirect(url.href);
});

app.get("/auth/discord/callback", async (req, res) => {
  const state = typeof req.query.state === "string" ? req.query.state : "";
  if (
    req.session.storeOAuth &&
    safeEqual(hash(state), req.session.storeOAuth.state)
  ) {
    const pending = req.session.storeOAuth;
    delete req.session.storeOAuth;
    await save(req);
    const challenge = storeAccount.challengeGet(pending.challenge);
    if (!challenge) throw new AuthError("invalid_login_state");
    try {
      if (pending.until < Date.now() || typeof req.query.code !== "string")
        throw new AuthError("invalid_login_state");
      return res.redirect(
        storeAccount.handoff(
          pending.challenge,
          await discord.storeIdentity(req.query.code),
        ),
      );
    } catch {
      return res.redirect(
        `${challenge.origin}/store/plus?error=discord_cancelled`,
      );
    }
  }
  if (
    req.session.ticketOAuth &&
    safeEqual(hash(state), req.session.ticketOAuth.state)
  ) {
    const pending = req.session.ticketOAuth;
    delete req.session.ticketOAuth;
    await save(req);
    try {
      if (pending.until < Date.now() || typeof req.query.code !== "string")
        throw new AuthError("invalid_login_state");
      return res.redirect(
        tickets.handoff(
          pending.challenge,
          await discord.identity(req.query.code),
        ),
      );
    } catch {
      return res.redirect(
        `${config.applications.publicOrigin}/help/new?error=discord_cancelled`,
      );
    }
  }
  if (
    req.session.applicationOAuth &&
    safeEqual(hash(state), req.session.applicationOAuth.state)
  ) {
    const pending = req.session.applicationOAuth;
    delete req.session.applicationOAuth;
    await save(req);
    try {
      if (pending.until < Date.now())
        throw new AuthError("invalid_login_state");
      if (req.query.error || typeof req.query.code !== "string")
        throw new AuthError("discord_cancelled");
      const identity = await discord.identity(req.query.code);
      return res.redirect(applications.handoff(pending.challenge, identity));
    } catch (error) {
      const code =
        error instanceof AuthError ? error.code : "service_unavailable";
      return res.redirect(
        `${config.applications.publicOrigin}/apply/start?error=${encodeURIComponent(code)}`,
      );
    }
  }
  if (
    !safeEqual(hash(state), req.session.oauthState) ||
    req.session.oauthUntil < Date.now()
  )
    throw new AuthError("invalid_login_state");
  const next = safeNext(req.session.next);
  delete req.session.oauthState;
  await save(req);
  if (req.query.error || typeof req.query.code !== "string")
    return res.redirect("/login?error=discord_cancelled");
  const user = await huly.sync(await discord.login(req.query.code));
  await regenerate(req);
  Object.assign(req.session, {
    userId: user.id,
    until: Date.now() + 43200000,
    accessEpoch: user.accessEpoch || 0,
    csrf: newToken(),
  });
  await save(req);
  res.redirect(
    next === "/minecraft/link" || minecraft.get(user.id)
      ? next
      : `/minecraft?next=${encodeURIComponent(next)}`,
  );
});

app.get("/api/me", async (req, res) => {
  const user = await signedIn(req, { allowUnlinked: true });
  res.json({ user: publicUser(user), csrf: req.session.csrf });
});
app.get("/api/overview", async (req, res) => {
  const user = await signedIn(req, { syncHuly: false });
  res.json(await overview.snapshot(user));
});
app.use(
  "/api/preferences/time",
  timePreferenceRouter(timeSettings, signedIn, requireMutation),
);
app.post(
  "/api/minecraft",
  rateLimit({ windowMs: 60000, limit: 8, legacyHeaders: false }),
  express.json({ limit: "1kb" }),
  async (req, res) => {
    const user = await signedIn(req, { allowUnlinked: true });
    requireMutation(req);
    const link = minecraft.register(user.id, req.body?.name);
    res.status(201).json({ minecraft: link });
  },
);
app.post(
  "/api/minecraft/change",
  rateLimit({ windowMs: 60000, limit: 8, legacyHeaders: false }),
  express.json({ limit: "1kb" }),
  async (req, res) => {
    const user = await signedIn(req);
    requireMutation(req);
    if (!user.capabilities["settings.minecraft"])
      throw new AuthError("staff_permission_required");
    res.json({ minecraft: minecraft.requestChange(user.id, req.body?.name) });
  },
);
app.use(
  botCommandRouter({
    service: botCommands,
    config,
    staffHost,
    dist,
    authorize: (req) => signedIn(req, { syncHuly: false, forceDiscord: true }),
    mutation: requireMutation,
  }),
);
app.get("/api/accounts", async (req, res) => {
  const user = await signedIn(req);
  if (!managementAccess(config, user).manager)
    throw new AuthError("management_role_required");
  const officeSnapshot = office?.snapshot(user);
  const roster = staffAccountRoster(officeSnapshot, minecraft.entries());
  const stats =
    tickets && user.capabilities["tickets.view"]
      ? tickets.staffStats(user)
      : null;
  const reviewSummaries =
    reviews && staffReviewAccess(config, user) ? reviews.summaries(user) : null;
  const accounts = [...roster].map(([id, { member, minecraft: link }]) => {
    const stored = store.get("user", id);
    return {
      id,
      name: member?.name ?? stored?.name ?? id,
      avatar: member?.avatar ?? stored?.avatar ?? null,
      ranks: member.ranks ?? [],
      minecraft: link,
      staffReview: reviewSummaries?.get(id) || null,
      reviewEligible: Boolean(
        reviewSummaries && member && reviews.eligible(member, user),
      ),
      discordStatus: member?.status ?? "unknown",
      lastActiveAt: member?.lastActiveAt ?? activity.lastActiveAt(id) ?? null,
      timeZone: timeSettings.get(id).timeZone,
      ticketStats: stats
        ? stats.get(id) || {
            ticketsResolved: 0,
            activeTickets: 0,
            ...(rolePolicy.isFounder(user)
              ? { reviewCount: 0, averageRating: null }
              : {}),
          }
        : null,
    };
  });
  accounts.sort((a, b) => a.name.localeCompare(b.name));
  res.json({ accounts, rankOrder: config.ranks.map((rank) => rank.name) });
});
async function authorizeMail(req, capability = "mail.view") {
  const user = await signedIn(req, {
    syncHuly: false,
    forceDiscord: req.method !== "GET",
  });
  if (!config.mail || !user.capabilities[capability])
    throw new AuthError("mail_role_required");
  return user;
}
app.use(
  "/api/mail",
  mailRouter({
    service: mail,
    authorize: authorizeMail,
    requireMutation,
    staffHost,
  }),
);
async function authorizeRoles(req) {
  const user = await signedIn(req, {
    syncHuly: false,
    forceDiscord: req.method !== "GET",
  });
  return rolePolicy.authorize(user, "roles.view");
}
app.use(
  "/api/roles",
  roleRouter({
    policy: rolePolicy,
    assignments,
    authorize: authorizeRoles,
    requireMutation,
    staffHost,
    onPolicyChange() {
      trackerAccess?.changed();
      void office?.emailAlerts?.refreshPermissions();
      void ticketTransport
        ?.refreshPermissions()
        .catch(() => console.error("Ticket permission refresh is pending."));
      for (const socket of sockets) {
        const user = store.get("user", socket.userId);
        const current = user && rolePolicy.apply(user);
        if (!current?.permissions.dashboard || !current.permissions.todo)
          socket.destroy();
      }
    },
  }),
);
app.post(
  "/api/accounts/:id/minecraft-change",
  rateLimit({ windowMs: 60000, limit: 12, legacyHeaders: false }),
  express.json({ limit: "1kb" }),
  async (req, res) => {
    const current = await signedIn(req, { forceDiscord: true });
    requireMutation(req);
    if (!managementAccess(config, current).approveMinecraftChange)
      throw new AuthError("minecraft_approver_role_required");
    if (!["approve", "reject"].includes(req.body?.decision))
      throw new AuthError("invalid_request", 400);
    const target = store.get("user", req.params.id);
    if (!target) throw new AuthError("account_not_found", 404);
    res.json({
      minecraft: minecraft.decide(target.id, req.body.decision === "approve"),
    });
  },
);
app.post("/api/logout", express.json({ limit: "1kb" }), async (req, res) => {
  requireMutation(req);
  const id = req.sessionID;
  await destroy(req);
  for (const socket of sockets)
    if (socket.staffSessionId === id) socket.destroy();
  res.clearCookie("__Host-drakora_staff", cookieOptions).json({ ok: true });
});

app.get(["/huly", "/todo"], async (req, res) => {
  try {
    const user = await signedIn(req);
    if (!user.permissions.todo)
      throw new AuthError("staff_permission_required");
    res.redirect("/tracker");
  } catch (error) {
    if (error.status === 401) return res.redirect("/login?next=/huly");
    if (error.code === "minecraft_name_required")
      return res.redirect("/minecraft?next=/huly");
    throw error;
  }
});
app.post(
  "/api/workspace-session",
  rateLimit({ windowMs: 60000, limit: 10, legacyHeaders: false }),
  express.json({ limit: "1kb" }),
  async (req, res) => {
    requireMutation(req);
    const user = await signedIn(req);
    const view = req.body?.view;
    if (!workspaceAllowed(user, view))
      throw new AuthError("staff_permission_required");
    const code = workspaceSession.issue(req.sessionID, user.id, view);
    res.json({ url: `${config.todoOrigin}/__staff/attach?code=${code}` });
  },
);
app.get("/huly/authorize", async (req, res) => {
  if (typeof req.query.challenge !== "string")
    throw new AuthError("invalid_handoff");
  let user;
  try {
    user = await signedIn(req);
  } catch (error) {
    if (error.status === 401)
      return res.redirect(
        `/login?next=${encodeURIComponent(safeNext(req.originalUrl))}`,
      );
    if (error.code === "minecraft_name_required")
      return res.redirect("/minecraft?next=/huly");
    throw error;
  }
  if (!user.permissions.todo) throw new AuthError("staff_permission_required");
  const challenge = store.take("challenge", hash(req.query.challenge));
  if (!challenge) throw new AuthError("invalid_handoff");
  const code = newToken();
  store.set(
    "handoff",
    hash(code),
    {
      userId: user.id,
      staffSession: req.sessionID,
      todoSession: challenge.todoSession,
    },
    Date.now() + 60000,
  );
  res.redirect(`${config.todoOrigin}/__staff/complete?code=${code}`);
});

const keyPath = `${dataPath}/oidc-jwks.json`;
if (!existsSync(keyPath)) {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  writeFileSync(
    keyPath,
    JSON.stringify({
      keys: [
        {
          ...privateKey.export({ format: "jwk" }),
          use: "sig",
          alg: "RS256",
          kid: newToken(),
        },
      ],
    }),
    { mode: 0o600, flag: "wx" },
  );
}
const provider = new Provider(`${config.staffOrigin}/oidc`, {
  adapter: OidcAdapter,
  clients: [
    {
      client_id: "drakora-huly",
      client_name: "Drakora Huly",
      client_secret: config.oidcClientSecret,
      redirect_uris: [`${config.todoOrigin}/_accounts/auth/openid/callback`],
      response_types: ["code"],
      grant_types: ["authorization_code"],
      token_endpoint_auth_method: "client_secret_basic",
    },
  ],
  jwks: JSON.parse(readFileSync(keyPath)),
  cookies: {
    keys: [config.sessionSecret],
    long: { secure: true, httpOnly: true, sameSite: "lax" },
    short: { secure: true, httpOnly: true, sameSite: "lax" },
  },
  features: { devInteractions: { enabled: false } },
  responseTypes: ["code"],
  scopes: ["openid", "email", "profile"],
  claims: {
    openid: ["sub"],
    email: ["email", "email_verified"],
    profile: ["name", "preferred_username"],
  },
  pkce: { required: () => false },
  ttl: {
    Session: 43200,
    Grant: 43200,
    AccessToken: 300,
    IdToken: 300,
    AuthorizationCode: 60,
    Interaction: 600,
  },
  interactions: {
    url: (_ctx, interaction) => `/interaction/${interaction.uid}`,
  },
  async findAccount(_ctx, id) {
    if (!/^discord:\d+$/.test(id)) return undefined;
    const user = await discord.check(id.slice(8));
    if (!user.permissions.dashboard || !user.permissions.todo) return undefined;
    if (!minecraft.get(user.id)) return undefined;
    return {
      accountId: id,
      async claims() {
        return {
          sub: id,
          name: user.name,
          preferred_username: user.username,
          email: user.email,
          email_verified: true,
        };
      },
    };
  },
  renderError(ctx) {
    ctx.status = 400;
    ctx.body =
      "Sign-in could not be completed. Return to the staff portal and try again.";
  },
});
provider.proxy = true;
provider.on("server_error", (_ctx, error) =>
  console.error("OpenID provider error:", error.message),
);
app.get("/interaction/:uid", async (req, res) => {
  let user;
  try {
    user = await signedIn(req);
  } catch (error) {
    if (error.status === 401)
      return res.redirect(
        `/login?next=${encodeURIComponent(safeNext(req.path))}`,
      );
    if (error.code === "minecraft_name_required")
      return res.redirect("/minecraft?next=/huly");
    throw error;
  }
  if (!user.permissions.todo) throw new AuthError("staff_permission_required");
  const details = await provider.interactionDetails(req, res);
  if (details.params.client_id !== "drakora-huly")
    throw new AuthError("invalid_client");
  if (details.prompt.name === "login") {
    return provider.interactionFinished(
      req,
      res,
      { login: { accountId: `discord:${user.id}` } },
      { mergeWithLastSubmission: false },
    );
  }
  if (details.prompt.name === "consent") {
    if (details.session.accountId !== `discord:${user.id}`)
      throw new AuthError("huly_account_mismatch");
    const grant = details.grantId
      ? await provider.Grant.find(details.grantId)
      : new provider.Grant({
          accountId: details.session.accountId,
          clientId: "drakora-huly",
        });
    grant.addOIDCScope("openid profile email");
    const grantId = await grant.save();
    return provider.interactionFinished(
      req,
      res,
      { consent: { grantId } },
      { mergeWithLastSubmission: true },
    );
  }
  throw new AuthError("invalid_interaction");
});
app.use("/oidc", async (req, res, next) => {
  if (req.path === "/auth") {
    try {
      const user = await signedIn(req);
      if (!user.permissions.todo)
        throw new AuthError("staff_permission_required");
      const url = new URL(req.url, config.staffOrigin);
      url.searchParams.set("prompt", "login");
      req.url = url.pathname + url.search;
    } catch (error) {
      return next(error);
    }
  }
  provider.callback()(req, res);
});

app.use("/__staff/assets", publicAssets(dist));
app.get(["/login", "/access"], (_req, res) =>
  res.sendFile(`${dist}/index.html`),
);
app.get("/minecraft", async (req, res) => {
  try {
    await signedIn(req, { allowUnlinked: true });
    res.sendFile(`${dist}/index.html`);
  } catch (error) {
    if (error.status === 401)
      return res.redirect(
        `/login?next=${encodeURIComponent(safeNext(req.query.next))}`,
      );
    throw error;
  }
});
async function applicationViewer(req) {
  const user = await signedIn(req, {
    syncHuly: false,
    forceDiscord: req.method !== "GET",
  });
  if (!applications || !applicationReviewAccess(config, user))
    throw new AuthError("application_review_role_required");
  return user;
}
async function applicationEditor(req) {
  const current = await signedIn(req, {
    syncHuly: false,
    forceDiscord: req.method !== "GET",
  });
  if (!applications || !staffCapability(config, current, "applications.edit"))
    throw new AuthError("application_decision_role_required");
  return current;
}
if (applications)
  app.use(
    applicationFormRouter(
      applications.forms,
      applicationEditor,
      requireMutation,
    ),
  );
app.get("/applications/editor", async (req, res) => {
  try {
    await applicationEditor(req);
    res.sendFile(`${dist}/index.html`);
  } catch (error) {
    if (error.status === 401)
      return res.redirect("/login?next=%2Fapplications%2Feditor");
    if (error.code === "minecraft_name_required")
      return res.redirect("/minecraft?next=%2Fapplications%2Feditor");
    throw error;
  }
});
app.get("/api/applications", async (req, res) => {
  await applicationViewer(req);
  const offset = Number(req.query.offset ?? 0);
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new AuthError("invalid_request", 400);
  res.json(
    applications.list(offset, {
      role: req.query.role,
      status: req.query.status,
      name: req.query.name,
      from: req.query.from,
      to: req.query.to,
    }),
  );
});
if (reviews) {
  const router = staffReviewRouter({
    reviews,
    authorize: (req) =>
      signedIn(req, {
        allowUnlinked: true,
        syncHuly: false,
        forceDiscord: true,
      }),
    mutation: requireMutation,
    staffHost,
    dist,
  });
  app.use((req, res, next) =>
    req.path.startsWith("/api/staff-reviews") ||
    req.path.startsWith("/staff-reviews/")
      ? router(req, res, next)
      : next(),
  );
}
app.use(
  moderationRouter({
    history: moderationHistory(store),
    authorize: (req) => signedIn(req, { syncHuly: false, forceDiscord: true }),
    cases: connectedModeration,
    staffNotes: playerStaffNotes,
    players,
    mutation: requireMutation,
    applications,
    tickets,
    staffHost,
    dist,
  }),
);
app.get("/api/applications/:id", async (req, res) => {
  await applicationViewer(req);
  const record = applications.get(req.params.id);
  if (!record) throw new AuthError("application_not_found", 404);
  res.json(record);
});
app.get("/api/applications/:id/history", async (req, res) => {
  await applicationViewer(req);
  res.set("Cache-Control", "no-store");
  res.json(
    applications.previousApplications(
      req.params.id,
      Number(req.query.offset ?? 0),
    ),
  );
});
app.post(
  "/api/applications/:id/comments",
  rateLimit({ windowMs: 60000, limit: 10, legacyHeaders: false }),
  express.json({ limit: "8kb" }),
  async (req, res) => {
    const current = await applicationViewer(req);
    requireMutation(req);
    res.json(
      applications.addComment(req.params.id, current, req.body?.comment),
    );
  },
);
app.post(
  "/api/applications/:id/review",
  rateLimit({ windowMs: 60000, limit: 10, legacyHeaders: false }),
  async (req, res) => {
    const current = await applicationViewer(req);
    requireMutation(req);
    res.json(applications.startReview(req.params.id, current));
  },
);
app.post(
  "/api/applications/:id/decision",
  rateLimit({ windowMs: 60000, limit: 10, legacyHeaders: false }),
  express.json({ limit: "8kb" }),
  async (req, res) => {
    const current = await applicationViewer(req);
    requireMutation(req);
    res.json(
      applications.decide(
        req.params.id,
        current,
        req.body?.decision,
        req.body?.reason,
        req.body?.reapplyDays,
      ),
    );
  },
);
app.get(["/applications", "/applications/:id"], async (req, res) => {
  try {
    await applicationViewer(req);
    res.sendFile(`${dist}/index.html`);
  } catch (error) {
    if (error.status === 401)
      return res.redirect(
        `/login?next=${encodeURIComponent(safeNext(req.path))}`,
      );
    if (error.code === "minecraft_name_required")
      return res.redirect(
        `/minecraft?next=${encodeURIComponent(safeNext(req.path))}`,
      );
    throw error;
  }
});
app.get("/office", async (req, res) => {
  await signedIn(req);
  res.redirect("/tracker");
});
app.get(
  ["/", "/settings", "/accounts", "/email", "/roles", "/tracker", "/calendar"],
  async (req, res) => {
    try {
      const user =
        req.path === "/email" ? await authorizeMail(req) : await signedIn(req);
      if (req.path === "/roles") await authorizeRoles(req);
      if (
        ["/tracker", "/calendar"].includes(req.path) &&
        !workspaceAllowed(user, req.path.slice(1))
      )
        throw new AuthError("staff_permission_required");
      if (req.path === "/settings" && !user.capabilities["settings.view"])
        throw new AuthError("staff_permission_required");
      if (req.path === "/accounts" && !managementAccess(config, user).manager)
        throw new AuthError("management_role_required");
      res.sendFile(`${dist}/index.html`);
    } catch (error) {
      if (error.status === 401)
        res.redirect(`/login?next=${encodeURIComponent(req.path)}`);
      else if (error.code === "minecraft_name_required")
        res.redirect(`/minecraft?next=${encodeURIComponent(req.path)}`);
      else throw error;
    }
  },
);
app.use((_req, res) => res.status(404).send("Page not found."));
app.use((error, req, res, _next) => {
  const status = error instanceof AuthError ? error.status : 503;
  const code = error instanceof AuthError ? error.code : "service_unavailable";
  if (!(error instanceof AuthError))
    console.error("Request failed:", error.message);
  if (
    req.path.startsWith("/api/") ||
    req.path.startsWith("/_drakora/api/") ||
    req.method !== "GET"
  )
    return res.status(status).json({ error: code });
  if (req.headers.host === todoHost) {
    if (req.headers["sec-fetch-dest"] === "iframe") {
      res.set(
        "Content-Security-Policy",
        `default-src 'none'; script-src 'self'; frame-ancestors ${config.staffOrigin}; base-uri 'none'`,
      );
      return res
        .status(status)
        .type("html")
        .send(workspaceFailureHtml(config, code));
    }
    if (code === "minecraft_name_required")
      return res.redirect(`${config.staffOrigin}/minecraft?next=/huly`);
    const message =
      code === "staff_permission_required"
        ? "Your staff permissions do not allow access to this workspace."
        : code === "dashboard_role_required"
          ? "You need the Dashboard role to sign in to Drakora Staff."
          : "Return to the staff portal to sign in or retry.";
    return res
      .status(status)
      .type("html")
      .send(
        `<!doctype html><html lang="en"><meta name="viewport" content="width=device-width"><title>Drakora access</title><body style="background:#313338;color:#f2f3f5;font:18px system-ui;padding:8vw"><h1>${status === 401 ? "Sign in to Drakora" : "Workspace access unavailable"}</h1><p>${message}</p><a style="color:#a6d0ff" href="${config.staffOrigin}/login?next=%2Fhuly">Continue with Discord</a></body></html>`,
      );
  }
  if (code === "minecraft_name_required")
    return res.redirect(
      `/minecraft?next=${encodeURIComponent(safeNext(req.path))}`,
    );
  res.redirect(`/login?error=${encodeURIComponent(code)}`);
});

const server = createServer(app);
server.on("upgrade", (req, socket, head) => {
  if (
    req.headers.host !== todoHost ||
    req.headers.origin !== config.todoOrigin ||
    req.headers["x-forwarded-proto"] !== "https"
  )
    return socket.destroy();
  const response = {
    getHeader() {},
    setHeader() {},
    writeHead() {},
    end() {
      socket.destroy();
    },
  };
  todoSession(req, response, async (error) => {
    try {
      if (error) throw error;
      const user = await signedIn(req);
      if (!user.permissions.todo || !matchingHulyIdentity(req, user))
        return socket.destroy();
      socket.userId = user.id;
      socket.staffSessionId = req.session.staffSessionId;
      socket.until = req.session.until;
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      proxy.upgrade(req, socket, head);
    } catch {
      socket.destroy();
    }
  });
});
const sweep = setInterval(async () => {
  store.clean();
  applicationDatabase?.store.clean();
  ticketDatabase?.store.clean();
  for (const socket of sockets) {
    try {
      if (
        socket.until < Date.now() ||
        !store.get("session", socket.staffSessionId)
      )
        throw new Error("Session expired");
      let user = await discord.check(socket.userId);
      if (
        !user.permissions.dashboard ||
        !user.permissions.todo ||
        !minecraft.get(user.id)
      )
        throw new Error("Access revoked");
      if (
        user.syncedAt !== user.checkedAt ||
        user.syncedPolicyRevision !== user.policyRevision
      )
        user = await huly.sync(user);
    } catch {
      socket.destroy();
    }
  }
}, 30000);
sweep.unref();
server.listen(3000, "0.0.0.0", () =>
  console.log("Drakora staff service ready."),
);
packVersions.start();
todoSync?.start();
trackerAccess?.start();
applications?.start();
tickets?.start();
retention.start();
reviews?.start();
partnerships?.start();
ticketEmails?.start();
ticketStaffNotices?.start();
rankAnnouncements?.start();
async function stop() {
  await rankAnnouncements?.close();
  await packVersions.close();
  clearInterval(minecraftBridgeTimer);
  if (minecraftBridgeListener)
    office.gateway.off("raw", minecraftBridgeListener);
  await minecraftRanks?.close();
  clearInterval(moderationTimer);
  await moderationRetry;
  await moderationTransport?.close();
  await connectedModeration.close();
  await reviews?.close();
  await retention.close();
  clearInterval(sweep);
  clearInterval(assignmentTimer);
  await onboarding?.close();
  await assignments?.close();
  await todoSync?.close();
  await trackerAccess?.close();
  await applications?.close();
  await partnerships?.close();
  await ticketEmails?.close();
  await ticketStaffNotices?.close();
  await tickets?.stop();
  await ticketTransport?.close();
  await honeypot?.close();
  await rulesPanel?.close();
  await office?.close();
  await mail?.close();
  for (const socket of sockets) socket.destroy();
  server.close(() => {
    store.close();
    applicationDatabase?.store.close();
    ticketDatabase?.store.close();
    process.exit(0);
  });
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
