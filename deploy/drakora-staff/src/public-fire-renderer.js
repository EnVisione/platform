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
uniform vec4 fires[12];
uniform float fireWidths[12];
uniform vec4 fireBounds[12];
uniform float fireFixed[12];
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
  for (int i = 0; i < 12; i++) {
    vec4 fire = fires[i];
    vec4 bounds = fireBounds[i];
    if (fire.x < bounds.x || fire.x > bounds.z || fire.y < bounds.y || fire.y > bounds.w || fire.y < 0.0 || fire.y > view.y) continue;
    vec2 local = p - fire.xy;
    float seeds = plume(local, 0.0, fireWidths[i] * 2.0 + 12.0) * fire.w;
    float billow = 0.35 + 0.65 * fbm(vec2(p.x * 0.021, p.y * 0.014 - time * 0.8));
    float emission = (local.y - fire.z * 0.75) / max(20.0, fire.z * 0.65);
    density += seeds * exp(-emission * emission) * billow * delta * 0.8;
  }
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

const sceneryField = `${flameField}
vec4 sceneryFire(vec2 p, float fixedOnly) {
  vec3 color = vec3(0.0);
  float alpha = 0.0;
  for (int i = 0; i < 12; i++) {
    if (abs(fireFixed[i] - fixedOnly) > 0.5) continue;
    vec4 source = fires[i];
    vec4 bounds = fireBounds[i];
    if (source.x < bounds.x || source.x > bounds.z || source.y < bounds.y || source.y > bounds.w) continue;
    vec2 local = p - source.xy;
    if (p.x < bounds.x || p.x > bounds.z || p.y < bounds.y || p.y > bounds.w || local.y < -3.0) continue;
    float height = max(1.0, source.z);
    float fire = flame(local, 0.0, float(i) * 5.0, height, fireWidths[i]) * source.w;
    fire *= smoothstep(-3.0, 3.0, local.y);
    float heat = clamp(1.0 - local.y / height, 0.0, 1.0);
    vec3 fireColor = mix(vec3(0.85, 0.17, 0.035), vec3(1.0, 0.8, 0.3), heat);
    float glow = exp(-length(local / vec2(fireWidths[i] * 2.8, height * 0.7))) * source.w * 0.12;
    color = color * (1.0 - fire * 0.9) + fireColor * fire * 0.9 + vec3(0.65, 0.16, 0.04) * glow;
    alpha = min(0.95, alpha * (1.0 - fire * 0.9) + fire * 0.9 + glow);
    float age = mod(time * (0.18 + float(i) * 0.006) + float(i) * 0.137, 1.0);
    vec2 ember = source.xy + vec2(sin(age * 8.0 + float(i)) * (8.0 + age * 20.0), age * height * 2.5);
    float spark = exp(-dot(p - ember, p - ember) / 2.8) * (1.0 - age) * source.w;
    color += vec3(1.0, 0.46, 0.1) * spark * 0.6;
    alpha = max(alpha, spark * 0.6);
  }
  return vec4(color, alpha);
}`;

const display = `${field}
uniform sampler2D smoke;
${sceneryField}
void main() {
  vec2 p = uv * view;
  float density = texture2D(smoke, uv).r;
  float detail = 0.6 + fbm(p * 0.012 + vec2(time * 0.08, -time * 0.25)) * 0.65;
  float smokeAlpha = min(density * detail * 0.68, 0.36);
  vec3 smokeColor = mix(vec3(0.23, 0.23, 0.24), vec3(0.36, 0.32, 0.3), exp(-p.y / 200.0));
  vec4 fire = sceneryFire(p, 1.0);
  gl_FragColor = vec4(smokeColor * smokeAlpha * (1.0 - fire.a) + fire.rgb, smokeAlpha * (1.0 - fire.a) + fire.a);
}`;

const sceneryDisplay = `${field}
${sceneryField}
void main() {
  gl_FragColor = sceneryFire(uv * view, 0.0);
}`;

const foregroundDisplay = `${field}
uniform vec3 breath;
void main() {
  vec2 p = uv * view;
  vec3 color = vec3(0.0);
  float alpha = 0.0;
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
  { foreground = false, scenery = false } = {},
) {
  const overlay = foreground || scenery;
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
        "pointer",
        "smoke",
        "breath",
        "breathTarget",
        ...Array.from({ length: 12 }, (_, index) => `fires[${index}]`),
        ...Array.from({ length: 12 }, (_, index) => `fireWidths[${index}]`),
        ...Array.from({ length: 12 }, (_, index) => `fireBounds[${index}]`),
        ...Array.from({ length: 12 }, (_, index) => `fireFixed[${index}]`),
      ].map((name) => [name, gl.getUniformLocation(item, name)]),
    );
    return { item, uniforms, position: gl.getAttribLocation(item, "position") };
  }
  try {
    const simulationProgram = overlay ? null : program(simulation);
    const displayProgram = program(
      foreground ? foregroundDisplay : scenery ? sceneryDisplay : display,
    );
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
      targets = overlay
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
      gl.uniform4f(u.pointer, pointer.x, pointer.y, pointer.dx, pointer.dy);
      gl.uniform3f(u.breath, ...scene.breath);
      gl.uniform2f(u.breathTarget, ...scene.breathTarget);
      for (let index = 0; index < 12; index++) {
        const source = scene.fires[index];
        gl.uniform1f(u[`fireFixed[${index}]`], source?.fixed ? 1 : 0);
        gl.uniform4f(
          u[`fires[${index}]`],
          source?.x ?? -1000,
          source?.y ?? -1000,
          source?.height ?? 1,
          source?.lit ?? 0,
        );
        gl.uniform1f(u[`fireWidths[${index}]`], source?.width ?? 1);
        gl.uniform4f(
          u[`fireBounds[${index}]`],
          ...(source?.bounds ?? [0, 0, 0, 0]),
        );
      }
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    return {
      resize,
      render(delta, time, pointer, scene) {
        if (!overlay && delta > 0) {
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
