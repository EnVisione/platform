import React, { useEffect, useState } from "react";

const errors = {
  ticket_access_denied: "Your permissions do not allow this macro action.",
  invalid_ticket_macro:
    "Enter a name and a nonblank message, up to 2,000 characters.",
  invalid_ticket_category: "Choose a ticket category you can reply to.",
  ticket_macro_changed:
    "This macro changed. Refresh the library before editing it.",
  ticket_macro_not_found: "This macro was removed. Refresh the library.",
  ticket_macro_limit:
    "This category already has 100 macros. Edit or remove an existing one.",
};
async function request(url, options) {
  const response = await fetch(url, options);
  const value = await response.json();
  if (!response.ok)
    throw new Error(
      errors[value.error] ||
        "The macro library could not be updated. Please retry.",
    );
  return value;
}

export function MacroPicker({ category, disabled, onInsert }) {
  const [items, setItems] = useState([]),
    [selected, setSelected] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setItems([]);
    setSelected("");
    setError("");
    request(`/api/ticket-macros?category=${encodeURIComponent(category)}`, {
      signal: controller.signal,
    })
      .then((data) => setItems(data.items))
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message);
      });
    return () => controller.abort();
  }, [category]);
  return (
    <div className="ticket-macro-picker">
      <label>
        Ticket macro
        <select
          value={selected}
          disabled={disabled}
          onChange={(event) => setSelected(event.target.value)}
        >
          <option value="">Choose a saved reply</option>
          {items.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        disabled={disabled || !selected}
        onClick={() =>
          onInsert(items.find((item) => item.id === selected).content)
        }
      >
        Insert macro
      </button>
      {error && <small role="alert">{error}</small>}
    </div>
  );
}

export function TicketMacroLibrary({ csrf, initialCategory = "support" }) {
  const [open, setOpen] = useState(false),
    [data, setData] = useState(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [deleting, setDeleting] = useState(false);
  const empty = {
    name: "",
    content: "",
    category: initialCategory || "support",
  };
  const [draft, setDraft] = useState(empty);
  async function refresh() {
    const value = await request("/api/ticket-macros");
    setData(value);
    setError("");
    return value;
  }
  useEffect(() => {
    if (data && !data.categories.some((item) => item.id === draft.category))
      setDraft((current) => ({
        ...current,
        category: data.categories[0]?.id || "",
      }));
  }, [data, draft.category]);
  useEffect(() => {
    if (!open) return;
    let active = true;
    request("/api/ticket-macros")
      .then((value) => {
        if (active) {
          setData(value);
          setError("");
        }
      })
      .catch((error) => {
        if (active) setError(error.message);
      });
    return () => {
      active = false;
    };
  }, [open]);
  async function change(method) {
    setBusy(true);
    setError("");
    try {
      await request(`/api/ticket-macros${draft.id ? `/${draft.id}` : ""}`, {
        method,
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
        body: JSON.stringify(draft),
      });
      await refresh();
      setDraft({ ...empty, category: draft.category });
      setDeleting(false);
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="ticket-macro-library" aria-label="Ticket macro library">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? "Hide ticket macros" : "Ticket macros"}
      </button>
      {open && (
        <div className="ticket-macro-panel">
          <header>
            <h3>Shared ticket macros</h3>
            <p>
              Save reusable replies for each category. Keep personal player
              details out of shared templates. Inserting a macro never sends it
              automatically.
            </p>
          </header>
          {error && (
            <p role="alert" className="ticket-error">
              {error}
            </p>
          )}
          {!data ? (
            error ? (
              <button
                type="button"
                onClick={() =>
                  refresh().catch((error) => setError(error.message))
                }
              >
                Retry loading macros
              </button>
            ) : (
              <p role="status">Loading macros…</p>
            )
          ) : (
            <div className="ticket-macro-grid">
              <div>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setDraft({
                      ...empty,
                      category: data.categories.some(
                        (item) => item.id === empty.category,
                      )
                        ? empty.category
                        : data.categories[0]?.id || "",
                    });
                    setDeleting(false);
                  }}
                >
                  New macro
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    refresh()
                      .then(() => setError(""))
                      .catch((error) => setError(error.message))
                  }
                >
                  Refresh macros
                </button>
                <ul>
                  {data.items.map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        disabled={busy}
                        aria-pressed={draft.id === item.id}
                        onClick={() => {
                          setDraft(item);
                          setDeleting(false);
                        }}
                      >
                        {item.name}{" "}
                        <small>
                          {
                            data.categories.find(
                              (category) => category.id === item.category,
                            )?.name
                          }
                        </small>
                      </button>
                    </li>
                  ))}
                </ul>
                {!data.items.length && <p>No macros yet.</p>}
              </div>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void change(draft.id ? "PUT" : "POST");
                }}
              >
                <label>
                  Macro name
                  <input
                    required
                    maxLength={80}
                    value={draft.name}
                    disabled={busy}
                    onChange={(event) =>
                      setDraft({ ...draft, name: event.target.value })
                    }
                  />
                </label>
                <label>
                  Macro category
                  <select
                    value={draft.category}
                    disabled={busy}
                    onChange={(event) =>
                      setDraft({ ...draft, category: event.target.value })
                    }
                  >
                    {data.categories.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Macro message
                  <textarea
                    required
                    maxLength={2000}
                    rows={5}
                    value={draft.content}
                    disabled={busy}
                    onChange={(event) =>
                      setDraft({ ...draft, content: event.target.value })
                    }
                  />
                </label>
                <div className="ticket-actions">
                  <button className="ticket-primary" disabled={busy}>
                    {busy ? "Saving…" : draft.id ? "Save macro" : "Add macro"}
                  </button>
                  {draft.id && !deleting && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setDeleting(true)}
                    >
                      Delete macro
                    </button>
                  )}
                  {deleting && (
                    <>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void change("DELETE")}
                      >
                        Confirm delete macro
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setDeleting(false)}
                      >
                        Keep macro
                      </button>
                    </>
                  )}
                </div>
              </form>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
