import * as THREE from 'three';

// Shared humanoid joint hierarchy. Every character (player, soldiers, boss) uses this exact skeleton,
// so every animation clip works on every character. See docs/ARCHITECTURE.md §Skeleton for the
// rotation conventions clips must follow.
//
// Frame: character faces +Z, +Y up, +X is the character's LEFT side (-X is its right).
// Rest pose: standing straight, arms hanging straight down at the sides, all joint rotations = 0.
// Rotations are Euler XYZ (radians) in each joint's local frame (which equals the parent frame at rest).
//   limb hanging down (-Y):  rot.x < 0 swings it FORWARD (raise arm forward / knee up), rot.x > 0 swings it back
//   shin / foreArm:          shin rot.x > 0 bends the knee (foot goes back); foreArm rot.x < 0 bends the elbow (hand comes forward/up)
//   upperArmL:               rot.z > 0 raises the arm out to the side;  upperArmR: rot.z < 0 raises it out
//   spine/chest/neck/head:   rot.y turns (twist) left(+)/right(-); rot.x > 0 bends forward (bow), rot.z leans sideways
//   hips:                    rotates the whole body; hips position is animated as an OFFSET from rest (clip `pos`)

export const JOINTS = [
  'hips', 'spine', 'chest', 'neck', 'head',
  'upperArmL', 'foreArmL', 'handL',
  'upperArmR', 'foreArmR', 'handR',
  'thighL', 'shinL', 'footL',
  'thighR', 'shinR', 'footR',
];

export const PARENT = {
  hips: null,
  spine: 'hips', chest: 'spine', neck: 'chest', head: 'neck',
  upperArmL: 'chest', foreArmL: 'upperArmL', handL: 'foreArmL',
  upperArmR: 'chest', foreArmR: 'upperArmR', handR: 'foreArmR',
  thighL: 'hips', shinL: 'thighL', footL: 'shinL',
  thighR: 'hips', shinR: 'thighR', footR: 'shinR',
};

// Joint pivot offsets from parent at rest (meters). Hips pivot sits at 0.98 m above the feet.
export const REST = {
  hips: [0, 0.98, 0],
  spine: [0, 0.1, 0],
  chest: [0, 0.2, 0],
  neck: [0, 0.22, 0],
  head: [0, 0.08, 0],
  upperArmL: [0.2, 0.17, 0],
  foreArmL: [0, -0.29, 0],
  handL: [0, -0.26, 0],
  upperArmR: [-0.2, 0.17, 0],
  foreArmR: [0, -0.29, 0],
  handR: [0, -0.26, 0],
  thighL: [0.1, -0.04, 0],
  shinL: [0, -0.44, 0],
  footL: [0, -0.44, 0],
  thighR: [-0.1, -0.04, 0],
  shinR: [0, -0.44, 0],
  footR: [0, -0.44, 0],
};

// Sockets: child Object3Ds for attaching props. Local frames at rest match the root frame.
//   weaponR: in the right fist. Blades/spear shafts extend along the socket's +Z (forward when the arm hangs).
//   weaponL: in the left fist, same convention (bow grip, gourd).
//   back:    between the shoulder blades (sheathed bow / quiver).
//   hipL:    left hip (scabbard).
export const SOCKETS = {
  weaponR: { parent: 'handR', pos: [0, -0.07, 0.0] },
  weaponL: { parent: 'handL', pos: [0, -0.07, 0.0] },
  back: { parent: 'chest', pos: [0, 0.1, -0.16] },
  hipL: { parent: 'hips', pos: [0.17, 0.0, 0.04] },
  headTop: { parent: 'head', pos: [0, 0.2, 0] },
};

export class Skeleton {
  constructor() {
    this.root = new THREE.Group();
    this.root.name = 'characterRoot';
    this.joints = {};
    this.sockets = {};
    for (const name of JOINTS) {
      const j = new THREE.Object3D();
      j.name = name;
      j.position.fromArray(REST[name]);
      this.joints[name] = j;
      const parent = PARENT[name] ? this.joints[PARENT[name]] : this.root;
      parent.add(j);
    }
    for (const [name, s] of Object.entries(SOCKETS)) {
      const o = new THREE.Object3D();
      o.name = 'socket_' + name;
      o.position.fromArray(s.pos);
      this.joints[s.parent].add(o);
      this.sockets[name] = o;
    }
    this.restHips = new THREE.Vector3().fromArray(REST.hips);
  }

  resetPose() {
    for (const name of JOINTS) {
      this.joints[name].quaternion.identity();
      this.joints[name].position.fromArray(REST[name]);
    }
  }

  /**
   * Debug mannequin: simple boxes per bone so poses can be previewed before real meshes exist.
   * Returns the created meshes.
   */
  addMannequin(color = 0xb0a890) {
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.8 });
    const accent = new THREE.MeshStandardMaterial({ color: 0x993322, roughness: 0.6 });
    const meshes = [];
    const box = (joint, w, h, d, y, m = mat, z = 0) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
      mesh.position.set(0, y, z);
      mesh.castShadow = true;
      this.joints[joint].add(mesh);
      meshes.push(mesh);
      return mesh;
    };
    box('hips', 0.3, 0.14, 0.18, 0);
    box('spine', 0.28, 0.2, 0.17, 0.1);
    box('chest', 0.36, 0.24, 0.2, 0.1);
    box('neck', 0.08, 0.1, 0.08, 0.04);
    box('head', 0.19, 0.22, 0.21, 0.1);
    box('head', 0.1, 0.04, 0.04, 0.1, accent, 0.11); // "face" marker shows forward
    for (const s of ['L', 'R']) {
      box('upperArm' + s, 0.09, 0.28, 0.09, -0.14);
      box('foreArm' + s, 0.08, 0.26, 0.08, -0.13);
      box('hand' + s, 0.07, 0.09, 0.09, -0.05);
      box('thigh' + s, 0.13, 0.43, 0.13, -0.21);
      box('shin' + s, 0.11, 0.43, 0.11, -0.21);
      box('foot' + s, 0.1, 0.06, 0.24, -0.03, mat, 0.05);
    }
    // katana stand-in on weaponR (+Z)
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.04, 0.75), new THREE.MeshStandardMaterial({ color: 0xdddddd, metalness: 0.9, roughness: 0.2 }));
    blade.position.set(0, 0, 0.42);
    this.sockets.weaponR.add(blade);
    meshes.push(blade);
    return meshes;
  }
}
