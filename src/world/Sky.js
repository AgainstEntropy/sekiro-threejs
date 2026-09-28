import * as THREE from 'three';
import { HAZE_GLSL, worldUniforms } from './materials.js';

// Dusk sky dome: indigo zenith -> violet -> burnt-orange horizon, an enormous pale moon with maria and a soft
// halo, faint twinkling stars and wispy clouds lit by the sunset. The horizon band uses worldHazeColor(), the
// same function the world fog uses, so distant silhouettes blend into the sky.

const vert = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * p;
  gl_Position.z = gl_Position.w; // at the far plane
}`;

const frag = /* glsl */ `
varying vec3 vDir;
uniform float uTime;
uniform vec3 uZenith;
uniform vec3 uMid;
uniform vec3 uLowSun;
uniform vec3 uLowMoon;
uniform vec3 uMoonColor;
uniform vec3 uCloudLit;
uniform vec3 uCloudDark;
uniform float uMoonSize;
uniform float uEnvMode;
uniform vec3 uGroundColor;
${HAZE_GLSL}

float h31(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.yzx + 33.33); return fract((p.x + p.y) * p.z); }
vec3 h33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}
float h21(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
float vn(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), u.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * vn(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; }
  return s;
}

void main() {
  vec3 d = normalize(vDir);
  float e = d.y;
  vec3 haze = worldHazeColor(d);
  vec2 dxz = normalize(d.xz + vec2(1e-5, 0.0));
  float s = dot(dxz, normalize(uSunDir.xz)) * 0.5 + 0.5;
  float sunSide = smoothstep(0.05, 1.0, s);

  // Gradient
  vec3 low = mix(uLowMoon, uLowSun, sunSide);
  vec3 col = mix(haze, low, smoothstep(0.0, 0.07 + 0.05 * sunSide, e));
  col = mix(col, uMid, smoothstep(0.04, 0.38 + 0.12 * sunSide, e));
  col = mix(col, uZenith, smoothstep(0.32, 0.95, e));
  // Sunset glow hugging the horizon toward the sun
  float sd = max(dot(d, normalize(vec3(uSunDir.x, 0.02, uSunDir.z))), 0.0);
  col += uLowSun * pow(sd, 6.0) * 0.55 * (1.0 - smoothstep(0.0, 0.35, e));

  // Moon geometry (needed by the clouds too)
  float cosA = dot(d, uMoonDir);
  float ang = acos(clamp(cosA, -1.0, 1.0));

  // Clouds: long wisps on a sky plane
  float cloud = 0.0;
  vec3 cloudCol = vec3(0.0);
  if (e > 0.0) {
    vec2 cp = d.xz / (e + 0.12) * 1.6;
    cp = vec2(cp.x * 0.45 + cp.y * 0.12, cp.y * 1.4 - cp.x * 0.1);
    cp += vec2(uTime * 0.006, uTime * 0.002);
    float warp = fbm(cp * 0.7 + 3.1);
    float n = fbm(cp + vec2(warp * 1.6, warp * 0.4));
    float band = smoothstep(0.02, 0.1, e) * (1.0 - smoothstep(0.35, 0.75, e));
    cloud = smoothstep(0.5, 0.78, n) * band;
    // thin wisps: domain-warped (no evenly spaced streaks) and mostly kept off the moon disc, so only the odd thick
    // wisp crosses it
    vec2 tw = vec2(vn(cp * 1.7 + 3.0), vn(cp * 1.9 - 5.0)) - 0.5;
    float thin = smoothstep(0.45, 0.62, fbm(cp * 2.3 + 11.0 + tw * vec2(1.4, 2.6))) * band * 0.35;
    thin *= 1.0 - 0.85 * smoothstep(uMoonSize * 2.6, uMoonSize * 1.05, ang);
    cloud = clamp(cloud + thin * (1.0 - cloud), 0.0, 1.0);
    float lit = sunSide * sunSide;
    cloudCol = mix(uCloudDark, uCloudLit, lit * 0.9 + 0.1);
    float md = max(dot(d, uMoonDir), 0.0);
    cloudCol += uMoonColor * 0.25 * pow(md, 30.0);           // silver lining near the moon
    cloudCol = mix(cloudCol, haze, smoothstep(0.12, 0.0, e) * 0.6);
  }

  // Stars
  if (e > 0.05 && uEnvMode < 0.5) {
    vec3 sp = d * 150.0;
    vec3 cell = floor(sp);
    float h = h31(cell);
    if (h > 0.965) {
      vec3 off = h33(cell) * 0.7 + 0.15;
      float dist = length(fract(sp) - off);
      float tw = 0.6 + 0.4 * sin(uTime * (1.5 + h * 4.0) + h * 80.0);
      float st = smoothstep(0.1, 0.0, dist) * tw * (h - 0.965) / 0.035;
      st *= smoothstep(0.05, 0.45, e) * (1.0 - cloud);
      col += vec3(0.8, 0.85, 1.0) * st * 1.6;
    }
  }

  // Moon
  vec3 up = abs(uMoonDir.y) > 0.99 ? vec3(1, 0, 0) : vec3(0, 1, 0);
  vec3 mr = normalize(cross(up, uMoonDir));
  vec3 mu = cross(uMoonDir, mr);
  float r = ang / uMoonSize;
  // Halo (outside the disc)
  vec3 halo = uMoonColor * (exp(-ang * 7.0) * 0.18 + exp(-ang * 22.0) * 0.35 + exp(-max(r - 1.0, 0.0) * 9.0) * 0.22);
  col += halo * (1.0 - cloud * 0.5);
  if (r < 1.02 && cosA > 0.0) {
    vec2 mp = vec2(dot(d, mr), dot(d, mu)) / sin(uMoonSize);
    float rr = length(mp);
    float z = sqrt(max(0.0, 1.0 - rr * rr));
    float maria = fbm(mp * 2.2 + vec2(4.0, 1.3));
    float maria2 = fbm(mp * 6.0 - 2.0);
    float tone = 1.0 - 0.44 * smoothstep(0.45, 0.68, maria) - 0.16 * smoothstep(0.5, 0.7, maria2);
    float crater = smoothstep(0.93, 0.99, vn(mp * 14.0)) * 0.1;
    float limb = 0.55 + 0.45 * pow(z, 0.5);
    vec3 disc = uMoonColor * (tone - crater) * limb * 1.6;
    float edge = 1.0 - smoothstep(0.985, 1.015, rr);
    col = mix(col, disc, edge * (1.0 - cloud * 0.75));
  }

  if (cloud > 0.0) col = mix(col, cloudCol, cloud * 0.85);

  // Distant ranges beyond the terrain: two hazy silhouette layers just above the horizon, seen wherever the nearer
  // mountains dip (under the moon, along the valley). Kept low around the moon's azimuth so the moon stays clear.
  if (e > -0.02 && e < 0.1) {
    vec2 cs = normalize(d.xz + vec2(1e-5, 0.0));
    vec2 mxz = normalize(uMoonDir.xz);
    float nearMoon = 1.0 - smoothstep(0.06, 0.5, acos(clamp(dot(cs, mxz), -1.0, 1.0)));
    float lowK = 1.0 - 0.55 * nearMoon;
    float rA = fbm(cs * 7.0 + vec2(3.1, 8.7)); rA = 1.0 - abs(rA * 2.0 - 1.0);
    float rB = fbm(cs * 11.0 - vec2(5.3, 1.9)); rB = 1.0 - abs(rB * 2.0 - 1.0);
    float hA = (0.012 + 0.05 * rA * rA) * lowK;
    float hB = (0.005 + 0.034 * rB * rB) * lowK;
    col = mix(col, haze * 0.8, 0.85 * smoothstep(hA + 0.0016, hA - 0.0016, e));
    col = mix(col, haze * 0.66, 0.9 * smoothstep(hB + 0.0014, hB - 0.0014, e));
  }

  // Below the horizon: haze, darkening (for the env map: dark earthy ground)
  if (e < 0.0) {
    col = mix(haze, haze * 0.55, smoothstep(0.0, -0.25, e));
    if (uEnvMode > 0.5) col = mix(haze * 0.6, uGroundColor, smoothstep(0.0, -0.2, e));
  }

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class Sky {
  constructor(colors) {
    this.uniforms = {
      ...worldUniforms,
      uZenith: { value: new THREE.Color(colors.zenith) },
      uMid: { value: new THREE.Color(colors.mid) },
      uLowSun: { value: new THREE.Color(colors.lowSun) },
      uLowMoon: { value: new THREE.Color(colors.lowMoon) },
      uMoonColor: { value: new THREE.Color(colors.moon) },
      uCloudLit: { value: new THREE.Color(colors.cloudLit) },
      uCloudDark: { value: new THREE.Color(colors.cloudDark) },
      uMoonSize: { value: colors.moonSize ?? 0.095 },
      uEnvMode: { value: 0 },
      uGroundColor: { value: new THREE.Color(colors.ground ?? 0x201a16) },
    };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: vert,
      fragmentShader: frag,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: true,
      fog: false,
    });
    this.material.name = 'world_sky';
    const geo = new THREE.SphereGeometry(1000, 48, 24);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'sky';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.mesh.onBeforeRender = (renderer, scene, camera) => {
      this.mesh.position.copy(camera.position);
      this.mesh.updateMatrixWorld();
    };
  }

  /** Pre-filtered environment map of the sky (with a dark ground hemisphere) for PBR ambient light. */
  makeEnvironment(renderer) {
    const envUniforms = { ...this.uniforms, uEnvMode: { value: 1 } };
    const mat = this.material.clone();
    mat.uniforms = envUniforms;
    const geo = new THREE.SphereGeometry(50, 32, 16);
    const mesh = new THREE.Mesh(geo, mat);
    const scene = new THREE.Scene();
    scene.add(mesh);
    const pm = new THREE.PMREMGenerator(renderer);
    const prevTM = renderer.toneMapping;
    const rt = pm.fromScene(scene, 0.02, 0.1, 200);
    renderer.toneMapping = prevTM;
    pm.dispose();
    geo.dispose();
    mat.dispose();
    return rt;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
