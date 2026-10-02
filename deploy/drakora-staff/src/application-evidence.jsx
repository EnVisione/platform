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

export function EvidenceImages({ images = [], basePath, onRemove, disabled }) {
  return images.length ? (
    <ul className="apply-evidence-images">
      {images.map((image) => (
        <li key={image.id}>
          <a
            href={`${basePath}/${image.id}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            <img
              src={`${basePath}/${image.id}`}
              alt={`Evidence: ${image.name}`}
              loading="lazy"
            />
            <span>{image.name}</span>
          </a>
          <small>{(image.size / 1024 / 1024).toFixed(2)} MB</small>
          {onRemove && (
            <button
              type="button"
              className="apply-link"
              disabled={disabled}
              onClick={() => onRemove(image.id)}
              aria-label={`Remove ${image.name}`}
            >
              Remove image
            </button>
          )}
        </li>
      ))}
    </ul>
  ) : null;
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
