// Probe (avatar.eval): Qubit's art as it is rendered in his page, read from the DOM. Qubit's rules
// (ui/src/vendor/avatars/qubit-engine.js): one SVG path, the square with the eye cut out of it
// (fill-rule evenodd, two subpaths), one solid fill, no stroke, shadow, filter, mask or gradient.
// Returns exactly { drawn, paths, fills, solidFill, eyeIsHole, strokes, gradients, filters, shadows,
// opacityLayers } (parity/PROTOCOL.md).
// A probe is one JS expression; its value (or what its promise resolves to) is the result.
(() => {
  const Q = window.__qubit;
  const body = Q && Q.q && Q.q.body;
  const svg = (body && body.ownerSVGElement) || document.querySelector('svg');
  const none = { drawn: false, paths: 0, fills: [], solidFill: false, eyeIsHole: false, strokes: 0, gradients: 0, filters: 0, shadows: 0, opacityLayers: 0 };
  if (!svg) return none;
  const cs = (el) => getComputedStyle(el);
  const shown = (el) => cs(el).display !== 'none' && cs(el).visibility !== 'hidden' && Number(cs(el).opacity) > 0;
  const SHAPES = 'path,rect,circle,ellipse,polygon,polyline,line,image,text,use';
  const shapes = [...svg.querySelectorAll(SHAPES)].filter(shown);
  // His body: the path(s) with a fill (the engine's one path).
  const bodyPaths = shapes.filter((el) => el.tagName.toLowerCase() === 'path' && cs(el).fill !== 'none');
  const fills = [...new Set(bodyPaths.map((el) => cs(el).fill))];
  const solidFill = fills.length === 1 && !/url\(/.test(fills[0]);
  // The eye: a second subpath of the body path, cut out by the fill rule (no shape drawn on top).
  const main = body && bodyPaths.includes(body) ? body : bodyPaths[0];
  const subpaths = main ? ((main.getAttribute('d') || '').match(/[Mm]/g) || []).length : 0;
  const fillRule = main ? cs(main).fillRule : '';
  const eyeIsHole = !!main && subpaths >= 2 && (fillRule === 'evenodd' || fillRule === 'nonzero') && bodyPaths.length === 1;
  const strokes = shapes.filter((el) => cs(el).stroke !== 'none' && parseFloat(cs(el).strokeWidth) > 0 && Number(cs(el).strokeOpacity) > 0).length;
  // Everything from the shapes up to the page, for CSS filters and shadows.
  const chain = [];
  for (const el of [...shapes, svg]) for (let n = el; n && n.nodeType === 1; n = n.parentElement) if (!chain.includes(n)) chain.push(n);
  const gradients = svg.querySelectorAll('linearGradient,radialGradient').length + shapes.filter((el) => /url\(/.test(cs(el).fill) || /url\(/.test(cs(el).stroke)).length;
  const filters = svg.querySelectorAll('filter').length + chain.filter((n) => cs(n).filter !== 'none' || n.hasAttribute('filter')).length;
  const shadows = svg.querySelectorAll('feDropShadow').length + chain.filter((n) => cs(n).boxShadow !== 'none' || (cs(n).textShadow && cs(n).textShadow !== 'none') || /drop-shadow/.test(cs(n).filter)).length;
  // Extra semi-transparent shapes laid over him (shading, glints): any shown shape besides the body.
  const opacityLayers = shapes.filter((el) => !bodyPaths.includes(el) && (Number(cs(el).opacity) < 1 || Number(cs(el).fillOpacity) < 1 || cs(el).fill !== 'none')).length;
  return { drawn: bodyPaths.length > 0, paths: bodyPaths.length, fills, solidFill, eyeIsHole, strokes, gradients, filters, shadows, opacityLayers };
})()
