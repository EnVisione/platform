import React, { useEffect, useRef, useState } from "react";
import { attachFireMotion } from "./public-fire-motion.js";
import dragonSprite from "./assets/flying-dragon-red.png";

function Torch({ x = 0, y = 0 }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <path fill="#211b18" d="M-9 9h18v5H-9z" />
      <path fill="#795039" d="M-3 0h6v24h-6z" />
      <path fill="#b18a58" d="M-6-3H6v7H-6z" />
      <rect
        data-fire-source="torch"
        x="-11"
        y="-45"
        width="22"
        height="42"
        fill="transparent"
      />
    </g>
  );
}

export function BannerTorches() {
  return (
    <div className="public-banner-torches" aria-hidden="true">
      {["left", "right"].map((side) => (
        <svg
          key={side}
          className={`public-banner-torch ${side}`}
          data-fire-container
          viewBox="-16 -60 32 90"
          shapeRendering="crispEdges"
        >
          <Torch />
        </svg>
      ))}
    </div>
  );
}

export function FireScenery({ image, forest = false }) {
  const torches = forest
    ? [
        [366, 300],
        [433, 300],
        [492, 329],
        [544, 329],
      ]
    : [
        [78, 340],
        [160, 340],
        [214, 341],
        [294, 341],
      ];
  const camp = forest ? [310, 398] : [310, 443];
  return (
    <div className="public-welcome-art" data-fire-container aria-hidden="true">
      <svg
        viewBox={forest ? "0 0 900 420" : "0 0 1440 480"}
        preserveAspectRatio="xMinYMid slice"
        shapeRendering="crispEdges"
      >
        <image
          href={image}
          width={forest ? 900 : 1440}
          height={forest ? 420 : 480}
        />
        <g className="public-scene-props">
          {torches.map(([x, y]) => (
            <Torch key={x} x={x} y={y} />
          ))}
          <g transform={`translate(${camp[0]} ${camp[1]})`}>
            <path
              fill="#55514a"
              d="M-30 5h10v6h-10zM-21 11h42v5h-42zM20 5h10v6H20z"
            />
            <path
              fill="#69452f"
              d="M-22-4h10v4h12v4h12v4h10v6H12V10H0V6h-12V2h-10zM12-4h10v6H12v4H0v4h-12v4h-10V8h10V4H0V0h12z"
            />
            <path fill="#af8050" d="M-22-4h6v6h-6zM16-4h6v6h-6z" />
            <rect
              data-fire-source="camp"
              x="-23"
              y="-72"
              width="46"
              height="72"
              fill="transparent"
            />
          </g>
        </g>
      </svg>
    </div>
  );
}

export function AmbientFire({ ready = true, intro = false }) {
  const canvas = useRef(null);
  const dragon = useRef(null);
  const foreground = useRef(null);
  const scenery = useRef(null);
  const motion = useRef(null);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (!ready) return;
    motion.current = attachFireMotion(
      canvas.current,
      dragon.current,
      window,
      undefined,
      foreground.current,
      scenery.current,
      intro,
    );
    return () => {
      motion.current.destroy();
      motion.current = null;
    };
  }, [ready, intro]);
  return (
    <>
      <div className="public-fire" aria-hidden="true">
        <div className="public-fire-fallback" />
        <canvas className="public-fire-canvas" ref={canvas} />
      </div>
      <canvas
        className="public-scenery-fire"
        ref={scenery}
        aria-hidden="true"
      />
      {intro && (
        <div className="public-dragon-flight" aria-hidden="true">
          <canvas
            className="public-fire-canvas public-fire-foreground"
            ref={foreground}
          />
          <div
            className="public-fire-dragon"
            ref={dragon}
            style={{ backgroundImage: `url(${dragonSprite})` }}
          />
        </div>
      )}
      <button
        hidden={!ready}
        type="button"
        className="public-motion-toggle"
        aria-pressed={paused}
        onClick={() => {
          const next = !paused;
          motion.current?.setPaused(next);
          setPaused(next);
        }}
      >
        {paused ? "Resume animation" : "Pause animation"}
      </button>
    </>
  );
}
