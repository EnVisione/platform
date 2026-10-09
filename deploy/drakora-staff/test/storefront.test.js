import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import {
  emptyStoreCatalog,
  emptyCommandCatalog,
  storeRanksForScope,
  validStoreSelection,
  storeProductKey,
  storePageFor,
  storePageHref,
} from "../shared/storefront.js";
import {
  validateStorefront,
  storefrontService,
  storefrontRouter,
} from "../server/storefront.js";

const mapping = {
  rank: "archdrake",
  scope: "network",
  billing: "monthly",
  packageId: 101,
  interval: "P1M",
  deliveryVerified: true,
};
const settings = {
  origin: "https://store.example.com",
  publicToken: "abcd-123456789012345678901234567890",
  allowPurchases: true,
  products: [mapping],
};
const remoteProduct = {
  id: 101,
  type: "subscription",
  base_price: 12,
  currency: "USD",
};
const request = {
  rank: "archdrake",
  scope: "network",
  billing: "monthly",
  username: "Test_Player",
};
const reply = (data) =>
  new Response(JSON.stringify({ data }), {
    headers: { "Content-Type": "application/json" },
  });

test("store page links resolve on both hosts and legacy comparisons retain coverage", () => {
  for (const separateHost of [false, true]) {
    for (const page of ["home", "network", "server", "commands"]) {
      const href = storePageHref(page, separateHost);
      assert.equal(storePageFor(href, "", separateHost), page);
      assert.equal(storePageFor(`${href}/`, "", separateHost), page);
    }
  }
  assert.equal(storePageHref("network", true), "/network-ranks");
  assert.equal(storePageHref("server", false), "/store/server-ranks");
  assert.equal(storePageFor("/", "", false), null);
  assert.equal(storePageFor("/store/compare", "?scope=network"), "network");
  for (const scope of ["server", "prom2", "restless-horizons"])
    assert.equal(storePageFor("/compare", `?scope=${scope}`), "server");
  assert.equal(storePageFor("/compare", "?scope=unknown"), "network");
  assert.equal(storePageFor("/store/thank-you"), "thank-you");
  assert.equal(storePageFor("/gift-cards"), "gift-cards");
  for (const path of [
    "/staff",
    "/rules",
    "/store/api/catalog",
    "/network-ranks/extra",
  ])
    assert.equal(storePageFor(path, "", true), null);
  assert.equal(storePageHref("unknown"), null);
});

test("coming-soon catalog separates four network tiers and four modpack tiers without creating baskets", async () => {
  const catalog = emptyStoreCatalog();
  assert.deepEqual(
    storeRanksForScope("network").map(({ name }) => name),
    ["ArchWyrm", "ArchDrake", "ArchWyvern", "ArchDragon"],
  );
  for (const scope of ["prom2", "restless-horizons"])
    assert.deepEqual(
      storeRanksForScope(scope).map(({ name }) => name),
      ["Wyrm", "Drake", "Wyvern", "Dragon"],
    );
  assert.equal(catalog.length, 24);
  assert.equal(new Set(catalog.map(storeProductKey)).size, 24);
  assert.ok(
    catalog.every((product) => !product.available && product.price === null),
  );
  const service = storefrontService(
    { ...settings, allowPurchases: false, products: [] },
    () => {
      throw new Error("unexpected provider call");
    },
  );
  assert.equal((await service.catalog()).acceptingPayments, false);
  const commands = (await service.catalog()).commands;
  assert.equal(commands.length, 30);
  assert.ok(
    commands.every((product) => !product.available && product.price === null),
  );
  assert.deepEqual(
    [...new Set(commands.map(({ invocation }) => invocation))],
    ["/hat", "/nick", "/particles", "/emote", "/sit"],
  );
  assert.equal(
    new Set([...catalog, ...emptyCommandCatalog()].map(storeProductKey)).size,
    54,
  );
  await assert.rejects(
    service.checkout(
      {
        command: "hat",
        scope: "network",
        billing: "lifetime",
        username: "Test_Player",
      },
      "192.0.2.5",
      settings.origin,
    ),
    { code: "command_unavailable" },
  );
  await assert.rejects(
    service.checkout(request, "192.0.2.5", settings.origin),
    { code: "rank_unavailable" },
  );
});

test("rank selections reject other categories, retired ranks and alternate titles", () => {
  for (const selection of emptyStoreCatalog())
    assert.equal(validStoreSelection(selection), true);
  for (const selection of [
    { ...request, scope: "prom2" },
    { ...request, rank: "wyrm" },
    { ...request, title: "ArchDrake" },
    {
      command: "hat",
      scope: "network",
      billing: "monthly",
      title: "ArchDrake",
    },
  ])
    assert.equal(validStoreSelection(selection), false);
  for (const rank of [
    "ruler",
    "monarch",
    "sovereign",
    "regent",
    "harbinger",
    "dovahkiin",
    "dragonborn",
    "warden",
    "thane",
    "adventurer",
    "emperor",
    "king",
    "archduke",
    "prince",
    "marquess",
    "earl",
    "viscount",
    "baron",
    "knight",
    "lord",
  ])
    for (const scope of ["network", "prom2", "restless-horizons"])
      assert.equal(validStoreSelection({ ...request, rank, scope }), false);
});

test("configuration rejects overlapping hosts, duplicate packages, unverified delivery and non-monthly subscription mappings", () => {
  const base = {
    staffOrigin: "https://staff.example.com",
    todoOrigin: "https://todo.example.com",
    applications: { publicOrigin: "https://public.example.com" },
    website: {},
    storefront: settings,
  };
  assert.doesNotThrow(() => validateStorefront(base));
  for (const storefront of [
    { ...settings, origin: base.staffOrigin },
    { ...settings, origin: "http://store.example.com" },
    { ...settings, products: [mapping, { ...mapping, scope: "prom2" }] },
    { ...settings, products: [{ ...mapping, deliveryVerified: false }] },
    { ...settings, products: [{ ...mapping, interval: "P1Y" }] },
    { ...settings, products: [{ ...mapping, rank: "founder" }] },
    { ...settings, products: [{ ...mapping, rank: "drake" }] },
    { ...settings, products: [{ ...mapping, title: "ArchDrake" }] },
  ])
    assert.throws(() => validateStorefront({ ...base, storefront }));
});

test("catalog cannot sell single-payment products as monthly or unpriced and disabled products", async () => {
  for (const product of [
    { ...remoteProduct, type: "single" },
    { ...remoteProduct, base_price: 0 },
    { ...remoteProduct, currency: "invalid" },
    { ...remoteProduct, disabled: true },
  ]) {
    const catalog = await storefrontService(settings, async () =>
      reply([product]),
    ).catalog();
    assert.equal(catalog.acceptingPayments, false);
    assert.equal(
      catalog.products.find(
        (slot) => storeProductKey(slot) === storeProductKey(mapping),
      ).available,
      false,
    );
  }
  const catalog = await storefrontService(settings, async () =>
    reply([remoteProduct]),
  ).catalog();
  assert.equal(catalog.acceptingPayments, true);
  assert.equal(
    catalog.products.find(
      (slot) => storeProductKey(slot) === storeProductKey(mapping),
    ).price,
    12,
  );
});

test("checkout uses the configured package and customer IP, ignores client prices and refuses unknown selections", async () => {
  const calls = [];
  const ident = "1a-123456789012345678901234567890";
  const service = storefrontService(settings, async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/packages") && options.method === "GET")
      return reply([remoteProduct]);
    if (url.endsWith("/baskets")) return reply({ ident });
    return reply({
      packages: [{ id: 101, type: "subscription" }],
      links: { checkout: `https://checkout.tebex.io/checkout/${ident}` },
    });
  });
  for (const input of [
    { ...request, scope: "unknown" },
    { ...request, scope: "prom2" },
    { ...request, rank: "drake" },
    { ...request, title: "ArchDrake" },
    { ...request, username: "a<script>" },
  ])
    await assert.rejects(
      service.checkout(input, "192.0.2.5", settings.origin),
      { code: "invalid_store_selection" },
    );
  assert.equal(calls.length, 0);
  const result = await service.checkout(
    { ...request, packageId: 999, price: 0 },
    "::ffff:192.0.2.5",
    settings.origin,
  );
  assert.equal(result.ident, ident);
  const basket = JSON.parse(calls[1].options.body);
  assert.equal(basket.username, "Test_Player");
  assert.equal(basket.ip_address, "192.0.2.5");
  assert.equal(basket.complete_url, `${settings.origin}/store/thank-you`);
  assert.deepEqual(JSON.parse(calls[2].options.body), {
    package_id: "101",
    quantity: 1,
  });
  assert.equal(basket.custom, undefined);
  assert.equal(
    calls[2].url,
    `https://headless.tebex.io/api/baskets/${ident}/packages`,
  );
  assert.ok(
    calls.every(
      ({ options }) =>
        options.signal instanceof AbortSignal && options.redirect === "error",
    ),
  );
});

test("checkout refreshes cached availability before making a basket", async () => {
  let count = 0;
  const service = storefrontService(settings, async () => {
    count++;
    return reply(count === 1 ? [remoteProduct] : []);
  });
  assert.equal((await service.catalog()).acceptingPayments, true);
  await assert.rejects(
    service.checkout(request, "192.0.2.5", settings.origin),
    { code: "rank_unavailable" },
  );
  assert.equal(count, 2);
});

test("server ranks require a server and checkout uses that server's package", async () => {
  const mappings = [
    { ...mapping, rank: "wyrm", scope: "prom2", packageId: 102 },
    {
      ...mapping,
      rank: "wyrm",
      scope: "restless-horizons",
      packageId: 103,
    },
  ];
  const calls = [];
  const ident = "server-12345678901234567890";
  const service = storefrontService(
    { ...settings, products: mappings },
    async (url, options) => {
      calls.push({ url, options });
      if (options.method === "GET")
        return reply(
          mappings.map(({ packageId }) => ({
            ...remoteProduct,
            id: packageId,
          })),
        );
      if (url.endsWith("/baskets")) return reply({ ident });
      return reply({
        packages: [
          {
            id: Number(JSON.parse(options.body).package_id),
            type: "subscription",
          },
        ],
        links: { checkout: `https://checkout.tebex.io/checkout/${ident}` },
      });
    },
  );
  for (const scope of [undefined, "", "server", "network", "unknown"])
    await assert.rejects(
      service.checkout(
        { ...request, rank: "wyrm", scope },
        "192.0.2.5",
        settings.origin,
      ),
      { code: "invalid_store_selection" },
    );
  assert.equal(calls.length, 0);
  for (const { scope, packageId } of mappings) {
    calls.length = 0;
    await service.checkout(
      { ...request, rank: "wyrm", scope, packageId: 999 },
      "192.0.2.5",
      settings.origin,
    );
    assert.deepEqual(JSON.parse(calls[2].options.body), {
      package_id: String(packageId),
      quantity: 1,
    });
  }
});

test("lifetime checkout verifies a single payment and rejects unsafe checkout links", async () => {
  const lifetime = { ...mapping, billing: "lifetime", interval: undefined };
  for (const checkout of [
    "http://checkout.tebex.io/checkout/example",
    "https://checkout.tebex.io.evil.test/example",
    "https://user:pass@checkout.tebex.io/example",
  ]) {
    const service = storefrontService(
      { ...settings, products: [lifetime] },
      async (url, options) =>
        options.method === "GET"
          ? reply([{ ...remoteProduct, type: "single" }])
          : url.endsWith("/baskets")
            ? reply({ ident: "1a-12345678901234567890" })
            : reply({
                packages: [{ id: 101, type: "single" }],
                links: { checkout },
              }),
    );
    await assert.rejects(
      service.checkout(
        { ...request, billing: "lifetime" },
        "192.0.2.5",
        settings.origin,
      ),
      {
        code: "store_unavailable",
      },
    );
  }
});

test("HTTP checkout rejects cross-origin requests and returns controlled errors for malformed bodies or provider timeouts", async (t) => {
  let calls = 0;
  const origins = [];
  const app = express();
  app.use(
    storefrontRouter(
      {
        catalog: async () => ({ products: [] }),
        checkout: async () => {
          calls++;
          throw new DOMException("provider timed out", "TimeoutError");
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
  const send = (body, requestOrigin = origin) =>
    fetch(`${origin}/store/api/checkout`, {
      method: "POST",
      headers: { Origin: requestOrigin, "Content-Type": "application/json" },
      body,
    });
  assert.equal(
    (await send(JSON.stringify(request), "https://evil.test")).status,
    403,
  );
  assert.equal(calls, 0);
  assert.equal((await send("{")).status, 400);
  assert.equal((await send(JSON.stringify(request))).status, 503);
  assert.equal(calls, 1);
});

test("store player preview validates names and returns profiles without creating a checkout", async (t) => {
  const names = [];
  const profile = {
    name: "Test_Player",
    uuid: "0123456789abcdef0123456789abcdef",
    found: true,
  };
  const app = express();
  app.use(
    storefrontRouter({}, [], undefined, {
      minecraftProfile: async (name) => {
        names.push(name);
        if (name === "Failed_Player") throw new Error("provider unavailable");
        return name === "Test_Player"
          ? profile
          : { name, uuid: null, found: false };
      },
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const name of ["ab", "bad-name", "a".repeat(17)])
    assert.equal(
      (await fetch(`${origin}/store/api/minecraft/${name}`)).status,
      400,
    );
  assert.equal(names.length, 0);
  const response = await fetch(`${origin}/store/api/minecraft/Test_Player`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), profile);
  assert.deepEqual(
    await (await fetch(`${origin}/store/api/minecraft/Unknown_Player`)).json(),
    {
      name: "Unknown_Player",
      uuid: null,
      found: false,
    },
  );
  const failed = await fetch(`${origin}/store/api/minecraft/Failed_Player`);
  assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), { error: "store_unavailable" });
});

test("command mappings validate category, unique packages, delivery and monthly interval", () => {
  const command = {
    command: "hat",
    scope: "prom2",
    billing: "lifetime",
    packageId: 102,
    deliveryVerified: true,
  };
  const base = {
    staffOrigin: "https://staff.example.com",
    todoOrigin: "https://todo.example.com",
    applications: { publicOrigin: "https://public.example.com" },
    website: {},
  };
  assert.doesNotThrow(() =>
    validateStorefront({
      ...base,
      storefront: { ...settings, products: [], commandProducts: [command] },
    }),
  );
  for (const commandProducts of [
    null,
    {},
    [mapping],
    [{ ...command, command: "ban" }],
    [{ ...command, packageId: 101 }],
    [{ ...command, deliveryVerified: false }],
    [{ ...command, billing: "monthly" }],
    [command, { ...command, packageId: 103 }],
  ])
    assert.throws(() =>
      validateStorefront({
        ...base,
        storefront: { ...settings, commandProducts },
      }),
    );
  assert.throws(() =>
    validateStorefront({
      ...base,
      storefront: { ...settings, products: [command] },
    }),
  );
});

test("an individual command checkout adds only its verified package and preserves rank catalog", async () => {
  const command = {
    command: "nick",
    scope: "prom2",
    billing: "lifetime",
    packageId: 202,
    deliveryVerified: true,
  };
  const selected = {
    command: "nick",
    scope: "prom2",
    billing: "lifetime",
    username: "Test_Player",
  };
  const ident = "command-12345678901234567890";
  const calls = [];
  const service = storefrontService(
    { ...settings, commandProducts: [command] },
    async (url, options) => {
      calls.push({ url, options });
      if (options.method === "GET")
        return reply([
          remoteProduct,
          { id: 202, type: "single", base_price: 5, currency: "USD" },
        ]);
      if (url.endsWith("/baskets")) return reply({ ident });
      return reply({
        packages: [{ id: 202, type: "single" }],
        links: { checkout: `https://checkout.tebex.io/checkout/${ident}` },
      });
    },
  );
  for (const input of [
    { ...selected, command: "ban" },
    { ...selected, rank: "archdrake" },
    { ...selected, username: "<script>" },
  ])
    await assert.rejects(
      service.checkout(input, "192.0.2.5", settings.origin),
      { code: "invalid_store_selection" },
    );
  assert.equal(calls.length, 0);
  const catalog = await service.catalog();
  assert.equal(catalog.products.length, 24);
  assert.equal(
    catalog.commands.filter((product) => product.available).length,
    1,
  );
  assert.equal(
    catalog.commands.find(
      (product) => storeProductKey(product) === storeProductKey(selected),
    ).price,
    5,
  );
  calls.length = 0;
  assert.equal(
    (
      await service.checkout(
        { ...selected, packageId: 101, price: 0 },
        "192.0.2.5",
        settings.origin,
      )
    ).ident,
    ident,
  );
  assert.equal(
    JSON.parse(calls[1].options.body).cancel_url,
    `${settings.origin}/store/commands`,
  );
  assert.deepEqual(JSON.parse(calls[2].options.body), {
    package_id: "202",
    quantity: 1,
  });
  const unavailable = storefrontService(
    { ...settings, products: [], commandProducts: [command] },
    async () =>
      reply([
        { id: 202, type: "subscription", base_price: 5, currency: "USD" },
      ]),
  );
  await assert.rejects(
    unavailable.checkout(selected, "192.0.2.5", settings.origin),
    { code: "command_unavailable" },
  );
});
