import React, { useEffect, useRef, useState } from "react";
import { PublicIcon } from "./public-icons.jsx";
import {
  useStoreCommunity,
  RecentPayments,
  TopCustomers,
  StoreWelcome,
} from "./store-community.jsx";
import { StoreGiftCards, useStoreWallet } from "./store-gift-cards.jsx";
import { StorePlayer, validUsername } from "./store-player.jsx";
import {
  emptyStoreCatalog,
  emptyCommandCatalog,
  storeCommands,
  storeRanks,
  storeScopes,
  storeBilling,
  storePageHref,
  storeProductKey,
  validStoreSelection,
} from "../shared/storefront.js";
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
    "Enter your Minecraft Java username and select a store item.",
  rank_unavailable: "This rank option is not available to purchase yet.",
  command_unavailable: "This command option is not available to purchase yet.",
  tebex_rejected_checkout:
    "Tebex could not start checkout. Check your Minecraft username and try again.",
  gift_card_not_found:
    "This gift card is no longer available. Register it again or choose another card.",
  gift_card_checkout_failed:
    "Tebex could not apply this gift card. Please refresh its balance and try again.",
  invalid_store_request:
    "Your store session expired. Refresh this page before checkout.",
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
function savedUsername() {
  try {
    const value = sessionStorage.getItem(usernameKey) || "";
    return validUsername(value) ? value : "";
  } catch {
    return "";
  }
}

function RankArtwork({ rank }) {
  const crown =
    storeRanks.find(({ id }) => id === rank)?.coverage === "network";
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

const commandArtwork = {
  hat: "M18 12h28v28H18zM6 40h52v10H6z",
  nick: "M8 12h48v32H28L16 56V44H8z",
  particles: "M28 4h8v16h16v8H36v16h-8V28H12v-8h16zM48 44h8v8h-8zM8 44h8v8H8z",
  emote: "M12 8h40v48H12zM20 20v8h8v-8zM36 20v8h8v-8zM20 36v8h8v8h8v-8h8v-8z",
  sit: "M12 8h10v30h30v10H22v12H12zM42 48h10v12H42z",
};
function ProductArtwork({ selection }) {
  return selection.command ? (
    <svg
      className="store-rank-art store-command-art"
      viewBox="0 0 64 64"
      aria-hidden="true"
      shapeRendering="crispEdges"
    >
      <path
        fill="currentColor"
        fillRule="evenodd"
        d={commandArtwork[selection.command]}
      />
    </svg>
  ) : (
    <RankArtwork rank={selection.rank} />
  );
}
const storeItem = (selection) =>
  selection.command
    ? storeCommands.find(({ id }) => id === selection.command)
    : storeRanks.find(({ id }) => id === selection.rank);
const initialCatalog = () => [...emptyStoreCatalog(), ...emptyCommandCatalog()];
const rankCategories = [
  { id: "network", name: "Network ranks" },
  { id: "server", name: "Server-specific ranks" },
];
const serverScopes = storeScopes.filter(({ id }) => id !== "network");
const ranksForCategory = (category) =>
  storeRanks.filter(
    ({ coverage }) =>
      coverage === (category === "server" ? "modpack" : "network"),
  );

function StoreDrawer({ title, onClose, children }) {
  const dialog = useRef(null);
  useEffect(() => {
    const trigger = document.activeElement;
    const element = dialog.current;
    element.showModal();
    element.querySelector("input, select")?.focus();
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

function RankComparison({ category, viewRank }) {
  const network = category === "network";
  const ranks = ranksForCategory(category);
  return (
    <section className="store-comparison" aria-labelledby="store-compare-title">
      <header className="store-comparison-heading">
        <h1 id="store-compare-title" tabIndex={-1}>
          Compare {network ? "network" : "server"} ranks
        </h1>
        <p>
          {network
            ? "All four ranks cover Prominence II and Restless Horizons."
            : "All four ranks apply to one modpack. Choose your server before adding a rank to your cart."}
        </p>
        <p>
          Monthly and lifetime options share the same perks. Prices and perks
          will be announced before purchases open.
        </p>
      </header>
      <p id="store-compare-scroll" className="store-compare-scroll">
        On smaller screens, scroll across to compare these four ranks.
      </p>
      <div
        className="store-comparison-scroll"
        role="region"
        aria-label={`${network ? "Network" : "Server"} rank comparison`}
        aria-describedby="store-compare-scroll"
        tabIndex={0}
      >
        <table className="store-comparison-table">
          <caption>{network ? "Network" : "Server-specific"} ranks</caption>
          <thead>
            <tr>
              <th scope="col">Rank</th>
              {ranks.map((rank) => (
                <th scope="col" key={rank.id}>
                  <RankArtwork rank={rank.id} />
                  <span>{rank.name}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">Explore rank</th>
              {ranks.map((rank) => (
                <td key={rank.id}>
                  <button
                    className="store-detail-button"
                    type="button"
                    aria-label={`View ${rank.name} rank`}
                    onClick={() => viewRank(rank.id)}
                  >
                    View rank
                  </button>
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function Storefront({
  discordInvite,
  discordCount,
  join,
  page = "home",
  locationKey,
  onNavigate,
  storefrontHost = false,
}) {
  const [scope, setScope] = useState("network");
  const storeHome = storePageHref("home", storefrontHost);
  const homePage = page === "home" || page === "thank-you";
  const commandsPage = page === "commands";
  const showComparison = page === "network" || page === "server";
  useEffect(() => {
    if (page === "gift-cards") {
      onNavigate(`${storeHome}${location.search}#store-gift-cards`, {
        replace: true,
      });
    } else if (location.hash === "#store-gift-cards") {
      document
        .getElementById("store-gift-cards")
        ?.scrollIntoView({ block: "start" });
    }
  }, [page, storeHome, locationKey, onNavigate]);
  const [billing, setBilling] = useState("monthly");
  const [catalog, setCatalog] = useState(initialCatalog);
  const [loading, setLoading] = useState(true);
  const [catalogError, setCatalogError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [username, setUsername] = useState(savedUsername);
  const [usernameDraft, setUsernameDraft] = useState("");
  const [usernameError, setUsernameError] = useState("");
  const [drawer, setDrawer] = useState(null);
  const [details, setDetails] = useState(null);
  const [cart, setCart] = useState(null);
  const community = useStoreCommunity();
  const wallet = useStoreWallet();
  const [giftCardId, setGiftCardId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [checkoutUrl, setCheckoutUrl] = useState("");
  const previousPage = useRef(page);
  useEffect(() => {
    if (previousPage.current !== page) {
      setDrawer(null);
      setError("");
      setCheckoutUrl("");
      document.querySelector(".store-main h1")?.focus({ preventScroll: true });
    }
    previousPage.current = page;
  }, [page]);
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
        setCatalog([
          ...data.products,
          ...(Array.isArray(data.commands)
            ? data.commands
            : emptyCommandCatalog()),
        ]);
      })
      .catch(() => {
        if (!disposed) {
          setCatalog(initialCatalog());
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
  const detailItem = details && storeItem(details);
  const detailNeedsServer = detailItem?.coverage === "modpack";
  const cartItem = cart && storeItem(cart);
  const purchaseReady = !loading && !catalogError && cartProduct?.available;
  const giftCards = wallet.data.cards.filter(
    (card) =>
      card.remaining > 0 &&
      (wallet.data.identity ||
        card.username.toLowerCase() === username.toLowerCase()),
  );
  useEffect(() => {
    if (!giftCards.some((card) => card.id === giftCardId)) setGiftCardId("");
  }, [wallet.data, username, giftCardId]);
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
  function selectScope(value) {
    setScope(value);
    setError("");
    setCheckoutUrl("");
  }
  function navigate(event, href) {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    onNavigate(href);
  }
  function viewRank(rank) {
    viewProduct({ rank });
  }
  function viewProduct(selection) {
    const rank = selection.rank && storeItem(selection);
    setDetails({
      ...selection,
      scope: rank ? (rank.coverage === "network" ? "network" : "") : scope,
      billing,
    });
    setDrawer("product");
  }
  function addToCart() {
    if (
      loading ||
      catalogError ||
      !validStoreSelection(details) ||
      !detailProduct?.available
    )
      return;
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
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": wallet.data.csrf,
        },
        body: JSON.stringify({ ...cart, username, giftCardId }),
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
      <div className="store-shell">
        <aside className="store-sidebar" aria-label="Store navigation">
          <div className="username-box">
            <StorePlayer username={username} body />
            <div className="store-player-text">
              <strong title={username || "Guest"}>{username || "Guest"}</strong>
              <button
                className="store-button secondary"
                type="button"
                onClick={username ? logout : openLogin}
              >
                {username ? "Logout" : "Login"}
              </button>
            </div>
          </div>
          <nav className="user-nav" aria-label="Store categories">
            <a
              href={storeHome}
              className={homePage ? "active" : ""}
              aria-current={homePage ? "page" : undefined}
              onClick={(event) => navigate(event, storeHome)}
            >
              <PublicIcon name="home" /> Store home
            </a>
            <span className="store-nav-label">RANKS</span>
            {rankCategories.map((item) => (
              <a
                key={item.id}
                href={storePageHref(item.id, storefrontHost)}
                className={page === item.id ? "active" : ""}
                aria-current={page === item.id ? "page" : undefined}
                onClick={(event) =>
                  navigate(event, storePageHref(item.id, storefrontHost))
                }
              >
                <PublicIcon name="servers" /> {item.name}
              </a>
            ))}
            <a
              href={storePageHref("commands", storefrontHost)}
              className={commandsPage ? "active" : ""}
              aria-current={commandsPage ? "page" : undefined}
              onClick={(event) =>
                navigate(event, storePageHref("commands", storefrontHost))
              }
            >
              <PublicIcon name="play" /> Commands
            </a>
          </nav>
          <RecentPayments community={community} />
          <StoreGiftCards
            username={username}
            onLogin={openLogin}
            wallet={wallet}
          />
          <div className="store-sidebar-help">
            <h2>Need a hand?</h2>
            <a href="https://drakora.org/help">
              <PublicIcon name="help" /> Get support
            </a>
            <a href={discordInvite || "https://drakora.org/discord"}>
              <PublicIcon name="discord" /> Join Discord
              {discordCount != null && (
                <small>{discordCount.toLocaleString()} members</small>
              )}
            </a>
            <div className="store-server-address">{join}</div>
            <a href="https://drakora.org">
              <PublicIcon name="home" /> Back to home
            </a>
          </div>
        </aside>
        <div className="store-main">
          <div className="store-main-top">
            {drawer !== "cart" && (
              <TopCustomers community={community} compact />
            )}
            <button
              className="store-cart-button"
              type="button"
              aria-label={`Cart ${cart ? 1 : 0}`}
              onClick={() => setDrawer("cart")}
            >
              <PublicIcon name="store" />
              <span className="store-cart-label">
                Cart <span className="store-cart-count">{cart ? 1 : 0}</span>
              </span>
            </button>
          </div>
          {homePage && <StoreWelcome />}
          {page === "thank-you" && (
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
          {showComparison ? (
            <RankComparison category={page} viewRank={viewRank} />
          ) : commandsPage ? (
            <section
              className="store-catalog"
              aria-labelledby="store-category-title"
            >
              <header className="store-category-header">
                <div>
                  <h1 id="store-category-title" tabIndex={-1}>
                    Individual commands
                  </h1>
                  <label className="store-command-scope">
                    Coverage
                    <select
                      value={scope}
                      onChange={(event) => selectScope(event.target.value)}
                    >
                      {storeScopes.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                  </label>
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
                {storeCommands.map((item) => {
                  const selection = { command: item.id };
                  const product = productFor({
                    ...selection,
                    scope,
                    billing,
                  });
                  const available = product?.available;
                  return (
                    <article className="package" key={item.id}>
                      <div className="store-product-image" aria-hidden="true">
                        <ProductArtwork selection={selection} />
                      </div>
                      <div className="store-product-info">
                        <h3>{item.invocation}</h3>
                        <p className="store-command-description">
                          {item.description}
                        </p>
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
                          aria-label={`View ${item.invocation} command`}
                          onClick={() => viewProduct(selection)}
                        >
                          {available ? "Choose command" : "View command"}
                          <PublicIcon name="arrow" />
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
          ) : null}
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
                : (detailItem.invocation ?? detailItem.name)
          }
          onClose={() => setDrawer(null)}
        >
          {drawer === "login" ? (
            <form className="store-login-form" onSubmit={login}>
              <StorePlayer username={usernameDraft} preview />
              <h3>Please enter your username to continue</h3>
              <p>
                Use your Minecraft Java username so your purchase can be
                delivered to the right player.
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
              <ProductArtwork selection={details} />
              <h3>{detailItem.invocation ?? detailItem.name}</h3>
              {details.command && <p>{detailItem.description}</p>}
              {detailNeedsServer && (
                <div className="store-server-choice">
                  <label htmlFor="store-rank-server">
                    Which server will you play on?
                  </label>
                  <select
                    id="store-rank-server"
                    required
                    value={details.scope}
                    onChange={(event) =>
                      setDetails({ ...details, scope: event.target.value })
                    }
                    aria-describedby="store-rank-server-help"
                  >
                    <option value="" disabled>
                      Choose a server
                    </option>
                    {serverScopes.map((server) => (
                      <option key={server.id} value={server.id}>
                        {server.name}
                      </option>
                    ))}
                  </select>
                  <p id="store-rank-server-help">
                    This rank applies only to the server you choose.
                  </p>
                </div>
              )}
              <dl>
                <div>
                  <dt>Coverage</dt>
                  <dd>
                    {storeScopes.find(({ id }) => id === details.scope)?.name ??
                      "Choose a server"}
                  </dd>
                </div>
                <div>
                  <dt>Payment</dt>
                  <dd>
                    <div
                      className="store-billing"
                      role="group"
                      aria-label="Payment period"
                    >
                      {storeBilling.map((item) => (
                        <button
                          type="button"
                          key={item.id}
                          className={
                            details.billing === item.id ? "active" : ""
                          }
                          aria-pressed={details.billing === item.id}
                          onClick={() => {
                            setDetails({ ...details, billing: item.id });
                            setBilling(item.id);
                          }}
                        >
                          {item.name}
                        </button>
                      ))}
                    </div>
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
              <p>
                {details.command
                  ? "Includes this individual command, without a rank bundle. Command behavior and access terms will be confirmed before purchases open."
                  : "Rank perks have not been announced yet."}
              </p>
              <button
                className="store-button"
                type="button"
                disabled={
                  loading ||
                  catalogError ||
                  !validStoreSelection(details) ||
                  !detailProduct?.available
                }
                onClick={addToCart}
              >
                {detailNeedsServer && !details.scope
                  ? "Choose a server"
                  : detailProduct?.available
                    ? "Add to cart"
                    : "Coming soon"}
              </button>
            </div>
          ) : cart ? (
            <div className="store-cart-content">
              <div className="store-cart-item">
                <ProductArtwork selection={cart} />
                <div>
                  <h3>{cartItem.invocation ?? cartItem.name}</h3>
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
                  aria-label={
                    cart.command
                      ? "Remove command from cart"
                      : "Remove rank from cart"
                  }
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
              {giftCards.length > 0 && (
                <div className="store-cart-gift">
                  <label htmlFor="store-cart-gift-card">Gift card</label>
                  <select
                    id="store-cart-gift-card"
                    value={giftCardId}
                    disabled={busy}
                    onChange={(event) => setGiftCardId(event.target.value)}
                  >
                    <option value="">No gift card</option>
                    {giftCards.map((card) => (
                      <option key={card.id} value={card.id}>
                        Card ending {card.suffix} ·{" "}
                        {money({
                          price: card.remaining,
                          currency: card.currency,
                        })}
                      </option>
                    ))}
                  </select>
                  {!wallet.data.identity && (
                    <p>
                      This card is registered only for this browser session.
                      Link Discord to save any unused balance for later.
                    </p>
                  )}
                </div>
              )}
              <button
                className="store-button"
                type="button"
                disabled={
                  !purchaseReady || busy || wallet.loading || !wallet.data.csrf
                }
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
                Ranks and individual commands are coming soon. Browse the
                categories to see what’s planned.
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
