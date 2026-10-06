/**
 * Regenerate the raster icons from the mark.
 *
 * There is no SVG rasteriser on this machine — no `rsvg-convert`, no Inkscape,
 * no sharp — so headless Chrome does the rendering. That is also the more
 * faithful choice: Chrome is the engine that will draw the inline mark, so the
 * PNGs match what the browser shows.
 *
 * This script exists because the icons it replaces were WRONG. `icon-192.png`,
 * `icon-512.png` and `apple-touch-icon.png` all had an opaque BLACK badge: the
 * `fill="url(#badge)"` reference had not resolved when they were produced, and
 * SVG's fallback for an unresolvable paint is black. Verified by sampling —
 * `srgba(0,0,0,1)` at the badge, gold at the leaf. Anyone who installed the
 * PWA got a black square on their home screen.
 *
 * Three compositions, because the three uses are not the same picture:
 *
 *   icon-192 / icon-512   'any' — the rounded badge on transparency.
 *   icon-maskable-512     'maskable' — full bleed, content inside the safe
 *                         circle. Android crops this to whatever shape the
 *                         launcher uses, and it can cut to a circle of radius
 *                         40% of the width. Measured on the raw mark, the
 *                         page's top-left corner sits 27.8 units from the
 *                         centre in a 64 viewBox against a safe radius of
 *                         25.6 — so the unmodified mark loses that corner.
 *                         Hence the 0.86 scale about the centre.
 *   apple-touch-icon      full bleed, no rounding: iOS applies its own mask,
 *                         and pre-rounded artwork gets rounded twice, which
 *                         shows as a pale fringe in the corners.
 *
 * Usage:  node scripts/generate-icons.mjs
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public');

/** The mark's innards, at the 64-unit viewBox the rest of the project uses. */
const DEFS = `
    <!-- Base Plate Gradients (Emerald Crystal 3D) -->
    <linearGradient id="emerald-base" x1="0.1" y1="0.05" x2="0.9" y2="0.95">
      <stop offset="0%" stop-color="#0f5132" />
      <stop offset="35%" stop-color="#064e3b" />
      <stop offset="70%" stop-color="#04392b" />
      <stop offset="100%" stop-color="#022119" />
    </linearGradient>

    <!-- Glass Surface Specular Light -->
    <radialGradient id="glass-specular" cx="0.25" cy="0.18" r="0.75">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.5" />
      <stop offset="30%" stop-color="#34d399" stop-opacity="0.15" />
      <stop offset="70%" stop-color="#059669" stop-opacity="0" />
    </radialGradient>

    <!-- Metallic Gold Chamfer Rim (3D Bevel) -->
    <linearGradient id="gold-bevel" x1="0.1" y1="0.9" x2="0.9" y2="1">
      <stop offset="0%" stop-color="#fff8d6" />
      <stop offset="25%" stop-color="#fbbf24" />
      <stop offset="50%" stop-color="#f59e0b" />
      <stop offset="75%" stop-color="#d97706" />
      <stop offset="100%" stop-color="#78350f" />
    </linearGradient>

    <!-- Inner Metallic Gold Accent -->
    <linearGradient id="gold-inner" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#fef08a" stop-opacity="0.8" />
      <stop offset="50%" stop-color="#f59e0b" stop-opacity="0.4" />
      <stop offset="100%" stop-color="#b45309" stop-opacity="0.8" />
    </linearGradient>

    <!-- Open Book 3D Pages Gradient -->
    <linearGradient id="book-page-left" x1="1" y1="0.5" x2="0" y2="0.5">
      <stop offset="0%" stop-color="#ffffff" />
      <stop offset="60%" stop-color="#f1f5f9" />
      <stop offset="100%" stop-color="#cbd5e1" />
    </linearGradient>
    <linearGradient id="book-page-right" x1="0" y1="0.5" x2="1" y2="0.5">
      <stop offset="0%" stop-color="#ffffff" />
      <stop offset="60%" stop-color="#f1f5f9" />
      <stop offset="100%" stop-color="#cbd5e1" />
    </linearGradient>
    <linearGradient id="book-page-shadow" x1="0.5" y1="0" x2="0.5" y2="1">
      <stop offset="0%" stop-color="#e2e8f0" />
      <stop offset="100%" stop-color="#94a3b8" />
    </linearGradient>

    <!-- Central Flame & Leaf Gold Gradient -->
    <linearGradient id="emblem-gold" x1="0.2" y1="0" x2="0.8" y2="1">
      <stop offset="0%" stop-color="#fffbeb" />
      <stop offset="20%" stop-color="#fde047" />
      <stop offset="55%" stop-color="#f59e0b" />
      <stop offset="85%" stop-color="#d97706" />
      <stop offset="100%" stop-color="#92400e" />
    </linearGradient>

    <!-- Forest Emerald Leaf Wing -->
    <linearGradient id="leaf-emerald" x1="0.1" y1="0" x2="0.9" y2="1">
      <stop offset="0%" stop-color="#6ee7b7" />
      <stop offset="45%" stop-color="#10b981" />
      <stop offset="85%" stop-color="#047857" />
      <stop offset="100%" stop-color="#064e3b" />
    </linearGradient>

    <!-- Deep Ambient Drop Shadows -->
    <filter id="shadow-book" x="-25%" y="-25%" width="150%" height="150%">
      <feDropShadow dx="0" dy="2.8" stdDeviation="2" flood-color="#01180f" flood-opacity="0.75" />
    </filter>
    <filter id="shadow-emblem" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="2" stdDeviation="1.6" flood-color="#022119" flood-opacity="0.85" />
    </filter>`;

/** Central 3D Open Book and Highlands Emblem */
const ARTWORK = `
  <!-- 2. CENTRAL 3D OPEN KNOWLEDGE BOOK -->
  <g filter="url(#shadow-book)">
    <path d="M12 43.5 C19 41.5 26.5 42 32 44.5 C37.5 42 45 41.5 52 43.5 L52 45.2 C45 43.2 37.5 43.7 32 46.2 C26.5 43.7 19 43.2 12 45.2 Z"
          fill="url(#book-page-shadow)" />
    <path d="M12 42.5 C19 40.2 26.5 40.8 32 43.2 L32 28.5 C26.5 26.5 19 26 12 28 Z"
          fill="url(#book-page-left)" />
    <path d="M52 42.5 C45 40.2 37.5 40.8 32 43.2 L32 28.5 C37.5 26.5 45 26 52 28 Z"
          fill="url(#book-page-right)" />
    <path d="M31.3 28.2 L32.7 28.2 L32.7 43.5 L31.3 43.5 Z" fill="#10b981" opacity="0.65" />
    <path d="M32 28.5 L32 43.2" stroke="#047857" stroke-width="0.7" />
  </g>

  <!-- Document Lines -->
  <path d="M15 31.5 C19 30.5 24 30.8 28 32 M15 34.5 C19 33.5 24 33.8 28 35 M15 37.5 C19 36.5 24 36.8 28 38"
        stroke="#94a3b8" stroke-width="0.8" stroke-linecap="round" opacity="0.75" />
  <path d="M36 32 C40 30.8 45 30.5 49 31.5 M36 35 C40 33.8 45 33.5 49 34.5 M36 38 C40 36.8 45 36.5 49 37.5"
        stroke="#94a3b8" stroke-width="0.8" stroke-linecap="round" opacity="0.75" />

  <!-- 3. CENTRAL EMBLEM: HIGHLANDS MOUNTAINS & KNOWLEDGE FLAME-LEAF -->
  <g filter="url(#shadow-emblem)">
    <path d="M20 28 L27 18 L32 23.5 L37 16 L44 28"
          fill="none" stroke="url(#emblem-gold)" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" />
    <path d="M27 18 L29 21 M37 16 L35 20"
          stroke="#fffbeb" stroke-width="1.2" stroke-linecap="round" />

    <path d="M32 38 C32 38 41 33 42 21 C36 22 33 27 32 31 Z"
          fill="url(#leaf-emerald)" />
    <path d="M32 38 C35 32 37 27 40 22.5"
          fill="none" stroke="#a7f3d0" stroke-width="1.1" stroke-linecap="round" />

    <path d="M32 38 C31 35 24 31 24 23 C24 18 28 15 30 13.5 C29.5 16 31 18 32.5 19 C34 16.5 33 13 32 10 C36 12 39 16 38 21 C37.5 23 36 24.5 35 26 C37 25 38.5 23 39 21 C39.5 28 34.5 34 32 38 Z"
          fill="url(#emblem-gold)" />

    <path d="M30 14 C31.5 17 33 20 31.5 25 C30.5 28 28 30 26 31"
          fill="none" stroke="#fffbeb" stroke-width="1.2" stroke-linecap="round" opacity="0.85" />

    <circle cx="32" cy="10" r="1.4" fill="#ffffff" />
    <circle cx="32" cy="10" r="2.8" fill="#fde047" opacity="0.45" />
  </g>`;

/** The rounded badge: what the favicon file and the header mark draw. */
const ROUNDED = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>${DEFS}<clipPath id="clip"><rect width="64" height="64" rx="16"/></clipPath></defs>
  <rect width="64" height="64" rx="16" fill="url(#emerald-base)"/>
  <g clip-path="url(#clip)">
    <rect width="64" height="64" fill="url(#glass-specular)"/>
    <path d="M-10 28 L40 -12 L56 -12 L6 38 Z" fill="#ffffff" opacity="0.12" />
  </g>
  <rect x="1.1" y="1.1" width="61.8" height="61.8" rx="15" fill="none"
        stroke="url(#gold-bevel)" stroke-width="2.2"/>
  <rect x="3" y="3" width="58" height="58" rx="13.2" fill="none"
        stroke="url(#gold-inner)" stroke-width="0.8" opacity="0.7"/>
${ARTWORK}
</svg>`;

/** Full bleed version. */
function fullBleed(scale) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>${DEFS}</defs>
  <rect width="64" height="64" fill="url(#emerald-base)"/>
  <rect width="64" height="64" fill="url(#glass-specular)"/>
  <path d="M-10 28 L40 -12 L56 -12 L6 38 Z" fill="#ffffff" opacity="0.12" />
  <g transform="translate(32 32) scale(${scale}) translate(-32 -32)">
${ARTWORK}
  </g>
</svg>`;
}

const OG_IMAGE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" width="1200" height="630">
  <defs>
    ${DEFS}
    <linearGradient id="og-bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#021f15" />
      <stop offset="45%" stop-color="#064e3b" />
      <stop offset="100%" stop-color="#01140e" />
    </linearGradient>
    <radialGradient id="og-glow" cx="0.25" cy="0.5" r="0.6">
      <stop offset="0%" stop-color="#10b981" stop-opacity="0.35" />
      <stop offset="100%" stop-color="#064e3b" stop-opacity="0" />
    </radialGradient>
    <radialGradient id="og-glow-gold" cx="0.8" cy="0.3" r="0.5">
      <stop offset="0%" stop-color="#f59e0b" stop-opacity="0.2" />
      <stop offset="100%" stop-color="#064e3b" stop-opacity="0" />
    </radialGradient>
    <linearGradient id="og-gold-text" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#fef08a" />
      <stop offset="40%" stop-color="#fbbf24" />
      <stop offset="80%" stop-color="#f59e0b" />
      <stop offset="100%" stop-color="#d97706" />
    </linearGradient>
    <filter id="og-shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="16" stdDeviation="24" flood-color="#000000" flood-opacity="0.65" />
    </filter>
  </defs>

  <!-- Background -->
  <rect width="1200" height="630" fill="url(#og-bg)"/>
  <rect width="1200" height="630" fill="url(#og-glow)"/>
  <rect width="1200" height="630" fill="url(#og-glow-gold)"/>

  <!-- Border Frame -->
  <rect x="24" y="24" width="1152" height="582" rx="28" fill="none" stroke="url(#gold-bevel)" stroke-width="2" opacity="0.45" />

  <!-- 3D Logo Mark Container -->
  <g transform="translate(110, 175) scale(4.4)" filter="url(#og-shadow)">
    <rect width="64" height="64" rx="16" fill="url(#emerald-base)"/>
    <g clip-path="url(#clip)">
      <rect width="64" height="64" fill="url(#glass-specular)"/>
      <path d="M-10 28 L40 -12 L56 -12 L6 38 Z" fill="#ffffff" opacity="0.12" />
    </g>
    <rect x="1.1" y="1.1" width="61.8" height="61.8" rx="15" fill="none"
          stroke="url(#gold-bevel)" stroke-width="2.2"/>
    <rect x="3" y="3" width="58" height="58" rx="13.2" fill="none"
          stroke="url(#gold-inner)" stroke-width="0.8" opacity="0.7"/>
    ${ARTWORK}
  </g>

  <!-- Typography Content -->
  <g transform="translate(460, 195)">
    <!-- Pill Badge -->
    <rect x="0" y="0" width="410" height="38" rx="19" fill="#0f5132" stroke="#fbbf24" stroke-width="1.2" opacity="0.9" />
    <circle cx="20" cy="19" r="6" fill="#fbbf24" />
    <text x="36" y="24" fill="#fef08a" font-family="system-ui, -apple-system, sans-serif" font-size="14" font-weight="700" letter-spacing="1.5">
      TRƯỜNG ĐẠI HỌC TÂY NGUYÊN
    </text>

    <!-- Main Title -->
    <text x="0" y="115" font-family="system-ui, -apple-system, sans-serif" font-size="68" font-weight="900" letter-spacing="2">
      <tspan fill="#ffffff">TAILIEU </tspan>
      <tspan fill="url(#og-gold-text)">TTN</tspan>
    </text>

    <!-- Subtitle -->
    <text x="0" y="165" fill="#a7f3d0" font-family="system-ui, -apple-system, sans-serif" font-size="26" font-weight="600">
      Kho Tri Thức Học Thuật &amp; Đề Thi Sinh Viên
    </text>

    <!-- Features / Highlights -->
    <text x="0" y="215" fill="#cbd5e1" font-family="system-ui, -apple-system, sans-serif" font-size="20" font-weight="400">
      Chia sẻ tài liệu • Khám phá đề thi • Bài giảng chất lượng cao
    </text>

    <!-- Website link badge -->
    <g transform="translate(0, 255)">
      <rect x="0" y="0" width="280" height="42" rx="12" fill="#022119" stroke="#34d399" stroke-width="1.2" opacity="0.85" />
      <text x="24" y="27" fill="#6ee7b7" font-family="monospace" font-size="18" font-weight="700">
        tailieu.5125121.com
      </text>
    </g>
  </g>
</svg>`;

const ASSETS = [
  { file: 'icon-192.png', width: 192, height: 192, svg: ROUNDED, transparent: true },
  { file: 'icon-512.png', width: 512, height: 512, svg: ROUNDED, transparent: true },
  { file: 'icon-maskable-512.png', width: 512, height: 512, svg: fullBleed(0.86), transparent: false },
  { file: 'apple-touch-icon.png', width: 180, height: 180, svg: fullBleed(1), transparent: false },
  { file: 'og-image.png', width: 1200, height: 630, svg: OG_IMAGE_SVG, transparent: false },
];

const work = mkdtempSync(join(tmpdir(), 'icons-'));

for (const asset of ASSETS) {
  const page = join(work, `${asset.file}.html`);
  writeFileSync(
    page,
    `<!doctype html><meta charset="utf-8">
     <style>html,body{margin:0;padding:0;background:transparent}
            svg{display:block;width:${asset.width}px;height:${asset.height}px}</style>
     ${asset.svg}`,
  );

  const result = spawnSync(
    'google-chrome',
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      // Only for the rounded icons; a maskable or touch icon with transparent
      // corners is the defect described at the top of this file.
      ...(asset.transparent ? ['--default-background-color=00000000'] : []),
      `--window-size=${asset.width},${asset.height}`,
      `--screenshot=${join(PUBLIC, asset.file)}`,
      `file://${page}`,
    ],
    { encoding: 'utf8' },
  );

  if (result.status !== 0) {
    console.error(`FAILED ${asset.file}\n${result.stderr}`);
    process.exit(1);
  }
  console.log(`${asset.file}  ${asset.width}x${asset.height}`);
}

console.log('\nWrote to', PUBLIC);
