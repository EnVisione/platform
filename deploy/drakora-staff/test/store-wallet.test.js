import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import express from "express";
import session from "express-session";
import { openStore } from "../server/store.js";
import { storeWalletService } from "../server/store-wallet.js";
import { storefrontRouter, storefrontService } from "../server/storefront.js";
import { discordClient } from "../server/discord.js";

const alice = { id: "111111111111111111", name: "Alice" };
const bob = { id: "222222222222222222", name: "Bob" };
const code = "PRIVATE-CARD-ABC123";
test("store linking reads only the Discord profile and persists no staff identity or tokens", async () => {
  const calls = [];
  const client = discordClient(
    {
      staffOrigin: "https://staff.example.test",
      discordClientId: "fixture",
      discordClientSecret: randomBytes(32).toString("base64url"),
    },
    {},
    async (url) => {
      calls.push(url);
      return new Response(
        JSON.stringify(
          url.endsWith("/token")
            ? { access_token: "fixture" }
            : {
                ...alice,
                username: alice.name,
                email: "private@example.test",
                roles: ["staff"],
              },
        ),
        { headers: { "Content-Type": "application/json" } },
      );
    },
  );
  assert.deepEqual(await client.storeIdentity("code"), alice);
  assert.deepEqual(calls, [
    "https://discord.com/api/oauth2/token",
    "https://discord.com/api/v10/users/@me",
  ]);
});
function fixture(
  t,
  lookup = async () => ({ remaining: 12.6, currency: "USD" }),
) {
  const scratch = mkdtempSync(join(tmpdir(), "drakora-store-wallet-test-"));
  const database = openStore(
    join(scratch, "wallet.sqlite"),
    Buffer.alloc(32, 7).toString("base64"),
  );
  let clock = Date.now();
  const wallet = storeWalletService(database.store, lookup, () => clock);
  t.after(() => {
    database.store.close();
    rmSync(scratch, { recursive: true });
  });
  return {
    ...database,
    wallet,
    scratch,
    advance: (ms) => {
      clock += ms;
    },
  };
}

test("registration requires a Minecraft name and keeps an unlinked card private to its session", async (t) => {
  let calls = 0;
  const { wallet, store } = fixture(t, async () => {
    calls++;
    return { remaining: 12.6, currency: "USD" };
  });
  const guest = {};
  for (const username of [undefined, "", "<script>", "MoreThanSixteenChars"])
    await assert.rejects(wallet.register(guest, { username, code }), {
      code: "minecraft_login_required",
    });
  assert.equal(calls, 0);
  await wallet.register(guest, { username: "PlayerOne", code });
  assert.equal(wallet.snapshot(guest).cards.length, 1);
  assert.deepEqual(wallet.snapshot({}), { identity: null, cards: [] });
  assert.equal(store.entries("store-gift-card").length, 0);
  assert.ok(!JSON.stringify(wallet.snapshot(guest)).includes(code));
  const id = guest.storeCards[0].id;
  assert.equal(wallet.checkoutCode(guest, id, "playerone"), code);
  assert.throws(() => wallet.checkoutCode(guest, id, "OtherPlayer"), {
    code: "gift_card_not_found",
  });
  assert.throws(() => wallet.checkoutCode({}, id, "PlayerOne"), {
    code: "gift_card_not_found",
  });
});

test("Discord linking preserves cards across sessions without allowing another account or the same Minecraft name to claim them", async (t) => {
  const { wallet, scratch } = fixture(t);
  const guest = {};
  await wallet.register(guest, { username: "PlayerOne", code });
  wallet.link(guest, alice);
  assert.equal(guest.storeCards, undefined);
  const returning = { storeIdentity: alice };
  assert.equal(wallet.snapshot(returning).cards.length, 1);
  assert.equal(wallet.snapshot({ storeIdentity: bob }).cards.length, 0);
  assert.ok(!JSON.stringify(wallet.snapshot(returning)).includes(code));
  await assert.rejects(wallet.register({}, { username: "PlayerOne", code }), {
    code: "gift_card_already_saved",
  });
  await assert.rejects(
    wallet.register({ storeIdentity: bob }, { username: "PlayerOne", code }),
    { code: "gift_card_already_saved" },
  );
  assert.ok(
    !readFileSync(join(scratch, "wallet.sqlite-wal")).includes(
      Buffer.from(code),
    ),
  );
  const id = wallet.snapshot(returning).cards[0].id;
  await wallet.register(returning, { username: "PlayerOne", code });
  assert.equal(wallet.snapshot(returning).cards.length, 1);
  assert.equal(wallet.snapshot(returning).cards[0].id, id);
});

test("empty cards are not registered and forgetting a reference never changes provider credit", async (t) => {
  let remaining = 0,
    calls = 0;
  const { wallet, store } = fixture(t, async () => {
    calls++;
    return { remaining, currency: "USD" };
  });
  const owner = { storeIdentity: alice };
  await wallet.register(owner, { username: "PlayerOne", code });
  assert.equal(wallet.snapshot(owner).cards.length, 0);
  remaining = 20;
  await wallet.register(owner, { username: "PlayerOne", code });
  const id = wallet.snapshot(owner).cards[0].id;
  remaining = 5;
  await wallet.refresh(owner, id);
  assert.equal(wallet.snapshot(owner).cards[0].remaining, 5);
  wallet.forget(owner, id);
  assert.equal(calls, 3);
  assert.equal(remaining, 5);
  assert.equal(wallet.snapshot(owner).cards.length, 0);
  assert.equal(store.entries("store-gift-card").length, 0);
  assert.equal(store.get("store-wallet", alice.id), undefined);
});

test("a concurrent registration cannot overwrite a Discord card owner", async (t) => {
  let release;
  const { wallet } = fixture(
    t,
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const first = { storeIdentity: alice },
    second = { storeIdentity: bob };
  const pending = wallet.register(second, { username: "PlayerOne", code });
  const releaseSecond = release;
  const claimed = wallet.register(first, { username: "PlayerOne", code });
  release({ remaining: 20, currency: "USD" });
  await claimed;
  releaseSecond({ remaining: 20, currency: "USD" });
  await assert.rejects(pending, { code: "gift_card_already_saved" });
  assert.equal(wallet.snapshot(second).cards.length, 0);
  assert.equal(wallet.snapshot(first).cards.length, 1);
});

test("Discord handoffs are short lived, single use and bound to the original browser session and origin", (t) => {
  const { wallet, advance } = fixture(t);
  const origin = "https://store.example.test";
  const challenge = wallet.challenge("original-session", origin);
  const redirect = new URL(wallet.handoff(challenge, alice));
  const value = redirect.searchParams.get("handoff");
  assert.equal(wallet.challengeGet(challenge), undefined);
  assert.throws(() => wallet.consume(value, "other-session", origin), {
    code: "invalid_handoff",
  });
  assert.throws(
    () => wallet.consume(value, "original-session", "https://evil.test"),
    { code: "invalid_handoff" },
  );
  assert.deepEqual(wallet.consume(value, "original-session", origin), alice);
  assert.throws(() => wallet.consume(value, "original-session", origin), {
    code: "invalid_handoff",
  });
  const expired = wallet.challenge("original-session", origin);
  advance(600001);
  assert.equal(wallet.challengeGet(expired), undefined);
});

test("wallet routes reject missing CSRF, foreign origins, and missing Minecraft login before checking a card", async (t) => {
  let lookups = 0;
  const { wallet } = fixture(t, async () => {
    lookups++;
    return { remaining: 5, currency: "USD" };
  });
  const app = express(),
    origins = [];
  app.use(
    session({
      secret: randomBytes(32).toString("base64url"),
      resave: false,
      saveUninitialized: false,
      cookie: { sameSite: "lax" },
    }),
  );
  app.use(
    storefrontRouter({}, origins, wallet, {
      staffOrigin: "https://staff.example.test",
      giftCardsEnabled: true,
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  origins.push(origin);
  const response = await fetch(`${origin}/store/api/wallet`);
  const cookie = response.headers.get("set-cookie").split(";")[0];
  const { csrf } = await response.json();
  const send = (body, extra = {}) =>
    fetch(`${origin}/store/api/gift-card`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: origin,
        "Content-Type": "application/json",
        "X-CSRF-Token": csrf,
        ...extra,
      },
      body: JSON.stringify(body),
    });
  assert.equal(
    (await send({ username: "PlayerOne", code }, { "X-CSRF-Token": "wrong" }))
      .status,
    403,
  );
  assert.equal(
    (
      await send(
        { username: "PlayerOne", code },
        { Origin: "https://evil.test" },
      )
    ).status,
    403,
  );
  assert.equal((await send({ code })).status, 401);
  assert.equal(lookups, 0);
  const registered = await send({ username: "PlayerOne", code });
  assert.equal(registered.status, 200);
  assert.equal((await registered.json()).cards.length, 1);
  const stranger = await fetch(`${origin}/store/api/wallet`);
  assert.equal((await stranger.json()).cards.length, 0);
  assert.equal(lookups, 1);
});

test("checkout applies only the server selected card to the Tebex basket", async () => {
  const calls = [];
  const service = storefrontService(
    {
      publicToken: "test-public-token",
      allowPurchases: true,
      products: [
        {
          rank: "archdrake",
          scope: "network",
          billing: "lifetime",
          packageId: 1,
          deliveryVerified: true,
        },
      ],
    },
    async (url, options) => {
      calls.push({ url, body: options.body && JSON.parse(options.body) });
      const product = {
        id: 1,
        type: "single",
        base_price: 10,
        currency: "USD",
      };
      const basket = {
        ident: "basket-ident-12345",
        packages: [product],
        links: { checkout: "https://checkout.tebex.io/test" },
      };
      const data = url.endsWith("/giftcards")
        ? { ...basket, giftcards: [{ card_number: code }] }
        : url.endsWith("/packages") && !options.body
          ? [product]
          : basket;
      return new Response(JSON.stringify({ data }), {
        headers: { "Content-Type": "application/json" },
      });
    },
  );
  const result = await service.checkout(
    {
      rank: "archdrake",
      scope: "network",
      billing: "lifetime",
      username: "PlayerOne",
    },
    "127.0.0.1",
    "https://store.example.test",
    code,
  );
  assert.deepEqual(calls.at(-1), {
    url: "https://headless.tebex.io/api/accounts/test-public-token/baskets/basket-ident-12345/giftcards",
    body: { card_number: code },
  });
  assert.equal(result.ident, "basket-ident-12345");
  assert.ok(!JSON.stringify(result).includes(code));
});
