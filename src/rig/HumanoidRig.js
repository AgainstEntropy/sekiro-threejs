import * as THREE from 'three';
import { Skeleton } from './Skeleton.js';
import { RigMaterials } from './materials.js';
import { PartBuilder } from './parts/PartBuilder.js';
import { SwingFlap, Follower, RibbonSet } from './parts/secondary.js';
import { buildWolf } from './parts/wolf.js';
import { buildSoldier } from './parts/soldier.js';
import { buildGenichiro } from './parts/genichiro.js';
import { createKatana, createKatanaHilt, createScabbard, createSpear, createBow, createArrow, createGourd, setBowNock } from './props.js';

// Detailed procedural characters rigidly attached to the shared Skeleton. All static parts — body, outfit and the
// katana / yari / scabbard / hilt / gourd / bow — are merged into ONE rigidly skinned mesh per material (every
// joint / flap / prop node is a bone, weight 1; see parts/PartBuilder.js), so a character costs ~8-10 draw calls and
// as many shadow casters (+1 for the scarf / headband ribbons, +1 for Genichiro's bow string / a nocked arrow).
// Hidden props are scaled to 0 (_show). `?rigsplit` in the URL keeps one plain mesh per (node, material) (debug).
// Types: 'wolf' (player), 'soldier', 'spear' (Ashina footsoldiers), 'genichiro' (boss, scale 1.06).
//
// API (docs/ARCHITECTURE.md §8): root joints sockets skeleton weapon weaponType getBladeSegment getSocketWorld
// setProp flash setGlow setVisible setOpacity update dispose  (+ resetSecondary(), prewarm(on) for Game.warmup).
//
// Secondary motion vs. root snaps: every update compares the root transform with the previous one. A jump of more
// than SNAP_RESET (teleport, respawn) re-initialises all flaps / ribbons in place; a smaller unexplained jump or a
// fast yaw change (deathblow alignment, separation pushes, dt spikes) carries their state rigidly with the root.
// Parts that could sink into the floor (scabbard, hakama / kusazuri panels, hats, the yari) are kept above the
// ground plane at root height; the scabbard also swings around the left leg (capsule avoidance) instead of through
// it. Each update also feeds the materials' rim-occlusion probe (a point above the head; see materials.js).

const BUILDERS = { wolf: buildWolf, soldier: buildSoldier, spear: buildSoldier, genichiro: buildGenichiro };
const SPLIT = typeof location !== 'undefined' && /[?&]rigsplit(?:[=&]|$)/.test(location.search || '');

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();
const _m2 = new THREE.Matrix4();
const _qd = new THREE.Quaternion();
const Z = new THREE.Vector3(0, 0, 1);

// root travel in one update beyond velocity * dt: > SNAP_RESET = teleport (reset), > SNAP_CARRY = snap (carry)
const SNAP_RESET = 1.0;
const SNAP_CARRY = 0.25;
const SNAP_YAW = 0.6; // rad of root yaw change in one update that counts as a snap
// yari ground clamp: tip / butt distance from the fist along the shaft (local +Z / -Z)
const SPEAR_TIP = 1.6, SPEAR_BUTT = 1.03, WEAPON_MARGIN = 0.02;
// left-leg clearance for the scabbard (outfit.sayaLeg overrides): thigh radius at the hip / knee, shin at knee / ankle
const SAYA_LEG = [0.1, 0.064, 0.062, 0.045];
// scabbard sample radii at s = 0.14, 0.2, 0.34, 0.56, 0.775 m (outfit.sayaLegR); < 0 = overlap allowed (obi end)
const SAYA_LEG_R = [-0.02, -0.026, 0.018, 0.018, 0.018];

// socket-point offsets in joint local space
const POINTS = {
  head: ['head', [0, 0.11, 0.01]],
  chest: ['chest', [0, 0.1, 0.02]],
  handR: ['handR', [0, -0.06, 0]],
  handL: ['handL', [0, -0.06, 0]],
  prosthetic: ['handL', [0, -0.07, 0]],
};

export class HumanoidRig {
  /** @param {{type:'wolf'|'soldier'|'spear'|'genichiro', scale?:number}} opts */
  constructor(opts = {}) {
    this.type = BUILDERS[opts.type] ? opts.type : 'soldier';
    this.skeleton = new Skeleton();
    this.root = this.skeleton.root;
    this.root.name = 'rig_' + this.type;
    this.joints = this.skeleton.joints;
    this.sockets = this.skeleton.sockets;
    this.mats = new RigMaterials();
    this.flaps = [];
    this.followers = [];
    this.ribbons = [];
    this.colliders = [];
    this.handPoses = null;
    this._time = Math.random() * 10;
    this._props = { gourd: false, bowHand: false, arrowHand: false };
    this._visible = true;
    this._prevRoot = new THREE.Matrix4();
    this._prevRootOk = false;
    /** Increments whenever update() detects a root snap (teleport / alignment / respawn): FX can break trails. */
    this.snapId = 0;
    this._weaponClamped = false;
    this._merge = !SPLIT;

    // ── body & outfit ──
    this.pb = new PartBuilder(this.mats);
    BUILDERS[this.type](this, opts);

    // ── weapons & props (their static geometry joins the merged meshes: see _absorb) ──
    this.weaponType = this.type === 'spear' ? 'spear' : 'katana';
    const style = this.type === 'wolf' ? 'kusabimaru' : this.type === 'genichiro' ? 'genichiro' : 'ashina';
    this.weapon = this.weaponType === 'spear' ? createSpear({ mats: this.mats }) : createKatana({ mats: this.mats, style });
    this.sockets.weaponR.add(this.weapon);
    this._weaponNode = this._absorb(this.weapon);
    this._weaponShown = true;

    // scabbard at the left hip, worn edge-up, sloping back and down
    this.scabbard = createScabbard({ mats: this.mats, style, sageo: this.outfit?.sageo, lacquer: this.outfit?.saya });
    const sayaPivot = new THREE.Object3D();
    sayaPivot.name = 'sayaPivot';
    const d = new THREE.Vector3(...(this.outfit?.sayaDir || [0.2, -0.46, -1])).normalize();
    const up = new THREE.Vector3(0, -1, 0);
    const xA = new THREE.Vector3().crossVectors(up, d).normalize();
    const yA = new THREE.Vector3().crossVectors(d, xA).normalize();
    sayaPivot.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(xA, yA, d));
    // the scabbard swings a little in the obi (and flops toward the ground when lying down)
    const sayaSwing = this.addFlap(this.sockets.hipL, this.outfit?.sayaOffset || [0.0, 0.02, 0.05], { name: 'sayaSwing', gain: 0.9, freq: 3.0, zeta: 0.4, inertia: 0.5, drag: 0.2, limX: [-1.3, 0.6], limZ: [-0.3, 0.5], flutter: 0 });
    sayaSwing.node.add(sayaPivot);
    sayaPivot.add(this.scabbard);
    this.sayaPivot = sayaPivot;
    this.sayaSwing = sayaSwing;
    // hilt shown when the sword is sheathed (spearman sidearm; Genichiro while using the bow)
    this.sheathedHilt = createKatanaHilt({ mats: this.mats, style: this.type === 'spear' ? 'ashina' : style });
    this.sheathedHilt.position.set(0, 0, -0.062);
    this.scabbard.add(this.sheathedHilt);
    this._absorb(this.scabbard, true);
    // (only the spearman and Genichiro ever show it: the others keep it as a hidden plain group — no cost)
    this._hiltShown = this.type === 'spear';
    this._hiltNode = this.type === 'spear' || this.type === 'genichiro' ? this._absorb(this.sheathedHilt) : this.sheathedHilt;
    this._show(this._hiltNode, this._hiltShown);
    // ground samples along the saya (kojiri, middle, near the mouth) + the hilt end when a hilt is shown: lying
    // face-down, the gravity swing lays the scabbard flat on the floor instead of through it
    const sp = (z, y = 0) => new THREE.Vector3(0, y, z).applyQuaternion(sayaPivot.quaternion);
    this._sayaGround = [sp(0.775, 0.02), sp(0.5, 0.01), sp(0.22)];
    this._sayaGroundHilt = [...this._sayaGround, sp(-0.29)];
    sayaSwing.groundMargin = 0.032;
    sayaSwing.setGround(this._hiltShown ? this._sayaGroundHilt : this._sayaGround);
    // the saya stays out of the left leg (hakama thigh, then the wrapped shin): lunges, the guard-break stagger and
    // kneeling swing the kojiri out behind / beside the leg instead of through it. Near the obi (s < 0.25) it may sink
    // into the baggy hakama top about as far as it does standing, no deeper.
    const L = this.outfit?.sayaLeg || SAYA_LEG;
    sayaSwing.setAvoid({
      points: [sp(0.14, 0.001), sp(0.2, 0.002), sp(0.34, 0.004), sp(0.56, 0.01), sp(0.775, 0.02)], radius: this.outfit?.sayaLegR || SAYA_LEG_R,
      capsules: [{ a: this.joints.thighL, b: this.joints.shinL, r0: L[0], r1: L[1] }, { a: this.joints.shinL, b: this.joints.footL, r0: L[2], r1: L[3] }],
    });

    const gourd = createGourd({ mats: this.mats });
    gourd.position.set(0, -0.005, 0.0);
    this.sockets.weaponL.add(gourd);
    this.gourd = this._absorb(gourd);

    this.bow = null;
    if (this.type === 'genichiro') {
      this.bow = createBow({ mats: this.mats });
      this.bowBackPose = { pos: new THREE.Vector3(0.04, -0.2, 0.035), quat: new THREE.Quaternion() };
      // long axis diagonal across the back (upper limb over the right shoulder), string facing away from the body
      const dir = new THREE.Vector3(-0.5, 0.86, -0.08).normalize();
      const yy = new THREE.Vector3(0, 0.1, -1).addScaledVector(dir, -new THREE.Vector3(0, 0.1, -1).dot(dir)).normalize();
      const xx = new THREE.Vector3().crossVectors(yy, dir).normalize();
      this.bowBackPose.quat.setFromRotationMatrix(new THREE.Matrix4().makeBasis(xx, yy, dir));
      this._placeBow(false);
      this._absorb(this.bow, true); // lacquer limbs merge; the string stays a Line
    }
    // (the arrow stays a plain mesh: it is re-posed every frame and hidden most of the time)
    this.arrow = createArrow({ mats: this.mats });
    this.arrow.visible = false;
    this.root.add(this.arrow);

    this.meshes = this.pb.build(this.root, this._merge);
    this.skinSkeleton = this.pb.skeleton;
    this.pb = null;
    this.setProp('gourd', false); // gourd hidden, prosthetic fingers relaxed

    this.root.scale.setScalar(opts.scale || (this.type === 'genichiro' ? 1.06 : 1));
    this.root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    this.arrow.castShadow = false; // (see createArrow: no shadow, no extra shadow-depth program)
    this.root.updateMatrixWorld(true);
    this._prewarmSaved = null;
  }

  /**
   * Move a prop's meshes (materials of this rig) into the merged skinned meshes. Returns the node that now carries
   * the geometry — scale it to hide the prop (_show). A Mesh prop is replaced in its parent by a plain node.
   * direct: put the geometry on the prop group itself (props that are never hidden); otherwise on a child carrier
   * so toggling it never touches the prop's own transform (rig.weapon's matrix feeds the blade segment).
   */
  _absorb(obj, direct = false) {
    if (!this._merge || !obj) return obj;
    let carrier;
    const list = [];
    if (obj.isMesh) {
      carrier = new THREE.Object3D();
      carrier.name = obj.name || 'prop';
      carrier.position.copy(obj.position); carrier.quaternion.copy(obj.quaternion); carrier.scale.copy(obj.scale);
      carrier.userData = obj.userData;
      const parent = obj.parent;
      if (parent) { parent.add(carrier); parent.remove(obj); }
      list.push([obj, false]);
    } else {
      carrier = direct ? obj : new THREE.Object3D();
      if (!direct) { carrier.name = (obj.name || 'prop') + 'Skin'; obj.add(carrier); }
      for (const c of obj.children.slice()) if (c.isMesh) list.push([c, true]);
    }
    for (const [m, child] of list) {
      const key = this.mats.keyOf(m.material);
      if (!key) { if (!child) carrier.add(m); continue; } // foreign material: keep it as a plain mesh
      const g = m.geometry.clone();
      if (child) { m.updateMatrix(); g.applyMatrix4(m.matrix); obj.remove(m); }
      this.pb.add(carrier, key, g);
    }
    return carrier;
  }

  /** Show / hide a part node: merged geometry is hidden by scaling its node to 0 (visible has no effect on it). */
  _show(node, v) {
    if (!node) return;
    node.visible = v;
    if (this._merge) node.scale.setScalar(v ? 1 : 0);
  }

  // ── builder helpers (used by parts/*.js) ──────────────────────────────────
  addFlap(parent, pivot, o) { const f = new SwingFlap(parent, pivot, o); this.flaps.push(f); return f; }
  addFollower(parent, source, pivot, k, o) { const f = new Follower(parent, source, pivot, k, o); this.followers.push(f); return f; }
  addCollider(joint, offset, r) { this.colliders.push({ joint, offset: new THREE.Vector3().fromArray(offset), r0: r, r, center: new THREE.Vector3() }); }
  addRibbons(strands, o = {}) {
    const rs = new RibbonSet(this.root, this.mats.get('ribbon'), strands, o);
    rs.colliders = this.colliders;
    this.ribbons.push(rs);
    return rs;
  }

  _placeBow(inHand) {
    const b = this.bow;
    if (!b) return;
    b.parent?.remove(b);
    if (inHand) {
      b.position.set(0, 0, 0);
      b.quaternion.identity();
      this.sockets.weaponL.add(b);
    } else {
      b.position.copy(this.bowBackPose.pos);
      b.quaternion.copy(this.bowBackPose.quat);
      this.sockets.back.add(b);
    }
    setBowNock(b, null);
  }

  // ── public API ────────────────────────────────────────────────────────────
  getBladeSegment(outBase, outTip) {
    const w = this.weapon;
    w.updateWorldMatrix(true, false);
    outBase.copy(w.userData.bladeBase).applyMatrix4(w.matrixWorld);
    outTip.copy(w.userData.bladeTip).applyMatrix4(w.matrixWorld);
  }

  getSocketWorld(name, out) {
    if (name === 'weaponTip') {
      this.weapon.updateWorldMatrix(true, false);
      return out.copy(this.weapon.userData.bladeTip).applyMatrix4(this.weapon.matrixWorld);
    }
    const p = POINTS[name];
    if (p) {
      const j = this.joints[p[0]];
      j.updateWorldMatrix(true, false);
      return out.fromArray(p[1]).applyMatrix4(j.matrixWorld);
    }
    const o = this.sockets[name] || this.joints[name] || this.joints.chest;
    o.updateWorldMatrix(true, false);
    return out.setFromMatrixPosition(o.matrixWorld);
  }

  setProp(name, visible) {
    visible = !!visible;
    if (name === 'gourd') {
      this._props.gourd = visible;
      this._show(this.gourd, visible);
      if (this.handPoses) { this._show(this.handPoses.grip, visible); this._show(this.handPoses.relaxed, !visible); }
    } else if (name === 'bowHand') {
      if (!this.bow) return;
      if (this._props.bowHand === visible) return;
      this._props.bowHand = visible;
      this._placeBow(visible);
      // the katana is sheathed while the bow is in use
      this._weaponShown = !visible;
      this._show(this._weaponNode, !visible);
      this._hiltShown = visible || this.type === 'spear';
      this._show(this._hiltNode, this._hiltShown);
      this.sayaSwing.setGround(this._hiltShown ? this._sayaGroundHilt : this._sayaGround);
    } else if (name === 'arrowHand') {
      this._props.arrowHand = visible;
      this.arrow.visible = visible;
      if (!visible && this.bow) setBowNock(this.bow, null);
    }
  }

  flash(color = 0xffffff, duration = 0.12) { this.mats.flash(color, duration); }
  setGlow(color = null, intensity = 1) { this.mats.setGlow(color, intensity); }
  setVisible(v) {
    v = !!v;
    if (v && !this._visible) this._prevRootOk = false; // shown again: secondary motion restarts in place
    this._visible = v;
    this.root.visible = v && this.mats._opacity > 0.002;
  }
  setOpacity(a) {
    this.mats.setOpacity(a);
    this.root.visible = this._visible && this.mats._opacity > 0.002;
  }

  /**
   * Shader warm-up (Game.warmup): while on, every normally hidden prop / variant is shown — the nocked arrow (a
   * plain, non-skinned mesh: its own color program), the gourd with the gripping prosthetic fingers, and for
   * Genichiro the bow in hand with the katana sheathed (hilt shown, string drawn) — so renderer.compile and the
   * hidden warm-up frame build their color and shadow-depth programs before play. prewarm(false) restores the
   * exact gameplay state. (Merged props are part of the always-drawn skinned meshes, so they share its programs;
   * the extra coverage matters for `?rigsplit` and for the arrow.)
   */
  prewarm(on) {
    on = !!on;
    if (on === !!this._prewarmSaved) return;
    if (on) {
      const p = this._props;
      this._prewarmSaved = { gourd: p.gourd, bowHand: p.bowHand, arrowHand: p.arrowHand };
      this.setProp('gourd', true);
      this.setProp('bowHand', true);
      this.setProp('arrowHand', true);
      this.root.updateMatrixWorld(true);
      this._updateArrow(); // nocked at the right fist (inside the view / shadow frustum with the character)
      this.arrow.updateMatrixWorld(true);
    } else {
      const s = this._prewarmSaved;
      this._prewarmSaved = null;
      this.setProp('arrowHand', s.arrowHand);
      this.setProp('bowHand', s.bowHand);
      this.setProp('gourd', s.gourd);
      this.root.updateMatrixWorld(true);
    }
  }

  /** Re-initialise all secondary motion (flaps, ribbons) at the current pose — e.g. after a respawn. */
  resetSecondary() {
    for (let i = 0; i < this.flaps.length; i++) this.flaps[i].reset();
    for (let i = 0; i < this.ribbons.length; i++) this.ribbons[i].reset();
  }

  /**
   * Compare the root transform with the previous update: reset secondary motion on teleports, carry it rigidly
   * through smaller snaps (deathblow alignment, yaw flips, pushes) so no cloth is dragged across the gap.
   */
  _handleRootSnap(dt, speed) {
    const M = this.root.matrixWorld, e = M.elements, p = this._prevRoot.elements;
    if (!this._prevRootOk) {
      this.resetSecondary();
    } else {
      const dx = e[12] - p[12], dy = e[13] - p[13], dz = e[14] - p[14];
      // travel not explained by the body velocity (fast legit motion — dodges, grapple flight — is not a snap)
      const jump = Math.sqrt(dx * dx + dy * dy + dz * dz) - speed * dt;
      let dyaw = Math.atan2(e[8], e[10]) - Math.atan2(p[8], p[10]);
      dyaw = Math.abs(dyaw - Math.round(dyaw / (Math.PI * 2)) * Math.PI * 2);
      if (!Number.isFinite(jump) || jump > SNAP_RESET * this.root.scale.x) {
        this.resetSecondary();
        this.snapId++;
      } else if (dyaw > SNAP_YAW || jump > SNAP_CARRY) {
        this.snapId++;
        _m2.copy(this._prevRoot).invert().premultiply(M); // delta = M * prev^-1
        _qd.setFromRotationMatrix(_m2);
        for (let i = 0; i < this.flaps.length; i++) this.flaps[i].carry(_m2, _qd);
        for (let i = 0; i < this.ribbons.length; i++) this.ribbons[i].carry(_m2);
      }
    }
    this._prevRoot.copy(M);
    this._prevRootOk = true;
  }

  update(dt, velocity) {
    dt = dt > 0 && dt < 1 ? dt : 0;
    this._time += dt;
    for (let i = 0; i < this.followers.length; i++) this.followers[i].update();
    if (this._weaponClamped) { this.weapon.quaternion.identity(); this._weaponClamped = false; }
    this.root.updateMatrixWorld(true);
    // secondary motion keeps running while the camera fades the rig out (opacity 0); only setVisible(false) stops it
    if (this._visible) {
      let speed = velocity ? Math.hypot(velocity.x || 0, velocity.z || 0) : 0;
      let speed3 = velocity ? Math.hypot(velocity.x || 0, velocity.y || 0, velocity.z || 0) : 0;
      if (!(speed < 30)) speed = speed > 0 ? 30 : 0; // NaN / absurd velocities
      if (!(speed3 < 40)) speed3 = speed3 > 0 ? 40 : 0;
      this._handleRootSnap(dt, speed3 * 1.2);
      const sc = this.root.scale.x;
      const groundY = this.root.matrixWorld.elements[13];
      for (let i = 0; i < this.colliders.length; i++) {
        const c = this.colliders[i];
        c.center.copy(c.offset).applyMatrix4(c.joint.matrixWorld);
        c.r = c.r0 * sc;
      }
      for (let i = 0; i < this.flaps.length; i++) this.flaps[i].update(dt, this._time, groundY);
      for (let i = 0; i < this.ribbons.length; i++) {
        const r = this.ribbons[i];
        r.groundY = groundY + 0.015;
        r.update(dt, this._time, speed);
      }
      if (this.weaponType === 'spear' && this._weaponShown) this._clampWeapon(groundY + WEAPON_MARGIN);
      if (this._props.arrowHand) this._updateArrow();
      // rim-light occlusion probe (materials.js): a point above the head, looked up in the sun's shadow map
      const he = this.joints.head.matrixWorld.elements;
      if (Number.isFinite(he[12] + he[13] + he[14])) this.mats.probe.value.set(he[12], he[13] + 0.32 * sc, he[14], 1);
    }
    this.mats.update(dt);
  }

  /** Pivot the yari in the fist (toward level) so neither the blade nor the butt goes through the floor. */
  _clampWeapon(target) {
    const e = this.sockets.weaponR.matrixWorld.elements;
    const s = Math.hypot(e[8], e[9], e[10]) || 1;
    const dx = e[8] / s, dy = e[9] / s, dz = e[10] / s; // shaft axis (local +Z) in world
    const hy = e[13];
    const lo = (target - hy) / (SPEAR_TIP * s), hi = (hy - target) / (SPEAR_BUTT * s);
    if (dy >= lo && dy <= hi) return;
    let ny = lo > hi ? Math.max(-1, Math.min(1, (lo + hi) * 0.5)) : Math.max(lo, Math.min(hi, dy));
    ny = Math.max(-0.995, Math.min(0.995, ny));
    let hx = dx, hz = dz, hl = Math.hypot(hx, hz);
    if (hl < 1e-4) { const r = this.root.matrixWorld.elements; hx = r[8]; hz = r[10]; hl = Math.hypot(hx, hz) || 1; }
    const k = Math.sqrt(1 - ny * ny) / hl;
    _v.set(dx, dy, dz);
    _v2.set(hx * k, ny, hz * k);
    _q.setFromUnitVectors(_v, _v2); // world-space correction
    this.sockets.weaponR.matrixWorld.decompose(_v3, _q2, _s);
    // local = socketQ^-1 * correction * socketQ
    this.weapon.quaternion.copy(_q2).invert().multiply(_q).multiply(_q2);
    this.weapon.updateMatrixWorld(true);
    this._weaponClamped = true;
  }

  _updateArrow() {
    const a = this.arrow;
    const hand = this.sockets.weaponR;
    _v.setFromMatrixPosition(hand.matrixWorld); // nock position (right fist)
    let dirOk = false;
    if (this._props.bowHand && this.bow) {
      _v2.setFromMatrixPosition(this.sockets.weaponL.matrixWorld);
      _v3.subVectors(_v2, _v);
      const len = _v3.length();
      if (len > 0.12) { _v3.divideScalar(len); dirOk = true; }
    }
    if (!dirOk) _v3.set(0, 0, 1).transformDirection(hand.matrixWorld);
    // world transform: nock (local z = -0.8) at the hand, pointing toward the bow grip
    _q.setFromUnitVectors(Z, _v3);
    _v2.copy(_v).addScaledVector(_v3, 0.8 * this.root.scale.x);
    // to root-local
    _m.copy(this.root.matrixWorld).invert();
    a.position.copy(_v2).applyMatrix4(_m);
    this.root.getWorldQuaternion(_q2).invert();
    a.quaternion.copy(_q2).multiply(_q);
    // pull the bow string to the nock
    if (dirOk) {
      this.bow.updateWorldMatrix(false, false);
      _m.copy(this.bow.matrixWorld).invert();
      _v2.copy(_v).applyMatrix4(_m);
      setBowNock(this.bow, _v2);
    }
  }

  dispose() {
    this.root.parent?.remove(this.root);
    this.root.traverse((o) => {
      if (o.isMesh || o.isLine) {
        if (!o.geometry?.userData?.shared && !o.userData.sharedGeometry) o.geometry?.dispose();
      }
    });
    for (const r of this.ribbons) r.dispose();
    if (this.bow) this.bow.userData.string?.line.geometry.dispose();
    this.skinSkeleton?.dispose();
    this.mats.dispose();
  }
}
