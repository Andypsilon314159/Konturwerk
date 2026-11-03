/*
 * Konturwerk – Vektorisierungskern.
 *
 * Reine Funktionen ohne DOM-Zugriff, damit derselbe Code im Web Worker,
 * im Hauptthread und in Node-Tests laufen kann.
 *
 * Ablauf:
 *   1. Farbreduktion (k-means mit k-means++-Start) bzw. Schwellwert
 *   2. Mehrheitsfilter gegen Pixelrauschen
 *   3. Gestapelte Ebenen (große Flächen unten), damit keine Lücken entstehen
 *   4. Konturverfolgung entlang der Pixelkanten zu geschlossenen Pfaden
 *   5. Vereinfachung (Douglas-Peucker) und optionale Kurvenglättung
 */
(function (root) {
  "use strict";

  const TRANSPARENT = -1;

  function vectorize(raster, options = {}) {
    const {
      mode = "color",
      colorCount = 8,
      threshold = 128,
      smoothing = "curves",
      minArea = 6,
      dropWhite = false,
    } = options;
    const { width, height, data } = raster;

    let labels;
    let palette;
    if (mode === "monochrome") {
      ({ labels, palette } = thresholdLabels(data, width, height, threshold));
    } else {
      ({ labels, palette } = colorLabels(data, width, height, colorCount, dropWhite));
      labels = majorityFilter(labels, width, height);
    }

    // Häufigste Farbe zuerst (unten), damit kleinere Flächen darüber liegen.
    const counts = new Array(palette.length).fill(0);
    for (let i = 0; i < labels.length; i += 1) if (labels[i] >= 0) counts[labels[i]] += 1;
    const order = palette.map((_, i) => i).filter((i) => counts[i] > 0).sort((a, b) => counts[b] - counts[a]);
    const rank = new Int16Array(palette.length).fill(-1);
    order.forEach((colorIndex, position) => { rank[colorIndex] = position; });

    const layers = [];
    const mask = new Uint8Array(width * height);
    let pathCount = 0;
    order.forEach((colorIndex, position) => {
      // Gestapelt: Ebene enthält ihre Farbe plus alle darüberliegenden Farben.
      for (let i = 0; i < labels.length; i += 1) {
        mask[i] = labels[i] >= 0 && rank[labels[i]] >= position ? 1 : 0;
      }
      const loops = traceMask(mask, width, height).filter((loop) => Math.abs(loop.area) >= minArea);
      if (!loops.length) return;
      const d = loops.map((loop) => loopToPath(loop.points, smoothing, width, height)).join("");
      pathCount += loops.length;
      layers.push({ color: rgbToHex(palette[colorIndex]), d, pixels: counts[colorIndex], loops: loops.length });
    });

    return { width, height, layers, pathCount };
  }

  /* ---------- Farb- und Schwellwertanalyse ---------- */

  function thresholdLabels(data, width, height, threshold) {
    const labels = new Int16Array(width * height);
    for (let i = 0, p = 0; i < labels.length; i += 1, p += 4) {
      const gray = data[p] * 0.2126 + data[p + 1] * 0.7152 + data[p + 2] * 0.0722;
      labels[i] = data[p + 3] >= 128 && gray < threshold ? 0 : TRANSPARENT;
    }
    return { labels, palette: [[0, 0, 0]] };
  }

  function colorLabels(data, width, height, colorCount, dropWhite) {
    const total = width * height;
    const sampleStep = Math.max(1, Math.floor(total / 60000));
    // Kantenpixel (Mischfarben durch Unschärfe/Antialiasing) nicht in die Palette
    // aufnehmen, sonst verbraucht k-means Farben für graue Säume.
    let samples = [];
    const edgeSamples = [];
    for (let i = 0; i < total; i += sampleStep) {
      const p = i * 4;
      if (data[p + 3] < 128) continue;
      const x = i % width;
      const right = x < width - 1 ? p + 4 : p;
      const down = i + width < total ? p + width * 4 : p;
      const contrast = Math.abs(data[p] - data[right]) + Math.abs(data[p + 1] - data[right + 1])
        + Math.abs(data[p + 2] - data[right + 2]) + Math.abs(data[p] - data[down])
        + Math.abs(data[p + 1] - data[down + 1]) + Math.abs(data[p + 2] - data[down + 2]);
      (contrast > 48 ? edgeSamples : samples).push(data[p], data[p + 1], data[p + 2]);
    }
    if (samples.length < edgeSamples.length / 4) samples = samples.concat(edgeSamples); // sehr feines Muster

    let palette = kmeans(samples, colorCount);
    const removed = palette.map((color) => dropWhite && isNearWhite(color));

    const labels = new Int16Array(total);
    // Cache auf 6 bit pro Kanal: identische Farben werden nur einmal zugeordnet.
    const cache = new Int16Array(1 << 18).fill(-2);
    for (let i = 0, p = 0; i < total; i += 1, p += 4) {
      if (data[p + 3] < 128) { labels[i] = TRANSPARENT; continue; }
      const key = ((data[p] >> 2) << 12) | ((data[p + 1] >> 2) << 6) | (data[p + 2] >> 2);
      let label = cache[key];
      if (label === -2) {
        label = nearest(palette, data[p], data[p + 1], data[p + 2]);
        if (removed[label]) label = TRANSPARENT;
        cache[key] = label;
      }
      labels[i] = label;
    }
    return { labels: resolveBlendPixels(data, width, height, labels, palette), palette };
  }

  /**
   * Übergangspixel an Kanten (z. B. Grau zwischen schwarzer Linie und weißem
   * Grund) liegen farblich oft zufällig nahe an einer ganz anderen Palettenfarbe
   * und erzeugen falsche Farbsäume. Lässt sich ein Pixel deutlich besser als
   * Mischung zweier Farben aus seiner 5×5-Umgebung erklären, bekommt es die
   * näher liegende dieser beiden Farben.
   */
  function resolveBlendPixels(data, width, height, labels, palette) {
    const out = new Int16Array(labels);
    const local = new Int16Array(25);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = y * width + x;
        const own = labels[i];
        if (own < 0) continue;

        let count = 0;
        let mixed = false;
        for (let dy = -2; dy <= 2; dy += 1) {
          const ny = y + dy;
          if (ny < 0 || ny >= height) continue;
          for (let dx = -2; dx <= 2; dx += 1) {
            const nx = x + dx;
            if (nx < 0 || nx >= width) continue;
            const v = labels[ny * width + nx];
            if (v < 0 || v === own) continue;
            mixed = true;
            let j = 0;
            while (j < count && local[j] !== v) j += 1;
            if (j === count) local[count++] = v;
          }
        }
        if (!mixed || count < 2) continue; // nur ein Nachbar: eigene Farbe ist plausibel

        const p = i * 4;
        const pixel = [data[p], data[p + 1], data[p + 2]];
        const c = palette[own];
        const single = sq(pixel[0] - c[0]) + sq(pixel[1] - c[1]) + sq(pixel[2] - c[2]);
        if (single < 15 * 15) continue; // Pixel passt gut zur eigenen Farbe

        let best = single * 0.25; // Mischung muss deutlich besser passen
        let choice = -1;
        for (let a = 0; a < count; a += 1) {
          for (let b = a + 1; b < count; b += 1) {
            const ca = palette[local[a]];
            const cb = palette[local[b]];
            const d = segmentDistanceSq3(pixel, ca, cb);
            if (d < best) {
              best = d;
              const da = sq(pixel[0] - ca[0]) + sq(pixel[1] - ca[1]) + sq(pixel[2] - ca[2]);
              const db = sq(pixel[0] - cb[0]) + sq(pixel[1] - cb[1]) + sq(pixel[2] - cb[2]);
              choice = da <= db ? local[a] : local[b];
            }
          }
        }
        if (choice >= 0) out[i] = choice;
      }
    }
    return out;
  }

  function segmentDistanceSq3(p, a, b) {
    const d0 = b[0] - a[0];
    const d1 = b[1] - a[1];
    const d2 = b[2] - a[2];
    const length = d0 * d0 + d1 * d1 + d2 * d2;
    let t = length ? ((p[0] - a[0]) * d0 + (p[1] - a[1]) * d1 + (p[2] - a[2]) * d2) / length : 0;
    t = Math.max(0, Math.min(1, t));
    return sq(p[0] - a[0] - t * d0) + sq(p[1] - a[1] - t * d1) + sq(p[2] - a[2] - t * d2);
  }

  /**
   * Gewichtetes k-means auf einem Farbhistogramm (5 bit pro Kanal).
   * Gewicht = Wurzel der Häufigkeit: kleine, aber deutlich andere Flächen
   * (z. B. eine weiße Bergspitze) bekommen so eine eigene Farbe, statt dass
   * große Flächen in viele fast gleiche Töne zerfallen.
   */
  function kmeans(samples, k) {
    const bins = new Map();
    for (let i = 0; i < samples.length; i += 3) {
      const key = ((samples[i] >> 3) << 10) | ((samples[i + 1] >> 3) << 5) | (samples[i + 2] >> 3);
      let bin = bins.get(key);
      if (!bin) { bin = [0, 0, 0, 0]; bins.set(key, bin); }
      bin[0] += samples[i]; bin[1] += samples[i + 1]; bin[2] += samples[i + 2]; bin[3] += 1;
    }
    const n = bins.size;
    if (n === 0) return [[0, 0, 0]];
    const points = new Float64Array(n * 3);
    const weights = new Float64Array(n);
    let index = 0;
    for (const bin of bins.values()) {
      points[index * 3] = bin[0] / bin[3];
      points[index * 3 + 1] = bin[1] / bin[3];
      points[index * 3 + 2] = bin[2] / bin[3];
      weights[index] = Math.sqrt(bin[3]);
      index += 1;
    }

    k = Math.max(1, Math.min(k, n));

    // Startwerte: häufigste Farbe, danach jeweils die am schlechtesten vertretene
    let heaviest = 0;
    for (let i = 1; i < n; i += 1) if (weights[i] > weights[heaviest]) heaviest = i;
    const centers = [[points[heaviest * 3], points[heaviest * 3 + 1], points[heaviest * 3 + 2]]];
    const dist = new Float64Array(n).fill(Infinity);
    while (centers.length < k) {
      const c = centers[centers.length - 1];
      let sum = 0;
      for (let i = 0; i < n; i += 1) {
        const d = sq(points[i * 3] - c[0]) + sq(points[i * 3 + 1] - c[1]) + sq(points[i * 3 + 2] - c[2]);
        if (d < dist[i]) dist[i] = d;
        sum += dist[i] * weights[i];
      }
      if (sum === 0) break; // weniger unterschiedliche Farben als gewünscht
      // Deterministisch: die Farbe mit dem größten gewichteten Abstand zur Palette.
      let chosen = 0;
      let best = -1;
      for (let i = 0; i < n; i += 1) {
        const score = dist[i] * weights[i];
        if (score > best) { best = score; chosen = i; }
      }
      centers.push([points[chosen * 3], points[chosen * 3 + 1], points[chosen * 3 + 2]]);
    }

    const assignment = new Int32Array(n).fill(-1);
    for (let iteration = 0; iteration < 24; iteration += 1) {
      const sums = centers.map(() => [0, 0, 0, 0]);
      let moved = 0;
      for (let i = 0; i < n; i += 1) {
        const label = nearest(centers, points[i * 3], points[i * 3 + 1], points[i * 3 + 2]);
        if (label !== assignment[i]) moved += 1;
        assignment[i] = label;
        const s = sums[label];
        const w = weights[i];
        s[0] += points[i * 3] * w; s[1] += points[i * 3 + 1] * w; s[2] += points[i * 3 + 2] * w; s[3] += w;
      }
      sums.forEach((s, i) => {
        if (s[3] > 0) centers[i] = [s[0] / s[3], s[1] / s[3], s[2] / s[3]];
      });
      if (moved === 0) break;
    }

    // Nahezu identische Zentren zusammenfassen.
    const unique = [];
    for (const center of centers) {
      if (!unique.some((u) => sq(u[0] - center[0]) + sq(u[1] - center[1]) + sq(u[2] - center[2]) < 4)) {
        unique.push(center.map(Math.round));
      }
    }
    return unique;
  }

  function nearest(palette, r, g, b) {
    let best = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < palette.length; i += 1) {
      const c = palette[i];
      const d = sq(r - c[0]) + sq(g - c[1]) + sq(b - c[2]);
      if (d < bestDistance) { bestDistance = d; best = i; }
    }
    return best;
  }

  /** Ersetzt ein Pixel, wenn mindestens 5 der 9 Pixel im 3×3-Fenster eine andere Farbe haben. */
  function majorityFilter(labels, width, height) {
    const out = new Int16Array(labels);
    const values = new Int16Array(9);
    const tallies = new Int8Array(9);
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        let distinct = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const v = labels[(y + dy) * width + x + dx];
            let j = 0;
            while (j < distinct && values[j] !== v) j += 1;
            if (j === distinct) { values[j] = v; tallies[j] = 0; distinct += 1; }
            tallies[j] += 1;
          }
        }
        for (let j = 0; j < distinct; j += 1) {
          if (tallies[j] >= 5) { out[y * width + x] = values[j]; break; }
        }
      }
    }
    return out;
  }

  /* ---------- Konturverfolgung ---------- */

  // Richtungen: 0 rechts, 1 unten, 2 links, 3 oben (y zeigt nach unten).
  const DX = [1, 0, -1, 0];
  const DY = [0, 1, 0, -1];

  /**
   * Liefert alle Randlinien einer Binärmaske als geschlossene Polygone auf dem
   * Pixelgitter. Außenkonturen laufen im Uhrzeigersinn, Löcher entgegengesetzt –
   * damit funktioniert die SVG-Füllregel "nonzero" ohne weitere Sortierung.
   */
  function traceMask(mask, width, height) {
    const stride = width + 1;
    const edges = new Uint8Array(stride * (height + 1));
    let edgeCount = 0;

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (!mask[y * width + x]) continue;
        if (y === 0 || !mask[(y - 1) * width + x]) { edges[y * stride + x] |= 1; edgeCount += 1; }
        if (x === width - 1 || !mask[y * width + x + 1]) { edges[y * stride + x + 1] |= 2; edgeCount += 1; }
        if (y === height - 1 || !mask[(y + 1) * width + x]) { edges[(y + 1) * stride + x + 1] |= 4; edgeCount += 1; }
        if (x === 0 || !mask[y * width + x - 1]) { edges[(y + 1) * stride + x] |= 8; edgeCount += 1; }
      }
    }

    const loops = [];
    if (!edgeCount) return loops;

    for (let start = 0; start < edges.length; start += 1) {
      const bits = edges[start];
      if (!bits || (bits & (bits - 1))) continue; // nur Ecken mit genau einer Kante als Start
      let dir = bits === 1 ? 0 : bits === 2 ? 1 : bits === 4 ? 2 : 3;
      let vx = start % stride;
      let vy = (start - vx) / stride;
      const points = [];
      let area = 0;

      for (;;) {
        const v = vy * stride + vx;
        const available = edges[v];
        if (!available) break;
        if (!(available & (1 << dir)) || (available & (available - 1))) {
          // An Sattelpunkten links abbiegen: diagonal benachbarte Pixel bleiben verbunden.
          const left = (dir + 3) & 3;
          const right = (dir + 1) & 3;
          if (available & (1 << left)) dir = left;
          else if (available & (1 << dir)) { /* geradeaus */ }
          else if (available & (1 << right)) dir = right;
          else dir = (dir + 2) & 3;
        }
        edges[v] &= ~(1 << dir);
        points.push(vx, vy);
        const nx = vx + DX[dir];
        const ny = vy + DY[dir];
        area += vx * ny - nx * vy;
        vx = nx;
        vy = ny;
      }
      if (points.length >= 8) loops.push({ points, area: area / 2 });
    }
    return loops;
  }

  /* ---------- Pfadaufbau ---------- */

  function loopToPath(points, smoothing, width, height) {
    if (smoothing === "pixel") return polygonPath(cornersOnly(points));

    // Mittelpunkte der Pixelkanten glätten Treppenstufen zu schrägen Linien.
    // Echte Ecken (beide anliegenden Kanten mindestens 3 px lang) bleiben erhalten,
    // Punkte am Bildrand werden auf den Rand gezogen, damit dort kein Spalt entsteht.
    const n = points.length / 2;
    const dirs = new Int8Array(n);
    for (let i = 0; i < n; i += 1) {
      const j = (i + 1) % n;
      const dx = points[j * 2] - points[i * 2];
      const dy = points[j * 2 + 1] - points[i * 2 + 1];
      dirs[i] = dx > 0 ? 0 : dy > 0 ? 1 : dx < 0 ? 2 : 3;
    }
    const runLength = new Int32Array(n);
    let first = 0;
    while (first < n && dirs[first] === dirs[(first - 1 + n) % n]) first += 1;
    for (let k = 0; k < n;) {
      let length = 1;
      while (length < n && dirs[(first + k + length) % n] === dirs[(first + k) % n]) length += 1;
      for (let m = 0; m < length; m += 1) runLength[(first + k + m) % n] = length;
      k += length;
    }

    const snap = (value, max) => (value <= 0.5 ? 0 : value >= max - 0.5 ? max : value);
    const mid = [];
    for (let i = 0; i < n; i += 1) {
      const j = (i + 1) % n;
      mid.push([
        snap((points[i * 2] + points[j * 2]) / 2, width),
        snap((points[i * 2 + 1] + points[j * 2 + 1]) / 2, height),
      ]);
      if (dirs[i] !== dirs[j] && runLength[i] >= 3 && runLength[j] >= 3) {
        mid.push([points[j * 2], points[j * 2 + 1]]);
      }
    }
    const tolerance = smoothing === "curves" ? 0.9 : 0.65;
    const simplified = simplifyClosed(mid, tolerance);
    if (simplified.length < 3) return "";
    return smoothing === "curves" ? curvedPath(simplified) : polygonPath(simplified);
  }

  function cornersOnly(points) {
    const n = points.length / 2;
    const result = [];
    for (let i = 0; i < n; i += 1) {
      const p = (i - 1 + n) % n;
      const q = (i + 1) % n;
      const ax = points[i * 2] - points[p * 2];
      const ay = points[i * 2 + 1] - points[p * 2 + 1];
      const bx = points[q * 2] - points[i * 2];
      const by = points[q * 2 + 1] - points[i * 2 + 1];
      if (ax !== bx || ay !== by) result.push([points[i * 2], points[i * 2 + 1]]);
    }
    return result;
  }

  function simplifyClosed(points, tolerance) {
    if (points.length <= 4) return points;
    // Am weitesten vom ersten Punkt entfernten Punkt teilen, dann beide Hälften vereinfachen.
    let far = 0;
    let farDistance = -1;
    for (let i = 1; i < points.length; i += 1) {
      const d = sq(points[i][0] - points[0][0]) + sq(points[i][1] - points[0][1]);
      if (d > farDistance) { farDistance = d; far = i; }
    }
    const firstHalf = douglasPeucker(points.slice(0, far + 1), tolerance);
    const secondHalf = douglasPeucker(points.slice(far).concat([points[0]]), tolerance);
    return firstHalf.slice(0, -1).concat(secondHalf.slice(0, -1));
  }

  function douglasPeucker(points, tolerance) {
    const keep = new Uint8Array(points.length);
    keep[0] = 1;
    keep[points.length - 1] = 1;
    const stack = [[0, points.length - 1]];
    const tol2 = tolerance * tolerance;
    while (stack.length) {
      const [a, b] = stack.pop();
      let index = -1;
      let maxDistance = tol2;
      for (let i = a + 1; i < b; i += 1) {
        const d = segmentDistanceSq(points[i], points[a], points[b]);
        if (d > maxDistance) { maxDistance = d; index = i; }
      }
      if (index !== -1) {
        keep[index] = 1;
        stack.push([a, index], [index, b]);
      }
    }
    return points.filter((_, i) => keep[i]);
  }

  function segmentDistanceSq(p, a, b) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const length = dx * dx + dy * dy;
    let t = length ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length : 0;
    t = Math.max(0, Math.min(1, t));
    return sq(p[0] - a[0] - t * dx) + sq(p[1] - a[1] - t * dy);
  }

  function polygonPath(points) {
    if (points.length < 3) return "";
    let d = `M${fmt(points[0][0])} ${fmt(points[0][1])}`;
    for (let i = 1; i < points.length; i += 1) d += `L${fmt(points[i][0])} ${fmt(points[i][1])}`;
    return `${d}Z`;
  }

  /**
   * Rundet flache Knicke (Teil einer Kurve) weich ab, scharfe Ecken nur
   * minimal – so bleiben Rechtecke eckig, Kreise werden rund und lange
   * Kanten wölben sich nicht aus.
   */
  const MAX_DEVIATION = 1;

  function curvedPath(points) {
    const n = points.length;
    const segments = [];
    for (let i = 0; i < n; i += 1) {
      const prev = points[(i - 1 + n) % n];
      const cur = points[i];
      const next = points[(i + 1) % n];
      const inX = cur[0] - prev[0];
      const inY = cur[1] - prev[1];
      const outX = next[0] - cur[0];
      const outY = next[1] - cur[1];
      const inLength = Math.hypot(inX, inY) || 1;
      const outLength = Math.hypot(outX, outY) || 1;
      // Abrundung so wählen, dass die Kurve höchstens MAX_DEVIATION vom Polygon abweicht:
      // Abstand der Bézier-Mitte zur Ecke = a · sin(Knickwinkel / 2) / 2.
      const cos = Math.max(-1, Math.min(1, (inX * outX + inY * outY) / (inLength * outLength)));
      const sinHalf = Math.sqrt((1 - cos) / 2);
      const reach = cos <= 0 ? 0.8 : sinHalf > 0 ? (2 * MAX_DEVIATION) / sinHalf : Infinity;
      const tIn = Math.min(0.5, reach / inLength);
      const tOut = Math.min(0.5, reach / outLength);
      segments.push({
        a: [cur[0] - inX * tIn, cur[1] - inY * tIn],
        c: cur,
        b: [cur[0] + outX * tOut, cur[1] + outY * tOut],
      });
    }
    let d = `M${fmt(segments[0].a[0])} ${fmt(segments[0].a[1])}`;
    for (let i = 0; i < n; i += 1) {
      const s = segments[i];
      if (i > 0) d += `L${fmt(s.a[0])} ${fmt(s.a[1])}`;
      d += `Q${fmt(s.c[0])} ${fmt(s.c[1])} ${fmt(s.b[0])} ${fmt(s.b[1])}`;
    }
    return `${d}Z`;
  }

  /* ---------- SVG ---------- */

  function buildSvg(result, { outputWidth, outputHeight, title = "Vektorgrafik" } = {}) {
    const w = outputWidth || result.width;
    const h = outputHeight || result.height;
    const body = result.layers
      .map((layer, i) => `  <path id="ebene-${i + 1}" fill="${layer.color}" d="${layer.d}"/>`)
      .join("\n");
    return `<?xml version="1.0" encoding="UTF-8"?>\n`
      + `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${result.width} ${result.height}">\n`
      + `  <title>${escapeXml(title)}</title>\n${body}\n</svg>\n`;
  }

  /** Bequeme Komplettfunktion: liefert SVG-Text plus kurze Zusammenfassung. */
  function vectorizeToSvg(raster, options, svgOptions) {
    const result = vectorize(raster, options);
    return {
      svg: buildSvg(result, svgOptions),
      summary: { pathCount: result.pathCount, colors: result.layers.map((layer) => layer.color) },
    };
  }

  /* ---------- Hilfsfunktionen ---------- */

  function isNearWhite([r, g, b]) {
    return Math.min(r, g, b) > 228 && Math.max(r, g, b) - Math.min(r, g, b) < 20;
  }

  function rgbToHex(color) {
    return `#${color.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
  }

  function fmt(value) {
    return String(Math.round(value * 100) / 100);
  }

  function escapeXml(text) {
    return String(text).replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
  }

  function sq(v) { return v * v; }

  const api = { vectorize, vectorizeToSvg, buildSvg, traceMask, kmeans };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.Konturwerk = api;
})(typeof self !== "undefined" ? self : globalThis);
