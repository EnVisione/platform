import { createFireRenderer } from "./public-fire-renderer.js";

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const smooth = (start, end, time) => {
  const value = clamp((time - start) / (end - start), 0, 1);
  return value * value * (3 - 2 * value);
};

export function fireScene(time, width, height, intro = true, sources = []) {
  const size = 480;
  const flight = clamp(time / 7.8, 0, 1);
  const x = -size + (width + size * 2) * flight;
  const visible = sources.filter(
    (source) =>
      source.y > 0 && source.y < height && source.x > 0 && source.x < width,
  );
  const highest = visible.length
    ? Math.max(...visible.map((source) => source.y))
    : height * 0.35;
  const y = clamp(
    highest + size * 0.42 + Math.sin(flight * Math.PI * 3) * 30,
    size * 0.5,
    height - size * 0.2,
  );
  const frame = Math.floor(time / 0.15) % 3;
  const roll = Math.cos(flight * Math.PI * 3) * 8;
  const angle = (roll * Math.PI) / 180;
  const mouthX = size * 0.34;
  const mouthY = size * (frame === 2 ? 0.05 : 0.1);
  const breathX = x + Math.cos(angle) * mouthX - Math.sin(angle) * mouthY;
  const breathY = y - Math.sin(angle) * mouthX - Math.cos(angle) * mouthY;
  const fires = sources.map((source) => {
    const hit = ((source.x + size - mouthX) / (width + size * 2)) * 7.8;
    return { ...source, lit: intro ? smooth(hit, hit + 0.3, time) : 1 };
  });
  const aim = visible
    .filter(
      (source) => source.y < breathY && Math.abs(source.x - breathX) < 160,
    )
    .sort((a, b) => Math.abs(a.x - breathX) - Math.abs(b.x - breathX))[0];
  const intensity = intro
    ? smooth(0.4, 0.8, time) * (1 - smooth(6.8, 7.5, time))
    : 0;
  return {
    dragon: {
      x,
      y,
      size,
      roll,
      direction: 1,
      frame,
      opacity: intro ? smooth(0, 0.3, time) * (1 - smooth(7.4, 8, time)) : 0,
    },
    breath: [breathX, breathY, intensity],
    breathTarget: aim
      ? [aim.x, aim.y]
      : [
          breathX + size * 0.16,
          Math.max(0, breathY - Math.min(height * 0.65, 480)),
        ],
    fires,
  };
}

export function attachFireMotion(
  canvas,
  dragon,
  environment = window,
  rendererFactory = createFireRenderer,
  foregroundCanvas = null,
  sceneryCanvas = null,
) {
  const document = environment.document;
  const reducedMotion = environment.matchMedia(
    "(prefers-reduced-motion: reduce)",
  );
  const mobile = environment.matchMedia("(max-width: 900px)");
  const layer = canvas.parentElement;
  let renderer = null;
  let foreground = null;
  let scenery = null;
  let viewWidth = environment.innerWidth,
    viewHeight = environment.innerHeight;
  let foregroundDone = false;
  let sources = [];
  let boundsDirty = true;
  const elements = [
    ...(document.querySelectorAll?.("[data-fire-source]") ?? []),
  ].slice(0, 12);
  function measureSources() {
    sources = elements.map((element) => {
      const rect = element.getBoundingClientRect();
      const art = element
        .closest("[data-fire-container]")
        .getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2,
        y: viewHeight - rect.bottom,
        width: rect.width / 2,
        fixed: element.dataset?.fireFixed === "true",
        height: rect.height,
        bounds: [
          art.left,
          viewHeight - art.bottom,
          art.right,
          viewHeight - art.top,
        ],
      };
    });
    boundsDirty = false;
  }
  function scroll() {
    boundsDirty = true;
  }
  let frame = 0;
  let previous = null;
  let time = 0;
  let paused = false;
  let destroyed = false;
  let contextLost = false;
  let unavailable = false;
  let intro = !reducedMotion.matches && !mobile.matches;
  let pointer = { x: -1000, y: -1000, dx: 0, dy: 0 };

  function resetPointer() {
    pointer = { x: -1000, y: -1000, dx: 0, dy: 0 };
  }

  function resize() {
    try {
      const viewport = canvas.getBoundingClientRect?.();
      viewWidth = viewport?.width || environment.innerWidth;
      viewHeight = viewport?.height || environment.innerHeight;
      renderer?.resize(viewWidth, viewHeight);
      foreground?.resize(viewWidth, viewHeight);
      if (scenery) {
        const bounds = sceneryCanvas.getBoundingClientRect();
        scenery.resize(bounds.width, bounds.height);
      }
      boundsDirty = true;
    } catch (error) {
      console.warn(
        "Background animation could not resize; using a still background.",
        error.message,
      );
      renderer?.destroy();
      foreground?.destroy();
      scenery?.destroy();
      renderer = foreground = scenery = null;
      foregroundCanvas?.style.setProperty("visibility", "hidden");
      sceneryCanvas?.style.setProperty("visibility", "hidden");
      unavailable = true;
      stop();
      layer.classList.remove("has-webgl");
      dragon.style.opacity = "0";
    }
    resetPointer();
  }

  function initialize() {
    if (renderer || contextLost || unavailable) return;
    renderer = rendererFactory(canvas);
    if (renderer && foregroundCanvas)
      foreground = rendererFactory(foregroundCanvas, { foreground: true });
    if (renderer && sceneryCanvas)
      scenery = rendererFactory(sceneryCanvas, { scenery: true });
    foregroundDone = false;
    unavailable = !renderer;
    layer.classList.toggle("has-webgl", Boolean(renderer));
    resize();
  }

  function stop() {
    environment.cancelAnimationFrame(frame);
    frame = 0;
    previous = null;
  }

  function render(now) {
    frame = 0;
    if (
      destroyed ||
      paused ||
      document.hidden ||
      reducedMotion.matches ||
      mobile.matches
    )
      return;
    const interval = 1000 / 30;
    if (previous === null || now - previous >= interval - 1) {
      const elapsed = previous === null ? 0 : (now - previous) / 1000;
      const delta = Math.min(elapsed, 0.05);
      previous = now;
      time += elapsed;
      if (boundsDirty) measureSources();
      const scene = fireScene(time, viewWidth, viewHeight, intro, sources);
      renderer.render(delta, time, pointer, scene);
      if (scenery) {
        const bounds = sceneryCanvas.getBoundingClientRect();
        const offset = bounds.height - viewHeight + bounds.top;
        const local = {
          ...scene,
          fires: scene.fires.map((source) => ({
            ...source,
            x: source.x - bounds.left,
            y: source.y + offset,
            bounds: [
              source.bounds[0] - bounds.left,
              source.bounds[1] + offset,
              source.bounds[2] - bounds.left,
              source.bounds[3] + offset,
            ],
          })),
        };
        scenery.render(delta, time, pointer, local);
      }
      if (!foregroundDone) {
        foreground?.render(delta, time, pointer, scene);
        foregroundDone = time >= 8;
      }
      const sprite = scene.dragon;
      if (time <= 8 || dragon.style.opacity !== "0") {
        dragon.style.transform = `translate(${sprite.x - sprite.size / 2}px, ${environment.innerHeight - sprite.y - (sprite.size * 128) / 144 / 2}px) rotate(${sprite.roll}deg)`;
        dragon.style.width = `${sprite.size}px`;
        dragon.style.height = `${(sprite.size * 128) / 144}px`;
        dragon.style.backgroundSize = `${sprite.size * 3}px ${((sprite.size * 128) / 144) * 4}px`;
        dragon.style.backgroundPosition = `${-sprite.frame * sprite.size}px ${((-sprite.size * 128) / 144) * sprite.direction}px`;
        dragon.style.opacity = String(sprite.opacity);
      }
      const decay = Math.exp(-delta * 6);
      pointer.dx *= decay;
      pointer.dy *= decay;
    }
    frame = environment.requestAnimationFrame(render);
  }

  function synchronize() {
    if (destroyed) return;
    const disabled = reducedMotion.matches || mobile.matches;
    const inactive = paused || document.hidden || disabled;
    layer.classList.toggle("is-paused", inactive);
    if (inactive) {
      stop();
      resetPointer();
      if (disabled) {
        intro = false;
        renderer?.destroy();
        foreground?.destroy();
        scenery?.destroy();
        renderer = foreground = scenery = null;
        layer.classList.remove("has-webgl");
        foregroundCanvas?.style.setProperty("visibility", "hidden");
        sceneryCanvas?.style.setProperty("visibility", "hidden");
        dragon.style.opacity = "0";
      }
      return;
    }
    foregroundCanvas?.style.removeProperty("visibility");
    sceneryCanvas?.style.removeProperty("visibility");
    initialize();
    if (renderer && !frame) frame = environment.requestAnimationFrame(render);
  }

  function move(event) {
    if (
      event.pointerType !== "mouse" ||
      paused ||
      document.hidden ||
      reducedMotion.matches ||
      mobile.matches
    )
      return;
    const x = clamp(event.clientX, 0, viewWidth);
    const y = viewHeight - clamp(event.clientY, 0, viewHeight);
    if (pointer.x >= 0) {
      pointer.dx = clamp((x - pointer.x) * 2, -110, 110);
      pointer.dy = clamp((y - pointer.y) * 2, -110, 110);
    }
    pointer.x = x;
    pointer.y = y;
  }

  function leave(event) {
    if (event.relatedTarget === null) resetPointer();
  }

  function lost(event) {
    event.preventDefault();
    contextLost = true;
    stop();
    renderer?.destroy();
    foreground?.destroy();
    scenery?.destroy();
    renderer = foreground = scenery = null;
    foregroundCanvas?.style.setProperty("visibility", "hidden");
    sceneryCanvas?.style.setProperty("visibility", "hidden");
    layer.classList.remove("has-webgl");
    dragon.style.opacity = "0";
  }

  function restored() {
    contextLost = false;
    unavailable = false;
    intro = false;
    synchronize();
  }

  const layout = environment.ResizeObserver
    ? new environment.ResizeObserver(resize)
    : null;
  for (const element of document.querySelectorAll?.(".public-site") ?? [])
    layout?.observe(element);

  environment.addEventListener("pointermove", move, { passive: true });
  environment.addEventListener("pointerout", leave);
  environment.addEventListener("blur", resetPointer);
  environment.addEventListener("resize", resize);
  environment.addEventListener("scroll", scroll, { passive: true });
  document.addEventListener("visibilitychange", synchronize);
  reducedMotion.addEventListener("change", synchronize);
  mobile.addEventListener("change", synchronize);
  canvas.addEventListener("webglcontextlost", lost);
  canvas.addEventListener("webglcontextrestored", restored);
  foregroundCanvas?.addEventListener("webglcontextlost", lost);
  foregroundCanvas?.addEventListener("webglcontextrestored", restored);
  sceneryCanvas?.addEventListener("webglcontextlost", lost);
  sceneryCanvas?.addEventListener("webglcontextrestored", restored);
  synchronize();
  return {
    setPaused(value) {
      paused = Boolean(value);
      synchronize();
    },
    destroy() {
      destroyed = true;
      layout?.disconnect();
      stop();
      renderer?.destroy();
      foreground?.destroy();
      scenery?.destroy();
      renderer = foreground = scenery = null;
      dragon.style.opacity = "0";
      environment.removeEventListener("pointermove", move);
      environment.removeEventListener("pointerout", leave);
      environment.removeEventListener("blur", resetPointer);
      environment.removeEventListener("resize", resize);
      environment.removeEventListener("scroll", scroll);
      document.removeEventListener("visibilitychange", synchronize);
      reducedMotion.removeEventListener("change", synchronize);
      mobile.removeEventListener("change", synchronize);
      canvas.removeEventListener("webglcontextlost", lost);
      canvas.removeEventListener("webglcontextrestored", restored);
      foregroundCanvas?.removeEventListener("webglcontextlost", lost);
      foregroundCanvas?.removeEventListener("webglcontextrestored", restored);
      sceneryCanvas?.removeEventListener("webglcontextlost", lost);
      sceneryCanvas?.removeEventListener("webglcontextrestored", restored);
    },
  };
}
