import React from "react";

const paths = {
  home: "M12 2 1 11h3v11h6v-7h4v7h6V11h3z",
  servers: "M3 2h18v6H3zM3 10h18v6H3zM3 18h18v4H3zM6 4v2h2V4zM6 12v2h2v-2z",
  store: "M7 7V6a5 5 0 0 1 10 0v1h4l1 15H2L3 7zm3 0h4V6a2 2 0 0 0-4 0z",
  rules:
    "m14 2 8 8-3 3-8-8zm-5 5 8 8-3 3-8-8zM2 17l8-8 3 3-8 8zM12 20h10v3H12z",
  apply: "M4 2h11l5 5v15H4zm10 2v5h4zM7 12v2h10v-2zM7 17v2h7v-2z",
  help: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-1 14h2v3h-2zm-3-7c0-3 2-4 4-4s4 1 4 4c0 2-3 3-3 5h-2c0-3 3-3 3-5 0-1-1-2-2-2s-2 1-2 2z",
  crest: "M12 2 3 5v6c0 5 4 9 9 11 5-2 9-6 9-11V5zm0 4v12c-3-2-5-4-5-7V8z",
  news: "M2 3h20v18H2zm3 3v6h6V6zm9 0v2h5V6zm0 4v2h5v-2zM5 15v2h14v-2z",
  users:
    "M8 2a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm10 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM1 14c0-2 3-3 7-3s7 1 7 3v7H1zm15-2c3 0 7 1 7 3v6h-6v-7z",
  ticket:
    "M2 5h20v5a2 2 0 0 0 0 4v5H2v-5a2 2 0 0 0 0-4zm12 3v2h2V8zm0 5v3h2v-3z",
  play: "M6 3v18l16-9z",
  menu: "M3 4h18v3H3zm0 7h18v3H3zm0 7h18v3H3z",
  arrow: "M3 10h11V5l7 7-7 7v-5H3z",
  back: "M21 10H10V5l-7 7 7 7v-5h11z",
  external: "M13 3h8v8h-3V8l-9 9-2-2 9-9h-3zM3 5h7v3H6v10h10v-4h3v7H3z",
  download: "M10 2h4v9h4l-6 6-6-6h4zM3 18h3v3h12v-3h3v6H3z",
  copy: "M2 2h14v3H5v11H2zm5 5h15v15H7zm3 3v9h9v-9z",
  check: "m9 17-6-6 3-3 3 3 9-9 3 3z",
  info: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-1 3h2v3h-2zm0 5h2v9h-2z",
  discord:
    "M19.7 5.2a18 18 0 0 0-4.5-1.4l-.6 1.2a16.6 16.6 0 0 0-5.2 0l-.6-1.2a18 18 0 0 0-4.5 1.4C1.5 9.3.7 13.3 1.1 17.2a18 18 0 0 0 5.5 2.8l1.1-1.8-1.7-.8.4-.3a12.9 12.9 0 0 0 11.2 0l.4.3-1.7.8 1.1 1.8a18 18 0 0 0 5.5-2.8c.5-4.5-.8-8.4-3.2-12ZM8.6 14.9c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2Zm6.8 0c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2Z",
};

export function PublicIcon({ name }) {
  return (
    <svg
      className="public-icon"
      viewBox="0 0 24 24"
      fill="currentColor"
      fillRule="evenodd"
      aria-hidden="true"
      focusable="false"
    >
      <path d={paths[name]} />
    </svg>
  );
}

export function PublicHeading({ as: Tag = "h2", icon, children, id }) {
  return (
    <Tag className="public-heading" id={id}>
      <PublicIcon name={icon} />
      <span>{children}</span>
    </Tag>
  );
}
