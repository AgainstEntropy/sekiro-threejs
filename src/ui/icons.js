// Inline SVG icons & shared SVG filter definitions for the HUD (all procedural).
import { FONT_BRUSH } from './fonts.js';

/** Hidden <svg> with filters referenced from CSS (filter: url(#hud-rough-s) etc.). */
export const SHARED_DEFS = `
<svg class="hud-defs" width="0" height="0" aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden">
  <defs>
    <!-- subtle brush edge for small kanji / labels -->
    <filter id="hud-rough-s" x="-10%" y="-10%" width="120%" height="120%">
      <feTurbulence type="fractalNoise" baseFrequency="0.09" numOctaves="2" seed="4" result="n"/>
      <feDisplacementMap in="SourceGraphic" in2="n" scale="2.2" xChannelSelector="R" yChannelSelector="G"/>
    </filter>
    <!-- stronger brush edge for mid-size kanji (危, 回生) -->
    <filter id="hud-rough-m" x="-15%" y="-15%" width="130%" height="130%">
      <feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves="3" seed="9" result="n"/>
      <feDisplacementMap in="SourceGraphic" in2="n" scale="7" xChannelSelector="R" yChannelSelector="G"/>
    </filter>
    <!-- stamped seal: rough edge + speckled ink loss -->
    <filter id="hud-seal" x="-10%" y="-10%" width="120%" height="120%" color-interpolation-filters="sRGB">
      <feTurbulence type="fractalNoise" baseFrequency="0.06" numOctaves="3" seed="12" result="w"/>
      <feDisplacementMap in="SourceGraphic" in2="w" scale="4.5" xChannelSelector="R" yChannelSelector="G" result="d"/>
      <feTurbulence type="fractalNoise" baseFrequency="0.55" numOctaves="1" seed="3" result="g"/>
      <feColorMatrix in="g" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  -6 0 0 0 4.1" result="ga"/>
      <feComposite in="d" in2="ga" operator="in" result="s"/>
      <feTurbulence type="fractalNoise" baseFrequency="0.018" numOctaves="2" seed="21" result="b"/>
      <feColorMatrix in="b" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  -3 0 0 0 2.35" result="ba"/>
      <feComposite in="s" in2="ba" operator="in"/>
    </filter>
    <radialGradient id="hud-gourd-g" cx="36%" cy="32%" r="75%">
      <stop offset="0" stop-color="#f6c77a"/>
      <stop offset="0.45" stop-color="#bf7a30"/>
      <stop offset="1" stop-color="#4f2a0c"/>
    </radialGradient>
  </defs>
</svg>`;

export const GOURD_SVG = `
<svg viewBox="0 0 40 58" aria-hidden="true">
  <rect x="16.6" y="1.5" width="6.8" height="6.5" rx="1.6" fill="#8d6c45" stroke="#2a1c0e" stroke-width="0.8"/>
  <path d="M15.5 8.5 h9 l-0.8 2.8 h-7.4z" fill="#5b3b1c"/>
  <circle cx="20" cy="18" r="8.2" fill="url(#hud-gourd-g)" stroke="#2b1606" stroke-width="0.9"/>
  <circle cx="20" cy="39.5" r="15" fill="url(#hud-gourd-g)" stroke="#2b1606" stroke-width="0.9"/>
  <path d="M13.2 26.4 Q20 30.2 26.8 26.4" stroke="#b01a1f" stroke-width="2.6" fill="none" stroke-linecap="round"/>
  <path d="M23.5 28.2 q3.2 5.5 0.6 11.8 M24.4 28.4 q5 4.6 4.2 10.4" stroke="#b01a1f" stroke-width="1.5" fill="none" stroke-linecap="round"/>
  <ellipse cx="14.8" cy="34" rx="3.2" ry="5.2" fill="#fff3d6" opacity="0.28" transform="rotate(20 14.8 34)"/>
</svg>`;

export const HOOK_SVG = `
<svg viewBox="0 0 32 32" aria-hidden="true" fill="none" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="16" cy="5" r="2.6" stroke="currentColor" stroke-width="1.8"/>
  <path d="M16 7.6 V21" stroke="currentColor" stroke-width="2.4"/>
  <path d="M16 21 C16 28, 7.5 28.5, 7 21.5 M16 21 C16 28, 24.5 28.5, 25 21.5" stroke="currentColor" stroke-width="2.2"/>
  <path d="M7 21.5 l-1.8 1.6 M25 21.5 l1.8 1.6" stroke="currentColor" stroke-width="1.8"/>
</svg>`;

/** Red hanko seal with a white carved character. */
export function sealSvg(char = '狼') {
  return `
<svg viewBox="0 0 100 100" aria-hidden="true" class="seal-svg">
  <g filter="url(#hud-seal)">
    <rect x="5" y="5" width="90" height="90" rx="9" fill="#b0141a"/>
    <rect x="11.5" y="11.5" width="77" height="77" rx="5" fill="none" stroke="#f3e6d8" stroke-width="2.6"/>
    <text x="50" y="53" text-anchor="middle" dominant-baseline="central" font-size="64" fill="#f3e6d8"
      style="font-family:${FONT_BRUSH.replace(/"/g, "'")}">${char}</text>
  </g>
</svg>`;
}
