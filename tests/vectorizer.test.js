"use strict";
// Ausführen mit: node --test tests/*.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { vectorize, traceMask, buildSvg } = require("../vectorizer.js");

function makeRaster(width, height, paint) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a = 255] = paint(x, y);
      data.set([r, g, b, a], (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

test("Quadrat mit Loch ergibt Außen- und Innenkontur mit korrekter Fläche", () => {
  const w = 10, h = 10;
  const mask = new Uint8Array(w * h);
  for (let y = 2; y < 8; y += 1) for (let x = 2; x < 8; x += 1) mask[y * w + x] = 1;
  for (let y = 4; y < 6; y += 1) for (let x = 4; x < 6; x += 1) mask[y * w + x] = 0;
  const loops = traceMask(mask, w, h);
  assert.equal(loops.length, 2);
  const areas = loops.map((l) => l.area).sort((a, b) => Math.abs(b) - Math.abs(a));
  assert.equal(Math.abs(areas[0]), 36);
  assert.equal(Math.abs(areas[1]), 4);
  assert.ok(Math.sign(areas[0]) !== Math.sign(areas[1]), "Loch muss entgegengesetzt orientiert sein");
});

test("Kanten am Bildrand und diagonale Pixel werden geschlossen verfolgt", () => {
  const w = 4, h = 4;
  const mask = new Uint8Array(w * h);
  mask[0] = 1; mask[5] = 1; mask[15] = 1; // Ecke, Diagonale, gegenüberliegende Ecke
  const loops = traceMask(mask, w, h);
  const total = loops.reduce((sum, l) => sum + Math.abs(l.area), 0);
  assert.equal(total, 3);
});

test("Farbbild wird in Ebenen mit echten Pfaden zerlegt", () => {
  const raster = makeRaster(120, 80, (x, y) => {
    if ((x - 40) ** 2 + (y - 40) ** 2 < 25 ** 2) return [220, 30, 40];
    if (x > 75 && y > 15 && y < 65) return [30, 90, 210];
    return [255, 255, 255];
  });
  for (const smoothing of ["pixel", "polygon", "curves"]) {
    const result = vectorize(raster, { mode: "color", colorCount: 3, smoothing });
    assert.equal(result.layers.length, 3, smoothing);
    const colors = result.layers.map((l) => l.color);
    assert.ok(colors.includes("#dc1e28") && colors.includes("#1e5ad2") && colors.includes("#ffffff"), colors.join());
    const svg = buildSvg(result, { title: "Test <1>" });
    assert.match(svg, /<path id="ebene-1"/);
    assert.ok(!svg.includes("<rect"));
    assert.ok(svg.length < 20000, `SVG zu groß: ${svg.length}`);
    assert.match(svg, /Test &#60;1&#62;/);
  }
});

test("Weißer Hintergrund kann weggelassen werden", () => {
  const raster = makeRaster(50, 50, (x, y) => (x > 10 && x < 40 && y > 10 && y < 40 ? [0, 120, 0] : [255, 255, 255]));
  const result = vectorize(raster, { colorCount: 2, dropWhite: true });
  assert.equal(result.layers.length, 1);
  assert.equal(result.layers[0].color, "#007800");
});

test("Schwarzweiß-Modus nutzt den Schwellwert", () => {
  const raster = makeRaster(40, 40, (x) => (x < 20 ? [40, 40, 40] : [200, 200, 200]));
  assert.equal(vectorize(raster, { mode: "monochrome", threshold: 128 }).layers.length, 1);
  assert.equal(vectorize(raster, { mode: "monochrome", threshold: 20 }).layers.length, 0);
});

test("Großes Rauschbild bleibt performant", () => {
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const raster = makeRaster(800, 600, (x, y) => [(x / 3 + rnd() * 60) % 256, (y / 2) % 256, rnd() * 255]);
  const t = Date.now();
  const result = vectorize(raster, { colorCount: 12 });
  assert.ok(result.layers.length > 1);
  assert.ok(Date.now() - t < 15000);
});

test("Unterste Ebene deckt das Bild bis zum Rand ab", () => {
  const raster = makeRaster(30, 20, (x, y) => (x > 10 && x < 20 && y > 5 && y < 15 ? [0, 0, 200] : [250, 240, 10]));
  for (const smoothing of ["polygon", "curves"]) {
    const [bottom] = vectorize(raster, { colorCount: 2, smoothing }).layers;
    const numbers = bottom.d.match(/-?\d+(\.\d+)?/g).map(Number);
    const xs = numbers.filter((_, i) => i % 2 === 0);
    const ys = numbers.filter((_, i) => i % 2 === 1);
    assert.equal(Math.min(...xs), 0, smoothing);
    assert.equal(Math.max(...xs), 30, smoothing);
    assert.equal(Math.min(...ys), 0, smoothing);
    assert.equal(Math.max(...ys), 20, smoothing);
  }
});
