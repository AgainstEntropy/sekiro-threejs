import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { merge } from './geo.js';

/**
 * Collects the static geometry of a character per (node, material) and emits it as ONE rigidly skinned mesh per
 * material: every node that carries geometry (joints, sockets, flap pivots, followers, toggle groups, prop carriers)
 * becomes a "bone" of a shared THREE.Skeleton and each vertex is bound to its node with weight 1. Vertices stay in
 * their node's local frame (bone inverses = identity, bind matrix = identity), so a character costs ~8-10 draw calls
 * (and as many shadow casters) instead of one per (joint, material) pair, while every part still follows its node
 * exactly as a plain child mesh would.
 *
 * Hiding a node's parts: scale the node to 0 (HumanoidRig._show) — `visible` has no effect on skinned geometry.
 * Vertex positions of the merged meshes are node-local: use mesh.getVertexPosition(i, v) (applies the bone transform)
 * then .applyMatrix4(mesh.matrixWorld) to get world positions.
 *
 * build(root, false) keeps the old layout (one plain mesh per (node, material) pair, parented to the node) —
 * HumanoidRig uses it for the `?rigsplit` debug URL parameter.
 */
const IDENTITY = new THREE.Matrix4();
// Culling sphere in rig-root space: generous enough for every pose (lying on the ground, arms / yari extended).
const CULL_CENTER = new THREE.Vector3(0, 0.9, 0);
const CULL_RADIUS = 2.9;

export class PartBuilder {
  constructor(mats) {
    this.mats = mats;
    this.nodes = new Map();
    /** Skeleton shared by the merged meshes (null before build / in split mode). */
    this.skeleton = null;
  }

  add(node, mat, ...geos) {
    if (!node) throw new Error('PartBuilder.add: missing node');
    let m = this.nodes.get(node);
    if (!m) { m = new Map(); this.nodes.set(node, m); }
    let arr = m.get(mat);
    if (!arr) { arr = []; m.set(mat, arr); }
    for (const g of geos) if (g) arr.push(g);
    return this;
  }

  /** @param {THREE.Object3D} root  rig root (merged meshes are parented to it)  @param {boolean} skinned */
  build(root, skinned = true) {
    return skinned && root ? this._buildSkinned(root) : this._buildSplit();
  }

  _buildSplit() {
    const meshes = [];
    for (const [node, m] of this.nodes) {
      for (const [mat, geos] of m) {
        if (!geos.length) continue;
        const g = merge(geos);
        if (!g) continue;
        g.computeBoundingSphere();
        g.computeBoundingBox();
        const mesh = new THREE.Mesh(g, this.mats.get(mat));
        mesh.name = (node.name || 'node') + ':' + mat;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        node.add(mesh);
        meshes.push(mesh);
      }
    }
    this.nodes.clear();
    return meshes;
  }

  _buildSkinned(root) {
    // pass 1: bones = nodes that actually carry geometry
    const bones = [];
    const boneIndex = new Map();
    for (const [node, m] of this.nodes) {
      let any = false;
      for (const geos of m.values()) if (geos.length) { any = true; break; }
      if (any && !boneIndex.has(node)) { boneIndex.set(node, bones.length); bones.push(node); }
    }
    const IA = bones.length > 255 ? Uint16Array : Uint8Array;
    // pass 2: merge per (node, material), tag with the node's bone, then gather per material
    const perMat = new Map();
    for (const [node, m] of this.nodes) {
      const bi = boneIndex.get(node);
      if (bi === undefined) continue;
      for (const [mat, geos] of m) {
        if (!geos.length) continue;
        const g = merge(geos);
        if (!g) continue;
        const n = g.attributes.position.count;
        const si = new IA(n * 4), sw = new Uint8Array(n * 4);
        for (let i = 0; i < n; i++) { si[i * 4] = bi; sw[i * 4] = 255; }
        g.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
        g.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4, true));
        let list = perMat.get(mat);
        if (!list) { list = []; perMat.set(mat, list); }
        list.push(g);
      }
    }
    this.nodes.clear();
    if (!bones.length) return [];
    const skeleton = new THREE.Skeleton(bones, bones.map(() => new THREE.Matrix4()));
    this.skeleton = skeleton;
    const meshes = [];
    for (const [mat, list] of perMat) {
      const g = list.length === 1 ? list[0] : mergeGeometries(list, false);
      if (list.length > 1) for (const q of list) q.dispose();
      if (!g) continue;
      g.boundingSphere = new THREE.Sphere(CULL_CENTER.clone(), CULL_RADIUS);
      const mesh = new THREE.SkinnedMesh(g, this.mats.get(mat));
      mesh.name = 'rig:' + mat;
      mesh.bind(skeleton, IDENTITY);
      // the engine never computes a (pose-dependent, expensive) bounds for us: fixed generous sphere in root space
      mesh.boundingSphere = new THREE.Sphere(CULL_CENTER.clone(), CULL_RADIUS);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      root.add(mesh);
      meshes.push(mesh);
    }
    return meshes;
  }
}
