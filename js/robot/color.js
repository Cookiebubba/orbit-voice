/* OKLCH -> sRGB, done properly: OKLab -> linear sRGB (Ottosson's matrices), then the CSS Color 4
 * gamut mapping (reduce chroma at constant L and hue until the clipped colour is within a JND), then
 * the sRGB transfer curve. Qubit's colours are never altered beyond what an sRGB screen can show.
 */

function oklabToLinear(L, a, b) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}
function linearToOklab(r, g, b) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}
const inGamut = (c, e = 1e-6) => c[0] >= -e && c[0] <= 1 + e && c[1] >= -e && c[1] <= 1 + e && c[2] >= -e && c[2] <= 1 + e;
const clip01 = (c) => c.map((v) => Math.min(1, Math.max(0, v)));
const encode = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

function lchToLinear(L, C, H) {
  const h = (H * Math.PI) / 180;
  return oklabToLinear(L, C * Math.cos(h), C * Math.sin(h));
}
function deltaEOK(lin1, lin2) {
  const a = linearToOklab(...lin1);
  const b = linearToOklab(...lin2);
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** OKLCH (L 0..1, C, H degrees) -> { linear: [r,g,b], srgb: [r,g,b] } in 0..1, gamut mapped. */
export function oklchToRgb(L, C, H) {
  L = Math.min(1, Math.max(0, L));
  C = Math.max(0, C);
  let lin = lchToLinear(L, C, H);
  if (!inGamut(lin)) {
    // CSS Color 4: binary search on chroma, accept when the clipped colour is within a JND.
    const JND = 0.02;
    let lo = 0;
    let hi = C;
    let clipped = clip01(lin);
    if (deltaEOK(clipped, lin) >= JND) {
      let done = false;
      for (let i = 0; i < 24 && !done; i++) {
        const mid = (lo + hi) / 2;
        const cand = lchToLinear(L, mid, H);
        if (inGamut(cand)) {
          lo = mid;
          continue;
        }
        const e = deltaEOK(clip01(cand), cand);
        if (e < JND) {
          lo = mid;
          if (JND - e < 1e-4) done = true;
        } else hi = mid;
      }
      clipped = clip01(lchToLinear(L, lo, H));
    }
    lin = clipped;
  }
  lin = clip01(lin);
  return { linear: lin, srgb: lin.map(encode) };
}

/** CSS rgb() string for an OKLCH colour. */
export function oklchCss(L, C, H) {
  const s = oklchToRgb(L, C, H).srgb;
  return `rgb(${(s[0] * 255).toFixed(2)} ${(s[1] * 255).toFixed(2)} ${(s[2] * 255).toFixed(2)})`;
}

/** Colour temperature (kelvin) -> sRGB hex (Tanner Helland's fit), for the floodlight. */
export function kelvinHex(k) {
  const t = k / 100;
  const r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const c = (v) => Math.max(0, Math.min(255, Math.round(v)));
  return '#' + [r, g, b].map((v) => c(v).toString(16).padStart(2, '0')).join('');
}
