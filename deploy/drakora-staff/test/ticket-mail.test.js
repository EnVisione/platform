import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { openStore } from "../server/store.js";
import { ticketService } from "../server/tickets.js";
import { ticketMail } from "../server/ticket-mail.js";
import { rolePermissions } from "../server/role-permissions.js";
import { config as fixture } from "./fixture.js";

test("guest email updates retry durably and contain no chat or staff resolution", async (t) => {
  const config = {
    ...fixture,
    applications: {
      publicOrigin: "https://example.invalid",
      smtp: { from: "support@example.invalid" },
    },
    tickets: { guildId: "2" },
  };
  const { store } = openStore(":memory:", randomBytes(32).toString("base64"));
  const service = ticketService(config, store, rolePermissions(config, store));
  const sent = [];
  let unavailable = true,
    closed = false;
  const mail = ticketMail(config, service, {
    async sendMail(message) {
      if (unavailable) throw new Error("Temporary SMTP failure");
      sent.push(message);
      return { accepted: [message.to.address] };
    },
    close() {
      closed = true;
    },
  });
  t.after(async () => {
    await mail.close();
    await service.stop();
    store.close();
    assert.equal(closed, true);
  });
  const owner = { id: "guest:fixture", name: "Jojo", guest: true },
    staff = { id: "200", name: "Helper", roles: ["10", "23"] };
  const ticket = service.create(
    owner,
    {
      requestId: randomUUID(),
      ign: "Jojo",
      type: "general",
      location: "Void",
      description: "A detailed description without needing Discord to submit.",
      email: "jojo@example.invalid",
    },
    "web",
    "a".repeat(64),
  );
  service.reply(owner, ticket.id, {
    requestId: randomUUID(),
    content: "PRIVATE player text",
  });
  service.claim(staff, ticket.id);
  service.reply(
    staff,
    ticket.id,
    { requestId: randomUUID(), content: "PRIVATE staff text" },
    true,
  );
  service.takeover(
    { id: "201", name: "Admin", roles: ["10", "21"] },
    ticket.id,
    staff.id,
  );
  service.closeTicket(
    staff,
    ticket.id,
    {
      summary: "PRIVATE staff resolution of the player's reported issue.",
      commands: "None",
    },
    true,
  );
  assert.equal(store.entries("ticket-email-outbox").length, 5);
  await mail.pump();
  assert.equal(sent.length, 0);
  assert.equal(store.entries("ticket-email-outbox").length, 5);
  unavailable = false;
  for (const [key, job] of store.entries("ticket-email-outbox")) {
    job.after = 0;
    store.set("ticket-email-outbox", key, job, Number.MAX_SAFE_INTEGER);
  }
  await mail.pump();
  assert.equal(sent.length, 5);
  assert.ok(
    sent.every(
      (message) =>
        message.to.address === "jojo@example.invalid" &&
        !message.text.includes("PRIVATE"),
    ),
  );
  assert.equal(new Set(sent.map((message) => message.messageId)).size, 5);
  assert.match(sent[0].subject, /Your ticket is open/);
  assert.match(sent[1].subject, /Helper claimed your ticket/);
  assert.match(sent[2].subject, /Staff replied/);
  assert.match(sent[2].subject, /Helper/);
  assert.match(sent[3].subject, /Admin took over your ticket/);
  const link = sent[0].text.match(/\/help\/access\/([A-Za-z0-9_-]{43})/)[1];
  assert.equal(service.consumeEmailAccess(link).identity.id, owner.id);
  assert.throws(() => service.consumeEmailAccess(link), {
    code: "invalid_ticket_link",
  });
  assert.equal(store.entries("ticket-email-outbox").length, 0);
  await mail.pump();
  assert.equal(sent.length, 5);
});
