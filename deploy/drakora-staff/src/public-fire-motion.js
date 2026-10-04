import { createFireRenderer } from "./public-fire-renderer.js";

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const smooth = (start, end, time) => {
  const value = clamp((time - start) / (end - start), 0, 1);
  return value * value * (3 - 2 * value);
};

export function fireScene(time, width, height, intro = true, targets = []) {
  const source = Math.min(46, width * 0.08);
  const size = width < 700 ? 280 : 480;
  const flight = clamp(time / 7.8, 0, 1);
  const x = -size + (width + size * 2) * flight;
  const y =
    height * 0.68 + Math.sin(flight * Math.PI * 3) * Math.min(75, height * 0.1);
  const frame = Math.floor(time / 0.15) % 3;
  const roll = Math.cos(flight * Math.PI * 3) * 8;
  const angle = (roll * Math.PI) / 180;
  const mouthX = size * 0.34;
  const mouthY = size * (frame === 2 ? 0.05 : 0.1);
  const breathX = x + Math.cos(angle) * mouthX - Math.sin(angle) * mouthY;
  const breathY = y - Math.sin(angle) * mouthX - Math.cos(angle) * mouthY;
  const burning = targets.map((target, index) => {
    const hit = ((target.x + size) / (width + size * 2)) * 7.8 - 0.4;
    const lit = intro ? smooth(hit, hit + 0.35, time) : 0;
    return {
      ...target,
      lit,
      fall: lit * smooth(hit + 0.15, hit + 1.1, time),
      tilt: index % 2 ? -2.5 : 2,
    };
  });
  const intensity = intro
    ? smooth(0.4, 0.8, time) * (1 - smooth(6.8, 7.5, time))
    : 0;
  return {
    source,
    ignition: intro ? [smooth(1.1, 1.8, time), smooth(6.2, 6.9, time)] : [1, 1],
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
    breathTarget: [
      breathX + size * 0.16,
      Math.max(0, breathY - Math.min(height * 0.65, 480)),
    ],
    burning,
  };
}

export function attachFireMotion(
  canvas,
  dragon,
  environment = window,
  rendererFactory = createFireRenderer,
  foregroundCanvas = null,
  wordCanvas = null,
) {
  const document = environment.document;
  const reducedMotion = environment.matchMedia(
    "(prefers-reduced-motion: reduce)",
  );
  const layer = canvas.parentElement;
  let renderer = null;
  let foreground = null;
  let words = null;
  let foregroundDone = false;
  let scorchDone = false;
  let targets = [];
  let boundsDirty = true;
  const elements = [
    ...(document.querySelectorAll?.(
      ".public-welcome h1 > span, .public-home-help h2 > span, .public-discord strong, #partnership-title > span",
    ) ?? []),
  ].slice(0, 4);
  const metrics = elements.length
    ? document.createElement("canvas").getContext("2d")
    : null;
  function measureTargets() {
    const transforms = elements.map((element) => element.style.transform);
    for (const element of elements) element.style.transform = "none";
    targets = elements.map((element, index) => {
      const rect = element.getBoundingClientRect();
      const glyphs = [];
      const walker = document.createTreeWalker(element, 4);
      if (metrics) metrics.font = environment.getComputedStyle(element).font;
      let node;
      while ((node = walker.nextNode())) {
        for (let offset = 0; offset < node.textContent.length; offset++) {
          const letter = node.textContent[offset];
          if (!letter.trim()) continue;
          const range = document.createRange();
          range.setStart(node, offset);
          range.setEnd(node, offset + 1);
          const box = range.getBoundingClientRect();
          const font = metrics?.measureText(letter) ?? {};
          const baseline =
            box.top + (font.fontBoundingBoxAscent ?? box.height * 0.8);
          glyphs.push({
            x: box.left + box.width / 2,
            y:
              environment.innerHeight -
              baseline +
              (font.actualBoundingBoxAscent ?? box.height * 0.7) -
              12,
          });
        }
      }
      return {
        index,
        x: rect.left + rect.width / 2,
        y: environment.innerHeight - rect.top,
        spots: [0.18, 0.53, 0.86]
          .map((fraction) => glyphs[Math.floor((glyphs.length - 1) * fraction)])
          .filter(Boolean),
      };
    });
    elements.forEach((element, index) => {
      if (transforms[index]) element.style.transform = transforms[index];
      else element.style.removeProperty("transform");
    });
    targets.sort((a, b) => a.x - b.x);
    boundsDirty = false;
  }
  function clearScorch() {
    boundsDirty = true;
    for (const element of elements) {
      element.classList.remove("public-scorched");
      element.style.removeProperty("--scorch-fall");
      element.style.removeProperty("--scorch-tilt");
    }
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
  let intro = !reducedMotion.matches;
  let pointer = { x: -1000, y: -1000, dx: 0, dy: 0 };

  function resetPointer() {
    pointer = { x: -1000, y: -1000, dx: 0, dy: 0 };
  }

  function resize() {
    try {
      renderer?.resize(environment.innerWidth, environment.innerHeight);
      foreground?.resize(environment.innerWidth, environment.innerHeight);
      words?.resize(environment.innerWidth, environment.innerHeight);
      boundsDirty = true;
    } catch (error) {
      console.warn(
        "Background animation could not resize; using a still background.",
        error.message,
      );
      renderer?.destroy();
      foreground?.destroy();
      words?.destroy();
      renderer = foreground = words = null;
      clearScorch();
      foregroundCanvas?.style.setProperty("visibility", "hidden");
      wordCanvas?.style.setProperty("visibility", "hidden");
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
    if (renderer && wordCanvas)
      words = rendererFactory(wordCanvas, { foreground: true, words: true });
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
    if (destroyed || paused || document.hidden || reducedMotion.matches) return;
    const interval = environment.innerWidth < 700 ? 1000 / 24 : 1000 / 30;
    if (previous === null || now - previous >= interval - 1) {
      const elapsed = previous === null ? 0 : (now - previous) / 1000;
      const delta = Math.min(elapsed, 0.05);
      previous = now;
      time += elapsed;
      if (boundsDirty) measureTargets();
      const scene = fireScene(
        time,
        environment.innerWidth,
        environment.innerHeight,
        intro,
        targets,
      );
      renderer.render(delta, time, pointer, scene);
      words?.render(delta, time, pointer, scene);
      if (!foregroundDone) {
        foreground?.render(delta, time, pointer, scene);
        foregroundDone = time >= 8;
      }
      if (intro && !scorchDone) {
        scene.burning.forEach((target) => {
          const index = target.index;
          elements[index].classList.toggle("public-scorched", target.lit > 0);
          elements[index].style.setProperty(
            "--scorch-fall",
            `${target.fall * 9}px`,
          );
          elements[index].style.setProperty(
            "--scorch-tilt",
            `${target.fall * target.tilt}deg`,
          );
        });
        scorchDone = time >= 8;
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
    const inactive = paused || document.hidden || reducedMotion.matches;
    layer.classList.toggle("is-paused", inactive);
    if (inactive) {
      stop();
      resetPointer();
      if (reducedMotion.matches) {
        intro = false;
        clearScorch();
        foregroundCanvas?.style.setProperty("visibility", "hidden");
        wordCanvas?.style.setProperty("visibility", "hidden");
        dragon.style.opacity = "0";
      }
      return;
    }
    foregroundCanvas?.style.removeProperty("visibility");
    wordCanvas?.style.removeProperty("visibility");
    initialize();
    if (renderer && !frame) frame = environment.requestAnimationFrame(render);
  }

  function move(event) {
    if (
      event.pointerType !== "mouse" ||
      paused ||
      document.hidden ||
      reducedMotion.matches
    )
      return;
    const x = clamp(event.clientX, 0, environment.innerWidth);
    const y =
      environment.innerHeight -
      clamp(event.clientY, 0, environment.innerHeight);
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
    words?.destroy();
    renderer = foreground = words = null;
    clearScorch();
    foregroundCanvas?.style.setProperty("visibility", "hidden");
    wordCanvas?.style.setProperty("visibility", "hidden");
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
    ? new environment.ResizeObserver(scroll)
    : null;
  for (const element of document.querySelectorAll?.(
    ".public-header, .public-content",
  ) ?? [])
    layout?.observe(element);

  environment.addEventListener("pointermove", move, { passive: true });
  environment.addEventListener("pointerout", leave);
  environment.addEventListener("blur", resetPointer);
  environment.addEventListener("resize", resize);
  environment.addEventListener("scroll", scroll, { passive: true });
  document.addEventListener("visibilitychange", synchronize);
  reducedMotion.addEventListener("change", synchronize);
  canvas.addEventListener("webglcontextlost", lost);
  canvas.addEventListener("webglcontextrestored", restored);
  foregroundCanvas?.addEventListener("webglcontextlost", lost);
  foregroundCanvas?.addEventListener("webglcontextrestored", restored);
  wordCanvas?.addEventListener("webglcontextlost", lost);
  wordCanvas?.addEventListener("webglcontextrestored", restored);
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
      words?.destroy();
      renderer = foreground = words = null;
      clearScorch();
      dragon.style.opacity = "0";
      environment.removeEventListener("pointermove", move);
      environment.removeEventListener("pointerout", leave);
      environment.removeEventListener("blur", resetPointer);
      environment.removeEventListener("resize", resize);
      environment.removeEventListener("scroll", scroll);
      document.removeEventListener("visibilitychange", synchronize);
      reducedMotion.removeEventListener("change", synchronize);
      canvas.removeEventListener("webglcontextlost", lost);
      canvas.removeEventListener("webglcontextrestored", restored);
      foregroundCanvas?.removeEventListener("webglcontextlost", lost);
      foregroundCanvas?.removeEventListener("webglcontextrestored", restored);
      wordCanvas?.removeEventListener("webglcontextlost", lost);
      wordCanvas?.removeEventListener("webglcontextrestored", restored);
    },
  };
}
