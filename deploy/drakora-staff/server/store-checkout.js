import { storeBuyer } from "./store-account.js";
import { parseCoinAmount } from "../shared/store-tip-jar.js";
import { isTebexCheckoutUrl } from "../shared/tebex-checkout.js";
import { isAbsolute } from "node:path";
import { isIP } from "node:net";
import { randomBytes } from "node:crypto";
import { bridgeUuid } from "./minecraft-bridge.js";
import { readPrivateKey } from "./private-key.js";
import { hash } from "./store.js";
import { createLoyaltyCoupon } from "./tebex-coupons.js";
import { storeProductKey, validStoreSelection } from "../shared/storefront.js";

const failure = (code, status = 503) =>
  Object.assign(new Error(code), { code, status });
export function validateStoreCheckout(settings) {
  if (settings === undefined) return;
  if (
    !settings ||
    Array.isArray(settings) ||
    typeof settings !== "object" ||
    Object.keys(settings).some(
      (key) => !["enabled", "projectId", "secretFile"].includes(key),
    ) ||
    typeof settings.enabled !== "boolean" ||
    (settings.enabled &&
      (!Number.isSafeInteger(settings.projectId) ||
        settings.projectId < 1 ||
        typeof settings.secretFile !== "string" ||
        !isAbsolute(settings.secretFile)))
  )
    throw new Error(
      "Configure the protected Tebex Checkout API with a private key file",
    );
}
export function supporterCheckoutReady(settings) {
  return (
    Boolean(settings.publicToken && settings.headlessSecretFile) &&
    Number.isSafeInteger(settings.supporterCoins?.packageId) &&
    settings.supporterCoins.packageId > 0 &&
    settings.supporterCoins.pricingVerified === true &&
    settings.webhooks?.enabled === true &&
    settings.webhooks.acceptPayments === true &&
    (settings.webhooks.mode === "production"
      ? settings.allowPurchases === true &&
        settings.supporterCoins.deliveryVerified === true
      : settings.webhooks.providerTestModeVerified === true)
  );
}

export function protectedCheckoutReady(settings) {
  return (
    Boolean(settings.publicToken && settings.headlessSecretFile) &&
    settings.plus?.protectedCheckoutVerified === true &&
    settings.webhooks?.enabled === true &&
    settings.webhooks.acceptPayments === true &&
    (settings.webhooks.mode === "production"
      ? settings.allowPurchases === true
      : settings.webhooks.providerTestModeVerified === true)
  );
}
export function loyaltyCheckoutReady(settings) {
  return (
    Boolean(
      settings.pluginSecret &&
        settings.publicToken &&
        settings.headlessSecretFile,
    ) &&
    settings.plus?.loyaltyCheckoutVerified === true &&
    settings.webhooks?.enabled === true &&
    settings.webhooks.acceptPayments === true &&
    (settings.webhooks.mode === "production" ||
      settings.webhooks.providerTestModeVerified === true)
  );
}

function cents(value, code = "plus_discount_basket_conflict") {
  const amount = Math.round(value * 100);
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    !Number.isSafeInteger(amount) ||
    amount > 100000000 ||
    Math.abs(value * 100 - amount) > 0.000001
  )
    throw failure(code, 409);
  return amount;
}
const empty = (value) =>
  value === undefined ||
  value === null ||
  (Array.isArray(value) && value.length === 0);
function headlessPrice(basket, packageId, recipient, amount, couponCode) {
  const row = basket?.packages?.[0];
  if (
    basket?.complete !== false ||
    basket.currency !== "USD" ||
    basket.username?.toLowerCase() !== recipient.name?.toLowerCase() ||
    basket.packages?.length !== 1 ||
    row?.id !== packageId ||
    (row.type !== "single" &&
      !(row.type === undefined && row.is_recurring === false)) ||
    row.in_basket?.quantity !== 1 ||
    row.is_recurring === true ||
    row.in_basket.gift_username ||
    row.in_basket.gift_username_id ||
    !empty(row.revenue_share) ||
    (couponCode
      ? basket.coupons?.length !== 1 || basket.coupons[0].code !== couponCode
      : !empty(basket.coupons)) ||
    !empty(basket.giftcards) ||
    cents(basket.base_price) !== amount ||
    cents(row.in_basket.price) !== amount ||
    cents(basket.total_price) !== amount + cents(basket.sales_tax)
  )
    throw failure("plus_discount_basket_conflict", 409);
}
export function storeCheckoutService(
  store,
  settings,
  plus,
  events,
  fetcher = fetch,
  now = Date.now,
) {
  validateStoreCheckout(settings.checkout);
  const enabled = protectedCheckoutReady(settings);
  const loyaltyEnabled = loyaltyCheckoutReady(settings);
  const coinsEnabled = supporterCheckoutReady(settings);
  const headlessKey =
    enabled || coinsEnabled
      ? readPrivateKey(settings.headlessSecretFile, "Tebex Headless API key")
      : undefined;
  const headlessAccount = `https://headless.tebex.io/api/accounts/${settings.publicToken}`;
  async function headless(url, body, signal, authenticated = false) {
    const response = await fetcher(url, {
      method: body ? "POST" : "GET",
      redirect: "error",
      signal,
      headers: {
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(authenticated
          ? {
              Authorization: `Basic ${Buffer.from(`${settings.publicToken}:${headlessKey}`).toString("base64")}`,
            }
          : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok)
      throw Object.assign(failure("plus_checkout_unavailable"), {
        providerStatus: response.status,
      });
    return (await response.json()).data;
  }
  const plusRequests = new Set();
  async function emptyPlusBasket(order, checkout) {
    if (!/^[A-Za-z0-9-]{10,120}$/.test(checkout.basketIdent ?? ""))
      throw failure("plus_checkout_cleanup_required");
    const signal = AbortSignal.timeout(10000);
    const read = async () => {
      const basket = await headless(
        `${headlessAccount}/baskets/${checkout.basketIdent}`,
        undefined,
        signal,
      );
      const token = basket?.custom?.drakora_order;
      if (
        basket?.ident !== checkout.basketIdent ||
        basket.complete !== false ||
        basket.username?.toLowerCase() !== order.name.toLowerCase() ||
        typeof token !== "string" ||
        hash(token) !== checkout.tokenHash ||
        !Array.isArray(basket.packages) ||
        basket.packages.some((row) => row.id !== checkout.packageId)
      )
        throw failure("plus_checkout_cleanup_required");
      return basket;
    };
    let basket = await read();
    if (basket.packages.length === 0) return;
    let removalError;
    try {
      await headless(
        `https://headless.tebex.io/api/baskets/${checkout.basketIdent}/packages/remove`,
        { package_id: String(checkout.packageId) },
        signal,
      );
    } catch (error) {
      removalError = error;
    }
    // A lost removal response does not establish whether the basket is still payable.
    basket = await read();
    if (basket.packages.length !== 0)
      throw removalError ?? failure("plus_checkout_cleanup_required");
  }
  return {
    async supporterCoins(
      buyer,
      amount,
      origin,
      custom,
      ipAddress,
      recipient = buyer,
    ) {
      if (!coinsEnabled) throw failure("supporter_coins_unavailable");
      const coins = parseCoinAmount(amount);
      if (coins === null) throw failure("invalid_coin_amount", 400);
      const uuid = bridgeUuid(buyer.uuid);
      bridgeUuid(recipient.uuid);
      const ip = String(ipAddress ?? "").replace(/^::ffff:/, "");
      if (
        settings.webhooks.mode !== "production" &&
        !settings.webhooks.testBuyers?.some(
          (value) => bridgeUuid(value) === uuid,
        )
      )
        throw failure("supporter_coins_test_buyer_required", 403);
      if (
        !/^[A-Za-z0-9_]{3,16}$/.test(buyer.name ?? "") ||
        !/^[A-Za-z0-9_]{3,16}$/.test(recipient.name ?? "") ||
        !isIP(ip)
      )
        throw failure("invalid_checkout_address", 400);
      if (!/^[A-Za-z0-9_-]{43}$/.test(custom?.drakora_supporter_order ?? ""))
        throw failure("supporter_coins_order_missing");
      const packageId = settings.supporterCoins.packageId;
      const denominations = [
        { packageId, coins: 100 },
        ...(settings.supporterCoins.denominations ?? []),
      ].sort((a, b) => b.coins - a.coins);
      let remaining = coins;
      const lines = [];
      for (const denomination of denominations) {
        const quantity = Math.floor(remaining / denomination.coins);
        if (quantity > 50)
          throw failure("supporter_coins_amount_unavailable", 400);
        if (quantity) {
          lines.push({ ...denomination, quantity });
          remaining %= denomination.coins;
        }
      }
      if (remaining) throw failure("supporter_coins_amount_unavailable", 400);
      const signal = AbortSignal.timeout(25000);
      let basket;
      let stage = "package_validation";
      try {
        await Promise.all(
          lines.map(async (line) => {
            const product = await headless(
              `${headlessAccount}/packages/${line.packageId}`,
              undefined,
              signal,
            );
            if (
              product?.id !== line.packageId ||
              product.type !== "single" ||
              product.currency !== "USD" ||
              product.base_price !== line.coins / 100 ||
              product.disable_gifting !== true ||
              product.disable_quantity !== false
            )
              throw failure("supporter_coins_price_mismatch", 409);
          }),
        );
        stage = "basket_creation";
        basket = await headless(
          `${headlessAccount}/baskets`,
          {
            username: recipient.name,
            ip_address: ip,
            custom,
            complete_url: `${origin}/store/thank-you`,
            cancel_url: `${origin}/store/tip-jar`,
            complete_auto_redirect: true,
          },
          signal,
          true,
        );
        if (!/^[A-Za-z0-9-]{10,120}$/.test(basket?.ident ?? ""))
          throw failure("supporter_coins_checkout_unavailable");
        let result;
        stage = "package_addition";
        for (const line of lines) {
          result = await headless(
            `https://headless.tebex.io/api/baskets/${basket.ident}/packages`,
            { package_id: String(line.packageId), quantity: line.quantity },
            signal,
          );
        }
        const expectedPrices = new Map(
          lines.map((line) => [line.packageId, line.coins]),
        );
        if (
          typeof result?.currency !== "string" ||
          !/^[A-Z]{3}$/.test(result.currency)
        )
          throw Object.assign(failure("supporter_coins_price_mismatch", 409), {
            validationField: "currency",
          });
        if (result.currency !== "USD") {
          stage = "localized_package_validation";
          await Promise.all(
            lines.map(async (line) => {
              const product = await headless(
                `${headlessAccount}/packages/${line.packageId}?basketIdent=${encodeURIComponent(basket.ident)}`,
                undefined,
                signal,
              );
              if (
                product?.id !== line.packageId ||
                product.type !== "single" ||
                product.currency !== result.currency ||
                product.disable_gifting !== true ||
                product.disable_quantity !== false
              )
                throw Object.assign(failure("supporter_coins_price_mismatch", 409), {
                  validationField: "localized_package",
                });
              const price = cents(product.base_price, "supporter_coins_price_mismatch");
              if (price <= 0)
                throw Object.assign(failure("supporter_coins_price_mismatch", 409), {
                  validationField: "localized_price",
                });
              expectedPrices.set(line.packageId, price);
            }),
          );
        }
        const expectedSubtotal = lines.reduce(
          (sum, line) => sum + expectedPrices.get(line.packageId) * line.quantity,
          0,
        );
        stage = "checkout_validation";
        let url;
        try {
          url = new URL(result?.links?.checkout);
        } catch {
          throw failure("supporter_coins_checkout_unavailable");
        }
        const validationField = (() => {
          if (result.complete !== false) return "completion_state";
          if (result.ident !== basket.ident) return "basket_identifier";
          if (result.username?.toLowerCase() !== recipient.name.toLowerCase())
            return "username";
          if (result.packages?.length !== lines.length) return "package_count";
          if (
            new Set(result.packages.map((row) => row.id)).size !== lines.length
          )
            return "package_ids";
          for (const line of lines) {
            const row = result.packages.find(
              (row) => row.id === line.packageId,
            );
            if (!row) return "package_row";
            if (row.in_basket?.quantity !== line.quantity) return "quantity";
            if (row.in_basket.price !== expectedPrices.get(line.packageId) / 100)
              return "package_price";
            if (row.is_recurring !== false) return "recurrence";
            if (row.type !== undefined && row.type !== "single")
              return "package_type";
            if (row.in_basket.gift_username || row.in_basket.gift_username_id)
              return "gift_recipient";
            if (!empty(row.revenue_share)) return "revenue_share";
          }
          if (!empty(result.coupons)) return "coupons";
          if (!empty(result.giftcards)) return "giftcards";
          if (
            result.custom?.drakora_supporter_order !==
            custom.drakora_supporter_order
          )
            return "order_metadata";
          if (cents(result.base_price) !== expectedSubtotal) return "base_price";
          if (cents(result.total_price) !== expectedSubtotal + cents(result.sales_tax))
            return "total_price";
          if (!isTebexCheckoutUrl(url)) return "checkout_url";
          return undefined;
        })();
        if (validationField)
          throw Object.assign(failure("supporter_coins_price_mismatch", 409), {
            validationField,
          });
        return { ident: basket.ident, checkoutUrl: url.href };
      } catch (error) {
        const failedStage = stage;
        let cleanupFailed = false;
        if (/^[A-Za-z0-9-]{10,120}$/.test(basket?.ident ?? "")) {
          try {
            let cleaned = await headless(
              `${headlessAccount}/baskets/${basket.ident}`,
              undefined,
              AbortSignal.timeout(10000),
            );
            for (const line of lines) {
              if (cleaned?.packages?.some((row) => row.id === line.packageId))
                cleaned = await headless(
                  `https://headless.tebex.io/api/baskets/${basket.ident}/packages/remove`,
                  { package_id: String(line.packageId) },
                  AbortSignal.timeout(10000),
                );
            }
            if (cleaned?.packages?.length !== 0)
              throw failure("supporter_coins_cleanup_failed");
          } catch {
            cleanupFailed = true;
            store.set(
              "store-coin-checkout-cleanup",
              hash(basket.ident),
              {
                uuid,
                basketIdent: basket.ident,
                packageId,
                packageIds: lines.map((line) => line.packageId),
                createdAt: now(),
              },
              Number.MAX_SAFE_INTEGER,
            );
          }
        }
        const code =
          typeof error?.code === "string" &&
          /^[a-z][a-z0-9_]{0,79}$/.test(error.code)
            ? error.code
            : "unknown";
        console.warn(
          "supporter_coin_checkout_failed",
          JSON.stringify({
            stage: failedStage,
            code,
            providerStatus: Number.isInteger(error?.providerStatus)
              ? error.providerStatus
              : undefined,
            validationField:
              typeof error?.validationField === "string" &&
              /^[a-z_]{1,32}$/.test(error.validationField)
                ? error.validationField
                : undefined,
            errorType:
              typeof error?.name === "string" &&
              /^[A-Za-z]{1,40}$/.test(error.name)
                ? error.name
                : undefined,
            cleanupFailed,
          }),
        );
        if (error?.code === "supporter_coins_price_mismatch") {
          error.supporterCoinDiagnosticLogged = true;
          throw error;
        }
        const mapped = failure("supporter_coins_checkout_unavailable");
        mapped.supporterCoinDiagnosticLogged = true;
        throw mapped;
      }
    },
    rankSaleReady: loyaltyEnabled,
    authorizeRankSale(session, recipient, selection) {
      if (!loyaltyEnabled) throw failure("plus_checkout_not_configured", 409);
      if (
        selection?.upgradeFrom !== undefined ||
        !validStoreSelection(selection)
      )
        throw failure("invalid_store_selection", 400);
      const prices = plus.rankPricesForSession(session, recipient);
      const mapping = (settings.products ?? []).find(
        (item) => storeProductKey(item) === storeProductKey(selection),
      );
      const quote = prices.products.find(
        (item) => storeProductKey(item) === storeProductKey(selection),
      );
      if (prices.status !== "eligible" || !mapping || !quote)
        throw failure("plus_discount_changed", 409);
      const token = randomBytes(32).toString("base64url");
      store.set(
        "store-rank-order",
        hash(token),
        {
          kind: "rank-loyalty",
          uuid: bridgeUuid(recipient.uuid),
          name: recipient.name,
          buyerUuid: storeBuyer(session, store)?.uuid,
          packageId: mapping.packageId,
          rank: mapping.rank,
          scope: mapping.scope,
          approvedPriceCents: quote.subtotalCents,
          discountBasisPoints: quote.discountBasisPoints,
          createdAt: now(),
          expiresAt: Math.min(
            now() + 1800000,
            prices.permanent === true && prices.discountUntil === null
              ? now() + 1800000
              : (prices.discountUntil ?? prices.paidThrough) * 1000,
          ),
          verified: false,
        },
        Number.MAX_SAFE_INTEGER,
      );
      return { token, custom: { drakora_loyalty_order: token } };
    },
    cancelRankSale(token) {
      if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token))
        return false;
      const orderKey = hash(token);
      return store.transaction(() => {
        const order = store.get("store-rank-order", orderKey);
        if (
          order?.kind !== "rank-loyalty" ||
          order.verified !== false ||
          order.basketIdent ||
          order.transactionId
        )
          return false;
        store.delete("store-rank-order", orderKey);
        return true;
      });
    },
    async rankSale(
      session,
      recipient,
      basket,
      packageId,
      approvedPriceCents,
      signal,
      readHeadless,
      token,
    ) {
      if (!loyaltyEnabled) throw failure("plus_checkout_not_configured", 409);
      const orderKey =
        typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token)
          ? hash(token)
          : undefined;
      const order = orderKey && store.get("store-rank-order", orderKey);
      if (
        !order ||
        order.kind !== "rank-loyalty" ||
        order.upgradeFrom !== undefined ||
        order.packageId !== packageId ||
        order.uuid !== bridgeUuid(recipient.uuid) ||
        (order.buyerUuid ?? order.uuid) !== storeBuyer(session, store)?.uuid ||
        order.approvedPriceCents !== approvedPriceCents ||
        order.expiresAt <= now()
      )
        throw failure("rank_checkout_binding_required", 403);
      const ident = basket?.ident;
      if (typeof ident !== "string" || !/^[A-Za-z0-9-]{10,120}$/.test(ident))
        throw failure("plus_discount_basket_conflict", 409);
      const subtotal = cents(basket.base_price);
      if (subtotal <= 0 || subtotal !== approvedPriceCents)
        throw failure("plus_discount_basket_conflict", 409);
      headlessPrice(basket, packageId, recipient, subtotal);
      const quote = () => {
        if (plus.rankPricesForSession(session, recipient).status !== "eligible")
          throw failure("plus_discount_changed", 409);
        return plus.quote({
          uuid: recipient.uuid,
          subtotalCents: subtotal,
          kind: "rank",
        });
      };
      const before = quote();
      if (before.discountBasisPoints !== order.discountBasisPoints)
        throw failure("plus_discount_changed", 409);
      let coupon;
      try {
        coupon = await createLoyaltyCoupon(settings, order, fetcher, signal);
      } catch (error) {
        if (error.cleanupRequired && Number.isSafeInteger(error.couponId))
          store.set(
            "store-coupon-cleanup",
            String(error.couponId),
            { couponId: error.couponId, expiresAt: order.expiresAt },
            Number.MAX_SAFE_INTEGER,
          );
        throw error;
      }
      let readback;
      try {
        if (quote().discountBasisPoints !== before.discountBasisPoints)
          throw failure("plus_discount_changed", 409);
        const response = await fetcher(
          `${headlessAccount}/baskets/${ident}/coupons`,
          {
            method: "POST",
            redirect: "error",
            signal: signal
              ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
              : AbortSignal.timeout(10000),
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ coupon_code: coupon.code }),
          },
        );
        if (!response.ok || (await response.json()).success !== true)
          throw failure("plus_discount_unavailable");
        readback = await readHeadless();
        if (readback.ident !== ident)
          throw failure("plus_discount_basket_conflict", 409);
        headlessPrice(
          readback,
          packageId,
          recipient,
          before.totalCents,
          coupon.code,
        );
        if (
          quote().discountBasisPoints !== before.discountBasisPoints ||
          order.expiresAt <= now()
        )
          throw failure("plus_discount_changed", 409);
      } catch (error) {
        try {
          await coupon.remove();
        } catch {
          store.set(
            "store-coupon-cleanup",
            String(coupon.id),
            { couponId: coupon.id, expiresAt: order.expiresAt },
            Number.MAX_SAFE_INTEGER,
          );
        }
        throw error;
      }
      store.set(
        "store-rank-order",
        orderKey,
        {
          ...order,
          verified: true,
          basketIdent: ident,
          subtotalCents: before.subtotalCents,
          discountCents: before.discountCents,
          totalCents: before.totalCents,
          taxCents: cents(readback.sales_tax),
          couponId: coupon.id,
        },
        Number.MAX_SAFE_INTEGER,
      );
      return before;
    },
    async plus(session, origin, ipAddress) {
      const buyer = storeBuyer(session, store);
      if (!buyer) throw failure("store_minecraft_required", 400);
      if (plusRequests.has(buyer.uuid))
        throw failure("plus_checkout_in_progress", 409);
      plusRequests.add(buyer.uuid);
      let stage = "eligibility";
      let cleanupFailed = false;
      let cleanupProviderStatus;
      try {
        if (!enabled) throw failure("plus_provider_checkout_disabled");
        const account = plus.forSession(session);
        if (!account.purchaseEligible)
          throw failure("store_minecraft_required", 400);
        if (account.plus?.active || account.hasSubscription)
          throw failure("plus_already_active", 409);
        if (!account.offer.available)
          throw failure("plus_provider_checkout_disabled");
        const variant = settings.plus.packages?.find(
          (item) => item.archDragon === account.offer.archDragon,
        );
        if (!variant) throw failure("plus_provider_checkout_disabled");
        const ip = String(ipAddress).replace(/^::ffff:/, "");
        if (!isIP(ip)) throw failure("invalid_checkout_address", 400);
        const owner = storeBuyer(session, store);
        let prior = store.get("store-plus-checkout", owner.uuid);
        if (prior?.cleanupRequired) {
          stage = "checkout_recovery";
          const previous = store.get("store-plus-order", prior.tokenHash);
          if (
            previous?.kind !== "plus" ||
            previous.uuid !== owner.uuid ||
            previous.packageId !== prior.packageId ||
            previous.verified === true
          )
            throw failure("plus_checkout_cleanup_required");
          try {
            await emptyPlusBasket(previous, prior);
          } catch (error) {
            cleanupFailed = true;
            cleanupProviderStatus = error.providerStatus;
            throw failure("plus_checkout_cleanup_required");
          }
          store.transaction(() => {
            const current = store.get("store-plus-checkout", owner.uuid);
            if (
              current?.tokenHash !== prior.tokenHash ||
              current.basketIdent !== prior.basketIdent ||
              current.cleanupRequired !== true
            )
              throw failure("plus_checkout_in_progress", 409);
            store.delete("store-plus-checkout", owner.uuid);
          });
          prior = undefined;
        }
        if (prior?.expiresAt > now()) {
          if (prior.result && prior.packageId === variant.packageId)
            return prior.result;
          throw failure("plus_checkout_in_progress", 409);
        }
        const current = plus.forSession(session);
        if (
          storeBuyer(session, store)?.uuid !== buyer.uuid ||
          !current.purchaseEligible ||
          current.offer.archDragon !== account.offer.archDragon ||
          !current.offer.available ||
          current.plus?.active ||
          current.hasSubscription
        )
          throw failure("plus_checkout_changed", 409);
        const token = events.authorizePlus(session, variant.packageId);
        const tokenHash = hash(token),
          order = store.get("store-plus-order", tokenHash);
        store.set(
          "store-plus-checkout",
          order.uuid,
          {
            tokenHash,
            packageId: variant.packageId,
            expiresAt: now() + 45000,
          },
          now() + 45000,
        );
        let basketIdent;
        try {
          const signal = AbortSignal.timeout(25000);
          stage = "package_validation";
          const product = await headless(
            `${headlessAccount}/packages/${variant.packageId}`,
            undefined,
            signal,
          );
          if (
            product?.id !== variant.packageId ||
            product.type !== "subscription" ||
            product.disabled === true ||
            product.disable_gifting !== true ||
            product.disable_quantity !== true ||
            product.currency !== "USD" ||
            cents(product.base_price) !== order.priceCents
          )
            throw failure("plus_checkout_unavailable");
          const owner = storeBuyer(session, store);
          if (
            owner?.uuid !== order.uuid ||
            !/^[A-Za-z0-9_]{3,16}$/.test(owner?.name ?? "")
          )
            throw failure("store_minecraft_required", 400);
          stage = "basket_creation";
          const created = await headless(
            `${headlessAccount}/baskets`,
            {
              username: owner.name,
              ip_address: ip,
              cancel_url: `${origin}/store/plus`,
              complete_url: `${origin}/store/thank-you`,
              complete_auto_redirect: true,
              custom: { drakora_order: token },
            },
            signal,
            true,
          );
          if (!/^[A-Za-z0-9-]{10,120}$/.test(created?.ident ?? ""))
            throw failure("plus_checkout_unavailable");
          basketIdent = created.ident;
          stage = "package_addition";
          const basket = await headless(
            `https://headless.tebex.io/api/baskets/${basketIdent}/packages`,
            { package_id: String(variant.packageId), quantity: 1 },
            signal,
          );
          stage = "checkout_validation";
          const row = basket?.packages?.[0];
          const url = new URL(basket?.links?.checkout);
          if (
            basket?.ident !== basketIdent ||
            basket.complete !== false ||
            basket.username?.toLowerCase() !== owner.name.toLowerCase() ||
            basket.packages?.length !== 1 ||
            basket.custom?.drakora_order !== token ||
            row.id !== variant.packageId ||
            row.in_basket?.quantity !== 1 ||
            row.is_recurring !== true ||
            (row.type !== undefined && row.type !== "subscription") ||
            row.in_basket.gift_username ||
            row.in_basket.gift_username_id ||
            !empty(row.revenue_share) ||
            !empty(basket.coupons) ||
            !empty(basket.giftcards) ||
            basket.creator_code ||
            basket.currency !== "USD" ||
            cents(row.in_basket.price) !== order.priceCents ||
            cents(basket.base_price) !== order.priceCents ||
            cents(basket.total_price) !==
              order.priceCents + cents(basket.sales_tax) ||
            !isTebexCheckoutUrl(url)
          )
            throw failure("plus_checkout_unavailable");
          stage = "eligibility_recheck";
          const current = plus.forSession(session);
          if (
            storeBuyer(session, store)?.uuid !== buyer.uuid ||
            !current.purchaseEligible ||
            current.offer.archDragon !== variant.archDragon ||
            current.offer.price !== account.offer.price ||
            current.plus?.active ||
            current.hasSubscription ||
            order.expiresAt <= now()
          )
            throw failure("plus_checkout_changed", 409);
          store.set(
            "store-plus-order",
            tokenHash,
            { ...order, provider: "headless", verified: true, basketIdent },
            Number.MAX_SAFE_INTEGER,
          );
          const result = { ident: basketIdent, checkoutUrl: url.href };
          store.set(
            "store-plus-checkout",
            order.uuid,
            {
              tokenHash,
              packageId: variant.packageId,
              expiresAt: order.expiresAt,
              result,
            },
            order.expiresAt,
          );
          return result;
        } catch (error) {
          if (basketIdent) {
            try {
              await emptyPlusBasket(order, {
                tokenHash,
                basketIdent,
                packageId: variant.packageId,
              });
            } catch (cleanupError) {
              cleanupFailed = true;
              cleanupProviderStatus = cleanupError.providerStatus;
              // Do not discard an authorization while a provider basket may still be payable.
              store.set(
                "store-plus-checkout",
                order.uuid,
                {
                  tokenHash,
                  packageId: variant.packageId,
                  basketIdent,
                  cleanupRequired: true,
                },
                Number.MAX_SAFE_INTEGER,
              );
            }
          }
          if (cleanupFailed)
            throw Object.assign(failure("plus_checkout_cleanup_required"), {
              providerStatus: error.providerStatus,
              originalCode: error.code,
            });
          store.delete("store-plus-checkout", order.uuid);
          store.delete("store-plus-order", tokenHash);
          throw error.code ? error : failure("plus_checkout_unavailable");
        }
      } catch (error) {
        const safeCode = (value) =>
          typeof value === "string" && /^[a-z][a-z0-9_]{0,79}$/.test(value)
            ? value
            : undefined;
        console.warn(
          "plus_checkout_failed",
          JSON.stringify({
            stage,
            code: safeCode(error.code) ?? "unknown",
            originalCode: safeCode(error.originalCode),
            providerStatus: Number.isInteger(error.providerStatus)
              ? error.providerStatus
              : undefined,
            cleanupFailed,
            cleanupProviderStatus: Number.isInteger(cleanupProviderStatus)
              ? cleanupProviderStatus
              : undefined,
          }),
        );
        throw error;
      } finally {
        plusRequests.delete(buyer.uuid);
      }
    },
  };
}
