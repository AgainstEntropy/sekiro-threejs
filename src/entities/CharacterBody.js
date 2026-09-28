import * as THREE from 'three';
import { GRAVITY } from '../core/constants.js';
import { dampAngle, forwardFromYaw, rightFromYaw, yawTo } from '../core/math.js';

// Kinematic character body shared by the player and all enemies.
// The owning entity writes velocity.x/z (and velocity.y for jumps); body.update() integrates gravity,
// resolves collisions and snaps to ground. position is the FEET position.

export class CharacterBody {
  constructor(collision, { radius = 0.4, height = 1.8, position = null, yaw = 0, stepUp = 0.45 } = {}) {
    this.collision = collision;
    this.radius = radius;
    this.height = height;
    this.stepUp = stepUp;
    this.position = new THREE.Vector3();
    if (position) this.position.copy(position);
    this.velocity = new THREE.Vector3();
    this.yaw = yaw;

    this.grounded = false;
    this.justLanded = false; // true for the single update in which we touched down
    this.landingSpeed = 0; // downward speed at touchdown (m/s, positive)
    this.airTime = 0;
    this.groundY = 0;

    this.gravityScale = 1;
    this.kinematic = false; // when true, update() does nothing (entity drives position directly, e.g. grapple)
    this.collideWorld = true;
    this.pushable = true; // participates in character-vs-character separation (Game handles it)
  }

  forward(out = new THREE.Vector3()) { return forwardFromYaw(this.yaw, out); }
  right(out = new THREE.Vector3()) { return rightFromYaw(this.yaw, out); }

  /** Smoothly rotate toward a world-space target position. */
  faceTowards(target, dt, rate = 12) {
    this.yaw = dampAngle(this.yaw, yawTo(this.position, target), rate, dt);
  }

  faceYaw(yaw, dt, rate = 12) {
    this.yaw = dampAngle(this.yaw, yaw, rate, dt);
  }

  teleport(pos, yaw = this.yaw) {
    this.position.copy(pos);
    this.velocity.set(0, 0, 0);
    this.yaw = yaw;
    this.groundY = this.collision.groundHeight(pos.x, pos.z, pos.y + 2);
    this.position.y = Math.max(this.position.y, this.groundY);
    this.grounded = Math.abs(this.position.y - this.groundY) < 0.05;
    this.airTime = 0;
  }

  update(dt) {
    this.justLanded = false;
    if (this.kinematic || dt <= 0) return;
    const p = this.position, v = this.velocity;
    const wasGrounded = this.grounded;

    v.y += GRAVITY * this.gravityScale * dt;
    if (wasGrounded && v.y < 0) v.y = Math.max(v.y, -2); // keep a small stick-to-ground force

    // Sub-step horizontal motion so fast dodges/grapples do not tunnel through thin walls.
    const horiz = Math.hypot(v.x, v.z) * dt;
    const steps = Math.min(4, Math.max(1, Math.ceil(horiz / (this.radius * 0.8))));
    const sdt = dt / steps;
    for (let i = 0; i < steps; i++) {
      p.x += v.x * sdt;
      p.z += v.z * sdt;
      if (this.collideWorld) this.collision.resolveCharacter(p, this.radius, this.height, this.stepUp);
    }
    p.y += v.y * dt;

    const g = this.collision.groundHeight(p.x, p.z, p.y + this.stepUp, this.radius * 0.35);
    if (p.y <= g) {
      if (!wasGrounded) {
        this.justLanded = true;
        this.landingSpeed = -v.y;
      }
      p.y = g;
      if (v.y < 0) v.y = 0;
      this.grounded = true;
    } else if (wasGrounded && v.y <= 0.01 && p.y - g <= this.stepUp + 0.1) {
      p.y = g; // follow slopes / stairs downward
      v.y = 0;
      this.grounded = true;
    } else {
      this.grounded = false;
    }
    this.groundY = g;
    this.airTime = this.grounded ? 0 : this.airTime + dt;
  }
}
