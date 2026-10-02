import React from "react";
import { applicationStatuses } from "../shared/application-form.js";

export function ApplicationStatus({ status }) {
  const tone = Object.hasOwn(applicationStatuses, status)
    ? status.toLowerCase()
    : "received";
  return (
    <span className={`application-status application-status-${tone}`}>
      {applicationStatuses[status] || status}
    </span>
  );
}
