import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { anchor, planarPolygons } from "../geo";
import type { MunicipalityShape } from "../api";

export interface SceneValue { height: number; color: string }
export interface SceneCallbacks {
  onHover: (id: number | null, screen: { x: number; y: number } | null) => void;
  onSelect: (id: number | null) => void;
}

const ANIMATION_MS = 650;

/** Extruded municipalities of Slovenia, rendered on demand. */
export class AtlasScene {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(32, 1, 0.5, 400);
  private controls: OrbitControls;
  private group = new THREE.Group();
  private meshes = new Map<number, THREE.Mesh<THREE.ExtrudeGeometry, THREE.MeshStandardMaterial>>();
  private anchors = new Map<number, THREE.Vector3>();
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private hovered: number | null = null;
  private selected: number | null = null;
  private frame = 0;
  private animation = 0;
  private observer: ResizeObserver;
  private reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  private down: { x: number; y: number } | null = null;
  private ground: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>;

  constructor(private host: HTMLElement, private callbacks: SceneCallbacks, dark: boolean) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.domElement.setAttribute("aria-hidden", "true");
    host.appendChild(this.renderer.domElement);

    this.group.rotation.x = -Math.PI / 2; // shapes live in XY; extrusion (Z) becomes height (Y)
    this.scene.add(this.group);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x404850, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.9);
    sun.position.set(-30, 60, 40);
    this.scene.add(sun);
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 300), new THREE.MeshStandardMaterial({ roughness: 1 }));
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = -0.02;
    this.scene.add(this.ground);
    this.setTheme(dark);

    this.camera.position.set(-6, 26, 30);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0, 0);
    this.controls.enableDamping = false;
    this.controls.minDistance = 8;
    this.controls.maxDistance = 70;
    this.controls.maxPolarAngle = Math.PI * 0.46;
    this.controls.addEventListener("change", this.request);

    const canvas = this.renderer.domElement;
    canvas.addEventListener("pointermove", this.move);
    canvas.addEventListener("pointerleave", this.leave);
    canvas.addEventListener("pointerdown", this.press);
    canvas.addEventListener("pointerup", this.release);
    canvas.addEventListener("webglcontextlost", this.lost);
    this.observer = new ResizeObserver(this.resize);
    this.observer.observe(host);
    this.resize();
  }

  setTheme(dark: boolean) {
    this.ground.material.color.set(dark ? "#141b22" : "#eef1ec");
    this.request();
  }

  setShapes(shapes: MunicipalityShape[]) {
    for (const mesh of this.meshes.values()) { mesh.geometry.dispose(); mesh.material.dispose(); this.group.remove(mesh); }
    this.meshes.clear();
    this.anchors.clear();
    for (const shape of shapes) {
      const polygons = planarPolygons(shape.geometry);
      if (!polygons.length) continue;
      const shapes3 = polygons.map(({ outer, holes }) => {
        const result = new THREE.Shape(outer.map(([x, y]) => new THREE.Vector2(x, y)));
        result.holes = holes.map((hole) => new THREE.Path(hole.map(([x, y]) => new THREE.Vector2(x, y))));
        return result;
      });
      const geometry = new THREE.ExtrudeGeometry(shapes3, { depth: 1, bevelEnabled: false });
      const material = new THREE.MeshStandardMaterial({ color: "#888888", roughness: 0.75, metalness: 0.02, flatShading: true });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.scale.z = 0.15;
      mesh.userData.id = shape.id;
      this.group.add(mesh);
      this.meshes.set(shape.id, mesh);
      const [x, y] = anchor(polygons);
      this.anchors.set(shape.id, new THREE.Vector3(x, y, 0));
    }
    this.request();
  }

  /** Animate heights and colours to new values (instant with reduced motion). */
  setValues(values: Map<number, SceneValue>) {
    cancelAnimationFrame(this.animation);
    const targets = [...this.meshes].map(([id, mesh]) => {
      const value = values.get(id);
      return { mesh, from: mesh.scale.z, to: value?.height ?? 0.15, color: new THREE.Color(value?.color ?? "#555b63"),
        start: mesh.material.color.clone() };
    });
    const started = performance.now();
    const step = (now: number) => {
      const t = this.reducedMotion ? 1 : Math.min(1, (now - started) / ANIMATION_MS);
      const eased = 1 - Math.pow(1 - t, 3);
      for (const target of targets) {
        target.mesh.scale.z = target.from + (target.to - target.from) * eased;
        target.mesh.material.color.copy(target.start).lerp(target.color, eased);
      }
      this.applyHighlight();
      this.renderNow();
      if (t < 1) this.animation = requestAnimationFrame(step);
    };
    this.animation = requestAnimationFrame(step);
  }

  select(id: number | null) {
    this.selected = id;
    this.applyHighlight();
    this.request();
  }

  /** Screen position (CSS px within the host) of a municipality's top centre. */
  screenPosition(id: number): { x: number; y: number } | null {
    const mesh = this.meshes.get(id);
    const local = this.anchors.get(id);
    if (!mesh || !local) return null;
    const point = new THREE.Vector3(local.x, local.y, mesh.scale.z).applyMatrix4(this.group.matrixWorld).project(this.camera);
    if (point.z > 1) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    return { x: (point.x * 0.5 + 0.5) * rect.width, y: (-point.y * 0.5 + 0.5) * rect.height };
  }

  resetView() {
    this.camera.position.set(-6, 26, 30);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
    this.request();
  }

  dispose() {
    cancelAnimationFrame(this.frame);
    cancelAnimationFrame(this.animation);
    this.observer.disconnect();
    const canvas = this.renderer.domElement;
    canvas.removeEventListener("pointermove", this.move);
    canvas.removeEventListener("pointerleave", this.leave);
    canvas.removeEventListener("pointerdown", this.press);
    canvas.removeEventListener("pointerup", this.release);
    canvas.removeEventListener("webglcontextlost", this.lost);
    this.controls.removeEventListener("change", this.request);
    this.controls.dispose();
    for (const mesh of this.meshes.values()) { mesh.geometry.dispose(); mesh.material.dispose(); }
    this.ground.geometry.dispose();
    this.ground.material.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    canvas.remove();
  }

  private applyHighlight() {
    for (const [id, mesh] of this.meshes) {
      const strength = id === this.selected ? 0.35 : id === this.hovered ? 0.18 : 0;
      mesh.material.emissive.setRGB(strength, strength * 0.85, strength * 0.55);
    }
  }

  private pick(event: PointerEvent): number | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObjects([...this.meshes.values()], false)[0];
    return hit ? (hit.object.userData.id as number) : null;
  }

  private move = (event: PointerEvent) => {
    if (this.down) return;
    const id = this.pick(event);
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (id !== this.hovered) { this.hovered = id; this.applyHighlight(); this.request(); }
    this.callbacks.onHover(id, id == null ? null : { x: event.clientX - rect.left, y: event.clientY - rect.top });
  };

  private leave = () => {
    this.hovered = null;
    this.applyHighlight();
    this.request();
    this.callbacks.onHover(null, null);
  };

  private press = (event: PointerEvent) => { this.down = { x: event.clientX, y: event.clientY }; };

  private release = (event: PointerEvent) => {
    const start = this.down;
    this.down = null;
    if (!start || Math.abs(event.clientX - start.x) + Math.abs(event.clientY - start.y) > 5) return; // a drag, not a click
    this.callbacks.onSelect(this.pick(event));
  };

  private lost = (event: Event) => { event.preventDefault(); };

  private resize = () => {
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.fov = width < 640 ? 44 : 32;
    this.camera.updateProjectionMatrix();
    this.renderNow();
  };

  private request = () => {
    if (!this.frame) this.frame = requestAnimationFrame(() => { this.frame = 0; this.renderNow(); });
  };

  private renderNow() {
    this.renderer.render(this.scene, this.camera);
  }
}
