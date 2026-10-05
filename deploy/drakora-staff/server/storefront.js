import express from "express";
import { rateLimit } from "express-rate-limit";
import { isIP } from "node:net";
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
    settings.products.length > 42 ||
    (settings.allowPurchases &&
      (!settings.publicToken || !settings.products.length))
  )
    throw new Error(
      "Configure the Tebex public token, purchase switch and rank products",
    );
  const keys = new Set(),
    packages = new Set();
  for (const product of settings.products) {
    const key = validStoreSelection(product)
      ? storeProductKey(product)
      : undefined;
    if (
      !key ||
      keys.has(key) ||
      !Number.isSafeInteger(product.packageId) ||
      product.packageId < 1 ||
      packages.has(product.packageId) ||
      product.deliveryVerified !== true ||
      (product.billing === "monthly" && product.interval !== "P1M")
    )
      throw new Error(
        "Map each rank option to a unique, verified Tebex package; monthly products require P1M",
      );
    keys.add(key);
    packages.add(product.packageId);
  }
}

export function storefrontService(settings = {}, fetcher = fetch) {
  const account = `${apiOrigin}/api/accounts/${settings.publicToken}`;
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
    if (!settings.publicToken || !settings.products?.length)
      return { products: emptyStoreCatalog(), acceptingPayments: false };
    if (!fresh && cache && cache.until > Date.now()) return cache.value;
    const response = await api("/packages");
    if (!Array.isArray(response.data)) throw failure("store_unavailable");
    const packages = new Map(
      response.data.map((product) => [product.id, product]),
    );
    const mapped = new Map(
      settings.products.map((product) => [storeProductKey(product), product]),
    );
    const products = emptyStoreCatalog().map((slot) => {
      const mapping = mapped.get(storeProductKey(slot));
      const product = packages.get(mapping?.packageId);
      const correctBilling =
        product?.type ===
        (slot.billing === "monthly" ? "subscription" : "single");
      const validPrice =
        Number.isFinite(product?.base_price) &&
        product.base_price > 0 &&
        /^[A-Z]{3}$/.test(product.currency ?? "");
      if (
        !mapping?.deliveryVerified ||
        !correctBilling ||
        !validPrice ||
        product.disabled === true
      )
        return slot;
      return {
        ...slot,
        price: product.base_price,
        currency: product.currency,
        available: settings.allowPurchases === true,
      };
    });
    const value = {
      products,
      acceptingPayments: products.some((product) => product.available),
    };
    cache = { value, until: Date.now() + 15000 };
    return value;
  }
  return {
    catalog,
    async checkout(input, ipAddress, origin) {
      if (
        !validStoreSelection(input) ||
        typeof input.username !== "string" ||
        !/^[A-Za-z0-9_]{3,16}$/.test(input.username)
      )
        throw failure("invalid_store_selection", 400);
      const ip = String(ipAddress).replace(/^::ffff:/, "");
      if (!isIP(ip)) throw failure("invalid_checkout_address", 400);
      const current = await catalog(true);
      if (
        !current.products.some(
          (product) =>
            storeProductKey(product) === storeProductKey(input) &&
            product.available,
        )
      )
        throw failure("rank_unavailable", 409);
      const mapping = settings.products.find(
        (product) => storeProductKey(product) === storeProductKey(input),
      );
      const basket = (
        await api("/baskets", {
          username: input.username,
          ip_address: ip,
          complete_url: `${origin}/store/thank-you`,
          cancel_url: `${origin}/store`,
          complete_auto_redirect: true,
        })
      ).data;
      if (!validIdent(basket?.ident)) throw failure("store_unavailable");
      const result = (
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
        throw failure("rank_unavailable", 409);
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

export function storefrontRouter(service, origins) {
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
  router.get("/store/api/catalog", async (_req, res) =>
    res.json(await service.catalog()),
  );
  router.post(
    "/store/api/checkout",
    express.json({ limit: "2kb" }),
    async (req, res) => {
      const origin = origins.find(
        (value) => new URL(value).host === req.headers.host,
      );
      if (!origin || req.headers.origin !== origin)
        throw failure("store_origin_required", 403);
      res
        .set("Cache-Control", "no-store")
        .json(await service.checkout(req.body, req.ip, origin));
    },
  );
  router.use((error, _req, res, _next) => {
    const status =
      error.type === "entity.too.large"
        ? 413
        : error.type === "entity.parse.failed"
          ? 400
          : (error.status ?? 503);
    res
      .status(status)
      .json({
        error:
          typeof error.code === "string" ? error.code : "store_unavailable",
      });
  });
  return router;
}
