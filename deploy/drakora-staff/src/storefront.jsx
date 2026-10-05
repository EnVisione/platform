import React, { useEffect, useState } from "react";
import { PublicIcon } from "./public-icons.jsx";
import {
  emptyStoreCatalog,
  storeRanks,
  storeScopes,
  storeBilling,
  storeProductKey,
} from "../shared/storefront.js";
import prominence from "./assets/prominence-logo.png";
import restless from "./assets/restless-horizons-logo.png";
import "./storefront.css";

const money = (product) =>
  product?.price == null
    ? "Coming soon"
    : new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: product.currency,
      }).format(product.price);
const errors = {
  invalid_store_selection:
    "Enter your Minecraft Java username and select a rank.",
  rank_unavailable: "This rank option is not available to purchase yet.",
  tebex_rejected_checkout:
    "Tebex could not start checkout. Check your Minecraft username and try again.",
};
let checkoutScript;
function loadCheckout() {
  if (window.Tebex) return Promise.resolve(window.Tebex);
  if (!checkoutScript)
    checkoutScript = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      const timer = setTimeout(() => {
        script.remove();
        checkoutScript = undefined;
        reject(new Error("checkout_timeout"));
      }, 10000);
      script.src = "https://js.tebex.io/v/1.js";
      script.onload = () => {
        clearTimeout(timer);
        if (window.Tebex) resolve(window.Tebex);
        else {
          checkoutScript = undefined;
          reject(new Error("checkout_unavailable"));
        }
      };
      script.onerror = () => {
        clearTimeout(timer);
        script.remove();
        checkoutScript = undefined;
        reject(new Error("checkout_unavailable"));
      };
      document.head.append(script);
    });
  return checkoutScript;
}

export function Storefront() {
  const [scope, setScope] = useState("network");
  const [billing, setBilling] = useState("monthly");
  const [rank, setRank] = useState("squires");
  const [catalog, setCatalog] = useState(emptyStoreCatalog());
  const [loading, setLoading] = useState(true);
  const [catalogError, setCatalogError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [username, setUsername] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [checkoutUrl, setCheckoutUrl] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    setLoading(true);
    setCatalogError(false);
    fetch("/store/api/catalog", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        const data = await response.json();
        if (!Array.isArray(data.products)) throw new Error();
        setCatalog(data.products);
      })
      .catch(() => {
        if (!disposed) {
          setCatalog(emptyStoreCatalog());
          setCatalogError(true);
        }
      })
      .finally(() => {
        clearTimeout(timer);
        if (!disposed) setLoading(false);
      });
    let disposed = false;
    return () => {
      disposed = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [revision]);
  const selected = catalog.find(
    (product) =>
      storeProductKey(product) === storeProductKey({ rank, scope, billing }),
  );
  const currentScope = storeScopes.find(({ id }) => id === scope);
  const currentRank = storeRanks.find(({ id }) => id === rank);
  const purchaseReady = !loading && !catalogError && selected?.available;
  const change = (setter, value) => {
    setter(value);
    setError("");
    setCheckoutUrl("");
  };
  async function checkout(event) {
    event.preventDefault();
    if (busy || !purchaseReady) return;
    setBusy(true);
    setError("");
    setCheckoutUrl("");
    try {
      const response = await fetch("/store/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rank,
          scope,
          billing,
          username: username.trim(),
        }),
        signal: AbortSignal.timeout(30000),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(
          errors[data.error] ??
            "Checkout is unavailable. Please try again shortly.",
        );
      const url = new URL(data.checkoutUrl);
      if (url.protocol !== "https:" || url.hostname !== "checkout.tebex.io")
        throw new Error("Checkout is unavailable. Please try again shortly.");
      setCheckoutUrl(url.href);
      try {
        const tebex = await loadCheckout();
        tebex.checkout.init({
          ident: data.ident,
          theme: "dark",
          colors: [
            { name: "primary", color: "#a6382b" },
            { name: "secondary", color: "#d3bd91" },
          ],
        });
        tebex.checkout.launch();
      } catch {
        setError(
          "The checkout window could not open. Use the secure checkout link below.",
        );
      }
    } catch (error) {
      setError(
        error.name === "TimeoutError"
          ? "Checkout took too long. Please try again."
          : error.message,
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="storefront">
      <div className="store-hero">
        <div>
          <span className="public-eyebrow">THE DRAKORA STORE</span>
          <h1>Your rank. Your adventure.</h1>
          <p>
            Choose the whole network or your favourite modpack, then pick
            monthly or lifetime.
          </p>
        </div>
        <span className="store-launch-badge">
          <span /> Ranks coming soon
        </span>
      </div>
      {location.pathname.endsWith("/thank-you") && (
        <div className="store-notice" role="status">
          You’ve returned from checkout. Check your Tebex receipt for payment
          confirmation and delivery information.
        </div>
      )}
      {catalogError && (
        <div className="store-notice" role="alert">
          We couldn’t load the latest store information. Purchases are
          temporarily unavailable.{" "}
          <button
            type="button"
            onClick={() => setRevision((value) => value + 1)}
          >
            Try again
          </button>
        </div>
      )}
      <div className="store-layout">
        <div className="store-options">
          <fieldset className="store-step" disabled={busy}>
            <legend>
              <span>01</span> Where will you play?
            </legend>
            <div className="store-scopes">
              {storeScopes.map((item) => (
                <label
                  key={item.id}
                  className={`store-scope${scope === item.id ? " selected" : ""}`}
                >
                  <input
                    type="radio"
                    name="store-scope"
                    value={item.id}
                    checked={scope === item.id}
                    onChange={() => change(setScope, item.id)}
                  />
                  <span className="store-scope-art">
                    {item.id === "network" ? (
                      <PublicIcon name="servers" />
                    ) : (
                      <img
                        src={item.id === "prom2" ? prominence : restless}
                        alt=""
                      />
                    )}
                  </span>
                  <strong>{item.name}</strong>
                  <span>{item.description}</span>
                  {item.id === "network" && <small>Both modpacks</small>}
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className="store-step" disabled={busy}>
            <legend>
              <span>02</span> How would you like to pay?
            </legend>
            <div className="store-billing">
              {storeBilling.map((item) => (
                <label
                  key={item.id}
                  className={billing === item.id ? "selected" : ""}
                >
                  <input
                    type="radio"
                    name="store-billing"
                    value={item.id}
                    checked={billing === item.id}
                    onChange={() => change(setBilling, item.id)}
                  />
                  <span>
                    <strong>{item.name}</strong>
                    <small>{item.description}</small>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className="store-step store-rank-step" disabled={busy}>
            <legend>
              <span>03</span> Choose your rank
            </legend>
            <p className="store-selection-label">
              {currentScope.name} <span>·</span>{" "}
              {billing === "monthly" ? "Monthly" : "Lifetime"}
            </p>
            <div className="store-ranks" aria-busy={loading}>
              {storeRanks.map((item, index) => {
                const product = catalog.find(
                  (entry) =>
                    storeProductKey(entry) ===
                    storeProductKey({ rank: item.id, scope, billing }),
                );
                const alternative = catalog.find(
                  (entry) =>
                    storeProductKey(entry) ===
                    storeProductKey({
                      rank: item.id,
                      scope,
                      billing: billing === "monthly" ? "lifetime" : "monthly",
                    }),
                );
                return (
                  <label
                    className={`store-rank${rank === item.id ? " selected" : ""}`}
                    key={item.id}
                  >
                    <input
                      type="radio"
                      name="store-rank"
                      value={item.id}
                      checked={rank === item.id}
                      onChange={() => change(setRank, item.id)}
                    />
                    <span className="store-rank-emblem" aria-hidden="true">
                      <PublicIcon name="rules" />
                      <small>
                        {String(storeRanks.length - index).padStart(2, "0")}
                      </small>
                    </span>
                    <strong>{item.name}</strong>
                    <span className="store-rank-price">
                      {loading ? "Loading…" : money(product)}
                      {product?.price != null && (
                        <small>
                          {billing === "monthly" ? " / month" : " once"}
                        </small>
                      )}
                    </span>
                    <small>
                      {alternative?.price != null
                        ? `${money(alternative)} ${billing === "monthly" ? "lifetime" : "per month"}`
                        : "Pricing to be announced"}
                    </small>
                    <span className="store-rank-choice">
                      {rank === item.id ? "Selected" : "Choose rank"}{" "}
                      <PublicIcon name={rank === item.id ? "check" : "arrow"} />
                    </span>
                  </label>
                );
              })}
            </div>
            <p className="store-perks-note">
              <PublicIcon name="info" /> Rank perks haven’t been announced yet.
              No purchases are available until pricing and benefits are ready.
            </p>
          </fieldset>
        </div>
        <aside className="store-summary" aria-label="Your rank selection">
          <span className="public-eyebrow">YOUR SELECTION</span>
          <h2>{currentRank.name}</h2>
          <dl>
            <div>
              <dt>Coverage</dt>
              <dd>{currentScope.name}</dd>
            </div>
            <div>
              <dt>Payment</dt>
              <dd>
                {billing === "monthly"
                  ? "Monthly subscription"
                  : "Lifetime · one payment"}
              </dd>
            </div>
          </dl>
          <div className="store-summary-price">
            {loading ? "Loading…" : money(selected)}
            {selected?.price != null && (
              <small>
                {billing === "monthly" ? "every month" : "one-time payment"}
              </small>
            )}
          </div>
          <p>
            {scope === "network"
              ? "One network rank across both current modpacks."
              : `A rank for ${currentScope.name}, including its Drakora worlds. It does not apply to the other modpack.`}
          </p>
          <form onSubmit={checkout}>
            {purchaseReady && (
              <label className="store-username">
                Minecraft Java username
                <input
                  name="username"
                  autoComplete="off"
                  minLength={3}
                  maxLength={16}
                  pattern="[A-Za-z0-9_]{3,16}"
                  required
                  value={username}
                  disabled={busy}
                  onChange={(event) => setUsername(event.target.value)}
                />
              </label>
            )}
            <button
              className="public-button beige"
              disabled={!purchaseReady || busy}
              type="submit"
            >
              {busy
                ? "Opening checkout…"
                : purchaseReady
                  ? "Continue to checkout"
                  : "Coming soon"}
              <PublicIcon name="arrow" />
            </button>
            {purchaseReady && (
              <small>
                Monthly subscriptions renew until cancelled. Final taxes and
                payment terms are shown by Tebex before you pay.
              </small>
            )}
            {error && (
              <p className="store-checkout-error" role="alert">
                {error}
              </p>
            )}
            {checkoutUrl && (
              <a className="public-button" href={checkoutUrl}>
                Open secure Tebex checkout <PublicIcon name="external" />
              </a>
            )}
          </form>
          <div className="store-payment-note">
            <PublicIcon name="rules" />
            <span>
              Payments handled by Tebex.
              <small>Drakora does not collect your card details.</small>
            </span>
          </div>
          <a className="store-help" href="https://drakora.org/help">
            Questions? Get support <PublicIcon name="arrow" />
          </a>
        </aside>
      </div>
      <section className="store-questions" aria-label="Store questions">
        <details>
          <summary>What does a modpack rank cover?</summary>
          <p>
            It covers the Drakora worlds running the selected modpack.
            Prominence II and Restless Horizons are separate options. A network
            rank covers both current modpacks.
          </p>
        </details>
        <details>
          <summary>Monthly or lifetime?</summary>
          <p>
            Monthly ranks will use a recurring monthly subscription. Lifetime
            ranks will use a single payment without a monthly renewal. Prices,
            perks and the full rank terms will be shown before purchases open.
          </p>
        </details>
        <details>
          <summary>When can I buy a rank?</summary>
          <p>
            The rank structure is ready to browse. Purchases will open after
            pricing, perks and rank delivery are configured.
          </p>
        </details>
      </section>
      <p className="store-legal">
        Read the <a href="/terms">Terms of Service</a> and{" "}
        <a href="/privacy">Privacy Policy</a>. Tebex’s checkout terms and
        privacy information apply when you use its payment services. Drakora is
        not affiliated with Mojang or Microsoft.
      </p>
    </div>
  );
}
