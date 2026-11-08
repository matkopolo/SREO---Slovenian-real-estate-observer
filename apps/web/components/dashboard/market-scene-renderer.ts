import * as THREE from "three";

/** Camera angles, kept across remounts so selecting a year does not reset the rotation. */
const DEFAULT_VIEW = { theta: -0.62, phi: 1.02 };
const view = { ...DEFAULT_VIEW };
const clampView = () => {
  view.theta = Math.max(-1.35, Math.min(1.35, view.theta));
  view.phi = Math.max(0.5, Math.min(1.4, view.phi));
};

export interface MarketSceneHandle {
  /** Highlight another period without recreating the WebGL context. */
  select: (index: number) => void;
  dispose: () => void;
}

/**
 * One renderer, rendered on demand, with explicit GPU/event cleanup.
 * The camera looks at the bars from an angle (orthographic, so equal counts keep equal
 * heights) and can be dragged to rotate; a click without dragging selects a period.
 */
export function mountMarketScene(host: HTMLElement, counts: number[], selected: number,
  onSelect: (index: number) => void, onFailure: () => void): MarketSceneHandle {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.setClearColor(0x000000, 0);
  host.appendChild(renderer.domElement);
  renderer.domElement.setAttribute("aria-hidden", "true");
  renderer.domElement.style.touchAction = "pan-y";
  renderer.domElement.style.cursor = "grab";
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
  const width = Math.max(counts.length, 4);
  const max = Math.max(1, ...counts);
  const geometry = new THREE.BoxGeometry(.66, 1, .9);
  const regular = new THREE.MeshStandardMaterial({ color: 0x548779, roughness: .8 });
  const active = new THREE.MeshStandardMaterial({ color: 0xc18c46, roughness: .6 });
  const meshes = counts.map((count, index) => {
    const mesh = new THREE.Mesh(geometry, index === selected ? active : regular);
    const height = Math.max(0.02, count / max * 4);
    mesh.scale.y = height;
    mesh.position.set(index - (counts.length - 1) / 2, height / 2, 0);
    mesh.userData.index = index;
    scene.add(mesh);
    return mesh;
  });
  scene.add(new THREE.HemisphereLight(0xffffff, 0x657b72, 2.4));
  const light = new THREE.DirectionalLight(0xffffff, 2.6);
  light.position.set(-4, 8, 6);
  scene.add(light);
  const floorGeometry = new THREE.PlaneGeometry(width + 1.5, 3);
  const floorMaterial = new THREE.MeshStandardMaterial({ color: 0xe6ece8, roughness: 1 });
  const floor = new THREE.Mesh(floorGeometry, floorMaterial);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.001;
  scene.add(floor);
  const grid = new THREE.GridHelper(width + 2, Math.max(6, counts.length + 2), 0x9baea6, 0xd7dfda);
  scene.add(grid);
  const target = new THREE.Vector3(0, 1.6, 0);

  const render = () => {
    const radius = 20;
    camera.position.set(
      target.x + radius * Math.sin(view.phi) * Math.sin(view.theta),
      target.y + radius * Math.cos(view.phi),
      target.z + radius * Math.sin(view.phi) * Math.cos(view.theta));
    camera.lookAt(target);
    camera.updateProjectionMatrix();
    renderer.render(scene, camera);
  };
  let frame = 0;
  const request = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; render(); }); };
  const resize = () => {
    const rect = host.getBoundingClientRect();
    const aspect = Math.max(rect.width, 1) / Math.max(rect.height, 1);
    const halfHeight = Math.max(3.4, (width + 2.5) / aspect / 2);
    camera.left = -halfHeight * aspect;
    camera.right = halfHeight * aspect;
    camera.top = halfHeight;
    camera.bottom = -halfHeight;
    renderer.setSize(Math.max(1, rect.width), Math.max(1, rect.height));
    render();
  };

  const raycaster = new THREE.Raycaster();
  let drag: { x: number; y: number; theta: number; phi: number; moved: boolean } | null = null;
  const down = (event: PointerEvent) => {
    drag = { x: event.clientX, y: event.clientY, theta: view.theta, phi: view.phi, moved: false };
    renderer.domElement.setPointerCapture?.(event.pointerId);
    renderer.domElement.style.cursor = "grabbing";
  };
  const move = (event: PointerEvent) => {
    if (!drag) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
    view.theta = drag.theta - dx * 0.008;
    view.phi = drag.phi - dy * 0.006;
    clampView();
    request();
  };
  const up = (event: PointerEvent) => {
    if (!drag) return; // press started outside the canvas
    const wasDrag = drag.moved;
    drag = null;
    renderer.domElement.releasePointerCapture?.(event.pointerId);
    renderer.domElement.style.cursor = "grab";
    if (wasDrag) return;
    const rect = renderer.domElement.getBoundingClientRect();
    raycaster.setFromCamera(new THREE.Vector2(
      (event.clientX - rect.left) / rect.width * 2 - 1,
      -(event.clientY - rect.top) / rect.height * 2 + 1), camera);
    const hit = raycaster.intersectObjects(meshes)[0];
    if (hit) onSelect(hit.object.userData.index as number);
  };
  const cancel = () => { drag = null; renderer.domElement.style.cursor = "grab"; };
  const reset = () => { Object.assign(view, DEFAULT_VIEW); request(); };
  const lost = (event: Event) => { event.preventDefault(); onFailure(); };
  renderer.domElement.addEventListener("pointerdown", down);
  renderer.domElement.addEventListener("pointermove", move);
  renderer.domElement.addEventListener("pointerup", up);
  renderer.domElement.addEventListener("pointercancel", cancel);
  renderer.domElement.addEventListener("dblclick", reset);
  renderer.domElement.addEventListener("webglcontextlost", lost);
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  resize();
  const select = (index: number) => {
    meshes.forEach((mesh, i) => { mesh.material = i === index ? active : regular; });
    request();
  };
  const dispose = () => {
    if (frame) cancelAnimationFrame(frame);
    observer.disconnect();
    renderer.domElement.removeEventListener("pointerdown", down);
    renderer.domElement.removeEventListener("pointermove", move);
    renderer.domElement.removeEventListener("pointerup", up);
    renderer.domElement.removeEventListener("pointercancel", cancel);
    renderer.domElement.removeEventListener("dblclick", reset);
    renderer.domElement.removeEventListener("webglcontextlost", lost);
    geometry.dispose(); regular.dispose(); active.dispose();
    floorGeometry.dispose(); floorMaterial.dispose();
    grid.geometry.dispose();
    for (const material of Array.isArray(grid.material) ? grid.material : [grid.material]) material.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    renderer.domElement.remove();
  };
  return { select, dispose };
}
