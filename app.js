"use strict";

const state = {
  image: null,
  imageName: "",
  svgText: "",
};

const elements = {
  imageInput: document.querySelector("#image-input"),
  fileName: document.querySelector("#file-name"),
  originalImage: document.querySelector("#original-image"),
  originalStage: document.querySelector("#original-stage"),
  vectorStage: document.querySelector("#vector-stage"),
  vectorizeButton: document.querySelector("#vectorize-button"),
  downloadButton: document.querySelector("#download-button"),
  resultBar: document.querySelector("#result-bar"),
  resultSummary: document.querySelector("#result-summary"),
  resultDetails: document.querySelector("#result-details"),
  status: document.querySelector("#status"),
  threshold: document.querySelector("#threshold"),
  thresholdOutput: document.querySelector("#threshold-output"),
  colorCount: document.querySelector("#color-count"),
  colorCountOutput: document.querySelector("#color-count-output"),
  detail: document.querySelector("#detail"),
  detailOutput: document.querySelector("#detail-output"),
  monochromeSettings: document.querySelector("#monochrome-settings"),
  colorSettings: document.querySelector("#color-settings"),
};

elements.imageInput.addEventListener("change", loadImage);
elements.vectorizeButton.addEventListener("click", vectorize);
elements.downloadButton.addEventListener("click", downloadSvg);
elements.threshold.addEventListener("input", () => {
  elements.thresholdOutput.value = elements.threshold.value;
});
elements.colorCount.addEventListener("input", () => {
  elements.colorCountOutput.value = elements.colorCount.value;
});
elements.detail.addEventListener("input", () => {
  elements.detailOutput.value = `${elements.detail.value} px`;
});
document.querySelectorAll('input[name="mode"]').forEach((input) => {
  input.addEventListener("change", updateModeControls);
});

function updateModeControls() {
  const colorMode = selectedMode() === "color";
  elements.monochromeSettings.classList.toggle("is-hidden", colorMode);
  elements.colorSettings.classList.toggle("is-hidden", !colorMode);
}

function selectedMode() {
  return document.querySelector('input[name="mode"]:checked').value;
}

function loadImage(event) {
  const [file] = event.target.files;
  if (!file) return;

  const reader = new FileReader();
  reader.addEventListener("load", () => {
    const image = new Image();
    image.addEventListener("load", () => {
      state.image = image;
      state.imageName = file.name.replace(/\.[^.]+$/, "") || "vektorgrafik";
      elements.originalImage.src = reader.result;
      elements.originalImage.hidden = false;
      elements.originalStage.querySelector(".empty-state")?.remove();
      elements.fileName.textContent = `${file.name} · ${image.naturalWidth} × ${image.naturalHeight} px`;
      elements.vectorizeButton.disabled = false;
      elements.status.textContent = "Bereit zur Umwandlung";
      elements.status.className = "status";
      elements.resultBar.hidden = true;
      elements.vectorStage.innerHTML = emptyState("Die neue SVG-Vorschau erscheint hier.");
    });
    image.src = reader.result;
  });
  reader.readAsDataURL(file);
}

function emptyState(text) {
  return `<div class="empty-state"><span aria-hidden="true">◇</span><p>${text}</p></div>`;
}

function vectorize() {
  if (!state.image) return;

  elements.vectorizeButton.disabled = true;
  elements.status.textContent = "Vektorisierung läuft …";
  elements.status.className = "status is-working";

  // Let the status update render before doing the CPU-intensive contour extraction.
  window.setTimeout(() => {
    const raster = rasterizeImage(state.image, Number(elements.detail.value));
    const result = selectedMode() === "color"
      ? colorVectorization(raster, Number(elements.colorCount.value))
      : monochromeVectorization(raster, Number(elements.threshold.value));
    state.svgText = buildSvg(raster.width, raster.height, result.layers);
    displaySvg(state.svgText);

    elements.resultSummary.textContent = selectedMode() === "color"
      ? `${result.layers.length} farbige Vektorebenen erstellt`
      : "Schwarzweiß-Vektorgrafik erstellt";
    elements.resultDetails.textContent = `${raster.width} × ${raster.height} px Arbeitsauflösung · ${result.pathCount.toLocaleString("de-DE")} Konturen`;
    elements.resultBar.hidden = false;
    elements.vectorizeButton.disabled = false;
    elements.status.textContent = "SVG fertig";
    elements.status.className = "status is-ready";
  }, 20);
}

function rasterizeImage(image, maxDimension) {
  const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  return { width, height, data: context.getImageData(0, 0, width, height).data };
}

function monochromeVectorization(raster, threshold) {
  const mask = new Uint8Array(raster.width * raster.height);
  for (let pixel = 0, index = 0; pixel < raster.data.length; pixel += 4, index += 1) {
    const grayscale = Math.round(
      raster.data[pixel] * 0.2126 +
      raster.data[pixel + 1] * 0.7152 +
      raster.data[pixel + 2] * 0.0722,
    );
    mask[index] = grayscale < threshold ? 1 : 0;
  }
  const paths = traceMask(mask, raster.width, raster.height);
  return {
    layers: [{ name: "Schwarz", color: "#000000", paths }],
    pathCount: paths.length,
  };
}

function colorVectorization(raster, colorCount) {
  const pixels = [];
  for (let index = 0; index < raster.width * raster.height; index += 1) {
    const offset = index * 4;
    const alpha = raster.data[offset + 3];
    const pixel = [raster.data[offset], raster.data[offset + 1], raster.data[offset + 2]];
    if (alpha < 8 || isNearWhite(pixel)) continue;
    pixels.push(pixel);
  }

  const palette = quantize(pixels, colorCount);
  const masks = palette.map(() => new Uint8Array(raster.width * raster.height));

  for (let index = 0; index < raster.width * raster.height; index += 1) {
    const offset = index * 4;
    const alpha = raster.data[offset + 3];
    const pixel = [raster.data[offset], raster.data[offset + 1], raster.data[offset + 2]];
    if (alpha < 8 || isNearWhite(pixel)) continue;
    let closestIndex = 0;
    let closestDistance = Infinity;
    palette.forEach((color, colorIndex) => {
      const distance = squaredDistance(pixel, color);
      if (distance < closestDistance) {
        closestDistance = distance;
        closestIndex = colorIndex;
      }
    });
    masks[closestIndex][index] = 1;
  }

  const layers = palette.map((color, index) => ({
    name: `Farbe ${index + 1}`,
    color: rgbToHex(color),
    paths: traceMask(masks[index], raster.width, raster.height),
  })).filter((layer) => layer.paths.length > 0);

  return { layers, pathCount: layers.reduce((sum, layer) => sum + layer.paths.length, 0) };
}

function quantize(pixels, count) {
  if (!pixels.length) return [[0, 0, 0]];

  const rgbBuckets = new Map();
  for (const pixel of pixels) {
    const key = pixel.map((value) => Math.round(value / 8)).join("|");
    if (!rgbBuckets.has(key)) {
      rgbBuckets.set(key, { count: 0, sum: [0, 0, 0] });
    }
    const bucket = rgbBuckets.get(key);
    bucket.count += 1;
    bucket.sum[0] += pixel[0];
    bucket.sum[1] += pixel[1];
    bucket.sum[2] += pixel[2];
  }

  const candidates = [...rgbBuckets.values()].map((bucket) => {
    const color = [
      bucket.sum[0] / bucket.count,
      bucket.sum[1] / bucket.count,
      bucket.sum[2] / bucket.count,
    ];
    const [hue, saturation] = rgbToHsl(color);
    return {
      color,
      count: bucket.count,
      hueBucket: Math.round(hue / 30),
      saturation,
      score: bucket.count * (0.35 + saturation / 100),
    };
  });

  const hueGroups = new Map();
  for (const candidate of candidates) {
    if (!hueGroups.has(candidate.hueBucket)) {
      hueGroups.set(candidate.hueBucket, { score: 0, candidates: [] });
    }
    const group = hueGroups.get(candidate.hueBucket);
    group.score += candidate.score;
    group.candidates.push(candidate);
  }

  const selected = [];
  for (const group of [...hueGroups.values()].sort((first, second) => second.score - first.score)) {
    const representative = group.candidates.sort((first, second) => second.score - first.score)[0];
    if (representative && selected.length < count) selected.push(representative);
  }

  for (const candidate of candidates.sort((first, second) => second.score - first.score)) {
    if (selected.length >= count) break;
    if (!selected.some((entry) => squaredDistance(entry.color, candidate.color) < 900)) {
      selected.push(candidate);
    }
  }

  return selected.map((entry) => entry.color).sort((first, second) => brightness(first) - brightness(second));
}

function isNearWhite(color) {
  const [r, g, b] = color;
  return Math.max(r, g, b) > 245 && Math.min(r, g, b) > 200;
}

function rgbToHsl([r, g, b]) {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;

  let hue = 0;
  if (delta !== 0) {
    if (max === red) hue = 60 * (((green - blue) / delta) % 6);
    else if (max === green) hue = 60 * ((blue - red) / delta + 2);
    else hue = 60 * ((red - green) / delta + 4);
  }
  if (hue < 0) hue += 360;

  const lightness = (max + min) / 2;
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
  return [hue, saturation * 100, lightness * 100];
}

function squaredDistance(first, second) {
  return (first[0] - second[0]) ** 2 + (first[1] - second[1]) ** 2 + (first[2] - second[2]) ** 2;
}

function brightness(color) {
  return color[0] * 0.2126 + color[1] * 0.7152 + color[2] * 0.0722;
}

function rgbToHex(color) {
  return `#${color.map((value) => Math.round(value).toString(16).padStart(2, "0")).join("")}`;
}

function traceMask(mask, width, height) {
  const visited = new Uint8Array(mask.length);
  const regions = [];

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (!mask[index] || visited[index]) continue;

      const queue = [[x, y]];
      const region = [];
      visited[index] = 1;

      while (queue.length) {
        const [cx, cy] = queue.pop();
        region.push([cx, cy]);

        const neighbors = [
          [cx - 1, cy],
          [cx + 1, cy],
          [cx, cy - 1],
          [cx, cy + 1],
        ];

        for (const [nx, ny] of neighbors) {
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          const neighborIndex = ny * width + nx;
          if (!mask[neighborIndex] || visited[neighborIndex]) continue;
          visited[neighborIndex] = 1;
          queue.push([nx, ny]);
        }
      }

      if (region.length > 0) regions.push(region);
    }
  }

  return regions;
}

function buildSvg(width, height, layers) {
  const layerMarkup = layers.map((layer) => {
    const rects = layer.paths.map((cells) => cells.map(([x, y]) => `<rect x="${x}" y="${y}" width="1" height="1"/>`).join("")).join("");
    return `<g id="${layer.name.replaceAll(" ", "-").toLowerCase()}" data-layer="${layer.name}" fill="${layer.color}">${rects}</g>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Vektorisierte Grafik" shape-rendering="crispEdges">${layerMarkup}</svg>`;
}

function displaySvg(svgText) {
  elements.vectorStage.innerHTML = svgText;
}

function downloadSvg() {
  const blob = new Blob([state.svgText], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${state.imageName || "vektorgrafik"}-vektor.svg`;
  link.click();
  URL.revokeObjectURL(url);
}
