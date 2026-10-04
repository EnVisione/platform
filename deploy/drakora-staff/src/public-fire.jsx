import React, { useEffect, useRef, useState } from "react";
import { attachFireMotion } from "./public-fire-motion.js";
import dragonSprite from "./assets/flying-dragon-red.png";

export function AmbientFire({ ready = true }) {
  const canvas = useRef(null);
  const dragon = useRef(null);
  const foreground = useRef(null);
  const words = useRef(null);
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
      words.current,
    );
    return () => {
      motion.current.destroy();
      motion.current = null;
    };
  }, [ready]);
  return (
    <>
      <div className="public-fire" aria-hidden="true">
        <div className="public-fire-fallback" />
        <canvas className="public-fire-canvas" ref={canvas} />
      </div>
      <div className="public-word-fire" aria-hidden="true">
        <canvas className="public-fire-canvas" ref={words} />
      </div>
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
