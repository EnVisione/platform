import {
  ticketStatuses,
  ticketTypes,
  ticketDetails,
} from "../shared/tickets.js";

const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ],
  );
const date = (value) =>
  new Date(value).toISOString().replace("T", " ").replace(".000Z", " UTC");
const imageTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

export async function ticketTranscript(
  service,
  user,
  id,
  staffView,
  attachmentBytes,
  { authorizeAsStaff = false } = {},
) {
  const ticket = service.get(id);
  service.authorize(user, ticket, staffView || authorizeAsStaff);
  const history = service
    .view(user, id, staffView || authorizeAsStaff)
    .history.filter((entry) => staffView || !entry.internal);
  let embeddedBytes = 0;
  async function attachment(fileId) {
    const file = service.store.get("ticket-media", fileId);
    if (!file || (file.internal && !staffView)) return "";
    const label = escape(file.name);
    if (file.purged || file.expiresAt <= Date.now())
      return `<p class="attachment">${label} — expired after 30 days</p>`;
    if (embeddedBytes + file.size > 24 * 1024 * 1024)
      return `<p class="attachment">${label} — download from the private web ticket while available</p>`;
    try {
      const bytes = await attachmentBytes(file);
      embeddedBytes += bytes.length;
      const type = imageTypes.has(file.type)
        ? file.type
        : "application/octet-stream";
      const uri = `data:${type};base64,${bytes.toString("base64")}`;
      return imageTypes.has(file.type)
        ? `<figure><img src="${uri}" alt="${label}"><figcaption>${label}</figcaption></figure>`
        : `<p class="attachment"><a href="${uri}" download="${label}">${label}</a></p>`;
    } catch {
      return `<p class="attachment">${label} — temporarily unavailable; generate another copy from the private ticket</p>`;
    }
  }
  const messages = [];
  for (const message of service.messages(id)) {
    if (message.internal && !staffView) continue;
    const files = [];
    for (const fileId of message.attachments)
      files.push(await attachment(fileId));
    messages.push(
      `<article class="message"><div class="avatar">${escape(message.actor.name?.slice(0, 1))}</div><div><header><strong>${escape(message.actor.name)}</strong>${message.staff ? '<span class="badge">STAFF</span>' : ""}<time>${escape(date(message.at))}</time></header><p>${escape(message.content)}</p>${message.editedAt ? "<small>Edited</small>" : ""}${files.join("")}</div></article>`,
    );
  }
  let resolution = "";
  if (staffView && ticket.resolution) {
    const files = [];
    for (const fileId of ticket.resolution.attachments)
      files.push(await attachment(fileId));
    resolution = `<section><h2>Private staff resolution</h2><p>${escape(ticket.resolution.summary)}</p><h3>Commands run</h3><p>${escape(ticket.resolution.commands)}</p><p>Recorded by ${escape(ticket.resolution.actor.name)} · ${escape(date(ticket.resolution.at))}</p>${files.join("")}</section>`;
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>Drakora ticket · ${escape(ticket.ign)}</title><style>body{margin:0;background:#313338;color:#dbdee1;font:16px/1.5 system-ui,sans-serif}main{max-width:960px;margin:auto;padding:32px 20px}h1,h2,strong{color:#f2f3f5}section{padding:20px;background:#2b2d31;margin-bottom:20px}p{white-space:pre-wrap;overflow-wrap:anywhere}header{display:flex;align-items:center;gap:10px;flex-wrap:wrap}time,small,figcaption{font-size:12px;color:#b5bac1}.message{display:grid;grid-template-columns:40px 1fr;gap:16px;padding:16px 0}.message p{margin:4px 0}.avatar{width:40px;height:40px;background:#1e1f22;border-radius:50%;display:grid;place-items:center}.badge{font-size:10px;background:#b92323;color:white;padding:1px 4px}figure{margin:12px 0}img{max-width:100%;max-height:420px}a{color:#a7c7ff}.history{font-size:13px}</style></head><body><main><h1>Drakora · ${escape(ticket.ign)}</h1><p>${staffView ? "Private staff transcript" : "Player transcript"} · ${escape(id)}</p><section><h2>${escape(ticketTypes.find((type) => type.id === ticket.type)?.name)}</h2><p>${escape(ticket.location)}</p>${ticketDetails(
    ticket,
  )
    .map((detail) => `<p>${escape(detail.label)}: ${escape(detail.value)}</p>`)
    .join(
      "",
    )}<p>${escape(ticket.description)}</p><p>${escape(ticketStatuses[ticket.status])} · Opened ${escape(date(ticket.createdAt))}</p>${ticket.claimedBy ? `<p>Assisted by ${escape(ticket.claimedBy.name)}</p>` : ""}${ticket.rating ? `<p>Optional rating: ${ticket.rating}/5</p>` : ""}</section>${messages.join("")}${resolution}<section class="history"><h2>Ticket history</h2>${history.map((entry) => `<p>${escape(date(entry.at))} · ${escape(entry.actor.name)} · ${escape(entry.detail)}</p>`).join("")}</section><small>Generated ${escape(date(Date.now()))}. Server attachments are retained for 30 days; text and ticket history remain in staff logs.</small></main></body></html>`;
}
