import React from "react";
import "./legal-notice.css";

export function LegalNotice({ application = false }) {
  return (
    <p className="legal-notice">
      {application
        ? "By submitting, you agree to the "
        : "By using Drakora services, including playing on our servers, you agree to the "}
      <a href="/terms" target="_blank" rel="noreferrer">
        Terms of Service
      </a>
      . Read the{" "}
      <a href="/privacy" target="_blank" rel="noreferrer">
        Privacy Policy
      </a>{" "}
      for information about collection, sharing, inactivity deletion and your
      rights. This is not consent to optional tracking. Privacy requests:{" "}
      <a href="mailto:support@drakora.org?subject=Privacy%20request">
        support@drakora.org
      </a>
      , subject Privacy request.
    </p>
  );
}
