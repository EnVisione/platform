import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { openStore, hash } from "../server/store.js";
import { storeCheckoutService } from "../server/store-checkout.js";

const uuid = "11111111-1111-4111-8111-111111111111";
const origin = "https://store.example.test";
const oldToken = "old-order-token";
const oldIdent = "old-basket-12345";
const newIdent = "new-basket-12345";
const response = (data, status = 200) =>
  new Response(JSON.stringify({ data }), { status });

function fixture(t, overrides = {}) {
  const path = mkdtempSync(join(tmpdir(), "plus-recovery-"));
  const keyFile = join(path, "headless.key");
  writeFileSync(keyFile, "test-headless-secret-key", { mode: 0o600 });
  const { store } = openStore(join(path, "test.sqlite"), randomBytes(32).toString("base64"));
  t.after(() => {
    store.close();
    rmSync(path, { recursive: true });
  });
  const session = { storePlayer: { uuid, name: "PlayerOne" } };
  const account = {
    purchaseEligible: true,
    hasSubscription: false,
    plus: { active: false },
    offer: { available: true, archDragon: true, price: 6.99 },
  };
  const packageId = overrides.standard ? 100 : 101;
  if (overrides.standard) account.offer = { available: true, archDragon: false, price: 12.99 };
  const checkout = {
    tokenHash: hash(oldToken),
    packageId,
    basketIdent: oldIdent,
    cleanupRequired: true,
  };
  const oldOrder = {
    kind: "plus", uuid, name: "PlayerOne", packageId,
    priceCents: Math.round(account.offer.price * 100),
    createdAt: Date.now() - 7200000,
    expiresAt: Date.now() - 5400000,
  };
  store.set("store-plus-order", checkout.tokenHash, oldOrder, Number.MAX_SAFE_INTEGER);
  store.set("store-plus-checkout", uuid, checkout, Number.MAX_SAFE_INTEGER);
  let authorizations = 0;
  let newToken;
  const events = {
    authorizePlus(_session, id) {
      authorizations++;
      newToken = randomBytes(32).toString("base64url");
      store.set("store-plus-order", hash(newToken), {
        kind: "plus", uuid: _session.storePlayer.uuid, name: _session.storePlayer.name,
        packageId: id, priceCents: Math.round(account.offer.price * 100),
        createdAt: Date.now(), expiresAt: Date.now() + 1800000,
      }, Number.MAX_SAFE_INTEGER);
      return newToken;
    },
  };
  const basket = (ident, token, packages = []) => ({
    ident, complete: false, username: "PlayerOne", custom: { drakora_order: token },
    packages, currency: "USD", base_price: packages.length ? account.offer.price : 0,
    total_price: packages.length ? account.offer.price : 0, sales_tax: 0,
    coupons: [], giftcards: [],
    links: { checkout: `https://checkout.tebex.io/checkout/${ident}` },
  });
  const line = () => ({
    id: packageId, is_recurring: true,
    in_basket: { quantity: 1, price: account.offer.price },
  });
  const oldBasket = basket(oldIdent, oldToken);
  const requests = [];
  const fetcher = async (url, options) => {
    const path = new URL(url).pathname;
    const body = options.body && JSON.parse(options.body);
    const request = { path, body, method: options.method };
    requests.push(request);
    const result = await overrides.fetch?.(request, ctx);
    if (result !== undefined) return result;
    if (path.endsWith(`/baskets/${oldIdent}`)) return response(oldBasket);
    if (path.endsWith(`/packages/${packageId}`)) return response({
      id: packageId, type: "subscription", disable_gifting: true,
      disable_quantity: true, currency: "USD", base_price: account.offer.price,
    });
    if (path.endsWith("/baskets") && body) return response({ ident: newIdent });
    if (path.endsWith(`/baskets/${newIdent}/packages`))
      return response(basket(newIdent, newToken, [line()]));
    if (path.endsWith(`/baskets/${newIdent}`)) return response(basket(newIdent, newToken));
    throw new Error(`Unexpected provider request: ${path}`);
  };
  const ctx = {
    store, session, account, checkout, oldOrder, oldBasket, requests, basket, line,
    get authorizations() { return authorizations; },
    get newToken() { return newToken; },
  };
  ctx.service = storeCheckoutService(store, {
    publicToken: "test-public-token", headlessSecretFile: keyFile, allowPurchases: true,
    plus: { protectedCheckoutVerified: true, packages: [
      { packageId: 100, archDragon: false }, { packageId: 101, archDragon: true },
    ] },
    webhooks: { enabled: true, acceptPayments: true, mode: "production" },
  }, { forSession: () => account }, events, fetcher);
  ctx.run = () => ctx.service.plus(session, origin, "192.0.2.1");
  return ctx;
}

test("an expired failed checkout with an empty basket recovers without Discord linking", async t => {
  const f = fixture(t);
  const result = await f.run();
  assert.equal(result.ident, newIdent);
  assert.equal(f.authorizations, 1);
  assert.equal(f.requests.filter(r => r.path.endsWith("/remove")).length, 0);
  assert.equal(f.store.get("store-plus-checkout", uuid).cleanupRequired, undefined);
  assert.deepEqual(f.store.get("store-plus-order", hash(oldToken)), f.oldOrder);
});

test("a lost package removal response is resolved by a fresh empty basket readback", async t => {
  let removed = false;
  const f = fixture(t, { fetch(r, f) {
    if (r.path.endsWith(`/baskets/${oldIdent}`))
      return response({ ...f.oldBasket, packages: removed ? [] : [f.line()] });
    if (r.path.endsWith(`/baskets/${oldIdent}/packages/remove`)) {
      removed = true;
      throw new Error("connection lost after removal");
    }
  } });
  assert.equal((await f.run()).ident, newIdent);
  assert.equal(f.requests.filter(r => r.path.endsWith(`/baskets/${oldIdent}`)).length, 2);
});

test("an unavailable recovery read keeps the lock and creates no new authorization", async t => {
  const f = fixture(t, { fetch: () => response(undefined, 503) });
  await assert.rejects(f.run(), { code: "plus_checkout_cleanup_required" });
  assert.deepEqual(f.store.get("store-plus-checkout", uuid), f.checkout);
  assert.equal(f.authorizations, 0);
});

for (const [name, change] of [
  ["completed payment", b => ({ ...b, complete: true })],
  ["different buyer", b => ({ ...b, username: "PlayerTwo" })],
  ["different order binding", b => ({ ...b, custom: { drakora_order: "another-token" } })],
  ["different basket", b => ({ ...b, ident: "another-basket-12345" })],
  ["unrelated products", b => ({ ...b, packages: [{ id: 999 }] })],
  ["missing package list", b => ({ ...b, packages: undefined })],
]) test(`recovery refuses a ${name} without touching the basket`, async t => {
  const f = fixture(t, { fetch(r, f) { return response(change(f.oldBasket)); } });
  await assert.rejects(f.run(), { code: "plus_checkout_cleanup_required" });
  assert.deepEqual(f.store.get("store-plus-checkout", uuid), f.checkout);
  assert.equal(f.authorizations, 0);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].method, "GET");
});

test("a verified authorization cannot be treated as a failed checkout", async t => {
  const f = fixture(t);
  f.store.set("store-plus-order", hash(oldToken), { ...f.oldOrder, verified: true });
  await assert.rejects(f.run(), { code: "plus_checkout_cleanup_required" });
  assert.equal(f.requests.length, 0);
  assert.equal(f.authorizations, 0);
});

test("a basket that remains payable after removal stays blocked", async t => {
  const f = fixture(t, { fetch(r, f) {
    if (r.path.endsWith(`/baskets/${oldIdent}`))
      return response({ ...f.oldBasket, packages: [f.line()] });
    if (r.path.endsWith("/remove")) return response(f.oldBasket);
  } });
  await assert.rejects(f.run(), { code: "plus_checkout_cleanup_required" });
  assert.deepEqual(f.store.get("store-plus-checkout", uuid), f.checkout);
  assert.equal(f.authorizations, 0);
});

test("overlapping recovery requests create only one new basket", { timeout: 5000 }, async t => {
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const f = fixture(t, { async fetch(r) {
    if (r.path.endsWith(`/baskets/${oldIdent}`)) {
      entered();
      await gate;
    }
  } });
  const first = f.run();
  await started;
  await assert.rejects(f.run(), { code: "plus_checkout_in_progress", status: 409 });
  release();
  await first;
  assert.equal(f.authorizations, 1);
  assert.equal(f.requests.filter(r => r.path.endsWith("/baskets") && r.body).length, 1);
});

test("a newer checkout is preserved if state changes during recovery", async t => {
  const replacement = { tokenHash: hash("replacement"), cleanupRequired: true, basketIdent: "other-basket-12345" };
  const f = fixture(t, { fetch(r, f) {
    if (r.path.endsWith(`/baskets/${oldIdent}`))
      f.store.set("store-plus-checkout", uuid, replacement);
  } });
  await assert.rejects(f.run(), { code: "plus_checkout_in_progress" });
  assert.deepEqual(f.store.get("store-plus-checkout", uuid), replacement);
  assert.equal(f.authorizations, 0);
});

test("eligibility is checked again after recovery", async t => {
  const f = fixture(t, { fetch(r, f) {
    if (r.path.endsWith(`/baskets/${oldIdent}`)) f.account.hasSubscription = true;
  } });
  await assert.rejects(f.run(), { code: "plus_checkout_changed" });
  assert.equal(f.authorizations, 0);
});

test("a changed store identity cannot acquire a checkout while recovery is pending", async t => {
  const f = fixture(t, { fetch(r, f) {
    if (r.path.endsWith(`/baskets/${oldIdent}`))
      f.session.storePlayer = { name: "PlayerTwo", uuid: "22222222-2222-4222-8222-222222222222" };
  } });
  await assert.rejects(f.run(), { code: "plus_checkout_changed" });
  assert.equal(f.authorizations, 0);
});

test("a rejected package addition with an already empty basket does not create a permanent lock", async t => {
  const logs = [];
  t.mock.method(console, "warn", (...args) => logs.push(args));
  const f = fixture(t, { fetch(r) {
    if (r.path.endsWith(`/baskets/${newIdent}/packages`)) return response(undefined, 422);
  } });
  await assert.rejects(f.run(), { code: "plus_checkout_unavailable" });
  assert.equal(f.store.get("store-plus-checkout", uuid), undefined);
  assert.equal(f.store.get("store-plus-order", hash(f.newToken)), undefined);
  assert.equal(f.requests.filter(r => r.path.endsWith("/remove")).length, 0);
  const diagnostic = JSON.parse(logs[0][1]);
  assert.equal(diagnostic.stage, "package_addition");
  assert.equal(diagnostic.providerStatus, 422);
  for (const secret of [uuid, "PlayerOne", oldToken, f.newToken, newIdent, "192.0.2.1"])
    assert.equal(JSON.stringify(logs).includes(secret), false);
});

test("a failed cleanup preserves the authorization and original provider status", async t => {
  const logs = [];
  t.mock.method(console, "warn", (...args) => logs.push(args));
  const f = fixture(t, { fetch(r) {
    if (r.path.endsWith(`/baskets/${newIdent}/packages`)) return response(undefined, 422);
    if (r.path.endsWith(`/baskets/${newIdent}`)) return response(undefined, 503);
  } });
  await assert.rejects(f.run(), { code: "plus_checkout_cleanup_required" });
  assert.equal(f.store.get("store-plus-checkout", uuid).cleanupRequired, true);
  assert.ok(f.store.get("store-plus-order", hash(f.newToken)));
  const diagnostic = JSON.parse(logs[0][1]);
  assert.equal(diagnostic.stage, "package_addition");
  assert.equal(diagnostic.providerStatus, 422);
  assert.equal(diagnostic.cleanupProviderStatus, 503);
});

test("an existing paid subscription is refused before basket recovery", async t => {
  const f = fixture(t);
  f.account.plus.active = true;
  await assert.rejects(f.run(), { code: "plus_already_active" });
  assert.equal(f.requests.length, 0);
  assert.equal(f.authorizations, 0);
});

test("standard Plus checkout still uses its fixed recurring price", async t => {
  const f = fixture(t, { standard: true });
  const result = await f.run();
  assert.equal(result.ident, newIdent);
  assert.equal(f.store.get("store-plus-order", hash(f.newToken)).priceCents, 1299);
});

test("a valid pending checkout is reused without creating another authorization", async t => {
  const f = fixture(t);
  const result = { ident: oldIdent, checkoutUrl: `https://checkout.tebex.io/checkout/${oldIdent}` };
  f.store.set("store-plus-checkout", uuid, {
    packageId: 101, result, expiresAt: Date.now() + 60000,
  });
  assert.deepEqual(await f.run(), result);
  assert.equal(f.authorizations, 0);
  assert.equal(f.requests.length, 0);
});
