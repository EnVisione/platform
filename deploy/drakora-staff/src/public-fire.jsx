import React, { useEffect, useRef } from "react";
import { attachFireMotion } from "./public-fire-motion.js";

const embers = Array.from({ length: 24 }, (_, index) => ({
  left: `${(index * 37 + 11) % 100}%`,
  size: `${2 + (index % 3)}px`,
  duration: `${20 + (index % 7) * 2}s`,
  delay: `${-index * 1.7}s`,
  color: index % 3 === 0 ? "#c39463" : "#ad503c",
}));

export function AmbientFire() {
  const layer = useRef(null);
  useEffect(() => attachFireMotion(layer.current), []);
  return (
    <div className="public-fire" ref={layer} aria-hidden="true">
      <div className="public-fire-drift">
        {embers.map((ember, index) => (
          <span
            key={index}
            className="public-fire-ember"
            style={{
              "--ember-x": ember.left,
              "--ember-size": ember.size,
              "--ember-duration": ember.duration,
              "--ember-delay": ember.delay,
              "--ember-color": ember.color,
            }}
          />
        ))}
        {[0, 1, 2, 3].map((index) => (
          <svg
            key={index}
            className={`public-fire-flame flame-${index}`}
            viewBox="0 0 24 32"
            shapeRendering="crispEdges"
            focusable="false"
          >
            <path
              fill="#853c2f"
              d="M4 32V24H2V16H6V20H8V12H10V4H14V0H16V8H18V16H20V12H22V24H20V32Z"
            />
            <path
              fill="#b55d3c"
              d="M8 32V24H6V20H10V24H12V14H16V22H18V28H16V32Z"
            />
            <path fill="#c69a67" d="M10 32V26H12V22H14V28H16V32Z" />
          </svg>
        ))}
      </div>
    </div>
  );
}
