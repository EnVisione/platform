const vertex = `
attribute vec2 position;
varying vec2 uv;
void main() {
  uv = position * 0.5 + 0.5;
  gl_Position = vec4(position, 0.0, 1.0);
}`;

const field = `
precision highp float;
varying vec2 uv;
uniform vec2 view;
uniform float time;
uniform vec2 ignition;
uniform float source;
uniform vec2 breathTarget;
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) {
  float value = 0.0, weight = 0.5;
  for (int i = 0; i < 4; i++) {
    value += weight * noise(p);
    p = mat2(1.6, 1.2, -1.2, 1.6) * p + 3.1;
    weight *= 0.5;
  }
  return value;
}
float plume(vec2 p, float anchor, float width) {
  float spread = width + p.y * 0.18;
  float sway = (fbm(vec2(p.y * 0.008, time * 0.22)) - 0.5) * p.y * 0.4;
  float x = (p.x - anchor + sway) / spread;
  return exp(-x * x * 2.0);
}`;

const simulation = `${field}
uniform sampler2D smoke;
uniform float delta;
uniform vec4 pointer;
void main() {
  vec2 p = uv * view;
  vec2 q = p * 0.006 + vec2(0.0, -time * 0.12);
  float e = 0.12;
  vec2 curl = vec2(
    fbm(q + vec2(0.0, e)) - fbm(q - vec2(0.0, e)),
    fbm(q - vec2(e, 0.0)) - fbm(q + vec2(e, 0.0)));
  vec2 velocity = curl * 240.0 + vec2(sin(p.y * 0.007 + time * 0.4) * 14.0, 52.0);
  vec2 away = p - pointer.xy;
  float influence = exp(-dot(away, away) / 72000.0);
  float wake = min(length(pointer.zw) / 100.0, 1.0);
  velocity += (pointer.zw * 4.0 + away * 0.32 + vec2(-away.y, away.x) * wake * 1.6) * influence;
  vec2 previous = uv - velocity * delta / view;
  float density = texture2D(smoke, clamp(previous, 0.0, 1.0)).r;
  density *= exp(-delta * 0.16);
  float seeds = plume(p, source, 65.0) * ignition.x
    + plume(p, view.x - source, 65.0) * ignition.y;
  float billow = 0.35 + 0.65 * fbm(vec2(p.x * 0.021, p.y * 0.014 - time * 0.8));
  float emission = (p.y - min(180.0, view.y * 0.22)) / 90.0;
  density += seeds * exp(-emission * emission) * billow * delta * 1.5;
  density *= smoothstep(0.0, 0.035, uv.y) * (1.0 - smoothstep(0.9, 1.0, uv.y));
  gl_FragColor = vec4(clamp(density, 0.0, 1.0), 0.0, 0.0, 1.0);
}`;

const flameField = `
float flame(vec2 p, float anchor, float seed, float height, float width) {
  vec2 q = vec2((p.x - anchor) / width, p.y / height);
  if (q.y > 1.2 || abs(q.x) > 2.0) return 0.0;
  float turbulence = fbm(vec2(q.x * 2.4 + seed, q.y * 3.8 - time * 2.4));
  float sway = sin(q.y * 6.0 - time * 3.1 + seed) * q.y * 0.35;
  sway += (fbm(vec2(q.y * 6.0 + seed, time * 1.9)) - 0.5) * q.y * 1.2;
  float taper = max(0.0, 1.0 - q.y);
  float body = taper - abs(q.x + sway) * 0.82 + (turbulence - 0.5) * 0.7;
  return smoothstep(-0.08, 0.16, body) * (1.0 - smoothstep(0.78, 1.15, q.y));
}
`;

const display = `${field}
uniform sampler2D smoke;
${flameField}
void main() {
  vec2 p = uv * view;
  float height = min(330.0, view.y * 0.4);
  float fireLeft = 0.0, fireRight = 0.0, core = 0.0;
  if (p.y < height * 1.15) {
    fireLeft = flame(p, source, 2.0, height, 34.0) * ignition.x;
    fireRight = flame(p, view.x - source, 11.0, height * 0.82, 38.0) * ignition.y;
    core = max(flame(p, source, 2.0, height * 0.65, 14.0) * ignition.x,
      flame(p, view.x - source, 11.0, height * 0.55, 13.0) * ignition.y);
  }
  float fire = max(fireLeft, fireRight);
  float glow = (exp(-length((p - vec2(source, 0.0)) / vec2(95.0, 140.0))) * ignition.x
    + exp(-length((p - vec2(view.x - source, 0.0)) / vec2(95.0, 140.0))) * ignition.y) * 0.15;
  float density = texture2D(smoke, uv).r;
  float detail = 0.6 + fbm(p * 0.012 + vec2(time * 0.08, -time * 0.25)) * 0.65;
  float smokeAlpha = min(density * detail * 0.68, 0.36);
  vec3 smokeColor = mix(vec3(0.23, 0.23, 0.24), vec3(0.36, 0.32, 0.3), exp(-p.y / 200.0));
  vec3 color = smokeColor * smokeAlpha;
  float alpha = smokeAlpha;
  float heat = clamp((1.0 - p.y / height) * core, 0.0, 1.0);
  vec3 fireColor = mix(vec3(0.72, 0.13, 0.035), vec3(1.0, 0.52, 0.13), smoothstep(0.05, 0.55, heat));
  fireColor = mix(fireColor, vec3(1.0, 0.87, 0.47), smoothstep(0.62, 1.0, heat));
  color = color * (1.0 - fire * 0.84) + fireColor * fire * 0.84 + vec3(0.7, 0.16, 0.04) * glow;
  alpha = min(0.95, alpha * (1.0 - fire * 0.84) + fire * 0.84 + glow);
  for (int i = 0; i < 8; i++) {
    float seed = float(i);
    float age = mod(time * (0.09 + seed * 0.004) + seed * 0.137, 1.0);
    float side = mod(seed, 2.0);
    float anchor = mix(source, view.x - source, side);
    float lit = mix(ignition.x, ignition.y, side);
    vec2 ember = vec2(anchor + sin(age * 8.0 + seed) * (12.0 + age * 45.0), age * min(view.y, 540.0));
    float spark = exp(-dot(p - ember, p - ember) / 2.8) * (1.0 - age) * lit;
    color += vec3(1.0, 0.46, 0.1) * spark * 0.7;
    alpha = max(alpha, spark * 0.7);
  }
  gl_FragColor = vec4(color, alpha);
}`;

const foregroundDisplay = `${field}
${flameField}
uniform vec3 breath;
uniform vec4 burns[12];
uniform float wordLayer;
uniform float breathLayer;
void main() {
  vec2 p = uv * view;
  vec3 color = vec3(0.0);
  float alpha = 0.0;
  if (wordLayer > 0.5) for (int i = 0; i < 12; i++) {
    vec4 spot = burns[i];
    float seed = float(i);
    float height = 24.0 + hash(vec2(seed, 3.0)) * 26.0;
    vec2 local = vec2(p.x, p.y - spot.y);
    float fire = local.y >= 0.0 ? flame(local, spot.x, seed * 5.0, height,
      8.0 + hash(vec2(seed, 7.0)) * 5.0) * spot.w : 0.0;
    fire *= smoothstep(0.0, 8.0, local.y);
    float hot = clamp(1.0 - local.y / height, 0.0, 1.0);
    vec3 fireColor = mix(vec3(0.9, 0.2, 0.03), vec3(1.0, 0.78, 0.25), hot);
    color += fireColor * fire * 0.8;
    alpha = max(alpha, fire * 0.8);
  }
  if (breathLayer > 0.5) {
  vec2 path = breathTarget - breath.xy;
  float progress = clamp(dot(p - breath.xy, path) / max(dot(path, path), 1.0), 0.0, 1.0);
  vec2 center = breath.xy + progress * path;
  float wave = (fbm(vec2(progress * 12.0, time * 3.0)) - 0.5) * progress * 16.0;
  float distance = length(p - center) + wave;
  float spread = 9.0 + pow(progress, 0.7) * min(view.x * 0.22, 160.0);
  float turbulence = fbm(p * 0.028 + vec2(time * 1.2, -time * 4.0));
  float jet = (1.0 - smoothstep(0.4, 1.0, distance / spread + (turbulence - 0.5) * 0.65));
  jet *= breath.z * (0.55 + 0.45 * turbulence);
  color = color * (1.0 - jet) + mix(vec3(1.0, 0.28, 0.04), vec3(1.0, 0.82, 0.3), 1.0 - progress) * jet;
  alpha = max(alpha, jet);
  }
  gl_FragColor = vec4(color, alpha);
}`;

export function fireResolution(width, height) {
  const scale = Math.min(1, 1440 / width, 900 / height);
  const simulationScale = Math.min(1, 480 / width, 320 / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    smokeWidth: Math.max(1, Math.round(width * simulationScale)),
    smokeHeight: Math.max(1, Math.round(height * simulationScale)),
  };
}

export function createFireRenderer(
  canvas,
  { foreground = false, words = false } = {},
) {
  const gl = canvas.getContext("webgl", {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: "low-power",
  });
  if (!gl) return null;
  const shaders = [],
    programs = [],
    buffers = [],
    textures = [],
    framebuffers = [];
  let width = 1,
    height = 1,
    resolution,
    targets = [],
    read = 0;
  function destroy() {
    for (const item of textures) gl.deleteTexture(item);
    for (const item of framebuffers) gl.deleteFramebuffer(item);
    for (const item of buffers) gl.deleteBuffer(item);
    for (const item of programs) gl.deleteProgram(item);
    for (const item of shaders) gl.deleteShader(item);
    textures.length =
      framebuffers.length =
      buffers.length =
      programs.length =
      shaders.length =
        0;
  }
  function shader(type, source) {
    const item = gl.createShader(type);
    shaders.push(item);
    gl.shaderSource(item, source);
    gl.compileShader(item);
    if (!gl.getShaderParameter(item, gl.COMPILE_STATUS))
      throw new Error(gl.getShaderInfoLog(item));
    return item;
  }
  function program(fragment) {
    const item = gl.createProgram();
    programs.push(item);
    gl.attachShader(item, shader(gl.VERTEX_SHADER, vertex));
    gl.attachShader(item, shader(gl.FRAGMENT_SHADER, fragment));
    gl.linkProgram(item);
    if (!gl.getProgramParameter(item, gl.LINK_STATUS))
      throw new Error(gl.getProgramInfoLog(item));
    const uniforms = Object.fromEntries(
      [
        "view",
        "time",
        "delta",
        "source",
        "ignition",
        "pointer",
        "smoke",
        "breath",
        "breathTarget",
        "wordLayer",
        "breathLayer",
        ...Array.from({ length: 12 }, (_, index) => `burns[${index}]`),
      ].map((name) => [name, gl.getUniformLocation(item, name)]),
    );
    return { item, uniforms, position: gl.getAttribLocation(item, "position") };
  }
  try {
    const simulationProgram = foreground ? null : program(simulation);
    const displayProgram = program(foreground ? foregroundDisplay : display);
    const quad = gl.createBuffer();
    buffers.push(quad);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    );
    function resize(nextWidth, nextHeight) {
      width = Math.max(1, nextWidth);
      height = Math.max(1, nextHeight);
      resolution = fireResolution(width, height);
      canvas.width = resolution.width;
      canvas.height = resolution.height;
      for (const item of textures) gl.deleteTexture(item);
      for (const item of framebuffers) gl.deleteFramebuffer(item);
      textures.length = framebuffers.length = 0;
      read = 0;
      targets = foreground
        ? []
        : [0, 1].map(() => {
            const texture = gl.createTexture();
            textures.push(texture);
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(
              gl.TEXTURE_2D,
              gl.TEXTURE_WRAP_S,
              gl.CLAMP_TO_EDGE,
            );
            gl.texParameteri(
              gl.TEXTURE_2D,
              gl.TEXTURE_WRAP_T,
              gl.CLAMP_TO_EDGE,
            );
            gl.texImage2D(
              gl.TEXTURE_2D,
              0,
              gl.RGBA,
              resolution.smokeWidth,
              resolution.smokeHeight,
              0,
              gl.RGBA,
              gl.UNSIGNED_BYTE,
              null,
            );
            const framebuffer = gl.createFramebuffer();
            framebuffers.push(framebuffer);
            gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
            gl.framebufferTexture2D(
              gl.FRAMEBUFFER,
              gl.COLOR_ATTACHMENT0,
              gl.TEXTURE_2D,
              texture,
              0,
            );
            if (
              gl.checkFramebufferStatus(gl.FRAMEBUFFER) !==
              gl.FRAMEBUFFER_COMPLETE
            )
              throw new Error("Smoke framebuffer unavailable");
            gl.clearColor(0, 0, 0, 0);
            gl.clear(gl.COLOR_BUFFER_BIT);
            return { texture, framebuffer };
          });
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    function draw(
      program,
      framebuffer,
      renderWidth,
      renderHeight,
      delta,
      time,
      pointer,
      scene,
    ) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.viewport(0, 0, renderWidth, renderHeight);
      gl.useProgram(program.item);
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.enableVertexAttribArray(program.position);
      gl.vertexAttribPointer(program.position, 2, gl.FLOAT, false, 0, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, targets[read]?.texture ?? null);
      const u = program.uniforms;
      gl.uniform1i(u.smoke, 0);
      gl.uniform2f(u.view, width, height);
      gl.uniform1f(u.time, time);
      gl.uniform1f(u.delta, delta);
      gl.uniform1f(u.source, scene.source);
      gl.uniform2f(u.ignition, ...scene.ignition);
      gl.uniform4f(u.pointer, pointer.x, pointer.y, pointer.dx, pointer.dy);
      gl.uniform3f(u.breath, ...scene.breath);
      gl.uniform2f(u.breathTarget, ...scene.breathTarget);
      gl.uniform1f(u.wordLayer, words ? 1 : 0);
      gl.uniform1f(u.breathLayer, words ? 0 : 1);
      const spots = (scene.burning ?? []).flatMap((target) => {
        const angle = (target.tilt * target.fall * Math.PI) / 180;
        return (target.spots ?? []).map((spot) => {
          const dx = spot.x - target.x,
            dy = target.y - spot.y;
          return [
            target.x + Math.cos(angle) * dx - Math.sin(angle) * dy,
            target.y -
              Math.sin(angle) * dx -
              Math.cos(angle) * dy -
              target.fall * 9,
            0,
            target.lit,
          ];
        });
      });
      for (let index = 0; index < 12; index++)
        gl.uniform4f(
          u[`burns[${index}]`],
          ...(spots[index] ?? [-1000, -1000, 0, 0]),
        );
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    return {
      resize,
      render(delta, time, pointer, scene) {
        if (!foreground && delta > 0) {
          draw(
            simulationProgram,
            targets[1 - read].framebuffer,
            resolution.smokeWidth,
            resolution.smokeHeight,
            delta,
            time,
            pointer,
            scene,
          );
          read = 1 - read;
        }
        draw(
          displayProgram,
          null,
          resolution.width,
          resolution.height,
          delta,
          time,
          pointer,
          scene,
        );
      },
      destroy,
    };
  } catch (error) {
    destroy();
    console.warn(
      "Background animation is unavailable; using a still background.",
      error.message,
    );
    return null;
  }
}
