import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import {
  storeCommunityService,
  summarizeStorePayments,
  validateStoreCommunity,
} from "../server/store-community.js";
import { storefrontRouter } from "../server/storefront.js";

const settings = {
  pluginSecret: "01234567890123456789012345678901",
  paymentCurrency: "USD",
};
const uuid = "0123456789abcdef0123456789abcdef";
const payment = (id, name, amount, date, extra = {}) => ({
  id,
  player: { name },
  amount,
  date,
  status: "Complete",
  currency: { iso_4217: "USD" },
  ...extra,
});
const response = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

test("top customers use full completed payment totals and UTC week and month boundaries without publishing private payment data", () => {
  const now = Date.parse("2026-10-05T12:00:00Z");
  const payments = [
    payment(1, "OldName", "2.00", "2026-10-05T00:00:00Z", {
      player: { name: "OldName", uuid },
    }),
    payment(2, "NewName", "4.00", "2026-10-05T11:00:00Z", {
      player: { name: "NewName", uuid },
    }),
    payment(3, "Weekend", "30.00", "2026-10-04T23:59:59Z"),
    payment(4, "LastMonth", "100.00", "2026-09-30T23:59:59Z"),
    payment(5, "October", "15.00", "2026-10-01T00:00:00Z"),
    payment(6, "WeekPlayer", "5.50", "2026-10-05T01:00:00Z"),
    payment(7, "Future", "1000", "2026-10-06T00:00:00Z"),
    payment(8, "Refunded", "1000", "2026-10-05T01:00:00Z", {
      status: "Refund",
    }),
    payment(9, "Waiting", "1000", "2026-10-05T01:00:00Z", {
      status: "Pending",
    }),
    payment(10, "OtherMoney", "1000", "2026-10-05T01:00:00Z", {
      currency: { iso_4217: "EUR" },
    }),
    payment(11, "<script>", "1000", "2026-10-05T01:00:00Z"),
    payment(12, "Broken", "Infinity", "2026-10-05T01:00:00Z"),
    null,
  ];
  payments.push(payments[1]);
  payments[0].email = "private@example.com";
  payments[0].gateway = { name: "private gateway" };
  const summary = summarizeStorePayments(payments, "USD", now);
  assert.deepEqual(
    summary.top.week.map(({ username }) => username),
    ["NewName", "WeekPlayer"],
  );
  assert.deepEqual(
    summary.top.month.map(({ username }) => username),
    ["Weekend", "October", "NewName"],
  );
  assert.deepEqual(
    summary.top.all.map(({ username }) => username),
    ["LastMonth", "Weekend", "October"],
  );
  assert.equal(summary.recent.length, 6);
  assert.equal(summary.recent[0].username, "NewName");
  assert.equal(summary.top.week[0].uuid, uuid);
  for (const field of [
    "private@example.com",
    "gateway",
    "amount",
    "total",
    "secret",
  ])
    assert.ok(!JSON.stringify(summary).includes(field));
});

test("payment service reads every provider page, shares concurrent work and rejects partial history", async () => {
  const calls = [];
  const service = storeCommunityService(settings, async (url, options) => {
    calls.push(url);
    assert.equal(options.headers["X-Tebex-Secret"], settings.pluginSecret);
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    const page = Number(new URL(url).searchParams.get("page"));
    return response({
      current_page: page,
      last_page: 2,
      next_page_url: "https://evil.test",
      data: [
        payment(
          page,
          page === 1 ? "First" : "Second",
          page === 1 ? "1" : "100",
          "2020-01-01T00:00:00Z",
        ),
      ],
    });
  });
  const [first, second] = await Promise.all([
    service.community(),
    service.community(),
  ]);
  assert.deepEqual(first, second);
  assert.deepEqual(
    first.top.all.map(({ username }) => username),
    ["Second", "First"],
  );
  assert.equal(first.giftCards, true);
  assert.deepEqual(calls, [
    "https://plugin.tebex.io/payments?paged=1&page=1",
    "https://plugin.tebex.io/payments?paged=1&page=2",
  ]);
  await service.community();
  assert.equal(calls.length, 2);
  for (const page of [
    { current_page: 1, last_page: 201, data: [] },
    { current_page: 2, last_page: 2, data: [] },
  ])
    await assert.rejects(
      storeCommunityService(settings, async () => response(page)).community(),
      { code: "store_community_unavailable" },
    );
  const unavailable = await storeCommunityService({}, () => {
    throw Error("unexpected provider call");
  }).community();
  assert.equal(unavailable.connected, false);
  assert.equal(unavailable.giftCards, false);
});

test("gift card lookup returns only remaining balance and refuses voided or invalid cards", async () => {
  const calls = [];
  const service = storeCommunityService(settings, async (url, options) => {
    calls.push(url);
    assert.equal(options.headers["X-Tebex-Secret"], settings.pluginSecret);
    return response({
      data: {
        id: 99,
        code: "012345678901",
        note: "private",
        balance: { starting: "25.00", remaining: "0.00", currency: "USD" },
        void: false,
      },
    });
  });
  for (const code of ["../private", "short", 123456, null])
    await assert.rejects(service.giftCard({ code }), {
      code: "invalid_gift_card",
    });
  assert.equal(calls.length, 0);
  assert.deepEqual(await service.giftCard({ code: "0123 4567 8901" }), {
    remaining: 0,
    currency: "USD",
  });
  assert.deepEqual(calls, [
    "https://plugin.tebex.io/gift-cards/lookup/012345678901",
  ]);
  for (const provider of [
    response({}, 404),
    response({ data: { void: true } }),
  ])
    await assert.rejects(
      storeCommunityService(settings, async () => provider).giftCard({
        code: "012345678901",
      }),
      { code: "gift_card_not_found" },
    );
  for (const remaining of [null, "", -1, "Infinity"])
    await assert.rejects(
      storeCommunityService(settings, async () =>
        response({ data: { balance: { remaining, currency: "USD" } } }),
      ).giftCard({ code: "012345678901" }),
      { code: "store_community_unavailable" },
    );
  await assert.rejects(
    storeCommunityService({}, () => {
      throw Error("unexpected provider call");
    }).giftCard({ code: "012345678901" }),
    { code: "gift_cards_unavailable" },
  );
  assert.doesNotThrow(() => validateStoreCommunity(settings));
  assert.throws(() =>
    validateStoreCommunity({ ...settings, paymentCurrency: "wrong" }),
  );
});

test("public community and gift card routes contain no private data and balance checks require the store origin", async (t) => {
  const app = express();
  const origins = [];
  let lookups = 0;
  app.use(
    storefrontRouter(
      {
        community: async () => ({
          recent: [],
          top: { week: [], month: [], all: [] },
          giftCards: true,
          connected: true,
        }),
        giftCard: async () => {
          lookups++;
          return { remaining: 12.6, currency: "USD" };
        },
      },
      origins,
    ),
  );
  const server = app.listen(0, "127.0.0.1");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  origins.push(origin);
  const publicResponse = await fetch(`${origin}/store/api/community`);
  assert.equal(publicResponse.status, 200);
  assert.equal(publicResponse.headers.get("cache-control"), "no-store");
  assert.equal(publicResponse.headers.get("set-cookie"), null);
  const send = (requestOrigin) =>
    fetch(`${origin}/store/api/gift-card`, {
      method: "POST",
      headers: { Origin: requestOrigin, "Content-Type": "application/json" },
      body: JSON.stringify({ code: "012345678901", username: "PlayerOne" }),
    });
  assert.equal((await send("https://evil.test")).status, 403);
  assert.equal(lookups, 0);
  const balance = await send(origin);
  assert.equal(balance.status, 200);
  assert.deepEqual(await balance.json(), { remaining: 12.6, currency: "USD" });
  assert.equal(balance.headers.get("cache-control"), "no-store");
  for (let i = 0; i < 3; i++) await send(origin);
  assert.equal((await send(origin)).status, 429);
  assert.equal(lookups, 4);
});
