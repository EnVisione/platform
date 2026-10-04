import test from "node:test";
import assert from "node:assert/strict";
import { attachFireMotion, fireScene } from "../src/public-fire-motion.js";
import { fireResolution } from "../src/public-fire-renderer.js";

function fixture({
  reduced = false,
  available = true,
  foreground = false,
  words = false,
} = {}) {
  const environment = new EventTarget();
  const document = new EventTarget();
  const preference = new EventTarget();
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
  environment.matchMedia = () => preference;
  environment.requestAnimationFrame = (callback) => {
    frames.set(++frameId, callback);
    return frameId;
  };
  environment.cancelAnimationFrame = (id) => frames.delete(id);
  const canvas = new EventTarget();
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
  const dragon = { style: {} };
  function rendererFactory() {
    created++;
    return available
      ? {
          resize: (...size) => calls.push({ size }),
          render: (delta, time, pointer, scene) =>
            calls.push({ delta, time, pointer: { ...pointer }, scene }),
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
  const wordLayer = words ? new EventTarget() : null;
  if (wordLayer) wordLayer.style = { setProperty() {}, removeProperty() {} };
  const motion = attachFireMotion(
    canvas,
    dragon,
    environment,
    rendererFactory,
    overlay,
    wordLayer,
  );
  return {
    environment,
    document,
    preference,
    canvas,
    overlay,
    wordLayer,
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

test("dragon breath precedes ignition and both sources remain lit after the fly-in", () => {
  assert.deepEqual(fireScene(0, 1200, 800).ignition, [0, 0]);
  assert.ok(fireScene(1.1, 1200, 800).breath[2] > 0);
  assert.equal(fireScene(1.1, 1200, 800).ignition[0], 0);
  assert.deepEqual(fireScene(2, 1200, 800).ignition, [1, 0]);
  assert.ok(fireScene(4.3, 1200, 800).breath[2] > 0);
  assert.deepEqual(fireScene(7, 1200, 800).ignition, [1, 1]);
  assert.equal(fireScene(10, 1200, 800).dragon.opacity, 0);
  assert.deepEqual(fireScene(0, 390, 800, false).ignition, [1, 1]);
  assert.equal(fireScene(0, 390, 800, false).dragon.opacity, 0);
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
    assert.deepEqual(f.calls.at(-1).scene.ignition, [1, 1]);
  } finally {
    f.motion.destroy();
  }
  f.send(f.environment, "resize");
  f.send(f.document, "visibilitychange");
  assert.equal(f.frames.size, 0);
  assert.deepEqual(f.counts(), { created: 1, disposed: 1 });
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
    assert.deepEqual(f.calls.at(-1).scene.ignition, [1, 1]);
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

test("the larger dragon crosses left to right and scorched elements remain usable", () => {
  const targets = [{ x: 350, y: 350, width: 450, height: 60 }];
  const early = fireScene(1, 1200, 800, true, targets);
  const middle = fireScene(4, 1200, 800, true, targets);
  const end = fireScene(8, 1200, 800, true, targets);
  assert.ok(early.dragon.x < middle.dragon.x && middle.dragon.x < end.dragon.x);
  assert.equal(middle.dragon.direction, 1);
  assert.equal(middle.dragon.size, 480);
  assert.ok(early.breath[2] > 0);
  assert.ok(middle.breathTarget[1] < middle.breath[1]);
  assert.ok(Math.abs(middle.breathTarget[0] - middle.breath[0]) < 100);
  assert.equal(early.burning[0].fall, 0);
  assert.equal(end.burning[0].fall, 1);
  assert.ok(end.burning[0].lit > 0);
  assert.equal(fireScene(24, 1200, 800, true, targets).burning[0].lit, 1);
  assert.equal(fireScene(4, 1200, 800, false, targets).burning[0].fall, 0);
  assert.equal(end.dragon.opacity, 0);
});

test("the foreground clears after delayed frames and context loss stops all three layers", () => {
  const f = fixture({ foreground: true, words: true });
  try {
    f.tick(0);
    f.tick(4000);
    f.tick(30000);
    assert.ok(f.calls.at(-1).scene.breath[2] === 0);
    const calls = f.calls.length;
    f.tick(30040);
    assert.equal(f.calls.length, calls + 2);
    f.send(f.wordLayer, "webglcontextlost");
    assert.equal(f.frames.size, 0);
    assert.deepEqual(f.counts(), { created: 3, disposed: 3 });
  } finally {
    f.motion.destroy();
  }
  assert.deepEqual(f.counts(), { created: 3, disposed: 3 });
});
