import React, { useEffect, useState } from "react";
export function StaffDirectory() {
  const [data, setData] = useState(null),
    [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const refresh = () => {
      if (document.hidden) return;
      fetch("/site/api/staff", { signal: controller.signal })
        .then(async (response) => {
          if (!response.ok) throw new Error();
          return response.json();
        })
        .then((data) => {
          if (active) {
            setData(data);
            setError(false);
          }
        })
        .catch((error) => {
          if (active && error.name !== "AbortError") {
            setError(true);
            setData(null);
          }
        });
    };
    refresh();
    const timer = setInterval(refresh, 60000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      active = false;
      clearInterval(timer);
      controller.abort();
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);
  return (
    <>
      <div className="public-page-title">
        <span className="public-eyebrow">THE PEOPLE BEHIND DRAKORA</span>
        <h1>Our staff</h1>
        <p>Meet the people building our worlds and helping the community.</p>
        {data && (
          <p>
            {data.total} staff members · <a href="/apply">Apply to join us</a>
          </p>
        )}
      </div>
      {error ? (
        <p className="public-panel">
          The staff list is temporarily unavailable. Please try again shortly.
        </p>
      ) : !data ? (
        <p>Loading staff…</p>
      ) : (
        <>
          <nav className="public-staff-links" aria-label="Staff ranks">
            {data.groups.map((group, index) => (
              <a key={group.name} href={`#staff-group-${index}`}>
                {group.name} · {group.members.length}
              </a>
            ))}
          </nav>
          {data.groups.map((group, index) => (
            <section
              className="public-staff-section"
              id={`staff-group-${index}`}
              key={group.name}
            >
              <h2>{group.name}</h2>
              <div className="public-staff-grid">
                {group.members.map((person) => (
                  <article
                    className="public-panel public-staff-card"
                    key={person.name + person.minecraft}
                  >
                    <div className="public-staff-avatar">
                      {person.minecraft ? (
                        <img
                          src={`https://mc-heads.net/avatar/${encodeURIComponent(person.minecraft)}/96`}
                          alt={`${person.minecraft}'s Minecraft skin`}
                          loading="lazy"
                          width="96"
                          height="96"
                        />
                      ) : (
                        <span aria-hidden="true">
                          {person.name.slice(0, 1)}
                        </span>
                      )}
                    </div>
                    <h3>{person.name}</h3>
                    <p>{person.minecraft || "Minecraft name not linked"}</p>
                    <p className="public-staff-ranks">
                      {person.ranks.join(" · ")}
                    </p>
                  </article>
                ))}
              </div>
            </section>
          ))}
        </>
      )}
    </>
  );
}
