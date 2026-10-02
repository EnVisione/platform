import React from "react";
import { parseEvidenceLinks } from "../shared/application-form.js";

export function RequiredMark() {
  return (
    <>
      <span className="apply-required" aria-hidden="true">
        {" "}
        *
      </span>
      <span className="sr-only"> (required)</span>
    </>
  );
}

export function EvidenceLinks({ value }) {
  const { links } = parseEvidenceLinks(value);
  return links.length ? (
    <ul className="apply-evidence-links">
      {links.map((url, index) => (
        <li key={index}>
          <a href={url} target="_blank" rel="noopener noreferrer">
            {url}
          </a>
        </li>
      ))}
    </ul>
  ) : null;
}
