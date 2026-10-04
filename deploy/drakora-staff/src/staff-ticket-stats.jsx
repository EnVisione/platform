import React from "react";

export function StaffTicketStats({ stats }) {
  if (!stats) return null;
  const average = stats.averageRating;
  return (
    <div className="staff-ticket-stats" aria-label="Support overview">
      <div
        className="staff-rating"
        aria-label={
          average === null
            ? "No ratings yet"
            : `${average.toFixed(1)} out of 5 stars, ${stats.reviewCount} reviews`
        }
      >
        <div className="staff-stars" aria-hidden="true">
          <span>★★★★★</span>
          <span
            className="staff-stars-filled"
            style={{ width: `${(average || 0) * 20}%` }}
          >
            ★★★★★
          </span>
        </div>
        <span>
          {average === null
            ? "No ratings yet"
            : `${average.toFixed(1)} / 5 · ${stats.reviewCount} ${stats.reviewCount === 1 ? "review" : "reviews"}`}
        </span>
      </div>
      <div>
        <strong>{stats.ticketsResolved}</strong>
        <span>Tickets resolved</span>
      </div>
      <div>
        <strong>{stats.activeTickets}</strong>
        <span>Active tickets</span>
      </div>
    </div>
  );
}
