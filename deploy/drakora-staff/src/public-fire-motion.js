export function attachFireMotion(layer, environment = window) {
  const document = environment.document;
  const reducedMotion = environment.matchMedia(
    "(prefers-reduced-motion: reduce)",
  );
  const smoke = Array.from(layer.querySelectorAll(".public-fire-smoke-rise"));
  let frame = 0;
  let x = 0;
  let y = 0;
  let pointerX = 0;
  let pointerY = 0;

  function disperseSmoke() {
    const pushes = smoke.map((cloud) => {
      const bounds = cloud.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return [cloud, 0, 0, 0];
      const dx = bounds.left + bounds.width / 2 - pointerX;
      const dy = bounds.top + bounds.height / 2 - pointerY;
      const distance = Math.hypot(dx, dy);
      const strength = Math.max(0, 1 - distance / 260);
      return [
        cloud,
        (distance ? dx / distance : 1) * strength * 84,
        (distance ? dy / distance : 0) * strength * 84,
        strength * 0.65,
      ];
    });
    for (const [cloud, pushX, pushY, scatter] of pushes) {
      cloud.style.setProperty("--smoke-push-x", `${pushX}px`);
      cloud.style.setProperty("--smoke-push-y", `${pushY}px`);
      cloud.style.setProperty("--smoke-scatter", String(scatter));
    }
  }

  function reset() {
    environment.cancelAnimationFrame(frame);
    frame = 0;
    layer.style.setProperty("--fire-x", "0px");
    layer.style.setProperty("--fire-y", "0px");
    for (const cloud of smoke) {
      cloud.style.setProperty("--smoke-push-x", "0px");
      cloud.style.setProperty("--smoke-push-y", "0px");
      cloud.style.setProperty("--smoke-scatter", "0");
    }
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
      -18,
      Math.min(18, (event.clientX / environment.innerWidth - 0.5) * 36),
    );
    y = Math.max(
      -9,
      Math.min(9, (event.clientY / environment.innerHeight - 0.5) * 18),
    );
    pointerX = event.clientX;
    pointerY = event.clientY;
    if (frame) return;
    frame = environment.requestAnimationFrame(() => {
      frame = 0;
      layer.style.setProperty("--fire-x", `${x}px`);
      layer.style.setProperty("--fire-y", `${y}px`);
      disperseSmoke();
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
