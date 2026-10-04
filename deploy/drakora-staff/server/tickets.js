import { randomUUID, randomBytes, createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { AuthError } from "./discord.js";
import { listFilters, matchesText } from "./list-filters.js";
import { validMailAddress } from "./mail-address.js";
import {
  ticketTypes,
  ticketIntake,
  ticketDetails,
  ticketCategories,
  ticketCategory,
  ticketCapability,
  ticketPath,
  ticketMediaDays,
  ticketMessageUploadLimit,
} from "../shared/tickets.js";

const forever = Number.MAX_SAFE_INTEGER;
const digest = (text) => createHash("sha256").update(text).digest("hex");
const token = () => randomBytes(32).toString("base64url");
const idPattern = /^[a-f0-9-]{36}$/;
const publicActor = (user) => ({
  id: user.id,
  name: user.name || user.username,
  avatar: user.avatar || null,
  ...(user.guest ? { guest: true } : {}),
});
function text(value, min, max, code = "invalid_ticket") {
  if (
    typeof value !== "string" ||
    value.trim().length < min ||
    value.trim().length > max ||
    value.includes("\0")
  )
    throw new AuthError(code, 400);
  return value.trim();
}

export function ticketService(
  config,
  store,
  rolePolicy,
  { now = Date.now, onActivity = () => {} } = {},
) {
  const events = new EventEmitter();
  events.setMaxListeners(200);
  let transport,
    timer,
    maintenance,
    running,
    expiring,
    stopped = false;
  const viewers = new Map();
  const cleanupWaiters = [];
  const put = (kind, id, value) => store.set(kind, id, value, forever);
  const get = (id) => {
    if (!idPattern.test(id || "")) throw new AuthError("ticket_not_found", 404);
    const ticket = store.get("ticket", id);
    if (!ticket || ticket.erasingAt)
      throw new AuthError("ticket_not_found", 404);
    return ticket;
  };
  function staff(user, ticket, capability = "tickets.view") {
    const current = rolePolicy.apply(user);
    if (
      (capability === "tickets.delete" && !rolePolicy.isAdmin(current)) ||
      !current.capabilities[capability] ||
      (ticket &&
        !current.capabilities[
          ticketCapability(ticket, capability.split(".").at(-1))
        ])
    )
      throw new AuthError("ticket_access_denied");
    return current;
  }
  function authorize(user, ticket, staffView = false, capability) {
    if (staffView) return staff(user, ticket, capability);
    if (!user || ticket.type === "partnership" || ticket.owner.id !== user.id)
      throw new AuthError("ticket_not_found", 404);
    return user;
  }
  function announce(ticket) {
    events.emit("changed", { id: ticket.id, revision: ticket.revision });
    void pump();
  }
  function queue(ticket, kind, ref = ticket.id) {
    const id = `${ticket.id}:${kind}:${ref}`;
    put(
      ticket.type === "partnership" ? "partnership-outbox" : "ticket-outbox",
      id,
      {
        id,
        generation: randomUUID(),
        ticketId: ticket.id,
        kind,
        ref,
        attempts: 0,
        after: 0,
      },
    );
  }
  function audit(ticket, user, action, detail, internal = false) {
    if (ticket.owner.id === user.id) {
      ticket.lastActiveAt = now();
      if (!ticket.owner.guest) onActivity(user.id, ticket.lastActiveAt);
    }
    ticket.revision++;
    ticket.updatedAt = now();
    const entry = {
      id: randomUUID(),
      at: now(),
      actor: publicActor(user),
      action,
      detail,
      internal,
    };
    put(
      `ticket-history:${ticket.id}`,
      `${String(ticket.revision).padStart(12, "0")}:${entry.id}`,
      entry,
    );
    put("ticket", ticket.id, ticket);
    if (
      ticket.type !== "partnership" &&
      ticket.owner.guest &&
      !internal &&
      (["opened", "claimed", "closed", "reopened"].includes(action) ||
        (action === "message" && user.id !== ticket.owner.id))
    )
      put("ticket-email-outbox", `${ticket.id}:${ticket.revision}`, {
        ticketId: ticket.id,
        event: action,
        revision: ticket.revision,
        status: ticket.status,
        attempts: 0,
        after: 0,
      });
  }
  function mediaView(file, staffView, ticketId) {
    if (file.internal && !staffView) return null;
    return {
      id: file.id,
      name: file.name,
      type: file.type,
      size: file.size,
      expired: Boolean(file.expiresAt <= now() || file.purged || file.removed),
      url: `${staffView ? "/api/tickets" : "/help/api/tickets"}/${ticketId}/attachments/${file.id}`,
    };
  }
  function view(user, id, staffView = false, before) {
    const ticket = get(id);
    authorize(user, ticket, staffView);
    const page = store.page(
      `ticket-messages:${id}`,
      50,
      0,
      (message) =>
        (!before || message.sequence < Number(before)) &&
        (!message.internal || staffView),
    );
    const messages = page.items.reverse().map((message) => ({
      ...message,
      attachments: message.attachments
        .map((fileId) =>
          mediaView(store.get("ticket-media", fileId), staffView, id),
        )
        .filter(Boolean),
    }));
    const safe = {
      id: ticket.id,
      ign: ticket.ign,
      type: ticket.type,
      location: ticket.location,
      description: ticket.description,
      reportTarget: ticket.reportTarget || null,
      intakeDetails: ticketDetails(ticket),
      owner: ticket.owner,
      origin: ticket.origin,
      status: ticket.status,
      claimedBy: ticket.claimedBy,
      createdAt: ticket.createdAt,
      updatedAt: ticket.updatedAt,
      revision: ticket.revision,
      rating: ticket.rating,
      ratingStaff: ticket.ratingStaff || ticket.claimedBy,
      closureId: ticket.closureId || null,
      channelRetained: Boolean(ticket.channelId),
      deletionPending: store
        .entries("ticket-outbox")
        .some(([, job]) => job.ticketId === id && job.kind === "delete"),
      path: ticket.type === "partnership" ? null : ticketPath(ticket),
      category: ticketCategory(ticket),
      discordUrl:
        ticket.channelId &&
        (staffView || ["pending", "claimed"].includes(ticket.status))
          ? `https://discord.com/channels/${config.tickets.guildId}/${ticket.channelId}`
          : null,
      sync:
        ticket.type === "partnership"
          ? ticket.partnership.preference
          : ticket.discordDeletedAt || ticket.discordArchivedAt
            ? "saved"
            : ticket.channelId
              ? "connected"
              : "pending",
      messages,
      hasOlder: page.total > messages.length,
      history: store
        .entries(`ticket-history:${id}`)
        .map(([, entry]) => entry)
        .filter((entry) => staffView || !entry.internal),
      viewers: staffView
        ? [
            ...new Map(
              [...(viewers.get(id)?.values() || [])].map((entry) => [
                entry.actor.id,
                entry.actor,
              ]),
            ).values(),
          ]
        : [],
    };
    if (staffView) {
      safe.contactEmail = ticket.contactEmail || null;
      safe.partnership = ticket.partnership || null;
      const current = rolePolicy.apply(user);
      safe.actions = Object.fromEntries(
        ["view", "reply", "claim", "close", "delete"].map((action) => [
          action,
          Boolean(
            current.capabilities[`tickets.${action}`] &&
            current.capabilities[ticketCapability(ticket, action)],
          ),
        ]),
      );
      safe.resolution = ticket.resolution
        ? {
            ...ticket.resolution,
            attachments: ticket.resolution.attachments.map((fileId) =>
              mediaView(store.get("ticket-media", fileId), true, id),
            ),
          }
        : null;
      safe.previousResolutions = store
        .entries(`ticket-closures:${id}`)
        .map(([, closure]) => ({
          ...closure,
          resolution: closure.resolution
            ? {
                ...closure.resolution,
                attachments: closure.resolution.attachments
                  .map((fileId) =>
                    mediaView(store.get("ticket-media", fileId), true, id),
                  )
                  .filter(Boolean),
              }
            : null,
        }));
      safe.deliveryIssues = store
        .entries(
          ticket.type === "partnership"
            ? "partnership-outbox"
            : "ticket-outbox",
        )
        .filter(([, job]) => job.ticketId === id && job.failed)
        .map(([, job]) => ({ kind: job.kind, failure: job.failure }));
      safe.deliveryPending = store
        .entries(
          ticket.type === "partnership"
            ? "partnership-outbox"
            : "ticket-outbox",
        )
        .filter(([, job]) => job.ticketId === id).length;
    }
    return safe;
  }
  function visible(user, ticket) {
    const current = rolePolicy.apply(user);
    return Boolean(
      current.capabilities["tickets.view"] &&
      current.capabilities[ticketCapability(ticket)],
    );
  }
  function list(user, input = {}) {
    const current = staff(user);
    const {
      closed = false,
      category = "",
      status = "",
      type = "",
      assignment = "",
    } = input;
    const sort = input.sort || "updated";
    const { offset, term, withinDate } = listFilters(input);
    if (category && !ticketCategories.some((entry) => entry.id === category))
      throw new AuthError("invalid_ticket_category", 400);
    if (
      (status &&
        !["pending", "claimed", "awaiting_resolution", "closed"].includes(
          status,
        )) ||
      (type && !ticketTypes.some((entry) => entry.id === type)) ||
      !["", "mine", "unclaimed", "claimed"].includes(assignment) ||
      !["updated", "newest", "oldest"].includes(sort)
    )
      throw new AuthError("invalid_list_filters", 400);
    const values = store
      .entries("ticket")
      .map(([, ticket]) => ticket)
      .filter(
        (ticket) =>
          !ticket.erasingAt &&
          (closed ? ticket.status === "closed" : ticket.status !== "closed") &&
          current.capabilities[ticketCapability(ticket)] &&
          (!status || ticket.status === status) &&
          (!type || ticket.type === type) &&
          (assignment !== "mine" || ticket.claimedBy?.id === current.id) &&
          (assignment !== "unclaimed" || !ticket.claimedBy) &&
          (assignment !== "claimed" || Boolean(ticket.claimedBy)) &&
          withinDate(ticket.createdAt) &&
          matchesText(term, [
            ticket.id,
            ticket.ign,
            ticket.location,
            ticket.description,
            ticket.reportTarget,
            ticket.owner.id,
            ticket.owner.name,
            ticket.claimedBy?.id,
            ticket.claimedBy?.name,
          ]),
      );
    const filtered = values.filter(
      (ticket) => !category || ticketCategory(ticket) === category,
    );
    const time = (ticket) =>
      sort === "updated" ? ticket.updatedAt : ticket.createdAt;
    filtered.sort(
      (a, b) =>
        (sort === "oldest" ? time(a) - time(b) : time(b) - time(a)) ||
        a.id.localeCompare(b.id),
    );
    return {
      items: filtered.slice(offset, offset + 50),
      total: filtered.length,
      pageSize: 50,
      categories: ticketCategories
        .filter(
          (entry) => current.capabilities[`tickets.category.${entry.id}.view`],
        )
        .map((entry) => ({
          ...entry,
          count: values.filter((ticket) => ticketCategory(ticket) === entry.id)
            .length,
        })),
    };
  }
  function create(user, input, origin = "web", guestNetwork) {
    if (!user?.id || !["web", "discord"].includes(origin))
      throw new AuthError("ticket_origin_disabled", 400);
    if (
      input.type === "partnership" ||
      !ticketTypes.some((type) => type.id === input.type) ||
      !/^[A-Za-z0-9_]{3,16}$/.test(input.ign || "")
    )
      throw new AuthError("invalid_ticket", 400);
    const requestId = text(input.requestId, 36, 36);
    if (!idPattern.test(requestId)) throw new AuthError("invalid_request", 400);
    let contactEmail;
    if (user.guest) {
      if (origin !== "web" || !/^[a-f0-9]{64}$/.test(guestNetwork || ""))
        throw new AuthError("invalid_request", 400);
      contactEmail = text(input.email, 3, 254, "invalid_ticket_email");
      if (!validMailAddress(contactEmail))
        throw new AuthError("invalid_ticket_email", 400);
    }
    const prior = store.get("ticket-request", `${user.id}:${requestId}`);
    if (prior) return get(prior.id);
    if (
      !user.guest &&
      store
        .entries("ticket")
        .filter(
          ([, ticket]) =>
            ticket.owner.id === user.id && ticket.status !== "closed",
        ).length >= 3
    )
      throw new AuthError("ticket_limit", 409);
    const intake = Object.fromEntries(
      ticketIntake(input.type).fields.map((field) => [
        field.id,
        text(
          field.required === false ? (input[field.id] ?? "") : input[field.id],
          field.min,
          field.max,
          field.id === "reportTarget"
            ? "invalid_report_target"
            : "invalid_ticket",
        ),
      ]),
    );
    const ticket = {
      id: randomUUID(),
      type: input.type,
      ...intake,
      owner: publicActor(user),
      ...(user.guest ? { guestNetwork, contactEmail } : {}),
      origin,
      status: "pending",
      claimedBy: null,
      channelId: null,
      createdAt: now(),
      updatedAt: now(),
      revision: 0,
      sequence: 0,
      rating: null,
      resolution: null,
    };
    store.transaction(() => {
      if (
        user.guest &&
        store
          .entries("ticket")
          .some(
            ([, current]) =>
              current.guestNetwork === guestNetwork &&
              ["pending", "claimed"].includes(current.status),
          )
      )
        throw new AuthError("ticket_ip_limit", 409);
      audit(ticket, user, "opened", "Ticket opened");
      queue(ticket, "create");
      if (config.tickets.staffChannelId)
        for (const event of ["opened", "unclaimed"])
          put("ticket-notice-outbox", `${ticket.id}:${event}`, {
            ticketId: ticket.id,
            event,
            channelId: config.tickets.staffChannelId,
            after: ticket.createdAt + (event === "unclaimed" ? 3600000 : 0),
            attempts: 0,
          });
      put("ticket-request", `${user.id}:${requestId}`, { id: ticket.id });
    });
    announce(ticket);
    return ticket;
  }
  function createPartnership(user, input, network) {
    if (!["owner", "developer"].includes(input.relationship))
      throw new AuthError("partnership_owner_required", 400);
    if (!user?.id || !/^[a-f0-9]{64}$/.test(network || ""))
      throw new AuthError("invalid_request", 400);
    const name = text(input.name, 2, 80);
    const email = text(
      input.email,
      3,
      254,
      "invalid_ticket_email",
    ).toLowerCase();
    if (!validMailAddress(email))
      throw new AuthError("invalid_ticket_email", 400);
    const discord = text(input.discord, 2, 100);
    const packUrl = text(input.packUrl, 10, 1000);
    let url;
    try {
      url = new URL(packUrl);
    } catch {
      throw new AuthError("invalid_pack_link", 400);
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      !url.hostname.includes(".")
    )
      throw new AuthError("invalid_pack_link", 400);
    if (!["email", "discord"].includes(input.preference))
      throw new AuthError("invalid_contact_preference", 400);
    if (
      input.preference === "discord" &&
      (user.guest || !/^\d{17,20}$/.test(user.id) || input.allowDm !== true)
    )
      throw new AuthError("partnership_discord_required", 400);
    if (!idPattern.test(input.requestId || ""))
      throw new AuthError("invalid_request", 400);
    const prior = store.get("ticket-request", `${user.id}:${input.requestId}`);
    if (prior) return get(prior.id);
    const ticket = {
      id: randomUUID(),
      ign: name,
      type: "partnership",
      location: url.hostname,
      description: text(input.description, 50, 4000),
      owner: publicActor({ ...user, name }),
      contactEmail: email,
      guestNetwork: network,
      origin: "web",
      status: "pending",
      claimedBy: null,
      channelId: null,
      createdAt: now(),
      updatedAt: now(),
      revision: 0,
      sequence: 0,
      rating: null,
      resolution: null,
      partnership: {
        relationship: input.relationship,
        packUrl: url.href,
        discord,
        preference: input.preference,
        discordId: user.guest ? null : user.id,
      },
    };
    store.transaction(() => {
      if (
        store
          .entries("ticket")
          .some(
            ([, current]) =>
              current.type === "partnership" &&
              current.status !== "closed" &&
              (current.guestNetwork === network ||
                current.contactEmail?.toLowerCase() === email ||
                current.owner.id === user.id),
          )
      )
        throw new AuthError("partnership_limit", 409);
      audit(ticket, user, "opened", "Modpack partnership request submitted");
      queue(ticket, "opened");
      if (config.tickets.staffChannelId)
        for (const event of ["opened", "unclaimed"])
          put("ticket-notice-outbox", `${ticket.id}:${event}`, {
            ticketId: ticket.id,
            event,
            channelId: config.tickets.staffChannelId,
            after: now() + (event === "unclaimed" ? 3600000 : 0),
            attempts: 0,
          });
      put("ticket-request", `${user.id}:${input.requestId}`, { id: ticket.id });
    });
    announce(ticket);
    return ticket;
  }
  function files(ticket, user, ids, internal = false) {
    if (
      !Array.isArray(ids) ||
      ids.length > 5 ||
      new Set(ids).size !== ids.length
    )
      throw new AuthError("invalid_attachment", 400);
    if (
      ids.reduce(
        (total, id) => total + (store.get("ticket-media", id)?.size || 0),
        0,
      ) >
      (ticket.type === "partnership"
        ? 10 * 1024 * 1024
        : ticketMessageUploadLimit)
    )
      throw new AuthError("attachments_too_large", 413);
    return ids.map((id) => {
      const file = store.get("ticket-media", id);
      if (
        !file ||
        file.ticketId !== ticket.id ||
        file.uploader !== user.id ||
        file.used ||
        file.expiresAt <= now() ||
        file.purged
      )
        throw new AuthError("invalid_attachment", 400);
      file.used = true;
      file.internal = internal;
      put("ticket-media", id, file);
      return id;
    });
  }
  function reply(user, id, input, staffView = false) {
    const ticket = get(id);
    authorize(user, ticket, staffView, "tickets.reply");
    if (!["pending", "claimed"].includes(ticket.status))
      throw new AuthError("ticket_closed", 409);
    if (!idPattern.test(input.requestId || ""))
      throw new AuthError("invalid_request", 400);
    const old = store.get(
      "ticket-message-request",
      `${id}:${user.id}:${input.requestId}`,
    );
    if (old) return old;
    const content = text(
      input.content || "",
      input.attachments?.length ? 0 : 1,
      2000,
      "invalid_message",
    );
    let message;
    store.transaction(() => {
      message = {
        id: randomUUID(),
        sequence: ++ticket.sequence,
        actor: publicActor(user),
        staff: staffView,
        content,
        attachments: files(ticket, user, input.attachments || []),
        at: now(),
        origin: staffView ? "dashboard" : "web",
        delivery: "pending",
        deleted: false,
      };
      put(
        `ticket-messages:${id}`,
        String(message.sequence).padStart(12, "0"),
        message,
      );
      put(
        "ticket-message-request",
        `${id}:${user.id}:${input.requestId}`,
        message,
      );
      queue(ticket, "message", String(message.sequence).padStart(12, "0"));
      audit(ticket, user, "message", "Message sent");
    });
    announce(ticket);
    return message;
  }
  function claim(user, id) {
    const ticket = get(id);
    staff(user, ticket, "tickets.claim");
    if (ticket.claimedBy?.id === user.id) return ticket;
    if (ticket.status !== "pending" || ticket.claimedBy)
      throw new AuthError("ticket_already_claimed", 409);
    store.transaction(() => {
      ticket.claimedBy = publicActor(user);
      ticket.status = "claimed";
      audit(ticket, user, "claimed", `${user.name} claimed the ticket`);
      queue(ticket, "status");
    });
    announce(ticket);
    return ticket;
  }
  function closeTicket(user, id, input, staffView = false) {
    const ticket = get(id);
    authorize(user, ticket, staffView, "tickets.close");
    if (ticket.status === "closed") return ticket;
    if (!staffView && ticket.status === "awaiting_resolution") return ticket;
    const resolution = staffView
      ? {
          summary: text(input.summary, 20, 4000, "resolution_required"),
          commands: text(input.commands, 4, 2000, "commands_required"),
          actor: publicActor(user),
          at: now(),
        }
      : null;
    store.transaction(() => {
      if (["pending", "claimed"].includes(ticket.status)) {
        ticket.closureId = randomUUID();
        ticket.ratingStaff = ticket.claimedBy;
        if (!ticket.owner.guest && ticket.type !== "partnership")
          queue(ticket, "feedback", ticket.closureId);
      }
      ticket.status = staffView ? "closed" : "awaiting_resolution";
      ticket.closedAt = now();
      if (resolution) {
        resolution.attachments = files(
          ticket,
          user,
          input.attachments || [],
          true,
        );
        ticket.resolution = resolution;
      }
      audit(
        ticket,
        user,
        "closed",
        staffView
          ? "Staff recorded the resolution and closed the ticket"
          : "Player closed the ticket; staff resolution is pending",
      );
      if (!ticket.discordDeletedAt && !ticket.discordArchivedAt)
        queue(ticket, "status");
    });
    announce(ticket);
    return ticket;
  }
  async function reopen(user, id, staffView = false, closureId) {
    authorize(user, get(id), staffView, "tickets.close");
    await pump();
    const ticket = get(id);
    authorize(user, ticket, staffView, "tickets.close");
    if (["pending", "claimed"].includes(ticket.status)) return ticket;
    if (closureId !== undefined && closureId !== (ticket.closureId || null))
      throw new AuthError("ticket_feedback_expired", 409);
    if (
      store
        .entries("ticket-outbox")
        .some(([, job]) => job.ticketId === id && job.kind === "delete") ||
      store.get("ticket-outbox", `${id}:create:${id}`) ||
      store.get("ticket-outbox", `${id}:status:${id}`)
    )
      throw new AuthError("ticket_reopen_pending", 409);
    const others = store
      .entries("ticket")
      .map(([, entry]) => entry)
      .filter((entry) => entry.id !== id);
    if (ticket.type === "partnership") {
      if (
        others.some(
          (entry) =>
            entry.type === "partnership" &&
            entry.status !== "closed" &&
            (entry.owner.id === ticket.owner.id ||
              entry.guestNetwork === ticket.guestNetwork ||
              entry.contactEmail?.toLowerCase() ===
                ticket.contactEmail?.toLowerCase()),
        )
      )
        throw new AuthError("partnership_limit", 409);
    } else if (ticket.owner.guest) {
      if (
        others.some(
          (entry) =>
            entry.guestNetwork === ticket.guestNetwork &&
            ["pending", "claimed"].includes(entry.status),
        )
      )
        throw new AuthError("ticket_ip_limit", 409);
    } else if (
      others.filter(
        (entry) =>
          entry.owner.id === ticket.owner.id && entry.status !== "closed",
      ).length >= 3
    )
      throw new AuthError("ticket_limit", 409);
    store.transaction(() => {
      put(
        `ticket-closures:${id}`,
        ticket.closureId || String(ticket.closedAt),
        {
          at: ticket.closedAt,
          claimedBy: ticket.ratingStaff || ticket.claimedBy,
          rating: ticket.rating,
          resolution: ticket.resolution,
        },
      );
      ticket.status = "pending";
      ticket.claimedBy = null;
      ticket.resolution = null;
      ticket.rating = null;
      ticket.ratingStaff = null;
      ticket.reopenedCount = (ticket.reopenedCount || 0) + 1;
      if (!ticket.channelId) {
        ticket.reopenedSequence = ticket.sequence;
        delete ticket.lastDiscordId;
      }
      delete ticket.closedAt;
      delete ticket.closureId;
      delete ticket.discordDeletedAt;
      delete ticket.discordArchivedAt;
      store.delete("ticket-discord-close", id);
      if (!ticket.channelId)
        for (const kind of [
          "ticket-discord-cursor",
          "ticket-discord-sweep",
          "ticket-discord",
        ])
          store.delete(kind, id);
      audit(
        ticket,
        user,
        "reopened",
        "Ticket reopened and returned to the waiting queue",
      );
      queue(
        ticket,
        ticket.type === "partnership" || ticket.channelId ? "status" : "create",
      );
      if (config.tickets.staffChannelId) {
        const cycle = `${id}:reopened:${ticket.reopenedCount}`;
        for (const event of ["reopened", "unclaimed"])
          put("ticket-notice-outbox", `${cycle}:${event}`, {
            ticketId: id,
            event,
            channelId: config.tickets.staffChannelId,
            openedKey: `${cycle}:reopened`,
            cycle: ticket.reopenedCount,
            after: now() + (event === "unclaimed" ? 3600000 : 0),
            attempts: 0,
          });
      }
    });
    announce(ticket);
    return ticket;
  }
  async function deleteChannel(user, id, closureId) {
    staff(user, get(id), "tickets.delete");
    await pump();
    const ticket = get(id);
    staff(user, ticket, "tickets.delete");
    if (!["closed", "awaiting_resolution"].includes(ticket.status))
      throw new AuthError("ticket_close_first", 409);
    if (closureId !== undefined && closureId !== (ticket.closureId || null))
      throw new AuthError("ticket_feedback_expired", 409);
    if (!ticket.channelId) return ticket;
    if (
      store
        .entries("ticket-outbox")
        .some(([, job]) => job.ticketId === id && job.kind === "delete")
    )
      return ticket;
    store.transaction(() => {
      store.delete("ticket-discord-close", id);
      audit(
        ticket,
        user,
        "channel_deletion_requested",
        "Admin requested Discord channel deletion; dashboard history is kept",
        true,
      );
      queue(ticket, "delete", ticket.channelId);
    });
    announce(ticket);
    return ticket;
  }
  function rate(user, id, rating, closureId) {
    const ticket = get(id);
    authorize(user, ticket);
    if (closureId !== undefined && closureId !== (ticket.closureId || null))
      throw new AuthError("ticket_feedback_expired", 409);
    if (
      !["closed", "awaiting_resolution"].includes(ticket.status) ||
      !Number.isInteger(rating) ||
      rating < 1 ||
      rating > 5
    )
      throw new AuthError("invalid_rating", 400);
    if (ticket.rating !== null)
      throw new AuthError("ticket_already_rated", 409);
    store.transaction(() => {
      ticket.rating = rating;
      audit(ticket, user, "rated", `Player rated the help ${rating}/5`);
    });
    announce(ticket);
    return ticket;
  }
  async function upload(
    user,
    id,
    bytes,
    name,
    type,
    staffView = false,
    internal = false,
  ) {
    const ticket = get(id);
    if (
      stopped ||
      ticket.status === "closed" ||
      (!internal && ticket.status === "awaiting_resolution")
    )
      throw new AuthError("ticket_closed", 409);
    authorize(
      user,
      get(id),
      staffView,
      internal ? "tickets.close" : "tickets.reply",
    );
    if (!transport) throw new AuthError("ticket_sync_unavailable", 503);
    const metadata = await transport.upload(bytes, name, type, ticket);
    // validate again after the upload. a closure may have raced it.
    const file = {
      ...metadata,
      id: randomUUID(),
      ticketId: id,
      uploader: user.id,
      internal,
      used: false,
      createdAt: now(),
      expiresAt: now() + ticketMediaDays * 86400000,
    };
    put("ticket-media", file.id, file);
    authorize(
      user,
      get(id),
      staffView,
      internal ? "tickets.close" : "tickets.reply",
    );
    if (
      get(id).status === "closed" ||
      (!internal && get(id).status === "awaiting_resolution")
    )
      throw new AuthError("ticket_closed", 409);
    return mediaView(file, staffView, id);
  }
  function media(user, id, fileId, staffView = false) {
    authorize(user, get(id), staffView);
    const file = store.get("ticket-media", fileId);
    if (
      !file ||
      file.ticketId !== id ||
      (file.internal && !staffView) ||
      (!file.used && file.uploader !== user.id)
    )
      throw new AuthError("ticket_not_found", 404);
    if (file.purged || file.removed || file.expiresAt <= now())
      throw new AuthError("attachment_expired", 410);
    return file;
  }
  function linked(channelId) {
    const ref = store.get("ticket-channel", channelId);
    return ref ? get(ref.id) : null;
  }
  function bind(id, channelId) {
    const ticket = get(id);
    ticket.channelId = channelId;
    store.transaction(() => {
      put("ticket", id, ticket);
      put("ticket-channel", channelId, { id });
    });
    announce(ticket);
  }
  function ingest(id, incoming, closing = false) {
    const ticket = get(id),
      ref = store.get("ticket-discord-message", incoming.id);
    const saveAttachment = (metadata) => {
      if (metadata.savedId) {
        const saved = store.get("ticket-media", metadata.savedId);
        if (
          !saved ||
          saved.ticketId !== id ||
          saved.uploader !== incoming.actor.id ||
          saved.expiresAt <= now()
        )
          throw new AuthError("invalid_attachment", 400);
        saved.used = true;
        put("ticket-media", saved.id, saved);
        return saved.id;
      }
      const createdAt = closing ? Math.min(incoming.at, now()) : now();
      const file = {
        ...metadata,
        id: randomUUID(),
        ticketId: id,
        uploader: incoming.actor.id,
        internal: false,
        used: true,
        createdAt,
        expiresAt: createdAt + ticketMediaDays * 86400000,
      };
      put("ticket-media", file.id, file);
      return file.id;
    };
    if (ref) {
      if (ref.ticketId !== id || (incoming.deleted && ref.mediaRemoved)) return;
      const message = store.get(`ticket-messages:${id}`, ref.key);
      if (
        !incoming.deleted &&
        (message.deleted ||
          (incoming.editedAt || 0) < (message.discordEditedAt || 0))
      )
        return;
      const nextContent = incoming.deleted
        ? "Message deleted"
        : (incoming.content || "").slice(0, 2000);
      const metadata = incoming.deleted ? [] : incoming.attachments;
      const previous = message.attachments.map((fileId) =>
        store.get("ticket-media", fileId),
      );
      const sameAttachment = (saved, incoming) =>
        saved &&
        (saved.attachmentId === incoming.attachmentId ||
          (saved.sourceChannelId === incoming.channelId &&
            saved.sourceAttachmentId === incoming.attachmentId));
      const attachmentsChanged =
        metadata !== undefined &&
        (metadata.length !== previous.length ||
          metadata.some(
            (file, index) => !sameAttachment(previous[index], file),
          ));
      if (
        message.origin !== "discord" ||
        (message.content === nextContent &&
          message.deleted === Boolean(incoming.deleted) &&
          !attachmentsChanged)
      )
        return;
      store.transaction(() => {
        if (attachmentsChanged) {
          message.attachments = metadata.map(
            (file) =>
              previous.find((old) => sameAttachment(old, file))?.id ||
              saveAttachment(file),
          );
          for (const old of previous)
            if (!message.attachments.includes(old.id)) {
              old.removed = true;
              put("ticket-media", old.id, old);
            }
        }
        Object.assign(message, {
          content: nextContent,
          deleted: Boolean(incoming.deleted),
          editedAt: now(),
          discordEditedAt: incoming.editedAt || 0,
        });
        put(`ticket-messages:${id}`, ref.key, message);
        audit(
          ticket,
          incoming.actor || message.actor,
          incoming.deleted ? "message_deleted" : "message_edited",
          "Discord message updated",
        );
      });
      announce(ticket);
      return;
    }
    if (
      incoming.deleted ||
      (!["pending", "claimed"].includes(ticket.status) &&
        !(closing && incoming.at <= ticket.closedAt))
    )
      return;
    store.transaction(() => {
      const attachments = (incoming.attachments || []).map(saveAttachment);
      const message = {
        id: randomUUID(),
        sequence: ++ticket.sequence,
        actor: publicActor(incoming.actor),
        staff: Boolean(incoming.staff),
        content: (incoming.content || "").slice(0, 2000),
        attachments,
        at: incoming.at || now(),
        origin: incoming.origin === "email" ? "email" : "discord",
        delivery: "delivered",
        discordId: incoming.id,
        discordEditedAt: incoming.editedAt || 0,
        deleted: false,
      };
      const key = String(message.sequence).padStart(12, "0");
      put(`ticket-messages:${id}`, key, message);
      put("ticket-discord-message", incoming.id, { ticketId: id, key });
      ticket.lastDiscordId = incoming.id;
      audit(
        ticket,
        incoming.actor,
        "message",
        incoming.origin === "email"
          ? "Email reply received"
          : "Discord message received",
      );
    });
    announce(ticket);
  }
  async function pump() {
    if (!transport || stopped || running) return running;
    running = Promise.resolve()
      .then(async () => {
        const blocked = new Set();
        const priority = {
          create: 0,
          message: 1,
          status: 2,
          delete: 3,
          feedback: 4,
        };
        let attempts = 0;
        for (const [key, job] of store
          .entries("ticket-outbox")
          .sort(
            ([, a], [, b]) =>
              a.ticketId.localeCompare(b.ticketId) ||
              priority[a.kind] - priority[b.kind] ||
              a.ref.localeCompare(b.ref),
          )) {
          if (job.kind !== "create" && blocked.has(job.ticketId)) continue;
          if (job.after > now()) {
            if (job.kind === "message") blocked.add(job.ticketId);
            continue;
          }
          if (store.get("ticket", job.ticketId)?.erasingAt) continue;
          const ticket = get(job.ticketId);
          if (job.kind === "feedback") {
            const intent = store.get("ticket-feedback-send", key);
            const cleanup = intent?.route === "channel" && intent.channelId;
            if (
              !cleanup &&
              (job.ref !== ticket.closureId ||
                ticket.rating !== null ||
                !["closed", "awaiting_resolution"].includes(ticket.status))
            ) {
              store.delete("ticket-outbox", key);
              store.delete("ticket-feedback-send", key);
              continue;
            }
            if (
              job.failed ||
              (!cleanup &&
                ticket.channelId &&
                !store.get("ticket-discord-close", ticket.id)?.ready)
            )
              continue;
          } else if (job.kind !== "create" && !ticket.channelId) {
            if (ticket.discordDeletedAt || ticket.discordArchivedAt)
              store.delete("ticket-outbox", key);
            continue;
          }
          if (attempts++ === 20) break;
          try {
            if (job.kind === "create") await transport.create(ticket);
            else if (job.kind === "feedback") {
              const result = await transport.feedback(ticket, job, key);
              if (result?.pending) continue;
            } else if (job.kind === "status" || job.kind === "delete") {
              if (
                job.kind === "delete" &&
                (ticket.channelId !== job.ref ||
                  !["closed", "awaiting_resolution"].includes(ticket.status))
              ) {
                store.delete("ticket-outbox", key);
                continue;
              }
              const result =
                job.kind === "delete"
                  ? await transport.deleteChannel(ticket)
                  : await transport.status(ticket);
              if (result?.pending) continue;
              if (result?.deleted)
                store.transaction(() => {
                  const current = get(ticket.id);
                  if (current.channelId !== ticket.channelId)
                    throw new Error("Ticket channel changed during closure");
                  store.delete("ticket-channel", current.channelId);
                  current.channelId = null;
                  current.discordDeletedAt = now();
                  current.revision++;
                  put("ticket", current.id, current);
                });
            } else {
              const message = store.get(
                `ticket-messages:${ticket.id}`,
                job.ref,
              );
              const delivered = await transport.message(
                ticket,
                message,
                message.attachments.map((id) => store.get("ticket-media", id)),
                { retry: job.attempts > 0 },
              );
              store.transaction(() => {
                message.discordId = delivered.id;
                message.delivery = "delivered";
                put(`ticket-messages:${ticket.id}`, job.ref, message);
                put("ticket-discord-message", delivered.id, {
                  ticketId: ticket.id,
                  key: job.ref,
                });
                store.delete("ticket-send", message.id);
                const current = get(ticket.id);
                current.revision++;
                put("ticket", ticket.id, current);
              });
            }
            // a concurrent status change replaces this job. keep that newer version.
            if (store.get("ticket-outbox", key)?.generation === job.generation)
              store.delete("ticket-outbox", key);
            events.emit("changed", {
              id: ticket.id,
              revision: get(ticket.id).revision,
            });
          } catch (error) {
            if (job.kind === "message") blocked.add(job.ticketId);
            job.attempts++;
            job.after =
              now() + Math.min(60000, 1000 * 2 ** Math.min(job.attempts, 6));
            job.failure = error.code || "discord_unavailable";
            if (job.kind === "feedback") job.failed = job.attempts >= 20;
            if (store.get("ticket-outbox", key)?.generation === job.generation)
              put("ticket-outbox", key, job);
            console.error(
              "Ticket Discord delivery is pending:",
              job.kind,
              job.failure,
            );
          }
        }
      })
      .finally(() => {
        running = null;
      });
    return running;
  }
  async function expire() {
    if (!transport || stopped || expiring) return expiring;
    expiring = Promise.resolve()
      .then(async () => {
        for (const [id, file] of store.entries("ticket-media")) {
          if (
            !file.purged &&
            (file.expiresAt <= now() ||
              (!file.used && file.createdAt + 3600000 <= now()))
          ) {
            try {
              await transport.removeMedia(file);
              file.purged = true;
              put("ticket-media", id, file);
            } catch {
              console.error("Ticket attachment removal is pending.");
            }
          }
        }
        for (const [, ticket] of store.entries("ticket")) {
          if (ticket.erasingAt) continue;
          if (
            ["closed", "awaiting_resolution"].includes(ticket.status) &&
            ticket.channelId &&
            !store.get("ticket-discord-close", ticket.id)?.ready &&
            !store.get("ticket-outbox", `${ticket.id}:status:${ticket.id}`)
          )
            queue(ticket, "status");
        }
        await pump();
      })
      .finally(() => {
        expiring = null;
      });
    return expiring;
  }
  return {
    async eraseInactive(id, lastActiveAt) {
      const ticket = store.get("ticket", id);
      if (!ticket || (ticket.lastActiveAt || ticket.createdAt) > lastActiveAt)
        return false;
      if (store.get("privacy-hold", id)) return false;
      if (transport && !transport.eraseTicket)
        throw new Error("Ticket erasure transport unavailable");
      ticket.erasingAt ||= now();
      put("ticket", id, ticket);
      await running;
      await expiring;
      await Promise.all(cleanupWaiters.map((wait) => wait()));
      if (transport) {
        for (const [, file] of store.entries("ticket-media"))
          if (file.ticketId === id && !file.purged)
            await transport.removeMedia(file);
        await transport.eraseTicket(ticket);
      } else if (ticket.channelId)
        throw new Error("Discord cleanup unavailable");
      store.transaction(() => {
        const messageIds = new Set(
          store.entries(`ticket-messages:${id}`).map(([, value]) => value.id),
        );
        for (const kind of store.kinds()) {
          if (!kind.startsWith("ticket") && !kind.startsWith("partnership"))
            continue;
          for (const [key, value] of store.entries(kind))
            if (
              kind.endsWith(`:${id}`) ||
              key === id ||
              key.startsWith(`${id}:`) ||
              value?.ticketId === id ||
              value?.id === id ||
              (kind === "ticket-send" && messageIds.has(key)) ||
              (kind === "ticket-channel" && value === id)
            )
              store.delete(kind, key);
        }
        store.delete("privacy-hold", id);
      });
      viewers.delete(id);
      events.emit("changed", { id });
      return true;
    },
    registerCleanupWaiter(wait) {
      cleanupWaiters.push(wait);
    },
    get,
    list,
    view,
    create,
    createPartnership,
    visible,
    reply,
    claim,
    closeTicket,
    reopen,
    deleteChannel,
    rate,
    media,
    upload,
    ingest,
    importMedia(id, actor, metadata) {
      get(id);
      const file = {
        ...metadata,
        id: randomUUID(),
        ticketId: id,
        uploader: actor.id,
        internal: false,
        used: false,
        createdAt: now(),
        expiresAt: now() + ticketMediaDays * 86400000,
      };
      put("ticket-media", file.id, file);
      return { savedId: file.id };
    },
    linked,
    bind,
    events,
    store,
    staff,
    authorize,
    attach(value) {
      transport = value;
    },
    all() {
      return store
        .entries("ticket")
        .map(([, ticket]) => ticket)
        .filter((ticket) => !ticket.erasingAt);
    },
    attention(user) {
      staff(user);
      return {
        kind: "tickets",
        name: "Drakora support",
        count: store
          .entries("ticket")
          .filter(
            ([, ticket]) => ticket.status !== "closed" && visible(user, ticket),
          ).length,
        available: true,
        checkedAt: now(),
        href: "/tickets",
      };
    },
    messages(id) {
      return store
        .entries(`ticket-messages:${id}`)
        .map(([, message]) => message)
        .sort((a, b) => a.sequence - b.sequence);
    },
    watch(id, user, staffView, listener) {
      authorize(user, get(id), staffView);
      const key = randomUUID();
      if (staffView) {
        if (!viewers.has(id)) viewers.set(id, new Map());
        viewers.get(id).set(key, { actor: publicActor(user) });
      }
      const receive = (event) => {
        if (event.id === id) listener(event);
      };
      events.on("changed", receive);
      events.emit("changed", { id });
      return () => {
        events.off("changed", receive);
        const room = viewers.get(id);
        room?.delete(key);
        if (!room?.size) viewers.delete(id);
        events.emit("changed", { id });
      };
    },
    challenge(sessionId, returnPath) {
      const challenge = token();
      store.set(
        "ticket-challenge",
        digest(challenge),
        { session: digest(sessionId), returnPath },
        now() + 600000,
      );
      return challenge;
    },
    challengeGet(challenge) {
      return typeof challenge === "string"
        ? store.get("ticket-challenge", digest(challenge))
        : undefined;
    },
    handoff(challenge, identity) {
      const pending = store.take("ticket-challenge", digest(challenge));
      if (!pending) throw new AuthError("invalid_login_state", 400);
      const handoff = token();
      store.set(
        "ticket-handoff",
        digest(handoff),
        { ...pending, identity: publicActor(identity) },
        now() + 60000,
      );
      return `${config.applications.publicOrigin}/help/auth/consume?handoff=${handoff}`;
    },
    consume(handoff, sessionId) {
      const pending =
        typeof handoff === "string"
          ? store.get("ticket-handoff", digest(handoff))
          : undefined;
      if (!pending || pending.session !== digest(sessionId))
        throw new AuthError("invalid_handoff", 400);
      store.delete("ticket-handoff", digest(handoff));
      return pending;
    },
    consumeEmailAccess(value) {
      if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value))
        throw new AuthError("invalid_ticket_link", 400);
      const pending = store.take("ticket-email-access", digest(value));
      if (!pending) throw new AuthError("invalid_ticket_link", 400);
      const ticket = get(pending.ticketId);
      if (!ticket.owner.guest) throw new AuthError("invalid_ticket_link", 400);
      return { identity: ticket.owner, returnPath: ticketPath(ticket) };
    },
    pump,
    expire,
    start() {
      timer = setInterval(() => void pump(), 1000);
      timer.unref();
      maintenance = setInterval(() => void expire(), 60000);
      maintenance.unref();
      void pump();
      void expire();
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      clearInterval(maintenance);
      events.emit("shutdown");
      await Promise.all([running, expiring]);
      events.removeAllListeners();
      viewers.clear();
    },
  };
}
