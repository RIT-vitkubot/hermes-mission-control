// 3D BMO mascot built from Three.js primitives (no external model).
// Reacts to the `mc-state` event dispatched by app.js:
//   happy   -> teal glow, calm float, blinking, smile
//   worried -> amber glow, glancing eyes, flat mouth
//   alarmed -> red pulsing glow, shaking, open mouth, flailing arms
import * as THREE from "three";

const canvas = document.getElementById("bmo-canvas");
const stage = document.getElementById("bmo-stage");

const PROFILE_COLORS = {
  default: 0x3ef2ff, editor: 0xff4fd8, obchodnik: 0xffc53d,
  programovani: 0x3dffa8, skola: 0x9b6bff, tegistic: 0xff8a3d,
};
const MOODS = {
  happy: { glow: new THREE.Color(0x3ef2ff), screen: new THREE.Color(0xc8ffe9), speed: 1.0 },
  worried: { glow: new THREE.Color(0xffc53d), screen: new THREE.Color(0xfff2b8), speed: 1.6 },
  alarmed: { glow: new THREE.Color(0xff2d55), screen: new THREE.Color(0xffc2cc), speed: 3.0 },
};

let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
} catch (e) {
  document.getElementById("bmo-fallback").classList.remove("hidden");
  throw e;
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x04060d, 0.045);
const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
camera.position.set(0, 1.6, 9);
camera.lookAt(0, 0.6, 0);

// ---- lights
scene.add(new THREE.AmbientLight(0x6688cc, 0.55));
const key = new THREE.DirectionalLight(0xffffff, 1.1);
key.position.set(3, 5, 6);
scene.add(key);
const moodLight = new THREE.PointLight(0x3ef2ff, 18, 14, 1.6);
moodLight.position.set(0, 1.2, 2.5);
scene.add(moodLight);
const rim = new THREE.PointLight(0xff4fd8, 10, 12, 1.8);
rim.position.set(-3, 2.5, -3);
scene.add(rim);

// ---- helpers
function glowTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d");
  const grd = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(0.25, "rgba(255,255,255,0.45)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(c);
}
const GLOW_TEX = glowTexture();
function glowSprite(color, size, opacity) {
  const m = new THREE.SpriteMaterial({
    map: GLOW_TEX, color, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const s = new THREE.Sprite(m);
  s.scale.set(size, size, 1);
  return s;
}
const mat = (color, opts = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.15, ...opts });

// ---- BMO
const bmo = new THREE.Group();
scene.add(bmo);

const bodyMat = mat(0x5fd6bd, { emissive: 0x0a3a32, emissiveIntensity: 0.6 });
const body = new THREE.Mesh(new THREE.BoxGeometry(2.2, 2.7, 1.4), bodyMat);
bmo.add(body);
// bevel-ish edges: thin darker frame behind body
const back = new THREE.Mesh(new THREE.BoxGeometry(2.1, 2.6, 0.2), mat(0x3aa996));
back.position.z = -0.72;
bmo.add(back);

// screen (face)
const screenMat = new THREE.MeshStandardMaterial({ color: 0xc8ffe9, emissive: 0x9affd8, emissiveIntensity: 0.35, roughness: 0.2 });
const bezel = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.25, 0.06), mat(0x2b7f71));
bezel.position.set(0, 0.55, 0.71);
bmo.add(bezel);
const screen = new THREE.Mesh(new THREE.PlaneGeometry(1.62, 1.08), screenMat);
screen.position.set(0, 0.55, 0.745);
bmo.add(screen);

const faceMat = new THREE.MeshBasicMaterial({ color: 0x0b2a24 });
const face = new THREE.Group();
face.position.set(0, 0.55, 0.75);
bmo.add(face);
const eyeGeo = new THREE.CircleGeometry(0.085, 20);
const eyeL = new THREE.Mesh(eyeGeo, faceMat);
const eyeR = new THREE.Mesh(eyeGeo, faceMat);
eyeL.position.set(-0.36, 0.14, 0.001);
eyeR.position.set(0.36, 0.14, 0.001);
face.add(eyeL, eyeR);
// eyebrows (only visible when worried/alarmed)
const browGeo = new THREE.PlaneGeometry(0.24, 0.035);
const browL = new THREE.Mesh(browGeo, faceMat);
const browR = new THREE.Mesh(browGeo, faceMat);
browL.position.set(-0.36, 0.33, 0.001);
browR.position.set(0.36, 0.33, 0.001);
face.add(browL, browR);
// mouths
const smile = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.028, 8, 24, Math.PI), faceMat);
smile.rotation.z = Math.PI;
smile.position.set(0, -0.08, 0.001);
const flat = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.04), faceMat);
flat.position.set(0, -0.2, 0.001);
const open = new THREE.Mesh(new THREE.CircleGeometry(0.13, 24), new THREE.MeshBasicMaterial({ color: 0x3a0d18 }));
open.scale.set(1.2, 0.85, 1);
open.position.set(0, -0.2, 0.001);
face.add(smile, flat, open);

// front controls: D-pad, buttons, slot
const dpadMat = mat(0xffd23f, { emissive: 0x332600 });
const dpadH = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.13, 0.08), dpadMat);
const dpadV = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.42, 0.08), dpadMat);
dpadH.position.set(-0.55, -0.62, 0.72);
dpadV.position.set(-0.55, -0.62, 0.72);
bmo.add(dpadH, dpadV);
const btnRed = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.08, 24), mat(0xff3b5c, { emissive: 0x440010 }));
btnRed.rotation.x = Math.PI / 2;
btnRed.position.set(0.62, -0.58, 0.72);
const btnGreen = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.08, 24), mat(0x3dffa8, { emissive: 0x003a20 }));
btnGreen.rotation.x = Math.PI / 2;
btnGreen.position.set(0.32, -0.88, 0.72);
const btnBlue = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.08, 3), mat(0x3e8bff, { emissive: 0x001a44 }));
btnBlue.rotation.x = Math.PI / 2;
btnBlue.position.set(0.25, -0.5, 0.72);
const slot = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.06, 0.04), mat(0x1f5d52));
slot.position.set(-0.2, -0.22, 0.71);
bmo.add(btnRed, btnGreen, btnBlue, slot);

// limbs
const limbMat = mat(0x4fc4ad);
function limb(len) {
  const g = new THREE.Group();
  const m = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, len, 12), limbMat);
  m.position.y = -len / 2;
  const hand = new THREE.Mesh(new THREE.SphereGeometry(0.1, 16, 12), limbMat);
  hand.position.y = -len;
  g.add(m, hand);
  return g;
}
const armL = limb(0.9);
const armR = limb(0.9);
armL.position.set(-1.12, -0.1, 0);
armR.position.set(1.12, -0.1, 0);
armL.rotation.z = -0.5;
armR.rotation.z = 0.5;
const legL = limb(0.7);
const legR = limb(0.7);
legL.position.set(-0.5, -1.35, 0);
legR.position.set(0.5, -1.35, 0);
bmo.add(armL, armR, legL, legR);

// glow halo behind BMO
const halo = glowSprite(0x3ef2ff, 7.5, 0.55);
halo.position.set(0, 0.2, -1.2);
bmo.add(halo);

// ---- floor: holo ring + grid
const floorY = -2.25;
const ringMat = new THREE.MeshBasicMaterial({ color: 0x3ef2ff, transparent: true, opacity: 0.65, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
const ring = new THREE.Mesh(new THREE.RingGeometry(1.7, 1.78, 64), ringMat);
ring.rotation.x = -Math.PI / 2;
ring.position.y = floorY;
scene.add(ring);
const ring2 = new THREE.Mesh(new THREE.RingGeometry(2.6, 2.63, 64), ringMat.clone());
ring2.material.opacity = 0.3;
ring2.rotation.x = -Math.PI / 2;
ring2.position.y = floorY;
scene.add(ring2);
const grid = new THREE.GridHelper(40, 40, 0x3ef2ff, 0x1a3a5a);
grid.position.y = floorY - 0.01;
grid.material.transparent = true;
grid.material.opacity = 0.18;
scene.add(grid);

// ---- profile orbs orbiting BMO (one per Hermes profile)
const orbs = {};
const orbGroup = new THREE.Group();
scene.add(orbGroup);
Object.keys(PROFILE_COLORS).forEach((p, i, arr) => {
  const color = PROFILE_COLORS[p];
  const g = new THREE.Group();
  const core = new THREE.Mesh(new THREE.SphereGeometry(0.13, 20, 16),
    new THREE.MeshBasicMaterial({ color }));
  const glow = glowSprite(color, 0.9, 0.8);
  g.add(core, glow);
  g.userData = { angle: (i / arr.length) * Math.PI * 2, core, glow, color: new THREE.Color(color) };
  orbGroup.add(g);
  orbs[p] = g;
});

// ---- particles
const N = 400;
const pGeo = new THREE.BufferGeometry();
const pos = new Float32Array(N * 3);
for (let i = 0; i < N; i++) {
  pos[i * 3] = (Math.random() - 0.5) * 24;
  pos[i * 3 + 1] = Math.random() * 10 - 2;
  pos[i * 3 + 2] = (Math.random() - 0.5) * 16 - 3;
}
pGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
const particles = new THREE.Points(pGeo, new THREE.PointsMaterial({
  color: 0x3ef2ff, size: 0.05, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false,
}));
scene.add(particles);

// ---- state handling
let mood = "happy";
const cur = { glow: MOODS.happy.glow.clone(), screen: MOODS.happy.screen.clone(), speed: 1 };
let agentState = {};

function applyState(st) {
  const m = (st && st.summary && st.summary.mood) || "happy";
  mood = MOODS[m] ? m : "happy";
  agentState = {};
  ((st && st.agents) || []).forEach((a) => { agentState[a.profile] = a; });
}
window.addEventListener("mc-state", (e) => applyState(e.detail));
if (window.__mcLastState) applyState(window.__mcLastState);

const pointer = { x: 0, y: 0 };
stage.addEventListener("pointermove", (e) => {
  const r = stage.getBoundingClientRect();
  pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
  pointer.y = ((e.clientY - r.top) / r.height) * 2 - 1;
});
stage.addEventListener("pointerleave", () => { pointer.x = 0; pointer.y = 0; });

// ---- resize
function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  // keep BMO framed on narrow screens
  camera.position.z = w / h < 1 ? 12 : 9;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);
resize();

// ---- animation loop
const clock = new THREE.Clock();
let t = 0;
let nextBlink = 2;
let visible = true;
new IntersectionObserver((entries) => { visible = entries[0].isIntersecting; }).observe(stage);

function animate() {
  requestAnimationFrame(animate);
  if (!visible || document.hidden) return;
  const dt = Math.min(clock.getDelta(), 0.05);
  const target = MOODS[mood];
  cur.glow.lerp(target.glow, 0.05);
  cur.screen.lerp(target.screen, 0.05);
  cur.speed += (target.speed - cur.speed) * 0.05;
  t += dt * cur.speed;

  // float / shake
  const alarmed = mood === "alarmed";
  bmo.position.y = Math.sin(t * 1.6) * 0.15 + 0.1;
  bmo.position.x = alarmed ? Math.sin(t * 40) * 0.05 : 0;
  bmo.rotation.y += ((pointer.x * 0.5 + Math.sin(t * 0.5) * 0.15) - bmo.rotation.y) * 0.05;
  bmo.rotation.x += ((pointer.y * 0.15) - bmo.rotation.x) * 0.05;
  bmo.rotation.z = alarmed ? Math.sin(t * 25) * 0.03 : Math.sin(t * 0.8) * 0.02;

  // limbs
  if (alarmed) {
    armL.rotation.z = -1.9 + Math.sin(t * 9) * 0.6;
    armR.rotation.z = 1.9 - Math.sin(t * 9 + 1) * 0.6;
  } else if (mood === "worried") {
    armL.rotation.z = -0.25 + Math.sin(t * 2) * 0.08;
    armR.rotation.z = 0.25 - Math.sin(t * 2) * 0.08;
  } else {
    armL.rotation.z = -0.45 + Math.sin(t * 1.6) * 0.12;
    armR.rotation.z = 0.7 + Math.sin(t * 3.2) * 0.45; // friendly wave
  }
  legL.rotation.x = Math.sin(t * 1.6) * 0.12;
  legR.rotation.x = -Math.sin(t * 1.6) * 0.12;

  // face
  smile.visible = mood === "happy";
  flat.visible = mood === "worried";
  open.visible = alarmed;
  browL.visible = browR.visible = mood !== "happy";
  browL.rotation.z = alarmed ? -0.45 : -0.2;
  browR.rotation.z = alarmed ? 0.45 : 0.2;
  if (alarmed) open.scale.y = 0.85 + Math.sin(t * 6) * 0.25;
  const glance = mood === "worried" ? Math.sin(t * 1.2) * 0.07 : pointer.x * 0.05;
  eyeL.position.x = -0.36 + glance;
  eyeR.position.x = 0.36 + glance;
  nextBlink -= dt;
  const blinking = nextBlink < 0.12 && nextBlink > 0;
  eyeL.scale.y = eyeR.scale.y = blinking ? 0.12 : (alarmed ? 1.4 : 1);
  if (nextBlink <= 0) nextBlink = 2 + Math.random() * 3;

  screenMat.color.copy(cur.screen);
  screenMat.emissive.copy(cur.screen).multiplyScalar(0.6);
  screenMat.emissiveIntensity = alarmed ? 0.4 + Math.abs(Math.sin(t * 4)) * 0.5 : 0.35;

  // glow + lights
  halo.material.color.copy(cur.glow);
  halo.material.opacity = alarmed ? 0.45 + Math.abs(Math.sin(t * 3)) * 0.4 : 0.45 + Math.sin(t) * 0.08;
  moodLight.color.copy(cur.glow);
  ringMat.color.copy(cur.glow);
  ring2.material.color.copy(cur.glow);
  ring.scale.setScalar(1 + Math.sin(t * 2) * 0.03);
  ring2.rotation.z += dt * 0.2;
  particles.material.color.copy(cur.glow);
  particles.rotation.y += dt * 0.02;

  // orbs: per-profile state
  Object.keys(orbs).forEach((p, i) => {
    const g = orbs[p];
    const a = agentState[p];
    const ud = g.userData;
    ud.angle += dt * (0.35 + (a && a.busy ? 0.6 : 0));
    const r = 3.1;
    g.position.set(Math.cos(ud.angle) * r, 0.3 + Math.sin(ud.angle * 2 + i) * 0.35, Math.sin(ud.angle) * r * 0.55);
    let color = ud.color;
    let op = 0.8;
    if (a && a.connected === false) { color = MOODS.alarmed.glow; op = 0.5 + Math.abs(Math.sin(t * 5)) * 0.5; }
    else if (!a || a.connected == null) { op = 0.25; }
    g.userData.core.material.color.copy(color);
    g.userData.glow.material.color.copy(color);
    g.userData.glow.material.opacity = op;
    const s = a && a.busy ? 1.2 + Math.sin(t * 6) * 0.15 : 1;
    g.scale.setScalar(s);
  });

  renderer.render(scene, camera);
}
animate();
