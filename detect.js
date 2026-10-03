'use strict';
/*
 * Detect: the geometry of the crop step. Points are {x, y} in the photo's own pixels.
 *
 * Copied from Vinyl Curator's detect.js, names kept: outputSize, homographyFromRect (now
 * exported) and warp (unchanged, used by no crop: it clamps to the photo's edge, which smears).
 * outputSize's cap is optional here (absent or Infinity: no cap). Vinyl's edge finders (detect,
 * detectCircle) are not copied.
 *
 * Role order, for both kinds: four [TL, TR, BR, BL]; six [TL, TM, TR, BR, BM, BL], clockwise on
 * the screen (y down). The halves of six are [TL, TM, BM, BL] and [TM, TR, BR, BM]. The top is the
 * outline's head as orderQuad judged it; Rotate is applied after the crop, never here.
 *
 *   orderQuad(pts4)                 four taps in any order -> [TL, TR, BR, BL], head at the top
 *   seedSix(q4)                     the two dots halfway along the page's own top and bottom edges
 *   vanishing(p)                    where the two side edges meet, homogeneous {x, y, w}
 *   dotsToVp(p6, held[, w, h])      keeps the dashed line between the dots through that point
 *   validShape(p, w, h)             {ok: true} or {ok: false, why}
 *   cropBox(p, m, w, h)             the part of the photo a crop reads (draw only this box)
 *   warpInto(src, quad, ...)        warp's loop with an output offset and a margin; grey outside
 *   cropFour(src, q, m)             one straightening, margin m on all four sides
 *   cropSix(src, p, midMoved, m)    dots untouched: the four-point warp, margin at head and foot;
 *                                   a dot moved: two halves side by side, margin at head, foot and
 *                                   the outer side (the wider half's far side), never the fold
 *   padOf(kind, midMoved, plan)     the margin a crop applied, [top, right, bottom, left]
 *
 * `src` for the crops is {img: ImageData, x0, y0, W, H}: img holds the box cropBox returned,
 * placed at (x0, y0) in the photo; W x H is the whole photo. A sample outside the PHOTO is plain
 * grey, never smeared. Nothing here moves a corner: dotsToVp moves only the dot not held.
 */
const Detect = (() => {

  const MIN_CROP = 24;     // photo px: no two points closer, no half narrower
  const MARGIN = 0.02;     // the safety margin beyond the outline, a share of its height or width
  const GREY = 128;        // what a sample beyond the photo shows
  const EDGES4 = Object.freeze([[0, 1], [1, 2], [2, 3], [3, 0]]);
  const EDGES6 = Object.freeze([[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 0]]);
  const OPP6 = Object.freeze([4, 3, 5, 1, 0, 2]);   // the edge opposite each of EDGES6

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const copy = p => Object.assign({}, p);

  /* ---------- copied from vinyl ---------- */

  function outputSize(quad, maxOut) {
    const d = (a, b) => Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
    const W = (d(quad[0], quad[1]) + d(quad[3], quad[2])) / 2;
    const H = (d(quad[0], quad[3]) + d(quad[1], quad[2])) / 2;
    // books: no cap unless one is given (vinyl always passed settings.maxOut)
    const s = (typeof maxOut === 'number' && maxOut === maxOut) ? Math.min(1, maxOut / Math.max(W, H, 1)) : 1;
    return { w: Math.max(2, Math.round(W * s)), h: Math.max(2, Math.round(H * s)) };
  }

  // Homography H mapping output-rect (u,v) -> source (x,y).
  function homographyFromRect(W, Hh, quad) {
    const dst = [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: Hh }, { x: 0, y: Hh }];
    const A = [];
    for (let i = 0; i < 4; i++) {
      const u = dst[i].x, v = dst[i].y, x = quad[i].x, y = quad[i].y;
      A.push([u, v, 1, 0, 0, 0, -u * x, -v * x, x]);
      A.push([0, 0, 0, u, v, 1, -u * y, -v * y, y]);
    }
    for (let col = 0; col < 8; col++) {
      let piv = col;
      for (let r = col + 1; r < 8; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
      if (Math.abs(A[piv][col]) < 1e-10) return null;
      const tmp = A[col]; A[col] = A[piv]; A[piv] = tmp;
      const pv = A[col][col];
      for (let r = 0; r < 8; r++) {
        if (r === col) continue;
        const f = A[r][col] / pv;
        if (f === 0) continue;
        for (let c = col; c <= 8; c++) A[r][c] -= f * A[col][c];
      }
    }
    const hm = new Float64Array(9);
    for (let i = 0; i < 8; i++) hm[i] = A[i][8] / A[i][i];
    hm[8] = 1;
    return hm;
  }

  function warp(srcData, quad, outW, outH) {
    const Hm = homographyFromRect(outW, outH, quad);
    if (!Hm) throw new Error('Invalid crop shape — adjust the corners');
    const sw = srcData.width, sh = srcData.height, sp = srcData.data;
    const out = new Uint8ClampedArray(outW * outH * 4);
    const h0 = Hm[0], h1 = Hm[1], h2 = Hm[2], h3 = Hm[3], h4 = Hm[4],
          h5 = Hm[5], h6 = Hm[6], h7 = Hm[7];
    let o = 0;
    for (let v = 0; v < outH; v++) {
      const vy = v + 0.5;
      for (let u = 0; u < outW; u++) {
        const ux = u + 0.5;
        const den = h6 * ux + h7 * vy + 1;
        const sx = (h0 * ux + h1 * vy + h2) / den - 0.5;
        const sy = (h3 * ux + h4 * vy + h5) / den - 0.5;
        const x0 = Math.floor(sx), y0 = Math.floor(sy);
        const fx = sx - x0, fy = sy - y0;
        const cx0 = x0 < 0 ? 0 : (x0 >= sw ? sw - 1 : x0);
        const cx1 = x0 + 1 < 0 ? 0 : (x0 + 1 >= sw ? sw - 1 : x0 + 1);
        const cy0 = y0 < 0 ? 0 : (y0 >= sh ? sh - 1 : y0);
        const cy1 = y0 + 1 < 0 ? 0 : (y0 + 1 >= sh ? sh - 1 : y0 + 1);
        const i00 = (cy0 * sw + cx0) * 4, i10 = (cy0 * sw + cx1) * 4;
        const i01 = (cy1 * sw + cx0) * 4, i11 = (cy1 * sw + cx1) * 4;
        const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy),
              w01 = (1 - fx) * fy, w11 = fx * fy;
        out[o++] = sp[i00] * w00 + sp[i10] * w10 + sp[i01] * w01 + sp[i11] * w11;
        out[o++] = sp[i00 + 1] * w00 + sp[i10 + 1] * w10 + sp[i01 + 1] * w01 + sp[i11 + 1] * w11;
        out[o++] = sp[i00 + 2] * w00 + sp[i10 + 2] * w10 + sp[i01 + 2] * w01 + sp[i11 + 2] * w11;
        out[o++] = 255;
      }
    }
    return new ImageData(out, outW, outH);
  }

  /* ---------- the outline ---------- */

  function applyH(Hm, u, v) {
    const den = Hm[6] * u + Hm[7] * v + Hm[8];
    return { x: (Hm[0] * u + Hm[1] * v + Hm[2]) / den, y: (Hm[3] * u + Hm[4] * v + Hm[5]) / den };
  }

  /* Four taps in any order -> [TL, TR, BR, BL]. Clockwise round the centroid; the shorter pair of
     opposite sides (by mean length) is head and foot, and the head is the one whose midpoint is
     nearer the top of the screen (level within 1 px: the left one); TL is the head's first point,
     clockwise. A near-square outline (the pairs within 10%) goes by the screen rule instead: the
     top is the edge whose direction points most nearly to the right. Returns the same objects. */
  function orderQuad(pts) {
    if (!pts || pts.length !== 4) throw new Error('orderQuad needs four points');
    const cx = (pts[0].x + pts[1].x + pts[2].x + pts[3].x) / 4;
    const cy = (pts[0].y + pts[1].y + pts[2].y + pts[3].y) / 4;
    const c = pts.map(p => ({ p, a: Math.atan2(p.y - cy, p.x - cx) }))
      .sort((a, b) => a.a - b.a).map(o => o.p);           // y down: increasing angle is clockwise
    const len = i => dist(c[i], c[(i + 1) % 4]);
    const a = (len(0) + len(2)) / 2, b = (len(1) + len(3)) / 2;
    let start = 0;
    if (Math.abs(a - b) <= 0.10 * Math.max(a, b)) {
      let best = -Infinity;
      for (let i = 0; i < 4; i++) {
        const n = c[(i + 1) % 4], r = (n.x - c[i].x) / (dist(c[i], n) || 1);
        if (r > best) { best = r; start = i; }
      }
    } else {
      const i0 = a < b ? 0 : 1, i1 = i0 + 2;
      const m0 = mid(c[i0], c[i0 + 1]), m1 = mid(c[i1], c[(i1 + 1) % 4]);
      if (Math.abs(m0.y - m1.y) <= 1) start = m0.x < m1.x ? i0 : i1;
      else start = m0.y < m1.y ? i0 : i1;
    }
    return [c[start], c[(start + 1) % 4], c[(start + 2) % 4], c[(start + 3) % 4]];
  }

  /* [TL, TR, BR, BL] -> [TL, TM, TR, BR, BM, BL]: TM and BM halfway along the page's own top and
     bottom edges (the four-point homography's (W/2, 0) and (W/2, H)), so the dashed line between
     them already runs through the side edges' vanishing point. New objects, the corners' values
     unchanged. */
  function seedSix(q4) {
    const [TL, TR, BR, BL] = q4;
    // Four corners that do not go round a page (a tap slipped inside the other three): the
    // page's plane is not there and its homography would throw a dot far off the photo. The dots
    // go halfway along the two edges instead, on the photo, and validShape says the outline
    // crosses itself.
    if (!convexCW([TL, TR, BR, BL])) return [copy(TL), mid(TL, TR), copy(TR), copy(BR), mid(BL, BR), copy(BL)];
    const s = outputSize(q4, Infinity);
    const H4 = homographyFromRect(s.w, s.h, q4);
    const TM = H4 ? applyH(H4, s.w / 2, 0) : mid(TL, TR);
    const BM = H4 ? applyH(H4, s.w / 2, s.h) : mid(BL, BR);
    return [copy(TL), onEdge(TL, TR, TM), copy(TR), copy(BR), onEdge(BL, BR, BM), copy(BL)];
  }

  /* p (on the line a-b, as a homography leaves it) put exactly on the segment, at the same share
     of it: a + lam (b - a). Two corners on the photo's bottom edge (y = h) give a dot with y = h
     exactly, never a rounding step past it, which validShape would call outside the photo. */
  function onEdge(a, b, p) {
    const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
    if (!(L2 > 0) || !isFinite(p.x) || !isFinite(p.y)) return mid(a, b);
    let lam = ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2;
    lam = lam < 0 ? 0 : (lam > 1 ? 1 : lam);
    return { x: a.x + lam * dx, y: a.y + lam * dy };
  }

  function lineThrough(a, b) {      // (a.x, a.y, 1) x (b.x, b.y, 1), scaled to a unit normal
    const A = a.y - b.y, B = b.x - a.x, C = a.x * b.y - a.y * b.x;
    const n = Math.hypot(A, B) || 1;
    return [A / n, B / n, C / n];
  }

  /* V = (TL x BL) x (TR x BR), the two side edges in homogeneous coordinates, scaled to unit
     length; w near 0 means the sides are parallel and (x, y) is their direction. Takes four
     points [TL, TR, BR, BL] or six [TL, TM, TR, BR, BM, BL]. */
  function vanishing(p) {
    const six = p.length >= 6;
    const TL = p[0], TR = six ? p[2] : p[1], BR = six ? p[3] : p[2], BL = six ? p[5] : p[3];
    const l1 = lineThrough(TL, BL), l2 = lineThrough(TR, BR);
    const x = l1[1] * l2[2] - l1[2] * l2[1];
    const y = l1[2] * l2[0] - l1[0] * l2[2];
    const w = l1[0] * l2[1] - l1[1] * l2[0];
    const n = Math.hypot(x, y, w) || 1;
    return { x: x / n, y: y / n, w: w / n };
  }

  /* The dot held stays; the other moves to the nearest point on the line through V and the held
     dot. held: 'TM' or 'BM'; 'seam' (both dots were moved together) keeps TM and puts BM back on
     the line. Anything else is read as 'seam'. The corners are never changed: a new array, the
     corners' values byte-equal. Optional imgW, imgH: a dot that would land outside the photo
     slides along that same line to the photo's edge (a head out of the frame is tapped at the
     edge, and validShape refuses a point beyond it). */
  function dotsToVp(p6, held, imgW, imgH) {
    const out = p6.map(copy);
    if (p6.length !== 6) return out;
    const hi = held === 'BM' ? 4 : 1, oi = held === 'BM' ? 1 : 4;
    const a = p6[hi], b = p6[oi];
    const V = vanishing(p6);
    let dx = V.x - a.x * V.w, dy = V.y - a.y * V.w;   // towards V (a point, or a direction)
    const n = Math.hypot(dx, dy);
    if (!(n > 0) || !isFinite(n)) return out;           // the held dot is at V: leave the other
    dx /= n; dy /= n;
    let t = (b.x - a.x) * dx + (b.y - a.y) * dy;
    let x = a.x + t * dx, y = a.y + t * dy;
    if (typeof imgW === 'number' && typeof imgH === 'number' && !(x >= 0 && x <= imgW && y >= 0 && y <= imgH)) {
      let lo = -Infinity, hi2 = Infinity;
      const slab = (p, d, max) => {
        if (d === 0) { if (p < 0 || p > max) { lo = Infinity; hi2 = -Infinity; } return; }
        const t1 = (0 - p) / d, t2 = (max - p) / d;
        lo = Math.max(lo, Math.min(t1, t2)); hi2 = Math.min(hi2, Math.max(t1, t2));
      };
      slab(a.x, dx, imgW); slab(a.y, dy, imgH);
      if (lo <= hi2) {
        t = t < lo ? lo : (t > hi2 ? hi2 : t);
        x = Math.min(imgW, Math.max(0, a.x + t * dx));
        y = Math.min(imgH, Math.max(0, a.y + t * dy));
      }
    }
    out[oi] = Object.assign({}, b, { x, y });
    return out;
  }

  function orient(a, b, c) { return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x); }
  function onSeg(a, b, c) {         // c on segment a-b, given the three are collinear
    return Math.min(a.x, b.x) <= c.x && c.x <= Math.max(a.x, b.x) &&
           Math.min(a.y, b.y) <= c.y && c.y <= Math.max(a.y, b.y);
  }
  function segsCross(a, b, c, d) {
    const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
    if (o1 * o2 < 0 && o3 * o4 < 0) return true;
    return (o1 === 0 && onSeg(a, b, c)) || (o2 === 0 && onSeg(a, b, d)) ||
           (o3 === 0 && onSeg(c, d, a)) || (o4 === 0 && onSeg(c, d, b));
  }
  // every turn the same way as the role order (clockwise on the screen), none straight
  function convexCW(q) {
    for (let i = 0; i < q.length; i++) {
      const p0 = q[i], p1 = q[(i + 1) % q.length], p2 = q[(i + 2) % q.length];
      if (!((p1.x - p0.x) * (p2.y - p1.y) - (p1.y - p0.y) * (p2.x - p1.x) > 0)) return false;
    }
    return true;
  }

  /* Before any warp, for four points too. why: 'outside' (a point beyond [0, w] x [0, h]),
     'close' (two points closer than MIN_CROP, which covers each half's top and bottom), 'cross'
     (non-adjacent edges cross, or a quad - the whole of four, each half of six - is not convex in
     the role order's clockwise turn), 'heights' (six: the longest of the three heights over twice
     the shortest). */
  function validShape(p, imgW, imgH) {
    const r = shapeWhy(p, imgW, imgH);
    // Six points whose four corners do not go round a page (a tap slipped inside the outline):
    // that is what she has to fix, so it is said first, before a dot placed from those corners
    // is reported outside the photo or too close.
    if (!r.ok && (r.why === 'outside' || r.why === 'close') && p.length === 6 && cornersBad(p)) return { ok: false, why: 'cross' };
    return r;
  }
  // The six points' four corners [TL, TR, BR, BL] cross or are not convex (all finite).
  function cornersBad(p) {
    const c = [p[0], p[2], p[3], p[5]];
    for (const q of c) if (!q || !isFinite(q.x) || !isFinite(q.y)) return false;
    return segsCross(c[0], c[1], c[2], c[3]) || segsCross(c[1], c[2], c[3], c[0]) || !convexCW(c);
  }
  const EDGE_EPS = 1e-6;   // photo px: a point this close beyond the photo's edge is on it (rounding)
  function shapeWhy(p, imgW, imgH) {
    const n = p ? p.length : 0;
    if (n !== 4 && n !== 6) return { ok: false, why: 'cross' };
    for (const q of p) if (!q || !isFinite(q.x) || !isFinite(q.y)) return { ok: false, why: 'outside' };
    if (typeof imgW === 'number' && typeof imgH === 'number') {
      for (const q of p) {
        if (q.x < -EDGE_EPS || q.x > imgW + EDGE_EPS || q.y < -EDGE_EPS || q.y > imgH + EDGE_EPS) return { ok: false, why: 'outside' };
      }
    }
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      if (dist(p[i], p[j]) < MIN_CROP) return { ok: false, why: 'close' };
    }
    const E = n === 4 ? EDGES4 : EDGES6;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      if (segsCross(p[E[i][0]], p[E[i][1]], p[E[j][0]], p[E[j][1]])) return { ok: false, why: 'cross' };
    }
    const quads = n === 4 ? [p] : [[p[0], p[1], p[4], p[5]], [p[1], p[2], p[3], p[4]]];
    for (const q of quads) if (!convexCW(q)) return { ok: false, why: 'cross' };
    if (n === 6) {
      const hs = [dist(p[0], p[5]), dist(p[1], p[4]), dist(p[2], p[3])];
      if (Math.max(...hs) > 2 * Math.min(...hs)) return { ok: false, why: 'heights' };
    }
    return { ok: true };
  }

  /* ---------- the crop ---------- */

  /* The layout of a crop's output: its size, where the outline sits in it, the margin per side,
     and the warps that fill it (each a rectangle of the output through one homography). Shared by
     cropFour, cropSix, cropBox and padOf, so they always agree. */
  function cropPlan(p, midMoved, m) {
    m = m == null ? MARGIN : m;
    if (p.length === 4) {
      const q = [p[0], p[1], p[2], p[3]], s = outputSize(q, Infinity);
      const t = Math.round(m * s.h), sd = Math.round(m * s.w);
      return {
        kind: 4, midMoved: false, m, OW: s.w + 2 * sd, OH: s.h + 2 * t,
        outline: { x: sd, y: t, w: s.w, h: s.h }, pad: [t / s.h, sd / s.w, t / s.h, sd / s.w],
        jobs: [{ quad: q, w: s.w, h: s.h, ox: sd, oy: t, u0: -sd, u1: s.w + sd, v0: -t, v1: s.h + t }]
      };
    }
    const [TL, TM, TR, BR, BM, BL] = p;
    if (!midMoved) {                                   // the four-point warp of the outline,
      const q = [TL, TR, BR, BL], s = outputSize(q, Infinity), t = Math.round(m * s.h);
      return {                                         // margin at head and foot only
        kind: 6, midMoved: false, m, OW: s.w, OH: s.h + 2 * t,
        outline: { x: 0, y: t, w: s.w, h: s.h }, pad: [t / s.h, 0, t / s.h, 0],
        jobs: [{ quad: q, w: s.w, h: s.h, ox: 0, oy: t, u0: 0, u1: s.w, v0: -t, v1: s.h + t }]
      };
    }
    const H = Math.max(1, Math.round((dist(TL, BL) + dist(TM, BM) + dist(TR, BR)) / 3));
    const W1 = Math.max(1, Math.round((dist(TL, TM) + dist(BL, BM)) / 2));
    const W2 = Math.max(1, Math.round((dist(TM, TR) + dist(BM, BR)) / 2));
    const t = Math.round(m * H), side = Math.round(m * (W1 + W2));
    const l = W1 >= W2 ? side : 0, r = W1 >= W2 ? 0 : side;   // the outer side: the wider half's far side
    return {
      kind: 6, midMoved: true, m, OW: l + W1 + W2 + r, OH: H + 2 * t,
      outline: { x: l, y: t, w: W1 + W2, h: H }, seam: l + W1,
      pad: [t / H, r / (W1 + W2), t / H, l / (W1 + W2)],
      jobs: [
        { quad: [TL, TM, BM, BL], w: W1, h: H, ox: l, oy: t, u0: -l, u1: W1, v0: -t, v1: H + t },
        { quad: [TM, TR, BR, BM], w: W2, h: H, ox: l + W1, oy: t, u0: 0, u1: W2 + r, v0: -t, v1: H + t }
      ]
    };
  }

  /* warpInto(src, quad, w, h, out, OW, ox, oy, u0, u1, v0, v1): the rectangle's u in [u0, u1) and
     v in [v0, v1) (beyond 0..w and 0..h is the margin) map through homographyFromRect(w, h, quad)
     and are written at out[(oy + v) * OW + (ox + u)]. Bilinear, as vinyl's warp; a sample outside
     the photo is plain grey. Anything that would land outside `out` is skipped. */
  function warpInto(src, quad, w, h, out, OW, ox, oy, u0, u1, v0, v1) {
    const Hm = homographyFromRect(w, h, quad);
    if (!Hm) throw new Error('Invalid crop shape');
    const img = src.img, sp = img.data, bw = img.width, bh = img.height;
    const bx = src.x0 || 0, by = src.y0 || 0;
    const PW = src.W == null ? bx + bw : src.W, PH = src.H == null ? by + bh : src.H;
    const xLo = Math.max(0, bx), xHi = Math.min(PW, bx + bw) - 1;   // the photo's pixels in the box
    const yLo = Math.max(0, by), yHi = Math.min(PH, by + bh) - 1;
    const none = xHi < xLo || yHi < yLo;
    const off = -(by * bw + bx), bw4 = bw * 4;                     // photo (x, y) -> box index
    const OH = Math.floor(out.length / 4 / OW);
    const ua = Math.max(u0, -ox), ub = Math.min(u1, OW - ox);
    const va = Math.max(v0, -oy), vb = Math.min(v1, OH - oy);
    const h0 = Hm[0], h1 = Hm[1], h2 = Hm[2], h3 = Hm[3], h4 = Hm[4],
          h5 = Hm[5], h6 = Hm[6], h7 = Hm[7];
    for (let v = va; v < vb; v++) {
      const vy = v + 0.5, h1v = h1 * vy, h4v = h4 * vy, h7v = h7 * vy;
      let o = ((oy + v) * OW + ox + ua) * 4;
      for (let u = ua; u < ub; u++, o += 4) {
        const ux = u + 0.5;
        const den = h6 * ux + h7v + 1;
        const X = (h0 * ux + h1v + h2) / den, Y = (h3 * ux + h4v + h5) / den;
        if (none || !(den > 0 && X >= 0 && X <= PW && Y >= 0 && Y <= PH)) {
          out[o] = GREY; out[o + 1] = GREY; out[o + 2] = GREY; out[o + 3] = 255;
          continue;
        }
        const sx = X - 0.5, sy = Y - 0.5;
        const x0 = Math.floor(sx), y0 = Math.floor(sy);
        const fx = sx - x0, fy = sy - y0;
        let i00, i10, i01, i11;
        if (x0 >= xLo && x0 < xHi && y0 >= yLo && y0 < yHi) {          // all four neighbours inside
          i00 = (y0 * bw + x0 + off) * 4; i10 = i00 + 4; i01 = i00 + bw4; i11 = i01 + 4;
        } else {                                                       // at the photo's edge: clamp
          const cx0 = x0 < xLo ? xLo : (x0 > xHi ? xHi : x0);
          const cx1 = x0 + 1 < xLo ? xLo : (x0 + 1 > xHi ? xHi : x0 + 1);
          const cy0 = y0 < yLo ? yLo : (y0 > yHi ? yHi : y0);
          const cy1 = y0 + 1 < yLo ? yLo : (y0 + 1 > yHi ? yHi : y0 + 1);
          i00 = (cy0 * bw + cx0 + off) * 4; i10 = (cy0 * bw + cx1 + off) * 4;
          i01 = (cy1 * bw + cx0 + off) * 4; i11 = (cy1 * bw + cx1 + off) * 4;
        }
        const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy),
              w01 = (1 - fx) * fy, w11 = fx * fy;
        out[o] = sp[i00] * w00 + sp[i10] * w10 + sp[i01] * w01 + sp[i11] * w11;
        out[o + 1] = sp[i00 + 1] * w00 + sp[i10 + 1] * w10 + sp[i01 + 1] * w01 + sp[i11 + 1] * w11;
        out[o + 2] = sp[i00 + 2] * w00 + sp[i10 + 2] * w10 + sp[i01 + 2] * w01 + sp[i11 + 2] * w11;
        out[o + 3] = 255;
      }
    }
  }

  // Run a plan into a new ImageData; the plan's layout rides along as img.plan (for padOf).
  function runPlan(src, plan) {
    const out = new Uint8ClampedArray(plan.OW * plan.OH * 4);
    for (const j of plan.jobs) warpInto(src, j.quad, j.w, j.h, out, plan.OW, j.ox, j.oy, j.u0, j.u1, j.v0, j.v1);
    const img = new ImageData(out, plan.OW, plan.OH);
    try {
      img.plan = { kind: plan.kind, midMoved: plan.midMoved, m: plan.m, OW: plan.OW, OH: plan.OH,
        outline: Object.assign({}, plan.outline), pad: plan.pad.slice() };
    } catch (e) { /* an engine that refuses the extra field: padOf still takes the points */ }
    return img;
  }

  function cropFour(src, q, m) {
    return runPlan(src, cropPlan([q[0], q[1], q[2], q[3]], false, m));
  }

  function cropSix(src, p, midMoved, m) {
    return runPlan(src, cropPlan(p, !!midMoved, m));
  }

  /* The integer box of the photo that cropFour / cropSix read (the outline, its margin and the
     bilinear neighbours), clipped to the photo. For six points it covers both kinds of six-point
     crop, so it can be drawn before anyone knows whether a dot moved. */
  function cropBox(p, m, imgW, imgH) {
    const plans = p.length === 6 ? [cropPlan(p, false, m), cropPlan(p, true, m)] : [cropPlan(p, false, m)];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, all = false;
    for (const pl of plans) for (const j of pl.jobs) {
      const Hm = homographyFromRect(j.w, j.h, j.quad);
      if (!Hm) { all = true; continue; }
      for (const [u, v] of [[j.u0, j.v0], [j.u1, j.v0], [j.u1, j.v1], [j.u0, j.v1]]) {
        const den = Hm[6] * u + Hm[7] * v + 1;
        if (!(den > 0)) { all = true; continue; }       // the margin runs past the horizon
        const X = (Hm[0] * u + Hm[1] * v + Hm[2]) / den, Y = (Hm[3] * u + Hm[4] * v + Hm[5]) / den;
        if (X < x0) x0 = X; if (X > x1) x1 = X; if (Y < y0) y0 = Y; if (Y > y1) y1 = Y;
      }
    }
    if (all || !isFinite(x0) || !isFinite(y0) || !isFinite(x1) || !isFinite(y1)) return { x: 0, y: 0, w: imgW, h: imgH };
    const clamp = (k, lo, hi) => k < lo ? lo : (k > hi ? hi : k);
    const bx0 = clamp(Math.floor(x0 - 0.5) - 1, 0, imgW - 1), by0 = clamp(Math.floor(y0 - 0.5) - 1, 0, imgH - 1);
    const bx1 = clamp(Math.floor(x1 - 0.5) + 3, bx0 + 1, imgW), by1 = clamp(Math.floor(y1 - 0.5) + 3, by0 + 1, imgH);
    return { x: bx0, y: by0, w: bx1 - bx0, h: by1 - by0 };
  }

  /* The margin a crop applied, [top, right, bottom, left], each a share of the outline's
     straightened height (top, bottom) or width (right, left), before Rotate (top = the outline's
     head); 0 where none. kind: 4, 6 or 'whole' (also 'quad', 'six'). plan: the points that were
     cropped (with an optional m, default 0.02), the ImageData cropFour / cropSix returned, or a
     plan object. null when it cannot be known. */
  function padOf(kind, midMoved, plan, m) {
    if (kind === 'whole') return [0, 0, 0, 0];
    if (plan && Array.isArray(plan.pad)) return plan.pad.slice();
    if (plan && plan.plan && Array.isArray(plan.plan.pad)) return plan.plan.pad.slice();
    const k = kind === 'quad' ? 4 : kind === 'six' ? 6 : Number(kind);
    const pts = Array.isArray(plan) ? plan : (plan && (plan.points || plan.p));
    const mm = m != null ? m : (plan && plan.m != null ? plan.m : MARGIN);
    if (!pts) return null;
    if (k === 4 && pts.length === 4) return cropPlan(pts, false, mm).pad;
    if (k === 4 && pts.length === 6) return cropPlan([pts[0], pts[2], pts[3], pts[5]], false, mm).pad;
    if (k === 6 && pts.length === 6) return cropPlan(pts, !!midMoved, mm).pad;
    return null;
  }

  return {
    outputSize, homographyFromRect, warp,
    orderQuad, seedSix, vanishing, dotsToVp, validShape,
    cropBox, cropFour, cropSix, warpInto, padOf, cropPlan, applyH,
    MIN_CROP, MARGIN, EDGES4, EDGES6, OPP6
  };
})();
