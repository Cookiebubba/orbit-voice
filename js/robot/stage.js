/* The robot on the page: one mesh, one draw call, the real CAD (model/qubit.bin, built by build/build-model.mjs).
 *
 * Every vertex carries a part number and a colour role. A small texture holds each part's explode vector,
 * its stage in the explode, and which joint moves it, so pulling the robot apart or turning a joint is a
 * uniform change and nothing is uploaded per frame. Qubit's face is the real engine (see face.js).
 *
 * Robot frame: mm, z up, +y front, +x right. Scene: metres, y up, the robot faces +z.
 * Loaded only when #/robot opens; dispose() gives everything back on the way out.
 */
import * as THREE from './vendor/three.module.min.js';
import { RoomEnvironment } from './vendor/RoomEnvironment.js';
import { MeshoptDecoder } from './vendor/meshopt_decoder.module.js';
import { createFace } from './face.js';

// How far parts travel, and when they leave: 0 goes first. Shell comes off, then the insides spread.
const EXPLODE_GAIN = 2.6;
const STAGE = { Shell: 0, Body: 0.04, Lights: 0.1, Phone: 0.16, Arm: 0.16, Drive: 0.12, Chassis: 0.3, Audio: 0.3, Power: 0.34, Electronics: 0.34, Sensors: 0.34, Fasteners: 0 };
const WHEEL_R = 40; // mm

const PARS = /* glsl */ `
  attribute float aPart;
  attribute float aRole;
  uniform highp sampler2D uParts;
  uniform mat4 uFrames[5];
  uniform float uExplode;
  uniform float uUnit;
  uniform vec4 uRoleA[16];
  varying vec3 vCol;
  varying vec2 vSurf;
  varying float vGlow;
  varying float vHide;
  mat4 qJ;
  vec3 qOff;
  void qInit() {
    int p = int(aPart + 0.5);
    vec4 ex = texelFetch(uParts, ivec2(p, 0), 0);
    vec4 fr = texelFetch(uParts, ivec2(p, 1), 0);
    qJ = uFrames[int(fr.x + 0.5)];
    float k = smoothstep(ex.w, min(1.0, ex.w + 0.62), uExplode);
    qOff = ex.xyz * k;
    vHide = fr.y;
    vec4 a = uRoleA[int(aRole + 0.5)];
    vCol = a.rgb * fr.z;
    vSurf = vec2(fract(a.a), floor(a.a) / 100.0);
    vGlow = fr.w > 0.5 ? 1.0 : 0.0;
  }
`;
function inject(m, uniforms, { surface = true } = {}) {
  m.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, uniforms);
    s.vertexShader = PARS + s.vertexShader
      .replace('void main() {', 'void main() {\n  qInit();')
      .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = mat3(qJ) * vec3(normal);')
      .replace('#include <begin_vertex>', 'vec3 transformed = (qJ * vec4(position * uUnit, 1.0)).xyz + qOff;');
    s.fragmentShader = `
      varying vec3 vCol; varying vec2 vSurf; varying float vGlow; varying float vHide;
      uniform float uExplode; uniform vec3 uGlow;
    ` + s.fragmentShader.replace('void main() {', `void main() {
      if (vHide > 0.5) {
        float h = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
        if (uExplode * 9.0 > h) discard;
      }`);
    if (surface) s.fragmentShader = s.fragmentShader
      .replace('#include <color_fragment>', 'diffuseColor.rgb = vCol;')
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = max(vSurf.x, 0.05);')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vSurf.y;')
      .replace('#include <emissivemap_fragment>', 'totalEmissiveRadiance += vGlow * uGlow;');
  };
}

function hash01(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1000) / 1000;
}

function roundedShape(hw, hh, r) {
  const s = new THREE.Shape();
  s.moveTo(-hw + r, -hh);
  s.lineTo(hw - r, -hh);
  s.quadraticCurveTo(hw, -hh, hw, -hh + r);
  s.lineTo(hw, hh - r);
  s.quadraticCurveTo(hw, hh, hw - r, hh);
  s.lineTo(-hw + r, hh);
  s.quadraticCurveTo(-hw, hh, -hw, hh - r);
  s.lineTo(-hw, -hh + r);
  s.quadraticCurveTo(-hw, -hh, -hw + r, -hh);
  return s;
}

function rot(origin, axis, deg, out = new THREE.Matrix4()) {
  const [ox, oy, oz] = origin;
  const R = new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(...axis).normalize(), THREE.MathUtils.degToRad(deg));
  return out.makeTranslation(ox, oy, oz).multiply(R).multiply(new THREE.Matrix4().makeTranslation(-ox, -oy, -oz));
}

export const DEFAULTS = {
  explode: 0, j1: 0, j2: 0, wheel: 0,
  az: 28, el: 8, dist: 2.1, tx: 0, ty: 0.19, tz: 0, shiftX: 0, shiftY: 0,
  rigX: 0, rigZ: 0, rigYaw: 0,
  dark: 0, scan: 0, path: 0,
};

export async function createStage(canvas, { still = false, phone = false, base = 'media/robot' } = {}) {
  const [man, bin] = await Promise.all([
    fetch(`${base}/qubit.json?v=1`).then((r) => r.json()),
    fetch(`${base}/qubit.bin?v=1`).then((r) => r.arrayBuffer()),
  ]);
  await MeshoptDecoder.ready;
  const vb = new Uint8Array(man.vertices * man.stride);
  MeshoptDecoder.decodeVertexBuffer(vb, man.vertices, man.stride, new Uint8Array(bin, 0, man.vBytes));
  const ib = new Uint8Array(man.indices * 4);
  MeshoptDecoder.decodeIndexBuffer(ib, man.indices, 4, new Uint8Array(bin, man.vBytes, man.iBytes));

  const n = man.vertices;
  const dv = new DataView(vb.buffer);
  const pos = new Int16Array(n * 3);
  const nrm = new Int8Array(n * 3);
  const prt = new Uint16Array(n);
  const rol = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * man.stride;
    pos[i * 3] = dv.getInt16(o, true);
    pos[i * 3 + 1] = dv.getInt16(o + 2, true);
    pos[i * 3 + 2] = dv.getInt16(o + 4, true);
    prt[i] = dv.getUint16(o + 6, true);
    nrm[i * 3] = dv.getInt8(o + 8);
    nrm[i * 3 + 1] = dv.getInt8(o + 9);
    nrm[i * 3 + 2] = dv.getInt8(o + 10);
    rol[i] = dv.getUint8(o + 11);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3, true));
  geo.setAttribute('aPart', new THREE.BufferAttribute(prt, 1));
  geo.setAttribute('aRole', new THREE.BufferAttribute(rol, 1));
  geo.setIndex(new THREE.BufferAttribute(new Uint32Array(ib.buffer), 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

  // part table: row 0 = explode xyz + stage, row 1 = joint, hide-in-explode, shade, glow
  const P = man.parts.length;
  const table = new Float32Array(P * 2 * 4);
  man.parts.forEach((p, i) => {
    const stage = STAGE[p.group] ?? 0.2;
    table.set([p.explode[0] * EXPLODE_GAIN, p.explode[1] * EXPLODE_GAIN, p.explode[2] * EXPLODE_GAIN, stage], i * 4);
    const lit = /^(led-|halo-)/.test(p.id) ? 1 : 0;
    table.set([p.frame, p.group === 'Fasteners' ? 1 : 0, 0.985 + hash01(p.id) * 0.03, lit], (P + i) * 4);
  });
  const partsTex = new THREE.DataTexture(table, P, 2, THREE.RGBAFormat, THREE.FloatType);
  partsTex.minFilter = partsTex.magFilter = THREE.NearestFilter;
  partsTex.needsUpdate = true;

  const roleA = man.roles.map((r) => {
    const c = new THREE.Color(r.color); // sRGB -> linear working space
    return new THREE.Vector4(c.r, c.g, c.b, Math.round(r.metal * 100) + Math.min(r.rough, 0.99));
  });
  while (roleA.length < 16) roleA.push(new THREE.Vector4());

  const frames = [0, 1, 2, 3, 4].map(() => new THREE.Matrix4());
  const u = {
    uParts: { value: partsTex }, uFrames: { value: frames }, uExplode: { value: 0 }, uUnit: { value: man.unit },
    uRoleA: { value: roleA }, uGlow: { value: new THREE.Color(0, 0, 0) },
  };

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: still, powerPreference: 'high-performance' });
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.VSMShadowMap;
  renderer.shadowMap.autoUpdate = false;

  const scene = new THREE.Scene();
  const pm = new THREE.PMREMGenerator(renderer);
  scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
  pm.dispose();
  scene.environmentIntensity = 0.85;

  const camera = new THREE.PerspectiveCamera(26, 1, 0.05, 40);

  const key = new THREE.DirectionalLight(0xfff4e6, 1.7);
  key.position.set(0.45, 3, 1);
  key.castShadow = true;
  key.shadow.mapSize.set(phone ? 1024 : 2048, phone ? 1024 : 2048);
  key.shadow.radius = 7;
  key.shadow.blurSamples = phone ? 10 : 18;
  key.shadow.bias = -0.0006;
  const sc = key.shadow.camera;
  sc.left = -1.3; sc.right = 1.3; sc.top = 1.3; sc.bottom = -1.3; sc.near = 0.2; sc.far = 6;
  scene.add(key, key.target);
  const fill = new THREE.DirectionalLight(0xffffff, 0.7);
  fill.position.set(-2, 1.1, 1.4);
  scene.add(fill);
  const rim = new THREE.DirectionalLight(0xbfd0ff, 0);
  rim.position.set(-1.6, 1.3, -1.6);
  scene.add(rim);

  // the robot rig: root maps robot frame to the scene
  const rig = new THREE.Group();
  scene.add(rig);
  const root = new THREE.Group();
  root.matrixAutoUpdate = false;
  root.matrix.set(-0.001, 0, 0, 0, 0, 0, 0.001, 0, 0, 0.001, 0, 0, 0, 0, 0, 1);
  rig.add(root);

  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff });
  inject(mat, u);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  inject(depth, u, { surface: false });
  mesh.customDepthMaterial = depth;
  root.add(mesh);

  // the phone's front: glass and the screen Qubit lives on, on its +y face
  const ph = man.phone;
  const cx = (ph.lo[0] + ph.hi[0]) / 2;
  const cz = (ph.lo[2] + ph.hi[2]) / 2;
  const hw = (ph.hi[0] - ph.lo[0]) / 2;
  const hh = (ph.hi[2] - ph.lo[2]) / 2;
  const phonePart = man.parts.findIndex((p) => p.id === 'phone');
  const glassRole = man.roles.findIndex((r) => r.name === 'glass');
  function faceGeo(halfW, halfH, r, lift) {
    const g = new THREE.ShapeGeometry(roundedShape(halfW, halfH, r), 12);
    const p = g.attributes.position;
    const uv = g.attributes.uv;
    const N = p.count;
    const out = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const sx = p.getX(i);
      const sy = p.getY(i);
      // seen from the front you look along -y, so robot -x is your right: u runs that way
      out[i * 3] = (cx - sx) / man.unit;
      out[i * 3 + 1] = (ph.hi[1] + lift) / man.unit;
      out[i * 3 + 2] = (cz + sy) / man.unit;
      uv.setXY(i, sx / (2 * halfW) + 0.5, sy / (2 * halfH) + 0.5);
    }
    g.setAttribute('position', new THREE.BufferAttribute(out, 3));
    const nn = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) nn[i * 3 + 1] = 1;
    g.setAttribute('normal', new THREE.BufferAttribute(nn, 3));
    g.setAttribute('aPart', new THREE.BufferAttribute(new Float32Array(N).fill(phonePart), 1));
    g.setAttribute('aRole', new THREE.BufferAttribute(new Float32Array(N).fill(glassRole), 1));
    return g;
  }
  const glass = new THREE.Mesh(faceGeo(hw - ph.edge, hh - ph.edge, ph.cornerR - ph.edge, 0.2), mat);
  glass.frustumCulled = false;
  root.add(glass);

  const face = createFace(hw * 2 - ph.bezel * 2, hh * 2 - ph.bezel * 2);
  inject(face.material, u, { surface: false });
  const screen = new THREE.Mesh(faceGeo(hw - ph.bezel, hh - ph.bezel, ph.screenR, 0.4), face.material);
  screen.frustumCulled = false;
  root.add(screen);

  // floor: only the shadow shows on the white page
  const floorMat = new THREE.ShadowMaterial({ opacity: 0.16 });
  floorMat.onBeforeCompile = (sh) => {
    sh.vertexShader = `varying vec2 vQ;
` + sh.vertexShader.replace('void main() {', `void main() {
  vQ = position.xy;`);
    sh.fragmentShader = `varying vec2 vQ;
` + sh.fragmentShader.replace('#include <tonemapping_fragment>', `gl_FragColor.a *= smoothstep(1.2, 0.72, length(vQ));
#include <tonemapping_fragment>`);
  };
  const floor = new THREE.Mesh(new THREE.CircleGeometry(1.2, 64), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  // ---------------------------------------------------------------- the room he'll map: simulated
  const room = createRoom();
  scene.add(room.group);

  const s = { ...DEFAULTS };
  let vw = 1;
  let vh = 1;
  let dirtyShadow = true;
  const J = man.joints;

  function apply() {
    u.uExplode.value = s.explode;
    const f = frames;
    rot(J.J1.origin, J.J1.axis, s.j1, f[1]);
    f[2].copy(f[1]).multiply(rot(J.J2.origin, J.J2.axis, s.j2));
    rot(J['wheel-left'].origin, J['wheel-left'].axis, s.wheel, f[3]);
    rot(J['wheel-right'].origin, J['wheel-right'].axis, s.wheel, f[4]);

    const az = THREE.MathUtils.degToRad(s.az);
    const el = THREE.MathUtils.degToRad(s.el);
    camera.position.set(
      s.tx + s.dist * Math.cos(el) * Math.sin(az),
      s.ty + s.dist * Math.sin(el),
      s.tz + s.dist * Math.cos(el) * Math.cos(az),
    );
    camera.lookAt(s.tx, s.ty, s.tz);
    camera.setViewOffset(vw, vh, -s.shiftX * vw, -s.shiftY * vh, vw, vh);

    rig.position.set(s.rigX, 0, s.rigZ);
    rig.rotation.y = s.rigYaw;
    floor.position.set(s.rigX, 0, s.rigZ);
    floorMat.opacity = 0.16 * (1 - s.dark);
    key.position.set(s.rigX + 0.45, 3, s.rigZ + 1);
    key.target.position.set(s.rigX, 0.1, s.rigZ);

    scene.environmentIntensity = THREE.MathUtils.lerp(0.85, 0.32, s.dark);
    key.intensity = THREE.MathUtils.lerp(1.7, 1.5, s.dark);
    fill.intensity = THREE.MathUtils.lerp(0.7, 0.15, s.dark);
    rim.intensity = THREE.MathUtils.lerp(0, 3, s.dark);
    const c = face.colour.linear;
    u.uGlow.value.setRGB(c[0], c[1], c[2]).multiplyScalar(0.25 + 1.8 * s.dark);
    room.update(s);
    if (dirtyShadow) {
      renderer.shadowMap.needsUpdate = true;
      dirtyShadow = false;
    }
  }

  const SHADOW_KEYS = ['explode', 'j1', 'j2', 'wheel', 'rigX', 'rigZ', 'rigYaw'];
  return {
    man,
    renderer,
    face,
    camera,
    state: s,
    set(next) {
      for (const k of Object.keys(next)) {
        if (s[k] === next[k]) continue;
        if (SHADOW_KEYS.includes(k)) dirtyShadow = true;
        s[k] = next[k];
      }
    },
    resize(w, h, dpr) {
      vw = w;
      vh = h;
      renderer.setPixelRatio(dpr);
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    },
    /** dt in seconds; 0 keeps Qubit where he is. */
    render(dt = 0) {
      if (dt) face.update(dt);
      apply();
      renderer.render(scene, camera);
    },
    room,
    WHEEL_R,
    dispose() {
      geo.dispose();
      glass.geometry.dispose();
      screen.geometry.dispose();
      floor.geometry.dispose();
      floorMat.dispose();
      mat.dispose();
      depth.dispose();
      face.dispose();
      partsTex.dispose();
      room.dispose();
      scene.environment.dispose();
      key.shadow.map?.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}

function createRoom() {
  // A made-up room, 4 x 4 m, seeded. Nothing here is a real capture.
  let seed = 20261031;
  const r = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pts = [];
  const add = (x, y, z) => pts.push(x, y, z);
  const box = (x0, x1, y0, y1, z0, z1, count) => {
    const a = [(x1 - x0) * (z1 - z0), (x1 - x0) * (y1 - y0), (z1 - z0) * (y1 - y0)];
    const sum = a[0] + a[1] + a[2];
    for (let i = 0; i < count; i++) {
      const w = r() * sum;
      const [u, v] = [r(), r()];
      if (w < a[0]) add(x0 + u * (x1 - x0), y1, z0 + v * (z1 - z0));
      else if (w < a[0] + a[1]) add(x0 + u * (x1 - x0), y0 + v * (y1 - y0), r() < 0.5 ? z0 : z1);
      else add(r() < 0.5 ? x0 : x1, y0 + v * (y1 - y0), z0 + u * (z1 - z0));
    }
  };
  for (let i = 0; i < 26000; i++) add(-2 + r() * 4, 0, -2 + r() * 4); // floor
  for (let i = 0; i < 16000; i++) add(-2 + r() * 4, r() * 2.2, -2); // back wall
  for (let i = 0; i < 16000; i++) add(-2, r() * 2.2, -2 + r() * 4); // left wall
  for (let i = 0; i < 9000; i++) add(2, r() * 2.2, -2 + r() * 4); // right wall
  box(-1.75, -0.65, 0, 0.42, -1.75, -0.95, 5200); // sofa seat
  box(-1.75, -0.65, 0.42, 0.78, -1.95, -1.72, 2200); // sofa back
  box(0.2, 0.95, 0.38, 0.42, -0.75, -0.25, 2200); // coffee table top
  for (const [x, z] of [[0.24, -0.71], [0.91, -0.71], [0.24, -0.29], [0.91, -0.29]]) box(x - 0.015, x + 0.015, 0, 0.38, z - 0.015, z + 0.015, 120);
  box(1.3, 1.9, 0, 0.9, 0.6, 1.1, 2600); // cabinet
  box(-1.7, -1.3, 0, 1.3, 1.2, 1.7, 1800); // plant-sized post

  const P = new Float32Array(pts);
  const N = P.length / 3;
  const rnd = new Float32Array(N);
  for (let i = 0; i < N; i++) rnd[i] = r();
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(P, 3));
  g.setAttribute('aRnd', new THREE.BufferAttribute(rnd, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 10);

  const uniforms = { uScan: { value: 0 }, uFade: { value: 0 }, uOrigin: { value: new THREE.Vector3() }, uSize: { value: 5 } };
  const pm = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    vertexShader: /* glsl */ `
      attribute float aRnd;
      uniform float uScan, uSize; uniform vec3 uOrigin;
      varying float vA; varying float vH;
      void main() {
        float d = distance(position.xz, uOrigin.xz);
        float front = uScan * 5.2;
        vA = smoothstep(front, front - 0.5, d + aRnd * 0.35);
        vH = position.y;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = uSize * (0.75 + aRnd * 0.5) * (1.0 + 2.2 * smoothstep(front - 0.7, front, d)) / max(-mv.z * 0.34, 0.4);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uFade; varying float vA; varying float vH;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        if (dot(c, c) > 0.25 || vA < 0.01) discard;
        vec3 low = vec3(0.92, 0.60, 0.16), high = vec3(0.86, 0.88, 0.96);
        gl_FragColor = vec4(mix(low, high, smoothstep(0.0, 1.3, vH)), vA * uFade * mix(0.7, 1.0, smoothstep(0.0, 0.5, vH)));
      }`,
  });
  const cloud = new THREE.Points(g, pm);
  cloud.frustumCulled = false;

  // his route round the coffee table, on the floor
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0, 0.9), new THREE.Vector3(-0.12, 0, 0.35), new THREE.Vector3(-0.28, 0, -0.2),
    new THREE.Vector3(-0.05, 0, -0.95), new THREE.Vector3(0.72, 0, -1.28), new THREE.Vector3(1.28, 0, -0.9),
  ], false, 'catmullrom', 0.5);
  const SEG = 260;
  const WIDTH = 0.012;
  const v = new Float32Array((SEG + 1) * 6);
  const idx = [];
  const lens = curve.getLengths(SEG);
  for (let i = 0; i <= SEG; i++) {
    const t = i / SEG;
    const p = curve.getPointAt(t);
    const d = curve.getTangentAt(t);
    v.set([p.x - d.z * WIDTH, 0.002, p.z + d.x * WIDTH, p.x + d.z * WIDTH, 0.002, p.z - d.x * WIDTH], i * 6);
    if (i < SEG) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
  }
  const lg = new THREE.BufferGeometry();
  lg.setAttribute('position', new THREE.BufferAttribute(v, 3));
  lg.setIndex(idx);
  const lm = new THREE.MeshBasicMaterial({ color: 0xec9a2a, transparent: true, opacity: 0, toneMapped: false, side: THREE.DoubleSide, depthWrite: false });
  const line = new THREE.Mesh(lg, lm);
  line.frustumCulled = false;

  const group = new THREE.Group();
  group.add(cloud, line);
  group.visible = false;

  return {
    group,
    curve,
    length: lens[SEG],
    uniforms,
    dispose() {
      g.dispose();
      pm.dispose();
      lg.dispose();
      lm.dispose();
    },
    update(s) {
      const on = s.dark > 0.01;
      group.visible = on;
      if (!on) return;
      uniforms.uScan.value = s.scan;
      uniforms.uFade.value = s.dark;
      uniforms.uOrigin.value.set(0, 0, 0.9);
      lm.opacity = s.dark;
      line.geometry.setDrawRange(0, Math.round(s.path * SEG) * 6);
    },
  };
}
