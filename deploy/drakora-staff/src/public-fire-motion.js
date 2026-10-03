export function attachFireMotion(layer, environment = window) {
  const document = environment.document;
  const reducedMotion = environment.matchMedia(
    "(prefers-reduced-motion: reduce)",
  );
  let frame = 0;
  let x = 0;
  let y = 0;

  function reset() {
    environment.cancelAnimationFrame(frame);
    frame = 0;
    layer.style.setProperty("--fire-x", "0px");
    layer.style.setProperty("--fire-y", "0px");
  }

  function synchronize() {
    const paused = document.hidden || reducedMotion.matches;
    layer.classList.toggle("is-paused", paused);
    if (paused) reset();
  }

  function move(event) {
    if (
      event.pointerType !== "mouse" ||
      document.hidden ||
      reducedMotion.matches
    ) {
      return;
    }
    x = Math.max(
      -12,
      Math.min(12, (event.clientX / environment.innerWidth - 0.5) * 24),
    );
    y = Math.max(
      -6,
      Math.min(6, (event.clientY / environment.innerHeight - 0.5) * 12),
    );
    if (frame) return;
    frame = environment.requestAnimationFrame(() => {
      frame = 0;
      layer.style.setProperty("--fire-x", `${x}px`);
      layer.style.setProperty("--fire-y", `${y}px`);
    });
  }

  function leave(event) {
    if (event.relatedTarget === null) reset();
  }

  synchronize();
  environment.addEventListener("pointermove", move, { passive: true });
  environment.addEventListener("pointerout", leave);
  environment.addEventListener("blur", reset);
  environment.addEventListener("resize", reset);
  document.addEventListener("visibilitychange", synchronize);
  reducedMotion.addEventListener("change", synchronize);
  return () => {
    reset();
    environment.removeEventListener("pointermove", move);
    environment.removeEventListener("pointerout", leave);
    environment.removeEventListener("blur", reset);
    environment.removeEventListener("resize", reset);
    document.removeEventListener("visibilitychange", synchronize);
    reducedMotion.removeEventListener("change", synchronize);
  };
}
