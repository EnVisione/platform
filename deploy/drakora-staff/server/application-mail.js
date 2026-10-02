import nodemailer from "nodemailer";
import { connect } from "node:net";
import { hash } from "./store.js";
import { applicationRoles } from "../shared/application-form.js";

const htmlEscape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ],
  );
const stages = {
  received: ["We received your application!", "#0f766e"],
  reviewing: ["Your application is under review", "#4f46e5"],
  approved: ["Welcome to the Drakora team!", "#15803d"],
  denied: ["An update on your application", "#b91c1c"],
};

export function applicationEmail(config, record, event) {
  const [title, color] = stages[event];
  const name = record.answers.displayName;
  const role = applicationRoles[record.role].label;
  const greeting = {
    received: `Thanks for applying, ${name}! Your ${role} application is safely with the Drakora team. We are glad you want to help our community.`,
    reviewing: `Hi ${name}! The team is now taking a closer look at your ${role} application. Thank you for your patience.`,
    approved: `Congratulations, ${name}! Your ${role} application has been approved. We are excited to welcome you to the Drakora team!`,
    denied: `Thank you for applying, ${name}. Your ${role} application was not accepted this time. We appreciate the time you put into it.`,
  }[event];
  const paragraphs = [greeting];
  if (["approved", "denied"].includes(event) && record.decision?.reason)
    paragraphs.push(record.decision.reason);
  if (event === "denied")
    paragraphs.push(
      `You can apply for this role again from ${new Date(record.decision.reapplyAfter).toUTCString()}. Waiting period: ${record.decision.reapplyDays} days. You can explore other teams you are eligible for in the meantime.`,
    );
  else
    paragraphs.push(
      event === "approved"
        ? "The team will reach out to help you get started."
        : "We will email you when there is another update on your application.",
    );
  const url = `${config.applications.publicOrigin}/apply`;
  const reference = `Application reference: ${record.id}`;
  return {
    from: {
      name: "Drakora Staff Applications",
      address: config.applications.smtp.from,
    },
    replyTo: config.applications.smtp.replyTo,
    to: { address: record.contactEmail },
    subject: `Drakora · ${role} · ${title}`,
    messageId: `<application-${hash(`${record.id}:${event}`)}@${config.applications.smtp.from.split("@")[1]}>`,
    text: [
      title,
      ...paragraphs,
      reference,
      `Application page: ${url}`,
      "You chose email updates for this application. You can change your notification preferences on your application receipt in the submitting browser.",
    ].join("\n\n"),
    html: `<!doctype html><html><body style="margin:0;background:#f1f5f9;font-family:Arial,sans-serif;color:#172033"><table role="presentation" style="width:100%;max-width:620px;margin:24px auto;background:#ffffff;border-radius:12px"><tr><td style="padding:28px;border-top:6px solid ${color}"><p style="color:${color};font-weight:bold;letter-spacing:1px">DRAKORA · STAFF APPLICATIONS</p><h1 style="font-size:26px;color:${color}">${htmlEscape(title)}</h1><p style="font-weight:bold">${htmlEscape(role)}</p>${paragraphs.map((paragraph) => `<p style="line-height:1.6;white-space:pre-wrap">${htmlEscape(paragraph)}</p>`).join("")}<p><a href="${htmlEscape(url)}" style="display:inline-block;padding:12px 18px;background:${color};color:#ffffff;border-radius:8px;text-decoration:none">Open application page</a></p><p style="font-size:12px;color:#64748b;overflow-wrap:anywhere">${htmlEscape(reference)}</p><p style="font-size:12px;color:#64748b">You chose email updates for this application. You can change notification preferences on your receipt in the submitting browser.</p></td></tr></table></body></html>`,
    disableFileAccess: true,
    disableUrlAccess: true,
  };
}

export function applicationMail(config) {
  const settings = config.applications.smtp;
  if (!settings) return undefined;
  const transport = nodemailer.createTransport({
    host: "127.0.0.1",
    port: 1025,
    secure: false,
    requireTLS: true,
    tls: { ca: settings.ca, minVersion: "TLSv1.2" },
    auth: { user: settings.user, pass: settings.password },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 30000,
    disableFileAccess: true,
    disableUrlAccess: true,
    getSocket(_options, done) {
      const socket = connect({ path: settings.socketPath });
      const fail = (error) => {
        socket.destroy();
        done(error);
      };
      socket.once("error", fail);
      socket.setTimeout(10000, () =>
        socket.destroy(new Error("SMTP socket timed out")),
      );
      socket.once("connect", () => {
        socket.removeListener("error", fail);
        socket.setTimeout(0);
        done(null, { connection: socket });
      });
    },
  });
  return {
    verify: () => transport.verify(),
    send: (record, event) =>
      transport.sendMail(applicationEmail(config, record, event)),
    close: () => transport.close(),
  };
}
