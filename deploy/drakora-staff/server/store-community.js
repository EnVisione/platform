const failure = (code, status = 503) =>
  Object.assign(new Error(code), { code, status });
const playerName = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_]{3,16}$/.test(value);
const playerUuid = (value) => {
  const uuid = typeof value === "string" ? value.replaceAll("-", "") : "";
  return /^[a-f0-9]{32}$/i.test(uuid) ? uuid.toLowerCase() : null;
};

export function validateStoreCommunity(settings) {
  if (
    settings.pluginSecret === undefined &&
    settings.paymentCurrency === undefined
  )
    return;
  if (
    typeof settings.pluginSecret !== "string" ||
    !/^[A-Za-z0-9]{20,128}$/.test(settings.pluginSecret) ||
    !/^[A-Z]{3}$/.test(settings.paymentCurrency ?? "")
  )
    throw new Error(
      "Configure the server only Tebex plugin key and payment currency",
    );
}

export function summarizeStorePayments(payments, currency, now = Date.now()) {
  const day = new Date(now);
  day.setUTCHours(0, 0, 0, 0);
  const week = day.getTime() - ((day.getUTCDay() + 6) % 7) * 86400000;
  const month = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), 1);
  const seen = new Set();
  const completed = [];
  for (const payment of payments) {
    if (!payment || typeof payment.status !== "string") continue;
    const date = Date.parse(payment.date);
    const amount = Number(payment.amount);
    if (
      payment.status.toLowerCase() !== "complete" ||
      !playerName(payment.player?.name) ||
      !Number.isFinite(date) ||
      date > now ||
      !Number.isFinite(amount) ||
      amount <= 0 ||
      !Number.isSafeInteger(Math.round(amount * 100)) ||
      payment.currency?.iso_4217 !== currency ||
      !/^[0-9]+$/.test(String(payment.id)) ||
      seen.has(String(payment.id))
    )
      continue;
    seen.add(String(payment.id));
    completed.push({
      username: payment.player.name,
      uuid: playerUuid(payment.player.uuid),
      date,
      amount: Math.round(amount * 100),
    });
  }
  completed.sort((a, b) => b.date - a.date);
  const top = (since) => {
    const customers = new Map();
    for (const payment of completed) {
      if (payment.date < since) continue;
      const key = payment.uuid ?? payment.username.toLowerCase();
      const customer = customers.get(key) ?? {
        username: payment.username,
        uuid: payment.uuid,
        total: 0,
      };
      customer.total += payment.amount;
      customers.set(key, customer);
    }
    return [...customers.values()]
      .sort((a, b) => b.total - a.total || a.username.localeCompare(b.username))
      .slice(0, 3)
      .map(({ username, uuid }) => ({ username, uuid }));
  };
  return {
    recent: completed.slice(0, 8).map(({ username, uuid, date }) => ({
      username,
      uuid,
      date: new Date(date).toISOString(),
    })),
    top: { week: top(week), month: top(month), all: top(0) },
  };
}

export function storeCommunityService(settings, fetcher = fetch) {
  let cache, pending;
  async function request(path, signal) {
    const response = await fetcher(`https://plugin.tebex.io${path}`, {
      headers: {
        Accept: "application/json",
        "X-Tebex-Secret": settings.pluginSecret,
      },
      signal,
      redirect: "error",
    });
    if (response.status === 404 && path.startsWith("/gift-cards/lookup/"))
      throw failure("gift_card_not_found", 404);
    if (!response.ok) throw failure("store_community_unavailable");
    return response.json();
  }
  async function loadPayments() {
    const signal = AbortSignal.timeout(25000);
    const payments = [];
    let lastPage = 1;
    for (let page = 1; page <= lastPage; page++) {
      const response = await request(`/payments?paged=1&page=${page}`, signal);
      if (
        !Array.isArray(response.data) ||
        response.data.length > 25 ||
        response.current_page !== page ||
        !Number.isSafeInteger(response.last_page) ||
        response.last_page < page ||
        response.last_page > 200
      )
        throw failure("store_community_unavailable");
      lastPage = response.last_page;
      payments.push(
        ...response.data.map((payment) => ({
          id: payment?.id,
          amount: payment?.amount,
          date: payment?.date,
          status: payment?.status,
          player: { name: payment?.player?.name, uuid: payment?.player?.uuid },
          currency: { iso_4217: payment?.currency?.iso_4217 },
        })),
      );
    }
    cache = { payments, until: Date.now() + 60000 };
    return payments;
  }
  return {
    async community() {
      if (!settings.pluginSecret)
        return {
          recent: [],
          top: { week: [], month: [], all: [] },
          connected: false,
          giftCards: false,
        };
      if (!cache || cache.until <= Date.now()) {
        if (!pending)
          pending = loadPayments().finally(() => {
            pending = undefined;
          });
        await pending;
      }
      return {
        ...summarizeStorePayments(cache.payments, settings.paymentCurrency),
        connected: true,
        giftCards: true,
      };
    },
    async giftCard(input) {
      if (typeof input?.code !== "string")
        throw failure("invalid_gift_card", 400);
      const code = input.code.trim().replaceAll(" ", "");
      if (!/^[A-Za-z0-9-]{6,64}$/.test(code))
        throw failure("invalid_gift_card", 400);
      if (!settings.pluginSecret) throw failure("gift_cards_unavailable");
      const { data } = await request(
        `/gift-cards/lookup/${encodeURIComponent(code)}`,
        AbortSignal.timeout(10000),
      );
      if (data?.void === true) throw failure("gift_card_not_found", 404);
      const remaining = Number(data?.balance?.remaining);
      if (
        !data ||
        !/^[0-9]+(?:\.[0-9]+)?$/.test(String(data.balance?.remaining)) ||
        !Number.isFinite(remaining) ||
        remaining < 0 ||
        !/^[A-Z]{3}$/.test(data.balance?.currency ?? "")
      )
        throw failure("store_community_unavailable");
      return { remaining, currency: data.balance.currency };
    },
  };
}
