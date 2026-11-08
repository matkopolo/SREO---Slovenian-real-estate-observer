import * as THREE from "three";

/** One renderer, rendered on demand, with explicit GPU/event cleanup. */
export function mountMarketScene(host: HTMLElement, counts: number[], selected: number,
  onSelect: (index: number) => void, onFailure: () => void) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.setClearColor(0x000000, 0);
  host.appendChild(renderer.domElement);
  renderer.domElement.setAttribute("aria-hidden", "true");
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera();
  const width = Math.max(counts.length, 4);
  const max = Math.max(1, ...counts);
  const geometry = new THREE.BoxGeometry(.62, 1, .62);
  const regular = new THREE.MeshStandardMaterial({ color: 0x548779, roughness: .8 });
  const active = new THREE.MeshStandardMaterial({ color: 0xc18c46, roughness: .6 });
  const meshes = counts.map((count, index) => {
    const mesh = new THREE.Mesh(geometry, index === selected ? active : regular);
    const height = count / max * 4;
    mesh.scale.y = height;
    mesh.position.set(index - (counts.length - 1) / 2, height / 2, 0);
    mesh.userData.index = index;
    scene.add(mesh);
    return mesh;
  });
  scene.add(new THREE.HemisphereLight(0xffffff, 0x657b72, 3));
  const light = new THREE.DirectionalLight(0xffffff, 3);
  light.position.set(-3, 7, 5);
  scene.add(light);
  const grid = new THREE.GridHelper(width + 2, Math.max(6, counts.length + 2), 0x9baea6, 0xd7dfda);
  scene.add(grid);
  const render = () => renderer.render(scene, camera);
  const resize = () => {
    const rect = host.getBoundingClientRect();
    const aspect = Math.max(rect.width, 1) / Math.max(rect.height, 1);
    const extent = Math.max(5, (width + 3) / aspect);
    camera.left = -extent * aspect / 2;
    camera.right = extent * aspect / 2;
    camera.top = extent / 2;
    camera.bottom = -extent / 2;
    camera.position.set(0, 5, 10);
    camera.lookAt(0, 1.7, 0);
    camera.updateProjectionMatrix();
    renderer.setSize(Math.max(1, rect.width), Math.max(1, rect.height));
    render();
  };
  const raycaster = new THREE.Raycaster();
  const click = (event: MouseEvent) => {
    const rect = renderer.domElement.getBoundingClientRect();
    raycaster.setFromCamera(new THREE.Vector2(
      (event.clientX - rect.left) / rect.width * 2 - 1,
      -(event.clientY - rect.top) / rect.height * 2 + 1), camera);
    const hit = raycaster.intersectObjects(meshes)[0];
    if (hit) onSelect(hit.object.userData.index as number);
  };
  const lost = (event: Event) => { event.preventDefault(); onFailure(); };
  renderer.domElement.addEventListener("click", click);
  renderer.domElement.addEventListener("webglcontextlost", lost);
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  resize();
  return () => {
    observer.disconnect();
    renderer.domElement.removeEventListener("click", click);
    renderer.domElement.removeEventListener("webglcontextlost", lost);
    geometry.dispose(); regular.dispose(); active.dispose();
    grid.geometry.dispose();
    for (const material of Array.isArray(grid.material) ? grid.material : [grid.material]) material.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    renderer.domElement.remove();
  };
}
