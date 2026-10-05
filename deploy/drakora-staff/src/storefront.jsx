import React, { useEffect, useRef, useState } from "react";
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
import logo from "./assets/drakora-logo.png";
import castle from "./assets/medieval-castle.svg";
import forest from "./assets/medieval-forest.svg";
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

const usernameKey = "drakora-store-username";
const validUsername = (value) => /^[A-Za-z0-9_]{3,16}$/.test(value);
function savedUsername() {
  try {
    const value = sessionStorage.getItem(usernameKey) || "";
    return validUsername(value) ? value : "";
  } catch {
    return "";
  }
}

function PlayerFace() {
  return (
    <svg
      className="store-player"
      viewBox="0 0 8 8"
      aria-hidden="true"
      shapeRendering="crispEdges"
    >
      <path fill="#49382b" d="M0 0h8v8H0z" />
      <path fill="#bb906b" d="M0 3h8v4H0zM2 7h4v1H2z" />
      <path fill="#e1d4bd" d="M1 4h2v1H1zM5 4h2v1H5z" />
      <path fill="#52615b" d="M2 4h1v1H2zM5 4h1v1H5z" />
      <path fill="#76553c" d="M3 5h2v1H3zM2 6h4v1H2z" />
    </svg>
  );
}

function RankArtwork({ rank }) {
  const crown = ["king", "duke", "earl"].includes(rank);
  return (
    <svg
      className={`store-rank-art ${rank}`}
      viewBox="0 0 64 64"
      aria-hidden="true"
      shapeRendering="crispEdges"
    >
      {crown ? (
        <>
          <path
            fill="currentColor"
            d="M10 20h8v8h8V12h12v16h8v-8h8v24H10zM14 48h36v8H14z"
          />
          <path fill="#a6382b" d="M28 30h8v8h-8zM16 34h6v6h-6zM42 34h6v6h-6z" />
        </>
      ) : (
        <>
          <path fill="currentColor" d="M12 12h40v28L32 56 12 40z" />
          <path fill="#161616" d="M20 20h24v16L32 46 20 36z" />
          <path fill="#a6382b" d="M28 20h8v24h-8zM20 28h24v8H20z" />
        </>
      )}
    </svg>
  );
}

function StoreDrawer({ title, onClose, children }) {
  const dialog = useRef(null);
  useEffect(() => {
    const trigger = document.activeElement;
    const element = dialog.current;
    element.showModal();
    element.querySelector("input")?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      element.close();
      document.body.style.overflow = previousOverflow;
      if (trigger?.isConnected) trigger.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="store-drawer"
      aria-labelledby="store-drawer-title"
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="store-drawer-inner">
        <header>
          <h2 id="store-drawer-title">{title}</h2>
          <button
            className="store-icon-button"
            type="button"
            onClick={onClose}
            aria-label="Close drawer"
          >
            <PublicIcon name="close" />
          </button>
        </header>
        {children}
      </div>
    </dialog>
  );
}

const slides = [
  {
    scope: "network",
    title: "Drakora Store",
    kicker: "Welcome to the official",
    description: "Network ranks for Prominence II and Restless Horizons.",
    artwork: castle,
  },
  {
    scope: "prom2",
    title: "Prominence II",
    kicker: "Choose your modpack",
    description: "Ranks for every Drakora world running Prominence II.",
    artwork: forest,
    logo: prominence,
  },
  {
    scope: "restless-horizons",
    title: "Restless Horizons",
    kicker: "Choose your modpack",
    description: "Ranks for every Drakora world running Restless Horizons.",
    artwork: castle,
    logo: restless,
  },
];

export function Storefront({ discordInvite, discordCount, join }) {
  const [category, setCategory] = useState("home");
  const scope = category === "home" ? "network" : category;
  const [billing, setBilling] = useState("monthly");
  const [catalog, setCatalog] = useState(emptyStoreCatalog());
  const [loading, setLoading] = useState(true);
  const [catalogError, setCatalogError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [username, setUsername] = useState(savedUsername);
  const [usernameDraft, setUsernameDraft] = useState("");
  const [usernameError, setUsernameError] = useState("");
  const [drawer, setDrawer] = useState(null);
  const [details, setDetails] = useState(null);
  const [cart, setCart] = useState(null);
  const [slide, setSlide] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [checkoutUrl, setCheckoutUrl] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    let disposed = false;
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
    return () => {
      disposed = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [revision]);
  const productFor = (selection) =>
    selection &&
    catalog.find(
      (product) => storeProductKey(product) === storeProductKey(selection),
    );
  const cartProduct = productFor(cart);
  const detailProduct = productFor(details);
  const currentScope = storeScopes.find(({ id }) => id === scope);
  const purchaseReady = !loading && !catalogError && cartProduct?.available;
  const activeSlide = slides[slide];
  function openLogin() {
    setUsernameDraft(username);
    setUsernameError("");
    setDrawer("login");
  }
  function login(event) {
    event.preventDefault();
    const value = usernameDraft.trim();
    if (!validUsername(value)) {
      setUsernameError(
        "Use 3–16 letters, numbers or underscores for a Minecraft Java username.",
      );
      return;
    }
    setUsername(value);
    try {
      sessionStorage.setItem(usernameKey, value);
    } catch {
      /* Browser storage can be disabled. */
    }
    setDrawer(cart ? "cart" : null);
  }
  function logout() {
    setUsername("");
    try {
      sessionStorage.removeItem(usernameKey);
    } catch {
      /* Browser storage can be disabled. */
    }
    setError("");
    setCheckoutUrl("");
  }
  function selectCategory(value) {
    setCategory(value);
    setError("");
    setCheckoutUrl("");
  }
  function viewRank(rank) {
    setDetails({ rank, scope, billing });
    setDrawer("product");
  }
  function addToCart() {
    if (loading || catalogError || !detailProduct?.available) return;
    setCart(details);
    setError("");
    setCheckoutUrl("");
    if (username) setDrawer("cart");
    else openLogin();
  }
  async function checkout() {
    if (busy || !purchaseReady) return;
    if (!username) {
      openLogin();
      return;
    }
    setBusy(true);
    setError("");
    setCheckoutUrl("");
    try {
      const response = await fetch("/store/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...cart, username }),
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
    } catch (failure) {
      setError(
        failure.name === "TimeoutError"
          ? "Checkout took too long. Please try again."
          : failure.message,
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="storefront">
      <header className="public-header store-header">
        <div className="store-topbar">
          <a href="https://drakora.org">
            <PublicIcon name="home" /> Back to home
          </a>
          <div>
            <button type="button" onClick={openLogin}>
              <PublicIcon name="users" /> {username || "Login"}
            </button>
            <button type="button" onClick={() => setDrawer("cart")}>
              <PublicIcon name="store" /> Cart <span>{cart ? 1 : 0}</span>
            </button>
          </div>
        </div>
        <div className="public-masthead">
          <div className="public-join">{join}</div>
          <a
            href="https://store.drakora.org"
            className="public-brand"
            aria-label="Drakora Store home"
          >
            <img src={logo} alt="" />
            <span>
              DRAKORA<small>NETWORK STORE</small>
            </span>
          </a>
          <a
            href={discordInvite || "https://drakora.org/discord"}
            className="public-discord"
          >
            <span className="public-status-icon">
              <PublicIcon name="discord" />
            </span>
            <span className="public-status-copy">
              <span className="public-eyebrow">
                {discordCount == null
                  ? "OUR COMMUNITY"
                  : `${discordCount.toLocaleString()} TOTAL MEMBERS`}
              </span>
              <strong>
                Join our Discord <PublicIcon name="external" />
              </strong>
              <span>Chat, updates & support</span>
            </span>
          </a>
        </div>
      </header>
      <div className="store-shell">
        <aside className="store-sidebar" aria-label="Store navigation">
          <div className="username-box">
            <PlayerFace />
            <div>
              <strong>{username || "Guest"}</strong>
              <span>
                {username ? "Minecraft Java" : "Enter your Minecraft username"}
              </span>
              <button
                className="store-button secondary"
                type="button"
                onClick={username ? logout : openLogin}
              >
                {username ? "Logout" : "Login"}
              </button>
            </div>
          </div>
          <nav className="user-nav" aria-label="Rank categories">
            <button
              type="button"
              className={category === "home" ? "active" : ""}
              aria-current={category === "home" ? "page" : undefined}
              onClick={() => selectCategory("home")}
            >
              <PublicIcon name="home" /> Store home
            </button>
            <span className="store-nav-label">RANKS</span>
            {storeScopes.map((item) => (
              <button
                key={item.id}
                type="button"
                className={category === item.id ? "active" : ""}
                aria-current={category === item.id ? "page" : undefined}
                onClick={() => selectCategory(item.id)}
              >
                <PublicIcon name="servers" />{" "}
                {item.id === "network" ? "Network ranks" : item.name}
              </button>
            ))}
          </nav>
          <div className="store-sidebar-help">
            <h2>Need a hand?</h2>
            <p>Questions about the store? Our staff can help.</p>
            <a href="https://drakora.org/help">
              <PublicIcon name="help" /> Get support
            </a>
            <a href={discordInvite || "https://drakora.org/discord"}>
              <PublicIcon name="discord" /> Join Discord
            </a>
          </div>
        </aside>
        <div className="store-main">
          {category === "home" && (
            <section
              className="store-slider"
              aria-label="Store highlights"
              aria-roledescription="carousel"
            >
              <img
                className="store-slide-scenery"
                src={activeSlide.artwork}
                alt=""
              />
              <div className="store-slide-content" aria-live="polite">
                <span>{activeSlide.kicker}</span>
                <h1>{activeSlide.title}</h1>
                <p>{activeSlide.description}</p>
                <button
                  className="store-button"
                  type="button"
                  onClick={() => selectCategory(activeSlide.scope)}
                >
                  Browse ranks <PublicIcon name="arrow" />
                </button>
              </div>
              {activeSlide.logo && (
                <img
                  className="store-slide-logo"
                  src={activeSlide.logo}
                  alt=""
                />
              )}
              <div className="store-slider-controls">
                <button
                  className="store-icon-button"
                  type="button"
                  aria-label="Previous slide"
                  onClick={() =>
                    setSlide(
                      (value) => (value + slides.length - 1) % slides.length,
                    )
                  }
                >
                  <PublicIcon name="back" />
                </button>
                {slides.map((item, index) => (
                  <button
                    type="button"
                    key={item.scope}
                    className={slide === index ? "active" : ""}
                    aria-label={`Show ${item.title}`}
                    aria-pressed={slide === index}
                    onClick={() => setSlide(index)}
                  />
                ))}
                <button
                  className="store-icon-button"
                  type="button"
                  aria-label="Next slide"
                  onClick={() =>
                    setSlide((value) => (value + 1) % slides.length)
                  }
                >
                  <PublicIcon name="arrow" />
                </button>
              </div>
            </section>
          )}
          {location.pathname.endsWith("/thank-you") && (
            <p className="store-notice" role="status">
              You’ve returned from checkout. Check your Tebex receipt for
              payment confirmation and delivery information.
            </p>
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
          <section
            className="store-catalog"
            aria-labelledby="store-category-title"
          >
            <header className="store-category-header">
              <div>
                <h2 id="store-category-title">
                  {scope === "network"
                    ? "Network ranks"
                    : `${currentScope.name} ranks`}
                </h2>
                <p>
                  {scope === "network"
                    ? "Across both of our current modpacks."
                    : currentScope.description}
                </p>
              </div>
              <div
                className="store-billing"
                role="group"
                aria-label="Payment period"
              >
                {storeBilling.map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    className={billing === item.id ? "active" : ""}
                    aria-pressed={billing === item.id}
                    onClick={() => setBilling(item.id)}
                  >
                    {item.name}
                  </button>
                ))}
              </div>
            </header>
            <div className="store-products" aria-busy={loading}>
              {storeRanks.map((item) => {
                const product = productFor({ rank: item.id, scope, billing });
                return (
                  <article className="package" key={item.id}>
                    <button
                      className="store-product-image"
                      type="button"
                      aria-label={`View ${item.name} rank`}
                      onClick={() => viewRank(item.id)}
                    >
                      <RankArtwork rank={item.id} />
                    </button>
                    <div className="store-product-info">
                      <h3>{item.name}</h3>
                      <span>
                        {loading ? "Loading…" : money(product)}
                        {product?.price != null && (
                          <small>
                            {billing === "monthly" ? " / month" : " once"}
                          </small>
                        )}
                      </span>
                    </div>
                    <div className="store-product-actions">
                      <button
                        className="store-detail-button"
                        type="button"
                        onClick={() => viewRank(item.id)}
                      >
                        View details
                      </button>
                      <button
                        className="store-button"
                        type="button"
                        disabled={
                          loading || catalogError || !product?.available
                        }
                        onClick={() => viewRank(item.id)}
                      >
                        {product?.available ? "Choose rank" : "Coming soon"}
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
            <p className="store-catalog-note">
              Prices and rank perks will be announced before purchases open.
            </p>
          </section>
          <section className="store-information" aria-label="Store information">
            <div>
              <h2>Network or modpack?</h2>
              <p>
                Network ranks cover Prominence II and Restless Horizons. Modpack
                ranks apply to the selected modpack’s Drakora worlds.
              </p>
            </div>
            <div>
              <h2>Monthly or lifetime?</h2>
              <p>
                Monthly is a recurring subscription. Lifetime is one payment
                with no monthly renewal. Full rank terms will be available
                before launch.
              </p>
            </div>
            <div>
              <h2>Secure checkout</h2>
              <p>
                Payments will be handled by Tebex. Drakora does not collect your
                card details.
              </p>
            </div>
          </section>
          <p className="store-legal">
            Read our <a href="/terms">Terms of Service</a> and{" "}
            <a href="/privacy">Privacy Policy</a>. Tebex’s checkout terms and
            privacy information apply when you use its payment services.
          </p>
        </div>
      </div>
      {drawer && (
        <StoreDrawer
          key={drawer}
          title={
            drawer === "login"
              ? "Login"
              : drawer === "cart"
                ? `Your cart (${cart ? 1 : 0})`
                : storeRanks.find(({ id }) => id === details.rank).name
          }
          onClose={() => setDrawer(null)}
        >
          {drawer === "login" ? (
            <form className="store-login-form" onSubmit={login}>
              <PlayerFace />
              <h3>Please enter your username to continue</h3>
              <p>
                Use your Minecraft Java username so your rank can be delivered
                to the right player.
              </p>
              <label htmlFor="store-username">Minecraft username</label>
              <input
                id="store-username"
                name="username"
                autoComplete="off"
                autoFocus
                required
                maxLength={16}
                value={usernameDraft}
                onChange={(event) => {
                  setUsernameDraft(event.target.value);
                  setUsernameError("");
                }}
              />
              {usernameError && (
                <p className="store-checkout-error" role="alert">
                  {usernameError}
                </p>
              )}
              <button className="store-button" type="submit">
                Continue <PublicIcon name="arrow" />
              </button>
              <small>
                This saves a username for this browser tab. It does not verify
                account ownership or create a Drakora account.{" "}
                <a href="/privacy-settings">Privacy information</a>
              </small>
            </form>
          ) : drawer === "product" ? (
            <div className="store-product-details">
              <RankArtwork rank={details.rank} />
              <h3>{storeRanks.find(({ id }) => id === details.rank).name}</h3>
              <dl>
                <div>
                  <dt>Coverage</dt>
                  <dd>
                    {storeScopes.find(({ id }) => id === details.scope).name}
                  </dd>
                </div>
                <div>
                  <dt>Payment</dt>
                  <dd>
                    {details.billing === "monthly"
                      ? "Monthly subscription"
                      : "Lifetime · one payment"}
                  </dd>
                </div>
              </dl>
              <strong className="store-detail-price">
                {money(detailProduct)}
              </strong>
              <p>
                {details.scope === "network"
                  ? "Applies across both current Drakora modpacks."
                  : "Applies to the selected modpack’s Drakora worlds."}
              </p>
              <p>Rank perks have not been announced yet.</p>
              <button
                className="store-button"
                type="button"
                disabled={loading || catalogError || !detailProduct?.available}
                onClick={addToCart}
              >
                {detailProduct?.available ? "Add to cart" : "Coming soon"}
              </button>
            </div>
          ) : cart ? (
            <div className="store-cart-content">
              <div className="store-cart-item">
                <RankArtwork rank={cart.rank} />
                <div>
                  <h3>{storeRanks.find(({ id }) => id === cart.rank).name}</h3>
                  <p>
                    {storeScopes.find(({ id }) => id === cart.scope).name} ·{" "}
                    {cart.billing === "monthly" ? "Monthly" : "Lifetime"}
                  </p>
                  <strong>{money(cartProduct)}</strong>
                </div>
                <button
                  className="store-icon-button"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setCart(null);
                    setError("");
                    setCheckoutUrl("");
                  }}
                  aria-label="Remove rank from cart"
                >
                  <PublicIcon name="close" />
                </button>
              </div>
              <div className="store-cart-player">
                <span>
                  {username
                    ? `For ${username}`
                    : "Enter your Minecraft username before checkout."}
                </span>
                <button
                  type="button"
                  className="store-detail-button"
                  onClick={openLogin}
                >
                  {username ? "Change" : "Login"}
                </button>
              </div>
              <button
                className="store-button"
                type="button"
                disabled={!purchaseReady || busy}
                onClick={checkout}
              >
                {busy
                  ? "Opening checkout…"
                  : purchaseReady
                    ? "Checkout"
                    : "Coming soon"}{" "}
                <PublicIcon name="arrow" />
              </button>
              <p>
                Monthly subscriptions renew until cancelled. Final taxes and
                payment terms are shown by Tebex before you pay.
              </p>
              {error && (
                <p className="store-checkout-error" role="alert">
                  {error}
                </p>
              )}
              {checkoutUrl && (
                <a className="store-button" href={checkoutUrl}>
                  Open secure Tebex checkout <PublicIcon name="external" />
                </a>
              )}
            </div>
          ) : (
            <div className="store-empty-cart">
              <PublicIcon name="store" />
              <h3>Your cart is empty</h3>
              <p>
                Ranks are coming soon. Browse the categories to see what’s
                planned.
              </p>
              <button
                className="store-button"
                type="button"
                onClick={() => setDrawer(null)}
              >
                Continue shopping <PublicIcon name="arrow" />
              </button>
            </div>
          )}
        </StoreDrawer>
      )}
    </div>
  );
}
