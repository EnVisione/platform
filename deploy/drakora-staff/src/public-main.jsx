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
import { PublicIcon, PublicHeading } from "./public-icons.jsx";
import { PartnershipForm } from "./partnerships.jsx";
import { AmbientFire } from "./public-fire.jsx";

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
        aria-label={`${large ? "0 players online. " : ""}Copy ${address}`}
      >
        <span className="public-address-copy">
          {large && <span className="public-eyebrow">0 PLAYERS ONLINE</span>}
          <strong>{address}</strong>
          <span className="public-address-hint">
            {copied ? "Copied!" : "Click to copy IP"}
          </span>
        </span>
        {large ? (
          <span className="public-status-icon play">
            <PublicIcon name="play" />
          </span>
        ) : (
          <PublicIcon name={copied ? "check" : "copy"} />
        )}
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
        <PublicHeading icon="servers">
          <a href={`/servers/${server.slug}`}>{server.name}</a>
        </PublicHeading>
        <p>{server.summary}</p>
        <div className="public-server-meta">
          <span className="public-icon-label">
            <PublicIcon name="users" />0 players online
          </span>
          {server.packVersion && <span>Pack {server.packVersion}</span>}
        </div>
        <div className="public-server-actions">
          <a className="public-button beige" href={`/servers/${server.slug}`}>
            View server <PublicIcon name="arrow" />
          </a>
          {server.downloadUrl && (
            <a
              className="public-button secondary"
              href={server.downloadUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Download pack <PublicIcon name="download" />
            </a>
          )}
          <CopyAddress address={server.address} />
        </div>
      </div>
    </article>
  );
}
function PartnershipBanner({ discordInvite }) {
  return (
    <section
      className="public-welcome public-partnership"
      aria-labelledby="partnership-title"
    >
      <div className="public-welcome-art" aria-hidden="true">
        <img src={forest} alt="" />
      </div>
      <div className="public-welcome-copy">
        <span className="public-eyebrow">A HOME FOR YOUR NEXT CHAPTER</span>
        <PublicHeading as="h2" icon="servers" id="partnership-title">
          Your modpack. Our next adventure.
        </PublicHeading>
        <p>
          Want your modpack featured on the Drakora network? Let’s build a place
          for your community to play.
        </p>
        <div className="public-partner-actions">
          <a className="public-button beige" href="/partners">
            Partner with us <PublicIcon name="arrow" />
          </a>
          <a href={discordInvite}>
            <PublicIcon name="discord" /> Talk on Discord
          </a>
          <a href="mailto:partners@drakora.org">
            <PublicIcon name="mail" /> partners@drakora.org
          </a>
        </div>
      </div>
    </section>
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
          <PublicHeading as="h1" icon="crest">
            {home.title}
          </PublicHeading>
          <p>{home.introduction}</p>
          <a href="/servers" className="public-button beige">
            View servers <PublicIcon name="arrow" />
          </a>
        </div>
        <div className="public-welcome-art" aria-hidden="true">
          <img src={castle} alt="" />
        </div>
      </section>
      <PartnershipBanner discordInvite={discordInvite} />
      <div className="public-home-grid">
        <section
          className="public-announcements"
          aria-labelledby="announcements-title"
        >
          <PublicHeading icon="news" id="announcements-title">
            {home.announcementsTitle}
          </PublicHeading>
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
                <PublicHeading as="h3" icon="news">
                  {entry.title}
                </PublicHeading>
                <Paragraphs text={entry.body} />
              </article>
            ))
          ) : (
            <div className="public-panel public-news-empty">
              <p>{home.emptyMessage}</p>
              <a href={discordInvite}>
                <PublicIcon name="discord" /> Catch up in Discord
                <PublicIcon name="external" />
              </a>
            </div>
          )}
        </section>
        <aside className="public-home-help">
          <span className="public-eyebrow">WE ARE HERE TO HELP</span>
          <PublicHeading icon="help">Need a hand?</PublicHeading>
          <p>New to the network, stuck in a world or need to reach staff?</p>
          <a href="/help">
            Find support <PublicIcon name="arrow" />
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
        <PublicHeading as="h1" icon="apply">
          {apply.title}
        </PublicHeading>
        <p>{apply.introduction}</p>
      </div>
      <article className="public-panel">
        {applicationSections.map(({ id, name, list }) => (
          <section key={id} aria-labelledby={`apply-${id}`}>
            <PublicHeading
              icon={id === "role" || id === "note" ? "users" : "apply"}
              id={`apply-${id}`}
            >
              {name}
            </PublicHeading>
            <SectionContent text={apply[id]} list={list} />
          </section>
        ))}
        <div className="public-application-actions">
          <PublicHeading icon="apply">Ready to apply?</PublicHeading>
          <p>
            Take your time. You can save your progress and return in this
            browser.
          </p>
          <a href="/apply/start" className="public-button">
            Continue application <PublicIcon name="arrow" />
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
        <PublicHeading as="h1" icon="help">
          {help.title}
        </PublicHeading>
        <p>{help.introduction}</p>
        <div className="public-help-actions">
          <a className="public-button" href="/help/new">
            <PublicIcon name="ticket" /> Open a ticket{" "}
            <PublicIcon name="arrow" />
          </a>
          <a className="public-button secondary" href={discordInvite}>
            <PublicIcon name="discord" /> Open Discord{" "}
            <PublicIcon name="external" />
          </a>
        </div>
      </div>
      <div className="public-help-grid">
        {helpSections.map(({ id, name, list }) => (
          <section
            className={`public-panel public-help-${id}`}
            key={id}
            aria-labelledby={`help-${id}`}
          >
            <PublicHeading
              icon={
                id === "tickets"
                  ? "ticket"
                  : id === "joining"
                    ? "servers"
                    : "info"
              }
              id={`help-${id}`}
            >
              {name}
            </PublicHeading>
            <SectionContent text={help[id]} list={list} />
            {id === "joining" && (
              <a href="/servers">
                Find your server <PublicIcon name="arrow" />
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
    partnershipPage = path === "/partners",
    applyPage = path === "/apply",
    helpPage = path === "/help";
  const title = home
    ? "Home"
    : partnershipPage
      ? "Partnerships"
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
      <AmbientFire />
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
            <PublicIcon name="menu" /> Menu
          </button>
          <div id="public-links" className={menu ? "open" : ""}>
            {[
              ["Home", "/", "home"],
              ["Servers", "/servers", "servers"],
              ["Store", storeUrl, "store"],
              ["Rules", "/rules", "rules"],
              ["Apply", "/apply", "apply"],
              ["Need help?", "/help", "help"],
            ].map(([name, href, icon]) => (
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
                <PublicIcon name={icon} />
                {name}
              </a>
            ))}
          </div>
        </nav>
        <div className="public-masthead">
          <div className="public-join">
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
            <span className="public-status-icon">
              <PublicIcon name="discord" />
            </span>
            <span className="public-status-copy">
              <span className="public-eyebrow">
                {status?.discord.active == null
                  ? "OUR COMMUNITY"
                  : `${status.discord.active} MEMBERS ONLINE${status.discord.stale ? " · LAST CHECK" : ""}`}
              </span>
              <strong>
                Join our Discord <PublicIcon name="external" />
              </strong>
              <span>Chat, updates & support</span>
            </span>
          </a>
        </div>
      </header>
      <main id="main" className="public-content">
        {error ? (
          <section className="public-panel">
            <PublicHeading as="h1" icon="info">
              We couldn’t load this page.
            </PublicHeading>
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
        ) : partnershipPage ? (
          <PartnershipForm />
        ) : serversPage ? (
          <>
            <PartnershipBanner discordInvite={content.discordInvite} />
            <div className="public-page-title">
              <span className="public-eyebrow">EXPLORE DRAKORA</span>
              <PublicHeading as="h1" icon="servers">
                Our servers
              </PublicHeading>
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
              <PublicIcon name="back" /> All servers
            </a>
            <div className="public-page-title">
              <span className="public-eyebrow">{server.worlds}</span>
              <PublicHeading as="h1" icon="servers">
                {server.name}
              </PublicHeading>
              <p>{server.summary}</p>
            </div>
            <div className="public-detail-grid">
              <article>
                <div className="public-detail-art">
                  <ServerArtwork server={server} />
                </div>
                <section className="public-panel">
                  <PublicHeading icon="info">About the server</PublicHeading>
                  <Paragraphs text={server.description} />
                </section>
                <section className="public-panel">
                  <PublicHeading icon="play">How to join</PublicHeading>
                  <Paragraphs text={server.joining} />
                </section>
              </article>
              <aside>
                <section className="public-panel">
                  <PublicHeading icon="play">Play {server.name}</PublicHeading>
                  <p className="public-player-count public-icon-label">
                    <PublicIcon name="users" />0 players online
                  </p>
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
                      className="public-button beige"
                      href={server.downloadUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Download pack <PublicIcon name="download" />
                    </a>
                  )}
                </section>
                <section className="public-panel">
                  <PublicHeading icon="help">Need a hand?</PublicHeading>
                  <p>
                    Find joining help or reach our staff through a Discord
                    ticket.
                  </p>
                  <a href="/help">
                    Find support <PublicIcon name="arrow" />
                  </a>
                </section>
                <a
                  className="public-button secondary"
                  href={`/rules/${server.rules}`}
                >
                  <PublicIcon name="rules" /> Server rules{" "}
                  <PublicIcon name="arrow" />
                </a>
              </aside>
            </div>
          </>
        ) : rulesPage && section ? (
          <>
            <div className="public-page-title">
              <span className="public-eyebrow">PLAY FAIR. FEEL AT HOME.</span>
              <PublicHeading as="h1" icon="rules">
                Community rules
              </PublicHeading>
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
                    <PublicIcon
                      name={
                        item.id === "discord"
                          ? "discord"
                          : item.id === "home"
                            ? "home"
                            : "servers"
                      }
                    />
                    {item.name}
                  </a>
                ))}
              </nav>
              <article className="public-panel public-rule-text">
                <PublicHeading icon="rules">
                  {section.id === "home"
                    ? "Universal rules"
                    : `${section.name} rules`}
                </PublicHeading>
                <Paragraphs text={content.rules[section.id]} />
                <p className="public-rule-help">
                  Need help?{" "}
                  <a href="/help">
                    Find support <PublicIcon name="arrow" />
                  </a>
                </p>
              </article>
            </div>
          </>
        ) : (
          <section className="public-panel">
            <PublicHeading as="h1" icon="info">
              Page not found
            </PublicHeading>
            <p>This page is no longer available.</p>
            <a className="public-button" href="/">
              <PublicIcon name="home" /> Go home
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
          <a href={content?.discordInvite || "/discord"}>
            <PublicIcon name="discord" /> Discord
          </a>
          <a href="/rules">
            <PublicIcon name="rules" /> Rules
          </a>
          <a href="/apply">
            <PublicIcon name="apply" /> Apply
          </a>
          <a href={storeUrl}>
            <PublicIcon name="store" /> Store
          </a>
          <a href="/help">
            <PublicIcon name="help" /> Need help?
          </a>
        </nav>
        <small>© {new Date().getFullYear()} Drakora</small>
      </footer>
    </div>
  );
}
createRoot(document.getElementById("root")).render(
  location.pathname.startsWith("/help/") ? <PublicTickets /> : <PublicSite />,
);
