import test from "node:test";
import assert from "node:assert/strict";
import { attachFireMotion, fireScene } from "../src/public-fire-motion.js";
import { fireResolution } from "../src/public-fire-renderer.js";

function fixture({
  reduced = false,
  available = true,
  foreground = false,
  mobile = false,
  scenery = false,
  scrollbar = 0,
  intro = true,
} = {}) {
  const environment = new EventTarget();
  const document = new EventTarget();
  const preference = new EventTarget();
  const mobilePreference = new EventTarget();
  mobilePreference.matches = mobile;
  document.hidden = false;
  preference.matches = reduced;
  const frames = new Map();
  const calls = [];
  const classes = new Set();
  let frameId = 0,
    created = 0,
    disposed = 0;
  environment.document = document;
  environment.innerWidth = 1200;
  environment.innerHeight = 800;
  environment.scrollY = 0;
  environment.matchMedia = (query) =>
    query.includes("max-width") ? mobilePreference : preference;
  document.querySelectorAll = (selector) =>
    selector === "[data-fire-source]"
      ? [
          {
            getBoundingClientRect: () => ({
              left: 590,
              right: 610,
              top: 490 - environment.scrollY,
              bottom: 540 - environment.scrollY,
              width: 20,
              height: 50,
            }),
            closest: (selector) => {
              assert.equal(selector, "[data-fire-container]");
              return {
                getBoundingClientRect: () => ({
                  left: 400,
                  right: 1000,
                  top: 300 - environment.scrollY,
                  bottom: 700 - environment.scrollY,
                }),
              };
            },
          },
        ]
      : [];
  environment.requestAnimationFrame = (callback) => {
    frames.set(++frameId, callback);
    return frameId;
  };
  environment.cancelAnimationFrame = (id) => frames.delete(id);
  const canvas = new EventTarget();
  canvas.getBoundingClientRect = () => ({
    width: environment.innerWidth - scrollbar,
    height: environment.innerHeight,
  });
  canvas.parentElement = {
    classList: {
      toggle(name, enabled) {
        if (enabled) classes.add(name);
        else classes.delete(name);
      },
      remove(name) {
        classes.delete(name);
      },
    },
  };
  const dragon = intro ? { style: {} } : null;
  function rendererFactory(canvas, options = {}) {
    const kind = options.scenery
      ? "scenery"
      : options.foreground
        ? "foreground"
        : "background";
    created++;
    return available
      ? {
          resize: (...size) => calls.push({ size, kind }),
          render: (delta, time, pointer, scene) =>
            calls.push({ delta, time, pointer: { ...pointer }, scene, kind }),
          destroy: () => disposed++,
        }
      : null;
  }
  function send(target, type, properties = {}) {
    target.dispatchEvent(
      Object.assign(new Event(type, { cancelable: true }), properties),
    );
  }
  function tick(now) {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(now);
  }
  const overlay = foreground ? new EventTarget() : null;
  if (overlay) overlay.style = { setProperty() {}, removeProperty() {} };
  const sceneryLayer = scenery ? new EventTarget() : null;
  if (sceneryLayer) {
    sceneryLayer.style = { setProperty() {}, removeProperty() {} };
    sceneryLayer.getBoundingClientRect = () => ({
      left: 0,
      top: -environment.scrollY,
      width: environment.innerWidth - scrollbar,
      height: 1700,
    });
  }
  const motion = attachFireMotion(
    canvas,
    dragon,
    environment,
    rendererFactory,
    overlay,
    sceneryLayer,
    intro,
  );
  return {
    environment,
    document,
    preference,
    mobilePreference,
    canvas,
    overlay,
    sceneryLayer,
    dragon,
    classes,
    frames,
    calls,
    motion,
    send,
    tick,
    counts: () => ({ created, disposed }),
  };
}

test("dragon lights measured scenery sources and they stay burning after the fly-in", () => {
  const sources = [
    { x: 300, y: 200, width: 20, height: 70 },
    { x: 900, y: 210, width: 12, height: 42 },
  ];
  assert.deepEqual(
    fireScene(0, 1200, 800, true, sources).fires.map((source) => source.lit),
    [0, 0],
  );
  assert.ok(fireScene(2, 1200, 800, true, sources).breath[2] > 0);
  const passing = fireScene(3.6, 1200, 800, true, sources);
  assert.equal(passing.fires[0].lit, 1);
  assert.equal(passing.fires[1].lit, 0);
  assert.deepEqual(
    fireScene(24, 1200, 800, true, sources).fires.map((source) => source.lit),
    [1, 1],
  );
  assert.equal(fireScene(10, 1200, 800).dragon.opacity, 0);
  assert.equal(fireScene(0, 1200, 800, false, sources).fires[0].lit, 1);
});

test("rendering stays bounded on high resolution and narrow viewports", () => {
  const large = fireResolution(3840, 2160);
  assert.ok(large.width <= 1440 && large.height <= 900);
  assert.ok(large.smokeWidth <= 480 && large.smokeHeight <= 320);
  assert.equal(large.width / large.height, 3840 / 2160);
  const phone = fireResolution(390, 844);
  assert.equal(phone.width, 390);
  assert.equal(phone.height, 844);
  assert.ok(phone.smokeWidth <= 480 && phone.smokeHeight <= 320);
});

test("mouse wakes are bounded, decay, ignore touch and reset on leaving", () => {
  const f = fixture();
  try {
    f.tick(0);
    f.send(f.environment, "pointermove", {
      pointerType: "mouse",
      clientX: 10,
      clientY: 400,
    });
    f.send(f.environment, "pointermove", {
      pointerType: "mouse",
      clientX: 2400,
      clientY: -500,
    });
    assert.equal(f.frames.size, 1);
    f.tick(40);
    const pointer = f.calls.at(-1).pointer;
    assert.deepEqual(pointer, { x: 1200, y: 800, dx: 110, dy: 110 });
    f.send(f.environment, "pointermove", {
      pointerType: "touch",
      clientX: 0,
      clientY: 0,
    });
    f.tick(80);
    assert.equal(f.calls.at(-1).pointer.x, 1200);
    assert.ok(f.calls.at(-1).pointer.dx < 110);
    f.send(f.environment, "pointerout", { relatedTarget: null });
    f.tick(120);
    assert.equal(f.calls.at(-1).pointer.x, -1000);
    assert.equal(f.calls.at(-1).pointer.dx, 0);
  } finally {
    f.motion.destroy();
  }
  assert.equal(f.frames.size, 0);
  assert.deepEqual(f.counts(), { created: 1, disposed: 1 });
});

test("pause and hidden tabs suspend frames without jumping the intro clock", () => {
  const f = fixture();
  try {
    f.tick(0);
    f.tick(40);
    const time = f.calls.at(-1).time;
    f.motion.setPaused(true);
    assert.equal(f.frames.size, 0);
    f.motion.setPaused(false);
    f.tick(9000);
    assert.equal(f.calls.at(-1).time, time);
    f.document.hidden = true;
    f.send(f.document, "visibilitychange");
    assert.equal(f.frames.size, 0);
    f.document.hidden = false;
    f.send(f.document, "visibilitychange");
    f.tick(18000);
    assert.equal(f.calls.at(-1).time, time);
    f.preference.matches = true;
    f.send(f.preference, "change");
    assert.equal(f.frames.size, 0);
    assert.equal(f.dragon.style.opacity, "0");
    f.preference.matches = false;
    f.send(f.preference, "change");
    f.tick(20000);
    assert.equal(f.calls.at(-1).scene.fires[0].lit, 1);
  } finally {
    f.motion.destroy();
  }
  f.send(f.environment, "resize");
  f.send(f.document, "visibilitychange");
  assert.equal(f.frames.size, 0);
  assert.deepEqual(f.counts(), { created: 2, disposed: 2 });
});

test("reduced motion and unsupported WebGL avoid a render loop", () => {
  const reduced = fixture({ reduced: true });
  const unavailable = fixture({ available: false });
  try {
    assert.equal(reduced.frames.size, 0);
    assert.equal(reduced.counts().created, 0);
    assert.equal(unavailable.frames.size, 0);
    assert.ok(!unavailable.classes.has("has-webgl"));
    unavailable.send(unavailable.document, "visibilitychange");
    assert.equal(unavailable.counts().created, 1);
  } finally {
    reduced.motion.destroy();
    unavailable.motion.destroy();
  }
});

test("pages without the Home intro keep scenery lit and never create a dragon renderer", () => {
  const f = fixture({ intro: false, foreground: true, scenery: true });
  try {
    for (const time of [0, 4000, 12000]) {
      f.tick(time);
      const scene = f.calls.at(-1).scene;
      assert.equal(scene.dragon.opacity, 0);
      assert.equal(scene.breath[2], 0);
      assert.equal(scene.fires[0].lit, 1);
    }
    assert.ok(f.calls.every((call) => call.kind !== "foreground"));
    assert.deepEqual(f.counts(), { created: 2, disposed: 0 });
    f.document.hidden = true;
    f.send(f.document, "visibilitychange");
    f.document.hidden = false;
    f.send(f.document, "visibilitychange");
    f.tick(16000);
    assert.equal(f.calls.at(-1).scene.dragon.opacity, 0);
    f.send(f.canvas, "webglcontextlost");
    f.send(f.canvas, "webglcontextrestored");
    f.tick(20000);
    assert.ok(f.calls.every((call) => call.kind !== "foreground"));
  } finally {
    f.motion.destroy();
  }
  assert.equal(f.frames.size, 0);
  assert.deepEqual(f.counts(), { created: 4, disposed: 4 });
});

test("context loss stops rendering and restoration recreates resources without repeating the intro", () => {
  const f = fixture();
  try {
    f.tick(0);
    f.send(f.canvas, "webglcontextlost");
    assert.equal(f.frames.size, 0);
    assert.ok(!f.classes.has("has-webgl"));
    assert.equal(f.counts().disposed, 1);
    f.send(f.canvas, "webglcontextrestored");
    f.tick(40);
    assert.equal(f.calls.at(-1).scene.fires[0].lit, 1);
  } finally {
    f.motion.destroy();
  }
  assert.deepEqual(f.counts(), { created: 2, disposed: 2 });
});

test("slow foreground frames preserve flight timing while bounding the fluid step", () => {
  const f = fixture();
  try {
    f.tick(0);
    f.tick(4000);
    assert.equal(f.calls.at(-1).time, 4);
    assert.equal(f.calls.at(-1).delta, 0.05);
    f.tick(10000);
    assert.equal(f.calls.at(-1).scene.dragon.opacity, 0);
  } finally {
    f.motion.destroy();
  }
  f.motion.setPaused(false);
  assert.equal(f.frames.size, 0);
  assert.equal(f.counts().created, 1);
});

test("breath keeps the dragon's angle and source geometry follows the artwork", () => {
  const sources = [{ x: 590, y: 200, width: 12, height: 42 }];
  const early = fireScene(1, 1200, 800, true, sources);
  const middle = fireScene(3.3, 1200, 800, true, sources);
  assert.ok(early.dragon.x < middle.dragon.x);
  assert.equal(middle.dragon.direction, 1);
  assert.equal(middle.dragon.size, 480);
  assert.ok(middle.breathTarget[1] < middle.breath[1]);
  for (const time of [0.8, 3.3, 5, 7]) {
    const scene = fireScene(time, 1200, 800, true, sources);
    const withoutProps = fireScene(time, 1200, 800);
    const direction = scene.breathTarget.map(
      (value, index) => value - scene.breath[index],
    );
    const angle = (scene.dragon.roll * Math.PI) / 180;
    assert.ok(
      Math.abs(
        direction[0] * Math.cos(angle) - direction[1] * Math.sin(angle) - 76.8,
      ) < 1e-9,
    );
    assert.ok(
      Math.abs(
        -direction[0] * Math.sin(angle) - direction[1] * Math.cos(angle) - 480,
      ) < 1e-9,
    );
    for (let index = 0; index < 2; index++) {
      assert.ok(
        Math.abs(
          direction[index] -
            (withoutProps.breathTarget[index] - withoutProps.breath[index]),
        ) < 1e-9,
      );
    }
  }
  const f = fixture();
  try {
    f.tick(0);
    assert.deepEqual(f.calls.at(-1).scene.fires[0], {
      x: 600,
      y: 260,
      width: 10,
      height: 50,
      bounds: [400, 100, 1000, 500],
      lit: 0,
    });
    f.environment.innerHeight = 900;
    f.send(f.environment, "resize");
    f.tick(40);
    assert.equal(f.calls.at(-1).scene.fires[0].y, 360);
    assert.deepEqual(
      f.calls.at(-1).scene.fires[0].bounds,
      [400, 200, 1000, 600],
    );
  } finally {
    f.motion.destroy();
  }
});

test("the foreground clears after delayed frames and context loss stops both layers", () => {
  const f = fixture({ foreground: true });
  try {
    f.tick(0);
    f.tick(4000);
    f.tick(30000);
    assert.equal(f.calls.at(-1).scene.breath[2], 0);
    const calls = f.calls.length;
    f.tick(30040);
    assert.equal(f.calls.length, calls + 1);
    f.send(f.overlay, "webglcontextlost");
    assert.equal(f.frames.size, 0);
    assert.deepEqual(f.counts(), { created: 2, disposed: 2 });
  } finally {
    f.motion.destroy();
  }
  assert.deepEqual(f.counts(), { created: 2, disposed: 2 });
});

test("mobile never starts GPU rendering and a viewport change releases desktop resources", () => {
  const phone = fixture({ mobile: true, foreground: true });
  try {
    assert.equal(phone.frames.size, 0);
    assert.equal(phone.counts().created, 0);
  } finally {
    phone.motion.destroy();
  }
  const desktop = fixture({ foreground: true });
  try {
    desktop.tick(0);
    desktop.mobilePreference.matches = true;
    desktop.send(desktop.mobilePreference, "change");
    assert.equal(desktop.frames.size, 0);
    assert.deepEqual(desktop.counts(), { created: 2, disposed: 2 });
    assert.equal(desktop.dragon.style.opacity, "0");
    desktop.mobilePreference.matches = false;
    desktop.send(desktop.mobilePreference, "change");
    desktop.tick(9000);
    assert.equal(desktop.calls.at(-1).scene.dragon.opacity, 0);
    assert.equal(desktop.calls.at(-1).scene.fires[0].lit, 1);
  } finally {
    desktop.motion.destroy();
  }
  assert.deepEqual(desktop.counts(), { created: 3, disposed: 3 });
});

test("scenery flames keep document positions across scroll and use canvas CSS width", () => {
  const f = fixture({ scenery: true, scrollbar: 17 });
  try {
    f.tick(0);
    const first = f.calls.findLast(
      (call) => call.kind === "scenery" && call.scene,
    );
    assert.equal(first.scene.fires[0].x, 600);
    assert.equal(first.scene.fires[0].y, 1160);
    assert.ok(
      f.calls.some(
        (call) => call.kind === "background" && call.size?.[0] === 1183,
      ),
    );
    f.environment.scrollY = 117;
    f.send(f.environment, "scroll");
    f.tick(40);
    const next = f.calls.findLast(
      (call) => call.kind === "scenery" && call.scene,
    );
    assert.equal(next.scene.fires[0].y, first.scene.fires[0].y);
    assert.deepEqual(next.scene.fires[0].bounds, first.scene.fires[0].bounds);
    f.send(f.sceneryLayer, "webglcontextlost");
    assert.equal(f.frames.size, 0);
    assert.deepEqual(f.counts(), { created: 2, disposed: 2 });
  } finally {
    f.motion.destroy();
  }
});
