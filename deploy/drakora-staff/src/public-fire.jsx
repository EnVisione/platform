import React, { useEffect, useRef } from "react";
import { attachFireMotion } from "./public-fire-motion.js";

const embers = Array.from({ length: 36 }, (_, index) => ({
  left: `${(index * 37 + 11) % 100}%`,
  size: `${2 + (index % 4)}px`,
  duration: `${12 + (index % 7) * 1.5}s`,
  delay: `${-index * 1.3}s`,
  color: index % 3 === 0 ? "#e4ae67" : "#d36538",
}));
const smoke = [
  ["-3%", "7%", 240, 18, -4],
  ["8%", "15%", 180, 16, -9],
  ["23%", "2%", 280, 22, -13],
  ["67%", "1%", 260, 20, -7],
  ["85%", "12%", 200, 17, -12],
  ["95%", "6%", 260, 21, -16],
  ["-4%", "50%", 200, 19, -11],
  ["94%", "52%", 220, 23, -18],
];

export function AmbientFire() {
  const layer = useRef(null);
  useEffect(() => attachFireMotion(layer.current), []);
  return (
    <div className="public-fire" ref={layer} aria-hidden="true">
      <div className="public-fire-drift">
        {smoke.map(([left, bottom, size, duration, delay], index) => (
          <div
            key={index}
            className={`public-fire-smoke smoke-${index}`}
            style={{
              "--smoke-x": left,
              "--smoke-bottom": bottom,
              "--smoke-size": `${size}px`,
              "--smoke-duration": `${duration}s`,
              "--smoke-delay": `${delay}s`,
            }}
          >
            <div className="public-fire-smoke-rise">
              <div className="public-fire-smoke-push">
                <svg
                  className="public-fire-smoke-cloud"
                  viewBox="0 0 80 100"
                  focusable="false"
                  shapeRendering="crispEdges"
                >
                  <path
                    fill="#7d756f"
                    d="M20 100V88H12V76H4V56H12V44H4V28H16V12H28V4H48V12H64V24H76V44H68V52H76V72H64V84H56V100Z"
                  />
                  <path
                    fill="#a29486"
                    opacity=".35"
                    d="M28 92V76H16V56H24V44H16V28H28V16H48V24H60V40H52V52H64V68H52V80H44V92Z"
                  />
                  <path
                    fill="#46413e"
                    opacity=".5"
                    d="M12 56H28V68H40V80H32V100H20V88H12V76H4V64H12ZM40 12H64V24H76V44H60V32H40Z"
                  />
                </svg>
              </div>
            </div>
          </div>
        ))}
        <div className="public-fire-embers">
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
        </div>
        {[0, 1, 2, 3, 4, 5].map((index) => (
          <svg
            key={index}
            className={`public-fire-flame flame-${index}`}
            viewBox="0 0 24 32"
            shapeRendering="crispEdges"
            focusable="false"
          >
            <g className="public-fire-tongue tongue-outer">
              <path
                fill="#b5462c"
                d="M4 32V24H2V16H6V20H8V12H10V4H14V0H16V8H18V16H20V12H22V24H20V32Z"
              />
            </g>
            <g className="public-fire-tongue tongue-inner">
              <path
                fill="#e18a40"
                d="M8 32V24H6V20H10V24H12V14H16V22H18V28H16V32Z"
              />
            </g>
            <g className="public-fire-tongue tongue-core">
              <path fill="#f0c581" d="M10 32V26H12V22H14V28H16V32Z" />
            </g>
          </svg>
        ))}
      </div>
    </div>
  );
}
