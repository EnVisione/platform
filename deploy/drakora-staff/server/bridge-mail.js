import nodemailer from "nodemailer";
import { connect } from "node:net";

export function bridgeMailTransport(settings) {
  return nodemailer.createTransport({
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
}
