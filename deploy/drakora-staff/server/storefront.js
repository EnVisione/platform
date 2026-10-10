import express from "express";
import { rateLimit } from "express-rate-limit";
import { isIP } from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { validStoreUsername } from "./store-wallet.js";
import {
  storeCommunityService,
  validateStoreCommunity,
} from "./store-community.js";
import {
  emptyStoreCatalog,
  validStoreSelection,
  storeProductKey,
} from "../shared/storefront.js";

const apiOrigin = "https://headless.tebex.io";
const failure = (code, status = 503) =>
  Object.assign(new Error(code), { code, status });
const validIdent = (value) =>
  typeof value === "string" && /^[a-zA-Z0-9-]{10,120}$/.test(value);

export function validateStorefront(config) {
  if (config.storefront === undefined) return;
  const settings = config.storefront;
  const commandProducts =
    settings?.commandProducts === undefined ? [] : settings.commandProducts;
  if (
    !settings ||
    Array.isArray(settings) ||
    typeof settings !== "object" ||
    !config.website
  )
    throw new Error(
      "Configure the public website before adding the storefront",
    );
  let origin;
  try {
    origin = new URL(settings.origin);
  } catch {
    throw new Error("Configure a separate HTTPS storefront origin");
  }
  if (
    origin.protocol !== "https:" ||
    origin.origin !== settings.origin ||
    [
      config.staffOrigin,
      config.todoOrigin,
      config.applications?.publicOrigin,
    ].includes(settings.origin)
  )
    throw new Error("Configure a separate HTTPS storefront origin");
  if (
    typeof settings.allowPurchases !== "boolean" ||
    (settings.publicToken !== undefined &&
      !/^[a-zA-Z0-9]{4,8}-[a-zA-Z0-9]{20,100}$/.test(settings.publicToken)) ||
    !Array.isArray(settings.products) ||
    settings.products.length > emptyStoreCatalog().length ||
    !Array.isArray(commandProducts) ||
    commandProducts.length !== 0 ||
    (settings.allowPurchases &&
      (!settings.publicToken || !settings.products.length))
  )
    throw new Error(
      "Configure the Tebex public token, purchase switch and store products",
    );
  const keys = new Set(),
    packages = new Set();
  validateStoreCommunity(settings);
  const mappings = settings.products;
  const categories = new Map();
  for (const product of mappings) {
    const key = validStoreSelection(product)
      ? storeProductKey(product)
      : undefined;
    if (
      !key ||
      product.rank === undefined ||
      keys.has(key) ||
      !Number.isSafeInteger(product.packageId) ||
      product.packageId < 1 ||
      packages.has(product.packageId) ||
      product.deliveryVerified !== true ||
      (product.billing === "monthly" && product.interval !== "P1M") ||
      (product.billing === "lifetime" &&
        (product.cumulativeVerified !== true ||
          !Number.isSafeInteger(product.categoryId) ||
          product.categoryId < 1))
    )
      throw new Error(
        "Map verified rank packages with cumulative categories and monthly P1M prerequisites",
      );
    const slot = emptyStoreCatalog().find(
      (item) => storeProductKey(item) === key,
    );
    if (slot.requiresRank) {
      const prerequisite = mappings.find(
        (item) =>
          item.rank === slot.requiresRank &&
          item.scope === product.scope &&
          item.billing === "lifetime",
      );
      if (
        !prerequisite ||
        product.requiredPackageId !== prerequisite.packageId ||
        product.prerequisiteVerified !== true
      )
        throw new Error(
          "Verify the matching top permanent rank requirement in Tebex before selling a monthly bonus",
        );
    } else {
      const previous = categories.get(product.scope);
      if (previous !== undefined && previous !== product.categoryId)
        throw new Error(
          "Keep each scope's permanent ranks in one cumulative Tebex category",
        );
      if (
        [...categories].some(
          ([scope, category]) =>
            scope !== product.scope && category === product.categoryId,
        )
      )
        throw new Error(
          "Use separate cumulative Tebex categories for the network and each modpack",
        );
      categories.set(product.scope, product.categoryId);
    }
    keys.add(key);
    packages.add(product.packageId);
  }
}

export function storefrontService(settings = {}, fetcher = fetch) {
  const account = `${apiOrigin}/api/accounts/${settings.publicToken}`;
  const mappings = settings.products ?? [];
  let cache;
  async function api(path, body, basket = false) {
    const response = await fetcher(
      `${basket ? apiOrigin + "/api/baskets" : account}${path}`,
      {
        method: body ? "POST" : "GET",
        headers: {
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(10000),
        redirect: "error",
      },
    );
    if (!response.ok)
      throw failure(
        response.status === 422
          ? "tebex_rejected_checkout"
          : "store_unavailable",
        response.status === 422 ? 422 : 503,
      );
    return response.json();
  }
  async function catalog(fresh = false) {
    if (!settings.publicToken || !mappings.length)
      return {
        products: emptyStoreCatalog(),
        acceptingPayments: false,
      };
    if (!fresh && cache && cache.until > Date.now()) return cache.value;
    const response = await api("/packages");
    if (!Array.isArray(response.data)) throw failure("store_unavailable");
    const packages = new Map(
      response.data.map((product) => [product.id, product]),
    );
    const mapped = new Map(
      mappings.map((product) => [storeProductKey(product), product]),
    );
    const priceProduct = (slot) => {
      const mapping = mapped.get(storeProductKey(slot));
      const product = packages.get(mapping?.packageId);
      const correctBilling =
        product?.type ===
        (slot.billing === "monthly" ? "subscription" : "single");
      const validPrice =
        Number.isFinite(product?.base_price) &&
        product.base_price > 0 &&
        product.currency === slot.currency &&
        Math.round(product.base_price * 100) === Math.round(slot.price * 100);
      if (
        !mapping?.deliveryVerified ||
        !correctBilling ||
        !validPrice ||
        product.disabled === true
      )
        return slot;
      return {
        ...slot,
        available: settings.allowPurchases === true,
      };
    };
    const products = emptyStoreCatalog().map(priceProduct);
    const value = {
      products,
      acceptingPayments: products.some((product) => product.available),
    };
    cache = { value, until: Date.now() + 15000 };
    return value;
  }
  return {
    ...storeCommunityService(settings, fetcher),
    catalog,
    async checkout(input, ipAddress, origin, giftCard) {
      if (
        !validStoreSelection(input) ||
        typeof input.username !== "string" ||
        !/^[A-Za-z0-9_]{3,16}$/.test(input.username)
      )
        throw failure("invalid_store_selection", 400);
      const ip = String(ipAddress).replace(/^::ffff:/, "");
      if (!isIP(ip)) throw failure("invalid_checkout_address", 400);
      const current = await catalog(true);
      const unavailable = "rank_unavailable";
      if (
        !current.products.some(
          (product) =>
            storeProductKey(product) === storeProductKey(input) &&
            product.available,
        )
      )
        throw failure(unavailable, 409);
      const mapping = mappings.find(
        (product) => storeProductKey(product) === storeProductKey(input),
      );
      const basket = (
        await api("/baskets", {
          username: input.username,
          ip_address: ip,
          complete_url: `${origin}/store/thank-you`,
          cancel_url: `${origin}/store/${input.scope === "network" ? "network-ranks" : "server-ranks"}`,
          complete_auto_redirect: true,
        })
      ).data;
      if (!validIdent(basket?.ident)) throw failure("store_unavailable");
      let result = (
        await api(
          `/${basket.ident}/packages`,
          { package_id: String(mapping.packageId), quantity: 1 },
          true,
        )
      ).data;
      const added = result?.packages?.find(
        (product) => product.id === mapping.packageId,
      );
      if (
        !added ||
        added.type !== (input.billing === "monthly" ? "subscription" : "single")
      )
        throw failure(unavailable, 409);
      if (giftCard) {
        result = (
          await api(`/baskets/${basket.ident}/giftcards`, {
            card_number: giftCard,
          })
        ).data;
        if (
          result?.ident !== basket.ident ||
          !result.giftcards?.some((card) => card.card_number === giftCard)
        )
          throw failure("gift_card_checkout_failed", 422);
      }
      let checkout;
      try {
        checkout = new URL(result.links.checkout);
      } catch {
        throw failure("store_unavailable");
      }
      if (
        checkout.protocol !== "https:" ||
        checkout.hostname !== "checkout.tebex.io" ||
        checkout.port ||
        checkout.username ||
        checkout.password
      )
        throw failure("store_unavailable");
      return { ident: basket.ident, checkoutUrl: checkout.href };
    },
  };
}

export function storefrontRouter(service, origins, wallet, options = {}) {
  const router = express.Router();
  router.use(
    "/store/api",
    rateLimit({
      windowMs: 60000,
      limit: 40,
      legacyHeaders: false,
      standardHeaders: "draft-8",
    }),
  );
  const requestOrigin = (req) => {
    const origin = origins.find(
      (value) => new URL(value).host === req.headers.host,
    );
    if (!origin) throw failure("store_origin_required", 403);
    return origin;
  };
  const mutation = (req) => {
    const origin = requestOrigin(req);
    if (req.headers.origin !== origin)
      throw failure("store_origin_required", 403);
    const actual = req.headers["x-csrf-token"],
      expected = req.session?.storeCsrf;
    if (
      wallet &&
      (typeof actual !== "string" ||
        typeof expected !== "string" ||
        Buffer.byteLength(actual) !== Buffer.byteLength(expected) ||
        !timingSafeEqual(Buffer.from(actual), Buffer.from(expected)))
    )
      throw failure("invalid_store_request", 403);
    return origin;
  };
  const saveSession = (req) =>
    new Promise((resolve, reject) =>
      req.session.save((error) => (error ? reject(error) : resolve())),
    );
  const regenerateSession = (req) =>
    new Promise((resolve, reject) =>
      req.session.regenerate((error) => (error ? reject(error) : resolve())),
    );
  if (wallet) {
    router.get("/store/api/wallet", async (req, res) => {
      req.session.storeCsrf ??= randomBytes(32).toString("base64url");
      await saveSession(req);
      res.json({
        ...wallet.snapshot(req.session),
        csrf: req.session.storeCsrf,
        enabled: options.giftCardsEnabled === true,
      });
    });
    router.post(
      "/store/api/wallet/connect",
      express.json({ limit: "1kb" }),
      async (req, res) => {
        const origin = mutation(req);
        if (!validStoreUsername(req.body?.username))
          throw failure("minecraft_login_required", 401);
        req.session.storeMinecraft = req.body.username;
        await saveSession(req);
        const challenge = wallet.challenge(req.sessionID, origin);
        res.json({
          url: `${options.staffOrigin}/auth/discord?purpose=store&challenge=${challenge}`,
        });
      },
    );
    router.get("/store/auth/consume", async (req, res) => {
      const origin = requestOrigin(req);
      try {
        const identity = wallet.consume(
          req.query.handoff,
          req.sessionID,
          origin,
        );
        const carried = {
          storeCards: req.session.storeCards,
          storeMinecraft: req.session.storeMinecraft,
        };
        wallet.link(carried, identity);
        await regenerateSession(req);
        Object.assign(req.session, carried, {
          storeCsrf: randomBytes(32).toString("base64url"),
        });
        await saveSession(req);
        res.redirect(`${origin}/store#store-gift-cards`);
      } catch {
        res.redirect(
          `${origin}/store?giftCardError=discord_link_failed#store-gift-cards`,
        );
      }
    });
    router.post(
      "/store/api/wallet/sign-out",
      express.json({ limit: "1kb" }),
      async (req, res) => {
        mutation(req);
        await regenerateSession(req);
        req.session.storeCsrf = randomBytes(32).toString("base64url");
        await saveSession(req);
        res.json({
          ...wallet.snapshot(req.session),
          csrf: req.session.storeCsrf,
          enabled: options.giftCardsEnabled === true,
        });
      },
    );
    router.post(
      "/store/api/wallet/:id/refresh",
      express.json({ limit: "1kb" }),
      async (req, res) => {
        mutation(req);
        const result = await wallet.refresh(req.session, req.params.id);
        await saveSession(req);
        res.json(result);
      },
    );
    router.delete("/store/api/wallet/:id", async (req, res) => {
      mutation(req);
      const result = wallet.forget(req.session, req.params.id);
      await saveSession(req);
      res.json(result);
    });
  }
  router.get("/store/api/catalog", async (_req, res) =>
    res.json(await service.catalog()),
  );
  router.get("/store/api/community", async (_req, res) =>
    res.set("Cache-Control", "no-store").json(await service.community()),
  );
  router.get("/store/api/minecraft/:name", async (req, res) => {
    if (!validStoreUsername(req.params.name))
      throw failure("invalid_minecraft_name", 400);
    if (!options.minecraftProfile)
      throw failure("player_preview_unavailable", 503);
    res
      .set("Cache-Control", "no-store")
      .json(await options.minecraftProfile(req.params.name));
  });
  router.post(
    "/store/api/gift-card",
    rateLimit({
      windowMs: 60000,
      limit: 5,
      legacyHeaders: false,
      standardHeaders: "draft-8",
    }),
    express.json({ limit: "1kb" }),
    async (req, res) => {
      mutation(req);
      if (!validStoreUsername(req.body?.username))
        throw failure("minecraft_login_required", 401);
      const result = wallet
        ? await wallet.register(req.session, req.body)
        : await service.giftCard(req.body);
      if (wallet) await saveSession(req);
      res.set("Cache-Control", "no-store").json(result);
    },
  );
  router.post(
    "/store/api/checkout",
    express.json({ limit: "2kb" }),
    async (req, res) => {
      const origin = mutation(req);
      const code =
        req.body?.giftCardId && wallet
          ? wallet.checkoutCode(
              req.session,
              req.body.giftCardId,
              req.body.username,
            )
          : undefined;
      if (req.body?.giftCardId && !code)
        throw failure("gift_card_not_found", 404);
      res
        .set("Cache-Control", "no-store")
        .json(await service.checkout(req.body, req.ip, origin, code));
    },
  );
  router.use((error, _req, res, _next) => {
    const status =
      error.type === "entity.too.large"
        ? 413
        : error.type === "entity.parse.failed"
          ? 400
          : (error.status ?? 503);
    res.status(status).json({
      error: typeof error.code === "string" ? error.code : "store_unavailable",
    });
  });
  return router;
}
