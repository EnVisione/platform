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
  storeRanks,
  storeScopes,
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

const storeItem = (selection) =>
  storeRanks.find(({ id }) => id === selection.rank);
const initialCatalog = emptyStoreCatalog;
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
const mobileStoreQuery = "(max-width: 760px)";

function StoreCartButton({ count, onClick }) {
  return (
    <button
      className="store-cart-button"
      type="button"
      aria-label={`Cart ${count}`}
      onClick={onClick}
    >
      <PublicIcon name="store" />
      <span className="store-cart-label">
        Cart <span className="store-cart-count">{count}</span>
      </span>
    </button>
  );
}

function StoreNavigation({
  page,
  homePage,
  mobile,
  storefrontHost,
  onNavigate,
}) {
  const [open, setOpen] = useState(false);
  const navigation = useRef(null);
  const toggle = useRef(null);
  useEffect(() => setOpen(false), [page, mobile]);
  useEffect(() => {
    if (!open || !mobile) return;
    const dismiss = (event) => {
      if (!navigation.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event) => {
      if (event.key === "Escape") {
        setOpen(false);
        toggle.current?.focus();
      }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [open, mobile]);
  function follow(event, target) {
    setOpen(false);
    onNavigate(event, storePageHref(target, storefrontHost));
  }
  return (
    <div
      ref={navigation}
      className="store-navigation"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        ref={toggle}
        className="store-menu-toggle"
        type="button"
        aria-label={open ? "Close store menu" : "Open store menu"}
        aria-expanded={open}
        aria-controls="store-category-links"
        onClick={() => setOpen((value) => !value)}
      >
        <PublicIcon name={open ? "close" : "menu"} /> Store menu
      </button>
      <nav
        id="store-category-links"
        className={`user-nav${open ? " open" : ""}`}
        aria-label="Store categories"
      >
        <a
          className="store-back-home"
          href="https://drakora.org/"
          onClick={() => setOpen(false)}
        >
          <PublicIcon name="home" /> Back to home
        </a>
        <a
          href={storePageHref("home", storefrontHost)}
          className={`store-category-home${homePage ? " active" : ""}`}
          aria-current={homePage ? "page" : undefined}
          onClick={(event) => follow(event, "home")}
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
            onClick={(event) => follow(event, item.id)}
          >
            <PublicIcon name="servers" /> {item.name}
          </a>
        ))}
        <a
          href={storePageHref("prefixes", storefrontHost)}
          className={page === "prefixes" ? "active" : ""}
          aria-current={page === "prefixes" ? "page" : undefined}
          onClick={(event) => follow(event, "prefixes")}
        >
          <PublicIcon name="play" /> Prefixes
        </a>
      </nav>
    </div>
  );
}

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

const previewRankFeatures = [
  { name: "Game replays", values: [true, true, true, true] },
  { name: "No chat cooldown", values: [true, true, true, true] },
  { name: "Rank-specific cosmetics", values: [true, true, true, true] },
  { name: "Saved outfits", values: [2, 4, 6, 6] },
  { name: "Priority queue", values: [true, true, true, true] },
  { name: "Create a guild", values: [false, true, true, true] },
  { name: "Custom name colours", values: [false, false, true, true] },
  { name: "Particle packs", values: [false, false, true, true] },
  { name: "Seasonal cosmetics", values: [false, false, false, true] },
  { name: "Nickname (/nick)", values: [false, false, false, true] },
  { name: "Exclusive chat emojis", values: [false, false, false, true] },
];
const morePreviewRankFeatures = [
  { name: "Flying in lobbies", values: [true, true, true, true] },
  { name: "Click effects", values: [true, true, true, true] },
  { name: "Emotes", values: [true, true, true, true] },
  { name: "Gift ranks", values: [true, true, true, true] },
  { name: "Cosmetic pets", values: [false, false, true, true] },
  { name: "Custom join messages", values: [false, false, false, true] },
];

function RankFeatureValue({ value }) {
  return typeof value === "boolean" ? (
    <span className={`store-feature-status ${value ? "included" : "excluded"}`}>
      <PublicIcon name={value ? "check" : "close"} />
      <span className="store-visually-hidden">
        {value ? "Included" : "Not included"}
      </span>
    </span>
  ) : (
    value
  );
}

function RankComparison({ category, viewRank, productFor, mobile }) {
  const network = category === "network";
  const ranks = ranksForCategory(category);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => setExpanded(false), [category]);
  const action = (rank) => (
    <button
      className="store-rank-action"
      type="button"
      aria-label={`View ${rank.name} rank`}
      onClick={() => viewRank(rank.id)}
    >
      <PublicIcon name="store" /> View rank
    </button>
  );
  const summary = (rank) =>
    rank.requiresRank ? (
      <>
        Monthly bonus for <strong>{network ? "ArchWyvern" : "Wyvern"}</strong>{" "}
        owners.
      </>
    ) : (
      "A permanent rank. One purchase, no monthly renewal."
    );
  const price = (rank) => (
    <strong className="store-compare-price">
      {money(
        productFor({
          rank: rank.id,
          scope: network ? "network" : "prom2",
          billing: rank.billing,
        }),
      )}
      {rank.billing === "monthly" && <small> / month</small>}
    </strong>
  );
  const featureRows = (features) =>
    features.map(({ name, values }) => (
      <tr key={name}>
        <th scope="row">{name}</th>
        {ranks.map((rank, index) => (
          <td key={rank.id}>
            <RankFeatureValue value={values[index]} />
          </td>
        ))}
      </tr>
    ));
  return (
    <section className="store-comparison" aria-labelledby="store-compare-title">
      <header className="store-comparison-heading">
        <h1 id="store-compare-title" tabIndex={-1}>
          {network ? "Network" : "Server-specific"} ranks
        </h1>
        <p>
          {network
            ? "Cover Prominence II and Restless Horizons with one network rank."
            : "Choose your modpack in the rank details before adding it to your cart."}
        </p>
        <p className="store-perks-preview-note">
          <strong>Preview perks.</strong> The features and prefix styles below
          are examples, not final benefits. Purchases are coming soon.
        </p>
      </header>
      {mobile && (
        <>
          <div className="store-mobile-rank-cards">
            {ranks.map((rank) => (
              <article
                className="store-mobile-rank-card"
                key={rank.id}
                aria-labelledby={`store-rank-card-${rank.id}`}
              >
                <RankArtwork rank={rank.id} />
                <h2 id={`store-rank-card-${rank.id}`}>{rank.name}</h2>
                <p>{summary(rank)}</p>
                {price(rank)}
                {action(rank)}
              </article>
            ))}
          </div>
          <h2 className="store-mobile-compare-title">Compare ranks</h2>
        </>
      )}
      <p id="store-compare-scroll" className="store-compare-scroll">
        {mobile
          ? "Swipe across to compare the perks."
          : "Scroll across to compare ranks, and down for more features."}
      </p>
      <div
        className="store-comparison-scroll"
        role="region"
        aria-label={`${network ? "Network" : "Server"} rank comparison`}
        aria-describedby="store-compare-scroll"
        tabIndex={0}
      >
        <table className="store-comparison-table">
          <caption>
            {network ? "Network" : "Server-specific"} rank preview
          </caption>
          <thead>
            {!mobile && (
              <tr className="store-rank-art-row" aria-hidden="true">
                <td className="store-comparison-spacer" />
                {ranks.map((rank) => (
                  <td key={rank.id}>
                    <RankArtwork rank={rank.id} />
                  </td>
                ))}
              </tr>
            )}
            <tr className="store-rank-name-row">
              <th scope="col" className="store-comparison-spacer">
                <span className="store-visually-hidden">Feature</span>
              </th>
              {ranks.map((rank) => (
                <th scope="col" key={rank.id}>
                  {rank.name}
                </th>
              ))}
            </tr>
            {!mobile && (
              <>
                <tr className="store-rank-summary-row">
                  <td className="store-comparison-spacer" />
                  {ranks.map((rank) => (
                    <td key={rank.id}>{summary(rank)}</td>
                  ))}
                </tr>
                <tr className="store-rank-purchase-row">
                  <td className="store-comparison-spacer" />
                  {ranks.map((rank) => (
                    <td key={rank.id}>
                      {price(rank)}
                      {action(rank)}
                    </td>
                  ))}
                </tr>
              </>
            )}
          </thead>
          <tbody>
            <tr className="store-chat-prefix-row">
              <th scope="row">Chat Prefix</th>
              {ranks.map((rank, index) => (
                <td key={rank.id}>
                  <span
                    className={`store-chat-prefix tier-${index}`}
                    aria-label={`${rank.name} chat prefix preview`}
                  >
                    [{rank.name}]
                  </span>
                </td>
              ))}
            </tr>
            {featureRows(previewRankFeatures)}
          </tbody>
          <tbody>
            <tr className="store-more-features-row">
              <td colSpan={ranks.length + 1}>
                <button
                  type="button"
                  className="store-more-features"
                  aria-expanded={expanded}
                  aria-controls="store-extra-rank-features"
                  onClick={() => setExpanded((value) => !value)}
                >
                  <span className="store-more-features-label">
                    <span className="store-more-chevron" aria-hidden="true">
                      {expanded ? "⌃" : "⌄"}
                    </span>
                    {expanded ? "Show fewer features" : "Show more features"}
                    <span className="store-more-chevron" aria-hidden="true">
                      {expanded ? "⌃" : "⌄"}
                    </span>
                  </span>
                </button>
              </td>
            </tr>
          </tbody>
          <tbody id="store-extra-rank-features" hidden={!expanded}>
            {featureRows(morePreviewRankFeatures)}
          </tbody>
          <tfoot>
            <tr>
              <td className="store-comparison-spacer" />
              {ranks.map((rank) => (
                <td key={rank.id}>{action(rank)}</td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>
      <div className="store-about-ranks">
        <h2>About ranks</h2>
        <p>
          Keep your permanent rank and upgrade by paying the difference within
          the same {network ? "network" : "server"} rank line.
        </p>
        <p>
          {network
            ? "ArchDragon requires ArchWyvern"
            : "Dragon requires Wyvern on the same modpack"}
          . The monthly bonus renews until cancelled; cancelling it keeps your
          permanent rank.
        </p>
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
  const [mobile, setMobile] = useState(
    () => matchMedia(mobileStoreQuery).matches,
  );
  useEffect(() => {
    const query = matchMedia(mobileStoreQuery);
    const resize = () => setMobile(query.matches);
    query.addEventListener("change", resize);
    return () => query.removeEventListener("change", resize);
  }, []);
  const storeHome = storePageHref("home", storefrontHost);
  const homePage = page === "home" || page === "thank-you";
  const prefixesPage = page === "prefixes";
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
        setCatalog(data.products);
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
  const detailProduct =
    productFor(details) ??
    (details && {
      ...storeItem(details),
      currency: "EUR",
      available: false,
    });
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
    const rank = storeItem(selection);
    setDetails({
      ...selection,
      scope: rank.coverage === "network" ? "network" : "",
      billing: rank.billing,
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
          <div className="store-account-row">
            <div className="username-box">
              <StorePlayer username={username} body />
              <div className="store-player-text">
                <strong title={username || "Guest"}>
                  {username || "Guest"}
                </strong>
                <button
                  className="store-button secondary"
                  type="button"
                  onClick={username ? logout : openLogin}
                >
                  {username ? "Logout" : "Login"}
                </button>
              </div>
            </div>
            {mobile && (
              <StoreCartButton
                count={cart ? 1 : 0}
                onClick={() => setDrawer("cart")}
              />
            )}
          </div>
          <StoreNavigation
            page={page}
            homePage={homePage}
            mobile={mobile}
            storefrontHost={storefrontHost}
            onNavigate={navigate}
          />
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
          </div>
        </aside>
        <div className="store-main">
          <div className="store-main-top">
            {drawer !== "cart" && (
              <TopCustomers community={community} compact />
            )}
            {!mobile && (
              <StoreCartButton
                count={cart ? 1 : 0}
                onClick={() => setDrawer("cart")}
              />
            )}
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
            <RankComparison
              category={page}
              viewRank={viewRank}
              productFor={productFor}
              mobile={mobile}
            />
          ) : prefixesPage ? (
            <section
              className="store-catalog"
              aria-labelledby="store-category-title"
            >
              <header className="store-category-header">
                <div>
                  <h1 id="store-category-title" tabIndex={-1}>
                    Prefixes
                  </h1>
                  <p>Make your name your own with a cosmetic chat prefix.</p>
                </div>
                <span className="store-prefix-status">Coming soon</span>
              </header>
              <div
                className="store-prefix-preview"
                aria-label="Example chat prefix"
              >
                <span>[Your prefix]</span> Player
                <p>Designs and prices will be announced here.</p>
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
                : detailItem.name
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
              <RankArtwork rank={details.rank} />
              <h3>{detailItem.name}</h3>
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
                    {details.billing === "monthly"
                      ? "Monthly bonus subscription"
                      : "One-time payment · permanent rank"}
                  </dd>
                </div>
              </dl>
              <strong className="store-detail-price">
                {money(detailProduct)}
                {details.billing === "monthly" && " / month"}
              </strong>
              {detailItem.requiresRank ? (
                <p>
                  Requires{" "}
                  {
                    storeRanks.find(({ id }) => id === detailItem.requiresRank)
                      .name
                  }
                  {detailNeedsServer ? " on the same server" : ""}. This adds a
                  monthly bonus to your permanent rank. Cancel the subscription
                  and keep your permanent rank. Bonus perks are coming soon.
                </p>
              ) : (
                <p>
                  Keep this rank permanently. Upgrades credit your previous
                  permanent rank within the same{" "}
                  {detailNeedsServer ? "server" : "network"} rank line. Perks
                  are coming soon.
                </p>
              )}
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
                <RankArtwork rank={cart.rank} />
                <div>
                  <h3>{cartItem.name}</h3>
                  <p>
                    {storeScopes.find(({ id }) => id === cart.scope).name} ·{" "}
                    {cart.billing === "monthly" ? "Monthly bonus" : "Permanent"}
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
              <p>Browse ranks and prefixes to find your next addition.</p>
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
