import * as THREE from "./vendor/three.module.js";

const canvas = document.getElementById("bg3d");
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

let renderer = null;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "low-power" });
} catch {
  canvas.remove();
}

if (renderer) {
  const DPR = Math.min(window.devicePixelRatio || 1, 1.6);
  renderer.setPixelRatio(DPR);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(52, window.innerWidth / window.innerHeight, 0.1, 80);
  camera.position.set(0, 0, 11);

  const group = new THREE.Group();
  scene.add(group);

  /* wireframe shells */
  const blue = new THREE.Color(0x5b8cff);
  const mint = new THREE.Color(0x37e8b0);

  const shellA = new THREE.LineSegments(
    new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(3.4, 1)),
    new THREE.LineBasicMaterial({ color: blue, transparent: true, opacity: 0.16 })
  );
  shellA.position.set(6.4, -1.6, -4);
  group.add(shellA);

  const shellB = new THREE.LineSegments(
    new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(1.7, 0)),
    new THREE.LineBasicMaterial({ color: mint, transparent: true, opacity: 0.2 })
  );
  shellB.position.set(-6.2, 2.6, -6);
  group.add(shellB);

  const shellC = new THREE.LineSegments(
    new THREE.WireframeGeometry(new THREE.TorusKnotGeometry(1.1, 0.3, 64, 6)),
    new THREE.LineBasicMaterial({ color: blue, transparent: true, opacity: 0.1 })
  );
  shellC.position.set(-7.4, -4.4, -5);
  group.add(shellC);

  /* drifting particles */
  const count = window.innerWidth < 760 ? 130 : 280;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const speeds = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    positions[i * 3] = THREE.MathUtils.randFloat(-12, 12);
    positions[i * 3 + 1] = THREE.MathUtils.randFloat(-7, 7);
    positions[i * 3 + 2] = THREE.MathUtils.randFloat(-9, 2);
    const c = Math.random() > 0.62 ? mint : blue;
    const dim = THREE.MathUtils.randFloat(0.35, 1);
    colors[i * 3] = c.r * dim;
    colors[i * 3 + 1] = c.g * dim;
    colors[i * 3 + 2] = c.b * dim;
    speeds[i] = THREE.MathUtils.randFloat(0.04, 0.16);
  }
  const pGeo = new THREE.BufferGeometry();
  pGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  pGeo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const points = new THREE.Points(
    pGeo,
    new THREE.PointsMaterial({
      size: 0.045,
      vertexColors: true,
      transparent: true,
      opacity: 0.8,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  );
  scene.add(points);

  const pointer = { x: 0, y: 0 };
  window.addEventListener("pointermove", (event) => {
    pointer.x = (event.clientX / window.innerWidth - 0.5) * 2;
    pointer.y = (event.clientY / window.innerHeight - 0.5) * 2;
  });

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.6));
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  let raf = 0;
  let elapsed = 0;
  const clock = new THREE.Clock();
  let running = true;

  document.addEventListener("visibilitychange", () => {
    running = !document.hidden;
    if (running) {
      clock.getDelta();
      loop();
    }
  });

  function draw(t) {
    shellA.rotation.y = t * 0.09;
    shellA.rotation.x = t * 0.05;
    shellB.rotation.y = -t * 0.14;
    shellB.rotation.z = t * 0.08;
    shellC.rotation.y = t * 0.11;
    shellC.rotation.x = t * 0.07;

    group.position.x += (pointer.x * 0.35 - group.position.x) * 0.02;
    group.position.y += (pointer.y * -0.25 - group.position.y) * 0.02;

    const pos = pGeo.attributes.position;
    for (let i = 0; i < count; i += 1) {
      let y = pos.getY(i) + speeds[i] * 0.02;
      if (y > 7) y = -7;
      pos.setY(i, y);
    }
    pos.needsUpdate = true;
    points.rotation.y = t * 0.008;
  }

  function loop() {
    cancelAnimationFrame(raf);
    if (!running) return;
    raf = requestAnimationFrame(loop);
    const dt = Math.min(clock.getDelta(), 0.05);
    elapsed += dt;
    if (!reduceMotion) draw(elapsed);
    renderer.render(scene, camera);
  }

  if (reduceMotion) {
    draw(0);
    renderer.render(scene, camera);
  } else {
    loop();
  }
}
