import express from "express";
import { readFileSync } from "node:fs";
import { legalVersion } from "../shared/privacy.js";

const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ],
  );
export function legalRouter(config) {
  const router = express.Router();
  const css = readFileSync(
    new URL("./legal/legal.css", import.meta.url),
    "utf8",
  );
  router.get("/legal.css", (_req, res) => res.type("css").send(css));
  for (const page of ["privacy", "terms", "privacy-settings"]) {
    const template = readFileSync(
      new URL(`./legal/${page}.html`, import.meta.url),
      "utf8",
    );
    router.get(`/${page}`, (_req, res) => {
      if (
        !config.privacy?.published ||
        !config.privacy.retentionEnabled ||
        !config.privacy.controllerName
      )
        return res
          .status(503)
          .send(
            "Legal documents are being prepared. Contact support@drakora.org for privacy information.",
          );
      res
        .set("Cache-Control", "no-store")
        .type("html")
        .send(
          template
            .replaceAll(
              "{{operatorName}}",
              escape(config.privacy.controllerName),
            )
            .replaceAll("{{version}}", legalVersion),
        );
    });
  }
  return router;
}
