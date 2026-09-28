import * as THREE from 'three';

// Coarse height field of the tall grass (pampas / tufts), so cinematic shots can keep the lens above the blades
// and pick angles where the fighters are not buried in grass.
//
// Source (read-only, defensive): `world.grassTopAt(x, z)` if the World provides it (absolute Y of the tallest
// blade tip there, or -Infinity), otherwise the World's grass InstancedMeshes (`world.grassMeshes`: per-instance
// translation + uniform scale of a clump geometry whose local +Y is height). Built lazily on first use (one pass
// over the instance matrices, ~1 ms), never per frame.

const CELL = 0.5;
const EMPTY = -1e9;
const _bb = new THREE.Box3();

export class GrassField {
  constructor(ctx) {
    this.ctx = ctx;
    this._built = false;
    this._retryAt = 0;
    this.grid = null;
    this.x0 = 0; this.z0 = 0; this.nx = 0; this.nz = 0;
  }

  /** Absolute Y of the tallest grass tip around (x, z), or -Infinity where there is no grass. */
  topAt(x, z) {
    const w = this.ctx.world;
    if (typeof w?.grassTopAt === 'function') {
      const y = w.grassTopAt(x, z);
      return Number.isFinite(y) ? y : -Infinity;
    }
    if (!this._built && performance.now() >= this._retryAt) this._build();
    const g = this.grid;
    if (!g) return -Infinity;
    const i = Math.floor((x - this.x0) / CELL), k = Math.floor((z - this.z0) / CELL);
    if (i < 0 || k < 0 || i >= this.nx || k >= this.nz) return -Infinity;
    const y = g[k * this.nx + i];
    return y > EMPTY * 0.5 ? y : -Infinity;
  }

  /**
   * Metres of the segment a→b that run below the grass tips, ignoring the first `skipA` m (the World thins grass
   * right at the lens) and the last `skipB` m (blades are pushed apart around characters). Sampled every 0.25 m.
   */
  buriedLength(a, b, skipA = 1.2, skipB = 0.45) {
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-3) return 0;
    const step = 0.25;
    let buried = 0;
    for (let s = skipA; s < len - skipB; s += step) {
      const t = s / len;
      const x = a.x + dx * t, y = a.y + dy * t, z = a.z + dz * t;
      if (y < this.topAt(x, z) - 0.04) buried += step;
    }
    return buried;
  }

  _build() {
    const meshes = this.ctx.world?.grassMeshes;
    if (!Array.isArray(meshes) || meshes.length === 0) {
      this._retryAt = performance.now() + 2000; // world not built yet (or no grass): look again later
      return;
    }
    this._built = true;
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    const clumps = [];
    for (const m of meshes) {
      if (!m?.isInstancedMesh || !m.geometry || !m.instanceMatrix) continue;
      const geo = m.geometry;
      if (!geo.boundingBox) geo.computeBoundingBox();
      _bb.copy(geo.boundingBox);
      const top = _bb.max.y;
      const rad = Math.max(-_bb.min.x, _bb.max.x, -_bb.min.z, _bb.max.z, 0) * 0.55; // blades lean out; tips thin
      if (!(top > 0.05)) continue;
      m.updateMatrixWorld?.();
      const mw = m.matrixWorld.elements;
      const e = m.instanceMatrix.array;
      for (let i = 0, n = m.count; i < n; i++) {
        const o = i * 16;
        const s = Math.hypot(e[o], e[o + 1], e[o + 2]);
        if (!(s > 1e-3)) continue;
        // instance → world (the grass meshes sit under the world root; usually identity)
        const lx = e[o + 12], ly = e[o + 13], lz = e[o + 14];
        const x = mw[0] * lx + mw[4] * ly + mw[8] * lz + mw[12];
        const y = mw[1] * lx + mw[5] * ly + mw[9] * lz + mw[13];
        const z = mw[2] * lx + mw[6] * ly + mw[10] * lz + mw[14];
        const r = rad * s;
        clumps.push(x, z, y + top * s, r);
        if (x - r < x0) x0 = x - r;
        if (x + r > x1) x1 = x + r;
        if (z - r < z0) z0 = z - r;
        if (z + r > z1) z1 = z + r;
      }
    }
    if (!clumps.length) return;
    this.x0 = Math.floor(x0 / CELL) * CELL;
    this.z0 = Math.floor(z0 / CELL) * CELL;
    this.nx = Math.max(1, Math.ceil((x1 - this.x0) / CELL) + 1);
    this.nz = Math.max(1, Math.ceil((z1 - this.z0) / CELL) + 1);
    if (this.nx * this.nz > 4e6) return; // absurd extents: give up rather than allocate a huge grid
    const g = (this.grid = new Float32Array(this.nx * this.nz).fill(EMPTY));
    for (let c = 0; c < clumps.length; c += 4) {
      const x = clumps[c], z = clumps[c + 1], top = clumps[c + 2], r = clumps[c + 3];
      const i0 = Math.max(0, Math.floor((x - r - this.x0) / CELL)), i1 = Math.min(this.nx - 1, Math.floor((x + r - this.x0) / CELL));
      const k0 = Math.max(0, Math.floor((z - r - this.z0) / CELL)), k1 = Math.min(this.nz - 1, Math.floor((z + r - this.z0) / CELL));
      for (let k = k0; k <= k1; k++) {
        for (let i = i0; i <= i1; i++) {
          const j = k * this.nx + i;
          if (top > g[j]) g[j] = top;
        }
      }
    }
  }
}
