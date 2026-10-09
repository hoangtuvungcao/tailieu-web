/**
 * Brand mark and logo with 3D aesthetic and Tay Nguyen identity.
 *
 * Inline SVG implementation ensures instant load without layout shifts,
 * crisp scaling across Retina/4K displays, and full dark/light theme harmony.
 */
import { useId } from 'react';

import { cn } from '@/lib/utils';

/**
 * 3D Brand Mark:
 * - Emerald crystal 3D squircle base with specular light reflections
 * - Chamfered metallic gold bevel rim
 * - Floating open 3D knowledge book with realistic page curves and soft drop shadows
 * - Central golden student academic graduation cap & star of knowledge
 */
export function LogoMark({
  className,
  decorative = false,
}: {
  className?: string;
  decorative?: boolean;
}) {
  const uid = `logo${useId().replace(/:/g, '')}`;

  return (
    <svg
      viewBox="0 0 64 64"
      className={cn('h-9 w-9 shrink-0 drop-shadow-sm', className)}
      role={decorative ? undefined : 'img'}
      aria-hidden={decorative ? true : undefined}
      aria-label={decorative ? undefined : 'Tài Liệu Sinh Viên'}
    >
      <defs>
        {/* Base Plate Gradients (Emerald Crystal 3D) */}
        <linearGradient id={`${uid}-emerald-base`} x1="0.1" y1="0.05" x2="0.9" y2="0.95">
          <stop offset="0%" stopColor="#0f5132" />
          <stop offset="35%" stopColor="#064e3b" />
          <stop offset="70%" stopColor="#04392b" />
          <stop offset="100%" stopColor="#022119" />
        </linearGradient>

        {/* Glass Surface Specular Light */}
        <radialGradient id={`${uid}-glass-specular`} cx="0.25" cy="0.18" r="0.75">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.5" />
          <stop offset="30%" stopColor="#34d399" stopOpacity="0.15" />
          <stop offset="70%" stopColor="#059669" stopOpacity="0" />
        </radialGradient>

        {/* Metallic Gold Chamfer Rim (3D Bevel) */}
        <linearGradient id={`${uid}-gold-bevel`} x1="0.1" y1="0" x2="0.9" y2="1">
          <stop offset="0%" stopColor="#fff8d6" />
          <stop offset="25%" stopColor="#fbbf24" />
          <stop offset="50%" stopColor="#f59e0b" />
          <stop offset="75%" stopColor="#d97706" />
          <stop offset="100%" stopColor="#78350f" />
        </linearGradient>

        {/* Inner Metallic Gold Accent */}
        <linearGradient id={`${uid}-gold-inner`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#fef08a" stopOpacity="0.8" />
          <stop offset="50%" stopColor="#f59e0b" stopOpacity="0.4" />
          <stop offset="100%" stopColor="#b45309" stopOpacity="0.8" />
        </linearGradient>

        {/* Open Book 3D Pages Gradient */}
        <linearGradient id={`${uid}-book-page-left`} x1="1" y1="0.5" x2="0" y2="0.5">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="60%" stopColor="#f1f5f9" />
          <stop offset="100%" stopColor="#cbd5e1" />
        </linearGradient>
        <linearGradient id={`${uid}-book-page-right`} x1="0" y1="0.5" x2="1" y2="0.5">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="60%" stopColor="#f1f5f9" />
          <stop offset="100%" stopColor="#cbd5e1" />
        </linearGradient>
        <linearGradient id={`${uid}-book-page-shadow`} x1="0.5" y1="0" x2="0.5" y2="1">
          <stop offset="0%" stopColor="#e2e8f0" />
          <stop offset="100%" stopColor="#94a3b8" />
        </linearGradient>

        {/* Central Flame & Leaf Gold Gradient */}
        <linearGradient id={`${uid}-emblem-gold`} x1="0.2" y1="0" x2="0.8" y2="1">
          <stop offset="0%" stopColor="#fffbeb" />
          <stop offset="20%" stopColor="#fde047" />
          <stop offset="55%" stopColor="#f59e0b" />
          <stop offset="85%" stopColor="#d97706" />
          <stop offset="100%" stopColor="#92400e" />
        </linearGradient>

        {/* Forest Emerald Leaf Wing */}
        <linearGradient id={`${uid}-leaf-emerald`} x1="0.1" y1="0" x2="0.9" y2="1">
          <stop offset="0%" stopColor="#6ee7b7" />
          <stop offset="45%" stopColor="#10b981" />
          <stop offset="85%" stopColor="#047857" />
          <stop offset="100%" stopColor="#064e3b" />
        </linearGradient>

        {/* Deep Ambient Drop Shadows */}
        <filter id={`${uid}-shadow-book`} x="-25%" y="-25%" width="150%" height="150%">
          <feDropShadow dx="0" dy="2.8" stdDeviation="2" floodColor="#01180f" floodOpacity="0.75" />
        </filter>
        <filter id={`${uid}-shadow-emblem`} x="-30%" y="-30%" width="160%" height="160%">
          <feDropShadow dx="0" dy="2" stdDeviation="1.6" floodColor="#022119" floodOpacity="0.85" />
        </filter>

        <clipPath id={`${uid}-squircle-clip`}>
          <rect width="64" height="64" rx="16" />
        </clipPath>
      </defs>

      {/* 1. BASE SQUIRCLE WITH 3D GLASS & BEVEL */}
      <rect width="64" height="64" rx="16" fill={`url(#${uid}-emerald-base)`} />

      {/* Glass Specular Reflection Highlight */}
      <g clipPath={`url(#${uid}-squircle-clip)`}>
        <rect width="64" height="64" fill={`url(#${uid}-glass-specular)`} />
        {/* Diagonal Glass Glare Arc */}
        <path d="M-10 28 L40 -12 L56 -12 L6 38 Z" fill="#ffffff" opacity="0.12" />
      </g>

      {/* Outer 3D Gold Metallic Chamfer Rim */}
      <rect
        x="1.1"
        y="1.1"
        width="61.8"
        height="61.8"
        rx="15"
        fill="none"
        stroke={`url(#${uid}-gold-bevel)`}
        strokeWidth="2.2"
      />

      {/* Inner Soft Accent Border */}
      <rect
        x="3"
        y="3"
        width="58"
        height="58"
        rx="13.2"
        fill="none"
        stroke={`url(#${uid}-gold-inner)`}
        strokeWidth="0.8"
        opacity="0.7"
      />

      {/* 2. CENTRAL 3D OPEN KNOWLEDGE BOOK (ISOMETRIC SPREAD) */}
      <g filter={`url(#${uid}-shadow-book)`}>
        {/* Lower pages depth edge (Thickness of book) */}
        <path
          d="M12 43.5 C19 41.5 26.5 42 32 44.5 C37.5 42 45 41.5 52 43.5 L52 45.2 C45 43.2 37.5 43.7 32 46.2 C26.5 43.7 19 43.2 12 45.2 Z"
          fill={`url(#${uid}-book-page-shadow)`}
        />

        {/* Left Open Page */}
        <path
          d="M12 42.5 C19 40.2 26.5 40.8 32 43.2 L32 28.5 C26.5 26.5 19 26 12 28 Z"
          fill={`url(#${uid}-book-page-left)`}
        />

        {/* Right Open Page */}
        <path
          d="M52 42.5 C45 40.2 37.5 40.8 32 43.2 L32 28.5 C37.5 26.5 45 26 52 28 Z"
          fill={`url(#${uid}-book-page-right)`}
        />

        {/* Center Fold Spine Glow */}
        <path d="M31.3 28.2 L32.7 28.2 L32.7 43.5 L31.3 43.5 Z" fill="#10b981" opacity="0.65" />
        <path d="M32 28.5 L32 43.2" stroke="#047857" strokeWidth="0.7" />
      </g>

      {/* Fine Document Lines (Subtle Text Lines on Pages) */}
      <path
        d="M15 31.5 C19 30.5 24 30.8 28 32 M15 34.5 C19 33.5 24 33.8 28 35 M15 37.5 C19 36.5 24 36.8 28 38"
        stroke="#94a3b8"
        strokeWidth="0.8"
        strokeLinecap="round"
        opacity="0.75"
      />
      <path
        d="M36 32 C40 30.8 45 30.5 49 31.5 M36 35 C40 33.8 45 33.5 49 34.5 M36 38 C40 36.8 45 36.5 49 37.5"
        stroke="#94a3b8"
        strokeWidth="0.8"
        strokeLinecap="round"
        opacity="0.75"
      />

      {/* 3. CENTRAL EMBLEM: STUDENT ACADEMIC CAP & KNOWLEDGE STAR (GOLD 3D) */}
      <g filter={`url(#${uid}-shadow-emblem)`}>
        {/* Cap Skull Base */}
        <path
          d="M24 22.5 L24 26.5 C24 30.5 40 30.5 40 26.5 L40 22.5"
          fill={`url(#${uid}-emblem-gold)`}
          stroke="#78350f"
          strokeWidth="0.8"
        />

        {/* Mortarboard Rhombus (Top Diamond) */}
        <path
          d="M18 20 L32 13 L46 20 L32 27 Z"
          fill={`url(#${uid}-emblem-gold)`}
          stroke="#92400e"
          strokeWidth="0.8"
        />

        {/* Rhombus Specular Bevel Highlight */}
        <path
          d="M19.5 19.8 L32 13.8 L44.5 19.8"
          fill="none"
          stroke="#fffbeb"
          strokeWidth="1.2"
          strokeLinecap="round"
        />

        {/* Center Button on Mortarboard */}
        <circle cx="32" cy="20" r="1.6" fill="#fffbeb" />

        {/* Tassel Ribbon hanging right */}
        <path
          d="M32 20 C38 21 44 24 45 28.5"
          fill="none"
          stroke="#fef08a"
          strokeWidth="1.1"
          strokeLinecap="round"
        />
        {/* Tassel Brush End */}
        <polygon
          points="43.5,28.5 46.5,28.5 46,33 44,33"
          fill={`url(#${uid}-emblem-gold)`}
        />

        {/* Knowledge Star / Wisdom Sparkle Above Cap */}
        <path
          d="M32 4 L32.8 7.2 L36 8 L32.8 8.8 L32 12 L31.2 8.8 L28 8 L31.2 7.2 Z"
          fill="#fffbeb"
        />
        <circle cx="32" cy="8" r="1.3" fill="#ffffff" />
        <circle cx="32" cy="8" r="3" fill="#fde047" opacity="0.45" />
      </g>
    </svg>
  );
}

/**
 * Mark plus wordmark with high brand recognition.
 */
export function Logo({
  className,
  wordmarkClassName,
}: {
  className?: string;
  wordmarkClassName?: string;
}) {
  return (
    <span className={cn('flex items-center gap-2.5', className)}>
      <LogoMark decorative />
      <span className={cn('flex flex-col leading-tight', wordmarkClassName)}>
        <span className="flex items-center gap-1.5 text-sm font-extrabold tracking-tight">
          <span className="text-[var(--color-foreground)]">TÀI LIỆU</span>
          <span className="rounded bg-gradient-to-r from-blue-600 to-indigo-600 px-1.5 py-0.5 text-[10px] font-black text-white shadow-xs">
            SINH VIÊN
          </span>
        </span>
        <span className="hidden text-[10px] font-medium tracking-wide text-[var(--color-muted-foreground)] sm:block">
          Cộng đồng học tập mở
        </span>
      </span>
    </span>
  );
}
