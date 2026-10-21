// Minimal SVG charts for the Results tab (stand-ins for the Swift Charts views).
// Colours are CSS custom properties so the charts follow light/dark mode.

const W = 600, PAD = { l: 44, r: 12, t: 10, b: 26 };

function niceTicks(lo, hi, n = 5) {
  if (!(hi > lo)) { hi = lo + 1; }
  const raw = (hi - lo) / n, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw);
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}

const fmt = v => (Math.abs(v) >= 100 || Number.isInteger(v) ? String(Math.round(v)) : String(+v.toPrecision(3)));

function frame(height, xs, ys, xLabel, yLabel, xTickLabels) {
  const H = height, iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;
  const [x0, x1] = xs, [y0, y1] = ys;
  const sx = x => PAD.l + ((x - x0) / (x1 - x0 || 1)) * iw;
  const sy = y => PAD.t + ih - ((y - y0) / (y1 - y0 || 1)) * ih;
  let g = '';
  for (const t of niceTicks(y0, y1, 4)) {
    g += `<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${sy(t)}" y2="${sy(t)}" class="grid"/>`
      + `<text x="${PAD.l - 6}" y="${sy(t) + 4}" text-anchor="end">${fmt(t)}</text>`;
  }
  if (!xTickLabels) {
    for (const t of niceTicks(x0, x1, 6)) g += `<text x="${sx(t)}" y="${H - 8}" text-anchor="middle">${fmt(t)}</text>`;
  }
  if (xLabel) g += `<text x="${W - PAD.r}" y="${H - 8}" text-anchor="end" class="axis-label">${xLabel}</text>`;
  if (yLabel) g += `<text x="4" y="${PAD.t + 8}" class="axis-label">${yLabel}</text>`;
  return { sx, sy, g, H, iw };
}

const svg = (H, body, label) => `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${label ?? ''}">${body}</svg>`;

function extent(vals, pad = 0.05, include = []) {
  const v = [...vals, ...include].filter(Number.isFinite);
  if (!v.length) return [0, 1];
  let lo = Math.min(...v), hi = Math.max(...v);
  if (lo === hi) { lo -= 1; hi += 1; }
  const p = (hi - lo) * pad;
  return [lo - p, hi + p];
}

/// series: [{points: [[x, y]], color, kind: 'line' | 'dot', dash?}]; bands: [{x0, x1, color}]
export function lineChart({ height = 180, series, bands = [], xDomain, yDomain, xLabel, yLabel, label }) {
  const allX = series.flatMap(s => s.points.map(p => p[0])), allY = series.flatMap(s => s.points.map(p => p[1]));
  const f = frame(height, xDomain ?? extent(allX, 0), yDomain ?? extent(allY), xLabel, yLabel);
  let body = '';
  for (const b of bands) {
    body += `<rect x="${f.sx(b.x0)}" y="${PAD.t}" width="${Math.max(1, f.sx(b.x1) - f.sx(b.x0))}" height="${height - PAD.t - PAD.b}" style="fill:${b.color}"/>`;
  }
  body += f.g;
  for (const s of series) {
    const pts = s.points.filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1]));
    if (s.kind === 'dot') {
      for (const [x, y] of pts) body += `<circle cx="${f.sx(x)}" cy="${f.sy(y)}" r="${s.r ?? 1.6}" style="fill:${s.color}"/>`;
    } else {
      // Break the line where consecutive points are far apart in x (gaps in the data).
      let d = '', prev = null;
      const gap = s.gap ?? Infinity;
      for (const [x, y] of pts) {
        d += `${prev == null || x - prev > gap ? 'M' : 'L'}${f.sx(x).toFixed(1)},${f.sy(y).toFixed(1)}`;
        prev = x;
      }
      body += `<path d="${d}" style="stroke:${s.color}" class="line${s.dash ? ' dash' : ''}"/>`;
      if (s.markers) for (const [x, y] of pts) body += `<circle cx="${f.sx(x)}" cy="${f.sy(y)}" r="3.5" style="fill:${s.color}"/>`;
    }
  }
  return svg(height, body, label);
}

/// bars: [{label, value, color, faded}]
export function barChart({ height = 170, bars, yLabel, label }) {
  const [lo, hi] = extent(bars.map(b => b.value), 0.1, [0]);
  const f = frame(height, [0, bars.length], [lo, hi], null, yLabel, true);
  const bw = f.iw / Math.max(1, bars.length);
  let body = f.g + `<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${f.sy(0)}" y2="${f.sy(0)}" class="zero"/>`;
  bars.forEach((b, i) => {
    const x = PAD.l + i * bw + bw * 0.15, w = bw * 0.7;
    const v = Number.isFinite(b.value) ? b.value : 0;
    const y = Math.min(f.sy(v), f.sy(0)), h = Math.max(1, Math.abs(f.sy(v) - f.sy(0)));
    body += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="2" style="fill:${b.color};opacity:${b.faded ? 0.3 : 1}"><title>${b.title ?? ''}</title></rect>`
      + `<text x="${x + w / 2}" y="${height - 8}" text-anchor="middle">${b.label}</text>`;
  });
  return svg(height, body, label);
}

export const legend = items =>
  `<div class="legend">${items.map(i => `<span><i style="background:${i.color}"></i>${i.label}</span>`).join('')}</div>`;
