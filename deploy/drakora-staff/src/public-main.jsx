import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ruleSections,
  applicationSections,
  helpSections,
} from "../shared/website.js";
import logo from "./assets/drakora-logo.png";
import castle from "./assets/medieval-castle.svg";
import forest from "./assets/medieval-forest.svg";
import prominence from "./assets/prominence-logo.png";
import restlessHorizons from "./assets/restless-horizons-logo.png";
import "./public.css";
import { PublicTickets } from "./tickets.jsx";

const artwork = {
  castle,
  forest,
  prominence,
  "restless-horizons": restlessHorizons,
};
const storeUrl = "https://store.drakora.org";
function CopyAddress({ address = "play.drakora.org", large = false }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (copied) {
      const timer = setTimeout(() => setCopied(false), 2500);
      return () => clearTimeout(timer);
    }
  }, [copied]);
  return (
    <div className={large ? "public-address large" : "public-address"}>
      <button
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(address);
            setCopied(true);
            setFailed(false);
          } catch {
            setFailed(true);
          }
        }}
        aria-label={`Copy ${address}`}
      >
        <strong>{address}</strong>
        <span>{copied ? "Copied!" : "Click to copy IP"}</span>
      </button>
      {failed && <p role="status">Copy this address: {address}</p>}
    </div>
  );
}
function Paragraphs({ text }) {
  return text
    .split(/\n\s*\n/)
    .filter(Boolean)
    .map((paragraph, i) => <p key={i}>{paragraph}</p>);
}
function SectionContent({ text, list }) {
  if (!list) return <Paragraphs text={text} />;
  return (
    <ul>
      {text
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line, index) => (
          <li key={index}>{line}</li>
        ))}
    </ul>
  );
}
function ServerArtwork({ server, decorative = false }) {
  const [failedUrl, setFailedUrl] = useState("");
  const customLogo = server.logoUrl && server.logoUrl !== failedUrl;
  const isLogo = customLogo || !["castle", "forest"].includes(server.artwork);
  return (
    <img
      className={isLogo ? "public-pack-logo" : undefined}
      src={customLogo ? server.logoUrl : artwork[server.artwork]}
      alt={
        decorative
          ? ""
          : isLogo
            ? `${server.pack || server.name} logo`
            : `${server.name} medieval landscape`
      }
      referrerPolicy="no-referrer"
      onError={() => {
        if (customLogo) setFailedUrl(server.logoUrl);
      }}
    />
  );
}
function ServerCard({ server }) {
  return (
    <article className="public-server">
      <a
        href={`/servers/${server.slug}`}
        className="public-server-art"
        tabIndex={-1}
        aria-hidden="true"
      >
        <ServerArtwork server={server} decorative />
      </a>
      <div className="public-server-body">
        <span className="public-eyebrow">
          {server.worlds || "DRAKORA NETWORK"}
        </span>
        <h2>
          <a href={`/servers/${server.slug}`}>{server.name}</a>
        </h2>
        <p>{server.summary}</p>
        <div className="public-server-meta">
          <span>0 players online</span>
          {server.packVersion && <span>Pack {server.packVersion}</span>}
        </div>
        <div className="public-server-actions">
          <a className="public-button" href={`/servers/${server.slug}`}>
            View server <span aria-hidden="true">→</span>
          </a>
          {server.downloadUrl && (
            <a
              className="public-button secondary"
              href={server.downloadUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Download pack <span aria-hidden="true">↗</span>
            </a>
          )}
          <CopyAddress address={server.address} />
        </div>
      </div>
    </article>
  );
}
function HomePage({ home, discordInvite }) {
  return (
    <>
      <section className="public-welcome">
        <div className="public-welcome-copy">
          <span className="public-eyebrow">
            YOUR NEXT ADVENTURE STARTS HERE
          </span>
          <h1>{home.title}</h1>
          <p>{home.introduction}</p>
          <a href="/servers" className="public-button">
            View servers <span aria-hidden="true">→</span>
          </a>
        </div>
        <div className="public-welcome-art" aria-hidden="true">
          <img src={castle} alt="" />
        </div>
      </section>
      <div className="public-home-grid">
        <section
          className="public-announcements"
          aria-labelledby="announcements-title"
        >
          <h2 id="announcements-title">{home.announcementsTitle}</h2>
          {home.announcements.length ? (
            home.announcements.map((entry) => (
              <article
                className="public-panel public-announcement"
                key={entry.id}
              >
                {entry.date && (
                  <time className="public-eyebrow" dateTime={entry.date}>
                    {new Date(`${entry.date}T12:00:00`).toLocaleDateString(
                      undefined,
                      {
                        year: "numeric",
                        month: "long",
                        day: "numeric",
                      },
                    )}
                  </time>
                )}
                <h3>{entry.title}</h3>
                <Paragraphs text={entry.body} />
              </article>
            ))
          ) : (
            <div className="public-panel public-news-empty">
              <p>{home.emptyMessage}</p>
              <a href={discordInvite}>
                Catch up in Discord <span aria-hidden="true">↗</span>
              </a>
            </div>
          )}
        </section>
        <aside className="public-home-help">
          <span className="public-eyebrow">WE ARE HERE TO HELP</span>
          <h2>Need a hand?</h2>
          <p>New to the network, stuck in a world or need to reach staff?</p>
          <a href="/help">
            Find support <span aria-hidden="true">→</span>
          </a>
        </aside>
      </div>
    </>
  );
}
function ApplicationInformation({ apply }) {
  return (
    <div className="public-application">
      <div className="public-page-title">
        <span className="public-eyebrow">JOIN THE TEAM</span>
        <h1>{apply.title}</h1>
        <p>{apply.introduction}</p>
      </div>
      <article className="public-panel">
        {applicationSections.map(({ id, name, list }) => (
          <section key={id} aria-labelledby={`apply-${id}`}>
            <h2 id={`apply-${id}`}>{name}</h2>
            <SectionContent text={apply[id]} list={list} />
          </section>
        ))}
        <div className="public-application-actions">
          <h2>Ready to apply?</h2>
          <p>
            Take your time. You can save your progress and return in this
            browser.
          </p>
          <a href="/apply/start" className="public-button">
            Continue application <span aria-hidden="true">→</span>
          </a>
        </div>
      </article>
    </div>
  );
}
function HelpPage({ help, discordInvite }) {
  return (
    <div className="public-help-page">
      <div className="public-page-title">
        <span className="public-eyebrow">DRAKORA SUPPORT</span>
        <h1>{help.title}</h1>
        <p>{help.introduction}</p>
        <a className="public-button" href="/help/new">
          Open a ticket <span aria-hidden="true">→</span>
        </a>
        <a className="public-button" href={discordInvite}>
          Open Discord <span aria-hidden="true">↗</span>
        </a>
      </div>
      <div className="public-help-grid">
        {helpSections.map(({ id, name, list }) => (
          <section
            className={`public-panel public-help-${id}`}
            key={id}
            aria-labelledby={`help-${id}`}
          >
            <h2 id={`help-${id}`}>{name}</h2>
            <SectionContent text={help[id]} list={list} />
            {id === "joining" && (
              <a href="/servers">
                Find your server <span aria-hidden="true">→</span>
              </a>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
function PublicSite() {
  const [content, setContent] = useState(null),
    [error, setError] = useState(false),
    [status, setStatus] = useState(null),
    [menu, setMenu] = useState(false);
  const path = location.pathname.replace(/\/$/, "") || "/";
  useEffect(() => {
    const controller = new AbortController();
    fetch("/site/api/content", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        return response.json();
      })
      .then(setContent)
      .catch((error) => {
        if (error.name !== "AbortError") setError(true);
      });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const refresh = () => {
      if (document.hidden) return;
      fetch("/site/api/status", { signal: controller.signal })
        .then(async (response) => {
          if (!response.ok) throw new Error();
          return response.json();
        })
        .then((value) => {
          if (active) setStatus(value);
        })
        .catch(() => {
          if (active) setStatus(null);
        });
    };
    refresh();
    const timer = setInterval(refresh, 60000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);
  const server = content?.servers.find(
    (server) => path === `/servers/${server.slug}`,
  );
  const rulesPage = path === "/rules" || path.startsWith("/rules/");
  const section =
    ruleSections.find((section) => path === `/rules/${section.id}`) ??
    (path === "/rules" ? ruleSections[0] : null);
  const home = path === "/",
    serversPage = path === "/servers",
    applyPage = path === "/apply",
    helpPage = path === "/help";
  const title = home
    ? "Home"
    : serversPage
      ? "Servers"
      : applyPage
        ? "Apply"
        : helpPage
          ? "Need help?"
          : (server?.name ?? (rulesPage ? "Rules" : "Page not found"));
  useEffect(() => {
    document.title = `${title} · Drakora Network`;
  }, [title]);
  return (
    <div className="public-site">
      <a href="#main" className="public-skip">
        Skip to content
      </a>
      <header className={`public-header${home ? " home" : ""}`}>
        <nav className="public-nav" aria-label="Main navigation">
          <a href="/" className="public-mobile-brand">
            Drakora
          </a>
          <button
            className="public-menu"
            aria-expanded={menu}
            aria-controls="public-links"
            onClick={() => setMenu(!menu)}
          >
            Menu <span aria-hidden="true">☰</span>
          </button>
          <div id="public-links" className={menu ? "open" : ""}>
            {[
              ["Home", "/"],
              ["Servers", "/servers"],
              ["Store", storeUrl],
              ["Rules", "/rules"],
              ["Apply", "/apply"],
              ["Need help?", "/help"],
            ].map(([name, href]) => (
              <a
                key={name}
                href={href}
                className={name === "Store" ? "public-store-link" : ""}
                aria-current={
                  (
                    href === "/"
                      ? home
                      : path === href || path.startsWith(href + "/")
                  )
                    ? "page"
                    : undefined
                }
              >
                {name}
              </a>
            ))}
          </div>
        </nav>
        <div className="public-masthead">
          <div className="public-join">
            <span className="public-eyebrow">0 PLAYERS ONLINE</span>
            <CopyAddress large />
          </div>
          <a href="/" className="public-brand" aria-label="Drakora Home">
            <img src={logo} alt="" />
            <span>
              DRAKORA<small>MINECRAFT NETWORK</small>
            </span>
          </a>
          <a
            href={content?.discordInvite || "/discord"}
            className="public-discord"
          >
            <span className="public-eyebrow">
              {status?.discord.active == null
                ? "OUR COMMUNITY"
                : `${status.discord.active} MEMBERS ONLINE${status.discord.stale ? " · LAST CHECK" : ""}`}
            </span>
            <strong>
              Join our Discord <span aria-hidden="true">↗</span>
            </strong>
            <span>Chat, updates & support</span>
          </a>
        </div>
      </header>
      <main id="main" className="public-content">
        {error ? (
          <section className="public-panel">
            <h1>We couldn’t load this page.</h1>
            <p>Please try again in a moment.</p>
            <button className="public-button" onClick={() => location.reload()}>
              Try again
            </button>
          </section>
        ) : !content ? (
          <p className="public-loading" role="status">
            Opening Drakora…
          </p>
        ) : home ? (
          <HomePage home={content.home} discordInvite={content.discordInvite} />
        ) : applyPage ? (
          <ApplicationInformation apply={content.apply} />
        ) : helpPage ? (
          <HelpPage help={content.help} discordInvite={content.discordInvite} />
        ) : serversPage ? (
          <>
            <div className="public-page-title">
              <span className="public-eyebrow">EXPLORE DRAKORA</span>
              <h1>Our servers</h1>
              <p>Pick your adventure. Bring your friends.</p>
            </div>
            <div className="public-server-grid">
              {content.servers.map((server) => (
                <ServerCard key={server.slug} server={server} />
              ))}
            </div>
            {!content.servers.length && (
              <p className="public-panel">
                New worlds are on the way. Join Discord for updates.
              </p>
            )}
          </>
        ) : server ? (
          <>
            <a className="public-back" href="/servers">
              ← All servers
            </a>
            <div className="public-page-title">
              <span className="public-eyebrow">{server.worlds}</span>
              <h1>{server.name}</h1>
              <p>{server.summary}</p>
            </div>
            <div className="public-detail-grid">
              <article>
                <div className="public-detail-art">
                  <ServerArtwork server={server} />
                </div>
                <section className="public-panel">
                  <h2>About the server</h2>
                  <Paragraphs text={server.description} />
                </section>
                <section className="public-panel">
                  <h2>How to join</h2>
                  <Paragraphs text={server.joining} />
                </section>
              </article>
              <aside>
                <section className="public-panel">
                  <h2>Play {server.name}</h2>
                  <p className="public-player-count">0 players online</p>
                  <CopyAddress address={server.address} />
                  <dl>
                    {[
                      ["Modpack", server.pack],
                      ["Pack version", server.packVersion],
                      ["Minecraft", server.minecraftVersion],
                      ["Worlds", server.worlds],
                    ]
                      .filter(([, value]) => value)
                      .map(([label, value]) => (
                        <div key={label}>
                          <dt>{label}</dt>
                          <dd>{value}</dd>
                        </div>
                      ))}
                  </dl>
                  {server.downloadUrl && (
                    <a
                      className="public-button"
                      href={server.downloadUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Download pack ↗
                    </a>
                  )}
                </section>
                <section className="public-panel">
                  <h2>Need a hand?</h2>
                  <p>
                    Find joining help or reach our staff through a Discord
                    ticket.
                  </p>
                  <a href="/help">Find support →</a>
                </section>
                <a
                  className="public-button secondary"
                  href={`/rules/${server.rules}`}
                >
                  Server rules →
                </a>
              </aside>
            </div>
          </>
        ) : rulesPage && section ? (
          <>
            <div className="public-page-title">
              <span className="public-eyebrow">PLAY FAIR. FEEL AT HOME.</span>
              <h1>Community rules</h1>
              <p>Keep Drakora welcoming. Play fair and respect each other.</p>
            </div>
            <div className="public-rules-grid">
              <nav className="public-rules-nav" aria-label="Rules sections">
                {ruleSections.map((item) => (
                  <a
                    key={item.id}
                    href={`/rules/${item.id}`}
                    aria-current={section.id === item.id ? "page" : undefined}
                  >
                    {item.name}
                  </a>
                ))}
              </nav>
              <article className="public-panel public-rule-text">
                <h2>
                  {section.id === "home"
                    ? "Universal rules"
                    : `${section.name} rules`}
                </h2>
                <Paragraphs text={content.rules[section.id]} />
                <p className="public-rule-help">
                  Need help? <a href="/help">Find support →</a>
                </p>
              </article>
            </div>
          </>
        ) : (
          <section className="public-panel">
            <h1>Page not found</h1>
            <p>This page is no longer available.</p>
            <a className="public-button" href="/">
              Go home
            </a>
          </section>
        )}
      </main>
      <footer className="public-footer">
        <div>
          <strong>Drakora Network</strong>
          <p>Not affiliated with Mojang or Microsoft.</p>
        </div>
        <nav aria-label="Footer links">
          <a href={content?.discordInvite || "/discord"}>Discord</a>
          <a href="/rules">Rules</a>
          <a href="/apply">Apply</a>
          <a href={storeUrl}>Store</a>
          <a href="/help">Need help?</a>
        </nav>
        <small>© {new Date().getFullYear()} Drakora</small>
      </footer>
    </div>
  );
}
createRoot(document.getElementById("root")).render(
  location.pathname.startsWith("/help/") ? <PublicTickets /> : <PublicSite />,
);
