import * as THREE from 'three';

// Static-world collision: a terrain height function + yaw-rotated boxes + vertical cylinders,
// bucketed in a coarse XZ grid. Characters are vertical capsules approximated as
// (feet position, radius, height). See docs/ARCHITECTURE.md §Collision.

const CELL = 8;
const cellKey = (ix, iz) => ix * 73856093 ^ iz * 19349663;

export class Collision {
  constructor() {
    this.colliders = [];
    this.grid = new Map();
    this.terrainFn = () => 0;
    this._stamp = 0;
    this._tmpList = [];
  }

  /** fn(x, z) -> ground height of the terrain surface. */
  setTerrain(fn) {
    this.terrainFn = fn;
  }

  terrainHeight(x, z) {
    return this.terrainFn(x, z);
  }

  /**
   * Add a (yaw-rotated) box.
   * @param {object} o
   * @param {THREE.Vector3|number[]} o.center  world center
   * @param {THREE.Vector3|number[]} o.size    full extents (x, y, z) in the box's local frame
   * @param {number} [o.rotY=0]                yaw rotation (same convention as Object3D.rotation.y)
   * @param {boolean} [o.walkable=true]        characters can stand on its top face
   * @param {boolean} [o.blocksCamera=true]    camera raycasts collide with it
   * @param {boolean} [o.blocksSight=true]     used by lineOfSight()
   * @param {boolean} [o.blocksCharacters=true] false = camera/sight-only volume (e.g. tree canopies); characters pass through
   * @param {string} [o.tag]
   */
  addBox(o) {
    const c = toArr(o.center), s = toArr(o.size);
    const rotY = o.rotY || 0;
    const col = {
      kind: 'box',
      cx: c[0], cy: c[1], cz: c[2],
      hx: s[0] / 2, hy: s[1] / 2, hz: s[2] / 2,
      rotY, cos: Math.cos(rotY), sin: Math.sin(rotY),
      minY: c[1] - s[1] / 2, maxY: c[1] + s[1] / 2,
      walkable: o.walkable !== false,
      blocksCamera: o.blocksCamera !== false,
      blocksSight: o.blocksSight !== false,
      blocksCharacters: o.blocksCharacters !== false,
      tag: o.tag || '',
      _stamp: 0,
    };
    this._insert(col);
    return col;
  }

  /**
   * Convenience: add a box collider matching a mesh's geometry bounding box, using the mesh's world
   * transform (only Y rotation is honoured; scale is honoured). Call mesh.updateWorldMatrix(true,false) first
   * if the mesh was just positioned.
   */
  addBoxFromObject(obj, opts = {}) {
    obj.updateWorldMatrix(true, false);
    const geo = obj.geometry;
    if (!geo.boundingBox) geo.computeBoundingBox();
    const bb = geo.boundingBox;
    const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scl = new THREE.Vector3();
    obj.matrixWorld.decompose(pos, quat, scl);
    const e = new THREE.Euler().setFromQuaternion(quat, 'YXZ');
    const localCenter = bb.getCenter(new THREE.Vector3()).multiply(scl).applyQuaternion(quat);
    const size = bb.getSize(new THREE.Vector3()).multiply(scl);
    return this.addBox({ ...opts, center: pos.add(localCenter), size, rotY: e.y });
  }

  /** Vertical cylinder (tree trunks, pillars, lanterns). */
  addCylinder(o) {
    const col = {
      kind: 'cyl',
      cx: o.x, cz: o.z, r: o.radius,
      minY: o.yMin ?? -1000, maxY: o.yMax ?? 1000,
      walkable: !!o.walkable,
      blocksCamera: o.blocksCamera !== false,
      blocksSight: o.blocksSight !== false,
      blocksCharacters: o.blocksCharacters !== false,
      tag: o.tag || '',
      _stamp: 0,
    };
    this._insert(col);
    return col;
  }

  remove(col) {
    const i = this.colliders.indexOf(col);
    if (i >= 0) this.colliders.splice(i, 1);
    for (const list of this.grid.values()) {
      const j = list.indexOf(col);
      if (j >= 0) list.splice(j, 1);
    }
  }

  _bounds(col) {
    if (col.kind === 'cyl') return [col.cx - col.r, col.cz - col.r, col.cx + col.r, col.cz + col.r];
    const ex = Math.abs(col.hx * col.cos) + Math.abs(col.hz * col.sin);
    const ez = Math.abs(col.hx * col.sin) + Math.abs(col.hz * col.cos);
    return [col.cx - ex, col.cz - ez, col.cx + ex, col.cz + ez];
  }

  _insert(col) {
    this.colliders.push(col);
    const [x0, z0, x1, z1] = this._bounds(col);
    col.bounds = [x0, z0, x1, z1];
    for (let ix = Math.floor(x0 / CELL); ix <= Math.floor(x1 / CELL); ix++) {
      for (let iz = Math.floor(z0 / CELL); iz <= Math.floor(z1 / CELL); iz++) {
        const k = cellKey(ix, iz);
        if (!this.grid.has(k)) this.grid.set(k, []);
        this.grid.get(k).push(col);
      }
    }
  }

  /** Colliders whose XZ bounds may overlap the given rect. Returned array is reused — copy if you keep it. */
  query(x0, z0, x1, z1) {
    const out = this._tmpList;
    out.length = 0;
    const stamp = ++this._stamp;
    for (let ix = Math.floor(x0 / CELL); ix <= Math.floor(x1 / CELL); ix++) {
      for (let iz = Math.floor(z0 / CELL); iz <= Math.floor(z1 / CELL); iz++) {
        const list = this.grid.get(cellKey(ix, iz));
        if (!list) continue;
        for (const c of list) {
          if (c._stamp === stamp) continue;
          c._stamp = stamp;
          const b = c.bounds;
          if (b[2] < x0 || b[0] > x1 || b[3] < z0 || b[1] > z1) continue;
          out.push(c);
        }
      }
    }
    return out;
  }

  // world -> box local (XZ)
  _toLocal(c, x, z) {
    const dx = x - c.cx, dz = z - c.cz;
    return [dx * c.cos - dz * c.sin, dx * c.sin + dz * c.cos];
  }
  _toWorldDir(c, lx, lz) {
    return [lx * c.cos + lz * c.sin, -lx * c.sin + lz * c.cos];
  }

  /**
   * Highest walkable surface under (x, z) whose top is <= maxY (terrain or walkable collider top).
   * `margin` lets a character's edge overhang a ledge slightly.
   */
  groundHeight(x, z, maxY = Infinity, margin = 0.12) {
    let best = this.terrainFn(x, z);
    const list = this.query(x - margin, z - margin, x + margin, z + margin);
    for (const c of list) {
      if (!c.walkable || c.blocksCharacters === false || c.maxY > maxY || c.maxY <= best) continue;
      if (c.kind === 'box') {
        const [lx, lz] = this._toLocal(c, x, z);
        if (Math.abs(lx) <= c.hx + margin && Math.abs(lz) <= c.hz + margin) best = c.maxY;
      } else if (Math.hypot(x - c.cx, z - c.cz) <= c.r + margin) {
        best = c.maxY;
      }
    }
    return best;
  }

  /**
   * Push a character (feet position `pos`, mutated in place) horizontally out of colliders that overlap
   * its vertical span. Colliders whose top is within `stepUp` of the feet are ignored (you step onto them).
   * Returns true if any push happened.
   */
  resolveCharacter(pos, radius, height, stepUp = 0.45) {
    let hit = false;
    for (let iter = 0; iter < 3; iter++) {
      let moved = false;
      const list = this.query(pos.x - radius, pos.z - radius, pos.x + radius, pos.z + radius);
      for (const c of list) {
        if (c.blocksCharacters === false) continue;
        if (c.maxY <= pos.y + stepUp || c.minY >= pos.y + height) continue;
        if (c.kind === 'box') {
          const [lx, lz] = this._toLocal(c, pos.x, pos.z);
          const qx = Math.max(-c.hx, Math.min(c.hx, lx));
          const qz = Math.max(-c.hz, Math.min(c.hz, lz));
          let dx = lx - qx, dz = lz - qz;
          const d2 = dx * dx + dz * dz;
          if (d2 >= radius * radius) continue;
          let px, pz;
          if (d2 > 1e-10) {
            const d = Math.sqrt(d2);
            px = (dx / d) * (radius - d);
            pz = (dz / d) * (radius - d);
          } else {
            // Center inside the box: exit along the axis of least penetration.
            const penX = c.hx - Math.abs(lx) + radius;
            const penZ = c.hz - Math.abs(lz) + radius;
            if (penX < penZ) { px = Math.sign(lx || 1) * penX; pz = 0; }
            else { px = 0; pz = Math.sign(lz || 1) * penZ; }
          }
          const [wx, wz] = this._toWorldDir(c, px, pz);
          pos.x += wx;
          pos.z += wz;
          moved = hit = true;
        } else {
          const dx = pos.x - c.cx, dz = pos.z - c.cz;
          const d = Math.hypot(dx, dz);
          const min = radius + c.r;
          if (d >= min) continue;
          if (d < 1e-6) { pos.x += min; continue; }
          pos.x += (dx / d) * (min - d);
          pos.z += (dz / d) * (min - d);
          moved = hit = true;
        }
      }
      if (!moved) break;
    }
    return hit;
  }

  /**
   * Raycast against colliders (+ terrain unless opts.ignoreTerrain).
   * @returns {{distance:number, point:THREE.Vector3, normal:THREE.Vector3, collider:object|null}|null}
   * opts.filter(col) -> boolean to skip colliders; opts.camera=true uses blocksCamera; opts.sight=true uses blocksSight.
   */
  raycast(origin, dir, maxDist, opts = {}) {
    let best = maxDist, bestCol = null;
    const bestN = new THREE.Vector3();
    const ex = origin.x + dir.x * maxDist, ez = origin.z + dir.z * maxDist;
    const list = this.query(Math.min(origin.x, ex), Math.min(origin.z, ez), Math.max(origin.x, ex), Math.max(origin.z, ez));
    for (const c of list) {
      if (opts.camera && !c.blocksCamera) continue;
      if (opts.sight && !c.blocksSight) continue;
      if (opts.filter && !opts.filter(c)) continue;
      const r = c.kind === 'box' ? this._rayBox(c, origin, dir, best) : this._rayCyl(c, origin, dir, best);
      if (r && r.t < best) {
        best = r.t;
        bestCol = c;
        bestN.set(r.nx, r.ny, r.nz);
      }
    }
    if (!opts.ignoreTerrain) {
      const t = this._rayTerrain(origin, dir, best);
      if (t !== null && t < best) {
        best = t;
        bestCol = null;
        bestN.set(0, 1, 0);
      }
    }
    if (best >= maxDist) return null;
    return {
      distance: best,
      point: new THREE.Vector3().copy(origin).addScaledVector(dir, best),
      normal: bestN,
      collider: bestCol,
    };
  }

  /** True if nothing that blocks sight lies between a and b. */
  lineOfSight(a, b) {
    const d = new THREE.Vector3().subVectors(b, a);
    const len = d.length();
    if (len < 1e-4) return true;
    d.divideScalar(len);
    return this.raycast(a, d, len - 0.05, { sight: true }) === null;
  }

  _rayBox(c, o, d, maxT) {
    // to local
    const ox = o.x - c.cx, oz = o.z - c.cz;
    const lox = ox * c.cos - oz * c.sin, loz = ox * c.sin + oz * c.cos, loy = o.y - c.cy;
    const ldx = d.x * c.cos - d.z * c.sin, ldz = d.x * c.sin + d.z * c.cos, ldy = d.y;
    let tmin = 0, tmax = maxT, axis = -1, sign = 0;
    const slabs = [[lox, ldx, c.hx], [loy, ldy, c.hy], [loz, ldz, c.hz]];
    for (let i = 0; i < 3; i++) {
      const [p, v, h] = slabs[i];
      if (Math.abs(v) < 1e-9) {
        if (p < -h || p > h) return null;
        continue;
      }
      let t1 = (-h - p) / v, t2 = (h - p) / v;
      let s = -1;
      if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; s = 1; }
      if (t1 > tmin) { tmin = t1; axis = i; sign = s; }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }
    if (axis < 0) return { t: 0, nx: -d.x, ny: -d.y, nz: -d.z }; // origin inside
    let nx = 0, ny = 0, nz = 0;
    if (axis === 0) nx = sign; else if (axis === 1) ny = sign; else nz = sign;
    const [wx, wz] = this._toWorldDir(c, nx, nz);
    return { t: tmin, nx: wx, ny, nz: wz };
  }

  _rayCyl(c, o, d, maxT) {
    const ox = o.x - c.cx, oz = o.z - c.cz;
    const a = d.x * d.x + d.z * d.z;
    if (a < 1e-9) return null;
    const b = 2 * (ox * d.x + oz * d.z);
    const cc = ox * ox + oz * oz - c.r * c.r;
    if (cc < 0) return null; // origin inside the trunk: ignore
    const disc = b * b - 4 * a * cc;
    if (disc < 0) return null;
    const t = (-b - Math.sqrt(disc)) / (2 * a);
    if (t < 0 || t > maxT) return null;
    const y = o.y + d.y * t;
    if (y < c.minY || y > c.maxY) return null;
    const px = ox + d.x * t, pz = oz + d.z * t;
    const l = Math.hypot(px, pz) || 1;
    return { t, nx: px / l, ny: 0, nz: pz / l };
  }

  _rayTerrain(o, d, maxT) {
    const step = 0.6;
    let prevT = 0;
    let prevAbove = o.y - this.terrainFn(o.x, o.z);
    if (prevAbove < 0) return null;
    for (let t = step; t <= maxT + step; t += step) {
      const tt = Math.min(t, maxT);
      const x = o.x + d.x * tt, y = o.y + d.y * tt, z = o.z + d.z * tt;
      const above = y - this.terrainFn(x, z);
      if (above < 0) {
        // refine
        let lo = prevT, hi = tt;
        for (let i = 0; i < 8; i++) {
          const m = (lo + hi) / 2;
          const my = o.y + d.y * m - this.terrainFn(o.x + d.x * m, o.z + d.z * m);
          if (my < 0) hi = m; else lo = m;
        }
        return lo;
      }
      prevT = tt;
      prevAbove = above;
      if (tt >= maxT) break;
    }
    return null;
  }
}

function toArr(v) {
  if (Array.isArray(v)) return v;
  return [v.x, v.y, v.z];
}
