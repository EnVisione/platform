import { randomUUID } from "node:crypto";
import { AuthError } from "./discord.js";
import { ticketCategories } from "../shared/tickets.js";

export function ticketMacros(store, rolePolicy) {
  function access(user, category, manage = false) {
    if (!ticketCategories.some((item) => item.id === category))
      throw new AuthError("invalid_ticket_category", 400);
    const current = rolePolicy.apply(user);
    if (
      !current.capabilities["tickets.view"] ||
      !current.capabilities["tickets.reply"] ||
      !current.capabilities[`tickets.category.${category}.view`] ||
      !current.capabilities[`tickets.category.${category}.reply`] ||
      (manage && !current.capabilities["tickets.macros.manage"])
    )
      throw new AuthError("ticket_access_denied");
    return current;
  }
  function get(user, id, manage = false) {
    const macro = store.get("ticket-macro", id);
    if (!macro) throw new AuthError("ticket_macro_not_found", 404);
    access(user, macro.category, manage);
    return macro;
  }
  function text(value, limit) {
    if (
      typeof value !== "string" ||
      !value.trim() ||
      value.trim().length > limit ||
      value.includes("\0")
    )
      throw new AuthError("invalid_ticket_macro", 400);
    return value.trim();
  }
  return {
    list(user, category) {
      const current = rolePolicy.apply(user);
      if (
        !current.capabilities["tickets.view"] ||
        !current.capabilities["tickets.reply"]
      )
        throw new AuthError("ticket_access_denied");
      const categories = ticketCategories.filter(
        ({ id }) =>
          current.capabilities[`tickets.category.${id}.view`] &&
          current.capabilities[`tickets.category.${id}.reply`],
      );
      if (category) access(user, category);
      const allowed = new Set(categories.map((item) => item.id));
      return {
        categories,
        items: store
          .entries("ticket-macro")
          .map(([, value]) => value)
          .filter(
            (item) =>
              allowed.has(item.category) &&
              (!category || item.category === category),
          )
          .sort((a, b) => a.name.localeCompare(b.name)),
      };
    },
    save(user, id, input) {
      if (!input || typeof input !== "object" || Array.isArray(input))
        throw new AuthError("invalid_ticket_macro", 400);
      const current = id ? get(user, id, true) : null;
      access(user, input.category, true);
      if (current && input.revision !== current.revision)
        throw new AuthError("ticket_macro_changed", 409);
      if (
        (!current || current.category !== input.category) &&
        store
          .entries("ticket-macro")
          .filter(([, item]) => item.category === input.category).length >= 100
      )
        throw new AuthError("ticket_macro_limit", 409);
      const macro = {
        id: current?.id || randomUUID(),
        category: input.category,
        name: text(input.name, 80),
        content: text(input.content, 2000),
        revision: (current?.revision || 0) + 1,
        updatedAt: Date.now(),
      };
      store.set("ticket-macro", macro.id, macro, Number.MAX_SAFE_INTEGER);
      return macro;
    },
    remove(user, id, revision) {
      const macro = get(user, id, true);
      if (revision !== macro.revision)
        throw new AuthError("ticket_macro_changed", 409);
      store.delete("ticket-macro", id);
    },
  };
}
