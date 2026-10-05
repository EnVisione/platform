import React, { useEffect, useRef, useState } from "react";

const errors = {
  minecraft_login_required: "Enter your Minecraft username first.",
  invalid_gift_card: "Enter a valid gift card number.",
  gift_card_not_found:
    "This gift card could not be found or is no longer valid.",
  gift_card_already_saved:
    "This card is already saved to another Discord account.",
  gift_card_limit:
    "You can save up to 20 cards. Forget an unused card before adding another.",
  invalid_store_request:
    "Your store session expired. Refresh the page and try again.",
  gift_cards_unavailable: "Gift card registration is temporarily unavailable.",
};
const balance = (card) =>
  new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: card.currency,
  }).format(card.remaining);

export function useStoreWallet() {
  const [data, setData] = useState({
    identity: null,
    cards: [],
    csrf: "",
    enabled: false,
  });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const active = useRef(null);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    fetch("/store/api/wallet", {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        const value = await response.json();
        if (!Array.isArray(value.cards) || typeof value.csrf !== "string")
          throw new Error();
        if (!controller.signal.aborted) setData(value);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError("We couldn’t load your saved cards. Please try again.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      controller.abort();
      active.current?.abort();
    };
  }, [revision]);
  async function request(path, body, method = "POST") {
    if (active.current || !data.csrf) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(path, {
        method,
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": data.csrf,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(12000),
        ]),
      });
      const value = await response.json();
      if (!response.ok)
        throw new Error(
          response.status === 429
            ? "Too many requests. Wait a minute and try again."
            : (errors[value.error] ??
              "Gift cards are temporarily unavailable. Please try again."),
        );
      if (!controller.signal.aborted) {
        if (Array.isArray(value.cards))
          setData((previous) => ({ ...previous, ...value }));
        return value;
      }
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(
          failure.name === "TimeoutError"
            ? "The request timed out. Please try again."
            : failure.message,
        );
    } finally {
      if (!controller.signal.aborted) setBusy(false);
      active.current = null;
    }
  }
  return {
    data,
    loading,
    busy,
    error,
    request,
    retry: () => setRevision((value) => value + 1),
  };
}

export function StoreGiftCards({ username, onLogin, wallet }) {
  const [code, setCode] = useState("");
  const [result, setResult] = useState("");
  const { data, loading, busy, error, request } = wallet;
  const cards = data.cards.filter(
    (card) =>
      data.identity || card.username.toLowerCase() === username.toLowerCase(),
  );
  const available = Boolean(
    username && data.enabled && data.csrf && !loading && !busy,
  );
  useEffect(() => {
    setCode("");
    setResult("");
  }, [username, data.identity?.id]);
  async function register(event) {
    event.preventDefault();
    if (!available) return;
    setResult("");
    const value = await request("/store/api/gift-card", { code, username });
    if (!value) return;
    setCode("");
    setResult(
      `Remaining balance: ${balance(value)}. ${
        value.remaining === 0
          ? "This card has no credit left."
          : value.saved
            ? "Saved to your Discord account."
            : "Registered for this browser session. Link Discord to save it for later."
      }`,
    );
  }
  async function connect() {
    const value = await request("/store/api/wallet/connect", { username });
    if (value?.url) location.assign(value.url);
  }
  return (
    <section
      className="store-community-panel store-gift-card"
      id="store-gift-cards"
      aria-labelledby="store-gift-title"
    >
      <h2 id="store-gift-title">Gift cards</h2>
      <p>Register an existing card. Gift card purchases are coming soon.</p>
      {!username ? (
        <>
          <p>Enter your Minecraft username before registering a gift card.</p>
          <button className="store-button" type="button" onClick={onLogin}>
            Minecraft login
          </button>
        </>
      ) : (
        <form onSubmit={register}>
          <label htmlFor="store-gift-number">Gift card number</label>
          <div className="store-gift-input">
            <input
              id="store-gift-number"
              type="password"
              autoComplete="off"
              spellCheck={false}
              maxLength={64}
              value={code}
              onChange={(event) => {
                setCode(event.target.value);
                setResult("");
              }}
              disabled={!available}
              placeholder="Card number"
              required
            />
            <button
              className="store-button"
              type="submit"
              disabled={!available}
            >
              {busy ? "Working…" : "Register card"}
            </button>
          </div>
          {result && <p role="status">{result}</p>}
        </form>
      )}
      <div className="store-gift-warning">
        <strong>Keep your unused balance safe</strong>
        <p>
          A Minecraft username does not verify ownership. Anyone can enter your
          name. Unlinked cards stay only in this browser session. If you lose
          the code, Drakora cannot recover your unused credit.
        </p>
        <p>
          Link Discord to save your cards privately for next time. Anyone with
          the original code can still redeem it at Tebex. Never share it.
        </p>
      </div>
      {data.identity ? (
        <>
          <p className="store-wallet-identity">
            Linked to {data.identity.name}
          </p>
          <button
            className="store-detail-button"
            type="button"
            disabled={busy}
            onClick={() => request("/store/api/wallet/sign-out", {})}
          >
            Sign out of Discord
          </button>
        </>
      ) : (
        username && (
          <button
            className="store-button secondary"
            type="button"
            disabled={busy || loading || !data.csrf}
            onClick={connect}
          >
            Link Discord & save cards
          </button>
        )
      )}
      {cards.length > 0 && (
        <ul className="store-saved-cards" aria-label="Registered gift cards">
          {cards.map((card) => (
            <li key={card.id}>
              <strong>Card ending {card.suffix}</strong>
              <span>
                {balance(card)} · {card.username}
              </span>
              <small>Checked {new Date(card.checkedAt).toLocaleString()}</small>
              <div>
                <button
                  className="store-detail-button"
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    request(`/store/api/wallet/${card.id}/refresh`, {})
                  }
                >
                  Refresh balance
                </button>
                <button
                  className="store-detail-button"
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    request(`/store/api/wallet/${card.id}`, null, "DELETE")
                  }
                >
                  Forget card
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {cards.length > 0 && (
        <p className="store-community-caption">
          Choose a registered card in your cart when checkout opens. Forget card
          removes the saved reference, not its Tebex balance.
        </p>
      )}
      {loading && <p role="status">Loading saved cards…</p>}
      {error && (
        <p className="store-checkout-error" role="alert">
          {error}
          {!data.csrf && (
            <button
              className="store-detail-button"
              type="button"
              onClick={wallet.retry}
            >
              Try again
            </button>
          )}
        </p>
      )}
      {new URLSearchParams(location.search).has("giftCardError") && (
        <p className="store-checkout-error" role="alert">
          Discord linking did not finish. Link again to check your saved cards.
        </p>
      )}
      {!loading && data.csrf && !data.enabled && (
        <p>Registration is temporarily unavailable.</p>
      )}
    </section>
  );
}
