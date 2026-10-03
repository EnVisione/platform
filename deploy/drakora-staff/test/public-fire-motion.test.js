import test from "node:test";
import assert from "node:assert/strict";
import { attachFireMotion } from "../src/public-fire-motion.js";

function fixture(reduced = false) {
  const environment = new EventTarget();
  const document = new EventTarget();
  document.hidden = false;
  const preference = new EventTarget();
  preference.matches = reduced;
  const frames = new Map();
  const styles = new Map();
  const classes = new Set();
  let nextFrame = 0;
  environment.document = document;
  environment.innerWidth = 1200;
  environment.innerHeight = 800;
  environment.matchMedia = () => preference;
  environment.requestAnimationFrame = (callback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  };
  environment.cancelAnimationFrame = (id) => frames.delete(id);
  const layer = {
    style: { setProperty: (name, value) => styles.set(name, value) },
    classList: {
      toggle(name, enabled) {
        if (enabled) classes.add(name);
        else classes.delete(name);
      },
    },
  };
  function send(target, type, properties = {}) {
    target.dispatchEvent(Object.assign(new Event(type), properties));
  }
  function mouse(clientX, clientY) {
    send(environment, "pointermove", {
      pointerType: "mouse",
      clientX,
      clientY,
    });
  }
  function flush() {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback();
  }
  return {
    environment,
    document,
    preference,
    frames,
    styles,
    classes,
    layer,
    send,
    mouse,
    flush,
  };
}

test("mouse input stays bounded and shares one pending frame", () => {
  const f = fixture();
  const stop = attachFireMotion(f.layer, f.environment);
  try {
    f.mouse(0, 0);
    f.mouse(600, 400);
    f.mouse(2400, 1600);
    assert.equal(f.frames.size, 1);
    f.flush();
    assert.equal(f.styles.get("--fire-x"), "12px");
    assert.equal(f.styles.get("--fire-y"), "6px");
    f.send(f.environment, "pointermove", {
      pointerType: "touch",
      clientX: 0,
      clientY: 0,
    });
    assert.equal(f.frames.size, 0);
    f.mouse(-1200, -800);
    f.flush();
    assert.equal(f.styles.get("--fire-x"), "-12px");
    assert.equal(f.styles.get("--fire-y"), "-6px");
    f.send(f.environment, "pointerout", { relatedTarget: null });
    assert.equal(f.styles.get("--fire-x"), "0px");
  } finally {
    stop();
  }
  assert.equal(f.frames.size, 0);
});

test("reduced motion, hidden tabs and teardown stop pending movement", () => {
  const f = fixture(true);
  const stop = attachFireMotion(f.layer, f.environment);
  try {
    assert.ok(f.classes.has("is-paused"));
    f.mouse(1200, 800);
    assert.equal(f.frames.size, 0);
    f.preference.matches = false;
    f.send(f.preference, "change");
    assert.ok(!f.classes.has("is-paused"));
    f.mouse(1200, 800);
    f.document.hidden = true;
    f.send(f.document, "visibilitychange");
    assert.equal(f.frames.size, 0);
    assert.equal(f.styles.get("--fire-x"), "0px");
    assert.ok(f.classes.has("is-paused"));
    f.mouse(1200, 800);
    assert.equal(f.frames.size, 0);
    f.document.hidden = false;
    f.send(f.document, "visibilitychange");
    assert.ok(!f.classes.has("is-paused"));
    f.mouse(1200, 800);
    f.send(f.environment, "blur");
    assert.equal(f.frames.size, 0);
    f.mouse(1200, 800);
  } finally {
    stop();
  }
  assert.equal(f.frames.size, 0);
  f.mouse(1200, 800);
  f.document.hidden = true;
  f.send(f.document, "visibilitychange");
  f.preference.matches = true;
  f.send(f.preference, "change");
  assert.equal(f.frames.size, 0);
  assert.ok(!f.classes.has("is-paused"));
  assert.equal(f.styles.get("--fire-x"), "0px");
});
