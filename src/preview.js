// three.js preview of the generated parts.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export class Preview {
  constructor(container) {
    this.container = container;
    this.renderer = null;
  }

  init() {
    if (this.renderer) return;
    const r = (this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true }));
    r.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.container.appendChild(r.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 10000);
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, r.domElement);
    this.controls.enableDamping = true;
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445544, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(-1, -1.5, 2.5);
    this.scene.add(sun);
    this.group = new THREE.Group();
    this.scene.add(this.group);
    new ResizeObserver(() => this.resize()).observe(this.container);
    this.resize();
    const loop = () => {
      requestAnimationFrame(loop);
      if (!this.container.offsetParent) return; // hidden tab
      this.controls.update();
      r.render(this.scene, this.camera);
    };
    loop();
  }

  resize() {
    if (!this.renderer) return;
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setClearColor(matchMedia('(prefers-color-scheme: dark)').matches ? 0x16191a : 0xeef0ec);
  }

  /** @param {{name:string,color:string,mesh:import('./mesh/meshbuf.js').MeshBuf}[]} parts */
  show(parts, stats) {
    this.init();
    this.container.querySelector('.empty')?.remove();
    for (const child of [...this.group.children]) {
      child.geometry.dispose();
      child.material.dispose();
      this.group.remove(child);
    }
    for (const p of parts) {
      if (p.mesh.empty) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(p.mesh.pos, 3));
      g.setIndex(p.mesh.vertexCount > 65535 ? new THREE.Uint32BufferAttribute(p.mesh.idx, 1) : new THREE.Uint16BufferAttribute(p.mesh.idx, 1));
      g.computeVertexNormals();
      const mat = new THREE.MeshStandardMaterial({ color: p.color, roughness: 0.85, metalness: 0, flatShading: true });
      const mesh = new THREE.Mesh(g, mat);
      mesh.name = p.name;
      this.group.add(mesh);
    }
    const size = Math.max(stats.widthMM, stats.heightMM);
    this.camera.position.set(0, -size * 1.15, size * 0.95);
    this.controls.target.set(0, 0, stats.maxZ / 3);
    this.controls.update();
    this.renderLegend(parts);
  }

  renderLegend(parts) {
    this.container.querySelector('.legend')?.remove();
    const el = document.createElement('div');
    el.className = 'legend';
    for (const p of parts) {
      if (p.mesh.empty) continue;
      const row = document.createElement('div');
      row.innerHTML = `<i style="background:${p.color}"></i>${p.label}`;
      el.appendChild(row);
    }
    this.container.appendChild(el);
  }
}
