import { useId, useState } from 'react';

import { cn, formatBytes } from '@/lib/utils';

/**
 * Admin chart and tile primitives.
 *
 * Hand-rolled SVG rather than a chart library. One single-series line chart
 * does not justify ~100KB of JavaScript, and the mark specs worth following
 * (2px line, recessive grid, selective direct labels, a real hover layer) are
 * a few dozen lines of SVG.
 *
 * Colour decisions are documented in `styles.css` and were validated against
 * this app's actual surfaces rather than assumed.
 */

// =============================================================================
// Stat tile
// =============================================================================

/**
 * A headline number.
 *
 * Deliberately a tile, not a one-bar bar chart. Four numbers that each answer a
 * different question are four statements, and drawing them as bars implies a
 * shared scale they do not have — 14 users and 23 MB of storage are not
 * comparable quantities.
 */
export function StatTile({
  label,
  value,
  hint,
  tone = 'neutral',
  icon,
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: 'neutral' | 'good' | 'warning' | 'critical';
  icon?: React.ReactNode;
}) {
  const toneClass = {
    neutral: 'text-[var(--color-foreground)]',
    good: 'text-[var(--color-success)]',
    warning: 'text-[var(--color-gold-600)]',
    critical: 'text-[var(--color-destructive)]',
  }[tone];

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-[var(--color-muted-foreground)]">{label}</p>
        {icon ? (
          <span className="text-[var(--color-muted-foreground)]" aria-hidden>
            {icon}
          </span>
        ) : null}
      </div>

      {/* The number is the point, so it gets the size. Text wears text tokens —
          never the series colour, which would imply it encodes something. */}
      <p className={cn('mt-2 text-2xl font-bold tabular-nums', toneClass)}>{value}</p>

      {hint ? (
        <p className="mt-1 text-[11px] text-[var(--color-muted-foreground)]">{hint}</p>
      ) : null}
    </div>
  );
}

// =============================================================================
// Line chart
// =============================================================================

export interface SeriesPoint {
  date: string;
  value: number;
}

/**
 * Daily counts over time.
 *
 * A line, not bars: the reader's job is "is this going up or down", which is a
 * trend question. Bars at 30 daily points also become thinner than the 2px
 * surface gap the mark specs require between adjacent fills, which reads as
 * noise.
 *
 * One series, so there is no legend — the title names it. That is the rule, not
 * an omission: a legend box for a single line is chrome that carries no
 * information.
 */
export function LineChart({
  data,
  title,
  height = 180,
  formatValue = (v: number) => String(v),
}: {
  data: SeriesPoint[];
  title: string;
  height?: number;
  formatValue?: (value: number) => string;
}) {
  const gradientId = useId();
  const [hover, setHover] = useState<number | null>(null);

  if (data.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center rounded-lg border border-dashed border-[var(--color-border)]">
        <p className="text-sm text-[var(--color-muted-foreground)]">Chưa có dữ liệu</p>
      </div>
    );
  }

  // Padding leaves room for the y-axis labels on the left and the x-axis labels
  // below; without it the first and last points sit on the frame.
  const padding = { top: 12, right: 16, bottom: 24, left: 44 };
  const width = 720;
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;

  const values = data.map((p) => p.value);
  const rawMax = Math.max(...values, 1);
  // Round the ceiling up to a "nice" number so the gridlines land on readable
  // values. A max of 4 producing gridlines at 0.8/1.6/2.4 is technically
  // correct and useless.
  const max = niceCeil(rawMax);
  const stepX = data.length > 1 ? innerWidth / (data.length - 1) : 0;

  const x = (index: number) => padding.left + index * stepX;
  const y = (value: number) => padding.top + innerHeight - (value / max) * innerHeight;

  const linePath = data.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(p.value)}`).join(' ');
  const areaPath = `${linePath} L ${x(data.length - 1)} ${padding.top + innerHeight} L ${x(0)} ${padding.top + innerHeight} Z`;

  // Four gridlines, not "one per data point" — a gridline behind every point is
  // a spreadsheet, not a chart.
  const gridValues = [0, max / 2, max];

  // Label every Nth x tick so they never collide at 30 days.
  const labelEvery = Math.max(1, Math.ceil(data.length / 7));

  const hovered = hover === null ? null : data[hover];

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        style={{ height }}
        role="img"
        aria-label={`${title}. ${data.length} điểm dữ liệu, cao nhất ${formatValue(rawMax)}.`}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--chart-line)" stopOpacity="0.18" />
            <stop offset="100%" stopColor="var(--chart-line)" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Grid and axis labels — recessive, so the data is what stands out. */}
        {gridValues.map((value) => (
          <g key={value}>
            <line
              x1={padding.left}
              x2={width - padding.right}
              y1={y(value)}
              y2={y(value)}
              stroke="var(--chart-grid)"
              strokeWidth="1"
            />
            <text
              x={padding.left - 8}
              y={y(value)}
              textAnchor="end"
              dominantBaseline="middle"
              fontSize="11"
              fill="var(--chart-axis-text)"
            >
              {formatValue(value)}
            </text>
          </g>
        ))}

        <path d={areaPath} fill={`url(#${gradientId})`} />
        <path
          d={linePath}
          fill="none"
          stroke="var(--chart-line)"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {data.map((point, index) =>
          index % labelEvery === 0 || index === data.length - 1 ? (
            <text
              key={point.date}
              x={x(index)}
              y={height - 6}
              textAnchor="middle"
              fontSize="11"
              fill="var(--chart-axis-text)"
            >
              {point.date.slice(5)}
            </text>
          ) : null,
        )}

        {/* Direct label on the final point only — a number on every point is
            noise, but the latest value is what someone opens this to see. */}
        <text
          x={Math.min(x(data.length - 1), width - padding.right)}
          y={y(data[data.length - 1]!.value) - 10}
          textAnchor="end"
          fontSize="12"
          fontWeight="600"
          fill="var(--color-foreground)"
        >
          {formatValue(data[data.length - 1]!.value)}
        </text>

        {/* Hover targets wider than the marks, so a 2px line is still easy to
            hit — the interaction layer is sized for fingers and mice, not for
            the stroke width. */}
        {data.map((point, index) => (
          <rect
            key={point.date}
            x={x(index) - stepX / 2}
            y={padding.top}
            width={Math.max(stepX, 12)}
            height={innerHeight}
            fill="transparent"
            onMouseEnter={() => setHover(index)}
            onFocus={() => setHover(index)}
            tabIndex={0}
            role="button"
            aria-label={`${point.date}: ${formatValue(point.value)}`}
            className="cursor-crosshair outline-none"
          />
        ))}

        {hover !== null ? (
          <g pointerEvents="none">
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={padding.top}
              y2={padding.top + innerHeight}
              stroke="var(--chart-line)"
              strokeWidth="1"
              strokeDasharray="3 3"
            />
            {/* A 2px surface ring keeps the marker readable where it crosses
                the line, instead of merging into it. */}
            <circle
              cx={x(hover)}
              cy={y(data[hover]!.value)}
              r="5"
              fill="var(--chart-line)"
              stroke="var(--color-card)"
              strokeWidth="2"
            />
          </g>
        ) : null}
      </svg>

      {/* The tooltip is HTML, not SVG text: it gets real typography and cannot
          be clipped by the viewBox. */}
      {hovered ? (
        <div
          className="pointer-events-none absolute -translate-x-1/2 rounded-md border border-[var(--color-border)] bg-[var(--color-card)] px-2.5 py-1.5 text-xs shadow-md"
          style={{
            left: `${(x(hover!) / width) * 100}%`,
            top: 0,
          }}
        >
          <p className="font-medium tabular-nums">{formatValue(hovered.value)}</p>
          <p className="text-[var(--color-muted-foreground)]">{hovered.date}</p>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Round a maximum up to a readable axis ceiling.
 *
 * Without this, a peak of 4 gives gridlines at 0.8 / 1.6 / 2.4 and a peak of 37
 * gives 12.33 / 24.67 — both technically correct and both unreadable.
 */
function niceCeil(value: number): number {
  if (value <= 5) return 5;
  if (value <= 10) return 10;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / magnitude) * magnitude;
}

/** Bar variant, for a comparison the line form does not suit. */
export function MiniBars({
  data,
  formatValue = (v: number) => String(v),
}: {
  data: SeriesPoint[];
  formatValue?: (value: number) => string;
}) {
  if (data.length === 0) return null;
  const max = Math.max(...data.map((p) => p.value), 1);

  return (
    <div className="flex h-16 items-end gap-[2px]" role="img" aria-label="Xu hướng gần đây">
      {data.map((point) => (
        <div
          key={point.date}
          // 4px rounded data-end anchored to the baseline, per the mark spec.
          className="flex-1 rounded-t-[4px] bg-[var(--chart-line)]"
          style={{ height: `${Math.max((point.value / max) * 100, 2)}%` }}
          title={`${point.date}: ${formatValue(point.value)}`}
        />
      ))}
    </div>
  );
}

export { formatBytes };
