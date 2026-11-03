"use strict";

// Bei jeder Änderung erhöhen – zusammen mit CACHE in sw.js (ein Test prüft das).
const APP_VERSION = "1.4.0";

const state = {
  image: null,
  imageName: "",
  svgText: "",
  svgUrl: "",
  pngBlob: null,
  jobId: 0,
  timer: 0,
};

const $ = (selector) => document.querySelector(selector);
const elements = {
  imageInput: $("#image-input"),
  fileName: $("#file-name"),
  originalImage: $("#original-image"),
  vectorStage: $("#vector-stage"),
  vectorImage: $("#vector-image"),
  vectorizeButton: $("#vectorize-button"),
  shareButton: $("#share-button"),
  downloadButton: $("#download-button"),
  pngButton: $("#png-button"),
  resultBar: $("#result-bar"),
  resultSummary: $("#result-summary"),
  resultDetails: $("#result-details"),
  swatches: $("#swatches"),
  previewTitle: $("#preview-title"),
  status: $("#status"),
  threshold: $("#threshold"),
  thresholdOutput: $("#threshold-output"),
  colorCount: $("#color-count"),
  colorCountOutput: $("#color-count-output"),
  dropWhite: $("#drop-white"),
  detail: $("#detail"),
  detailOutput: $("#detail-output"),
  minArea: $("#min-area"),
  minAreaOutput: $("#min-area-output"),
  monochromeSettings: $("#monochrome-settings"),
  colorSettings: $("#color-settings"),
  viewer: $("#viewer"),
  viewerImage: $("#viewer-image"),
  viewerClose: $("#viewer-close"),
  installHint: $("#install-hint"),
  installHintClose: $("#install-hint-close"),
};

/* ---------- Hintergrundverarbeitung ---------- */

let worker = null;
try {
  worker = new Worker("worker.js");
  worker.addEventListener("message", (event) => handleResult(event.data));
  worker.addEventListener("error", () => {
    worker = null;
    runVectorization(); // laufenden Auftrag im Hauptthread wiederholen
  });
} catch {
  worker = null; // z. B. bei file:// – dann im Hauptthread rechnen
}

/* ---------- Ereignisse ---------- */

elements.imageInput.addEventListener("change", loadImage);
elements.vectorizeButton.addEventListener("click", () => runVectorization());
elements.shareButton.addEventListener("click", shareSvg);
elements.downloadButton.addEventListener("click", () => downloadBlob(svgBlob(), svgFileName()));
elements.pngButton.addEventListener("click", sharePng);
elements.vectorStage.addEventListener("click", openViewer);
elements.viewerClose.addEventListener("click", () => elements.viewer.close());
elements.viewer.addEventListener("click", (event) => {
  if (event.target === elements.viewer) elements.viewer.close();
});

bindOutput(elements.threshold, elements.thresholdOutput, (v) => v);
bindOutput(elements.colorCount, elements.colorCountOutput, (v) => v);
bindOutput(elements.detail, elements.detailOutput, (v) => `${v} px`);
bindOutput(elements.minArea, elements.minAreaOutput, (v) => `${v} px²`);
elements.dropWhite.addEventListener("change", scheduleVectorization);
document.querySelectorAll('input[name="mode"], input[name="smoothing"]').forEach((input) => {
  input.addEventListener("change", () => {
    updateModeControls();
    scheduleVectorization();
  });
});

function bindOutput(input, output, format) {
  input.addEventListener("input", () => {
    output.value = format(input.value);
    scheduleVectorization();
  });
}

function updateModeControls() {
  const colorMode = selectedValue("mode") === "color";
  elements.monochromeSettings.classList.toggle("is-hidden", colorMode);
  elements.colorSettings.classList.toggle("is-hidden", !colorMode);
}

function selectedValue(name) {
  return document.querySelector(`input[name="${name}"]:checked`).value;
}

/* ---------- Bild laden ---------- */

function loadImage(event) {
  const [file] = event.target.files;
  if (!file) return;

  const url = URL.createObjectURL(file);
  const image = new Image();
  image.addEventListener("load", () => {
    if (state.image) URL.revokeObjectURL(state.image.src);
    state.image = image;
    state.imageName = file.name.replace(/\.[^.]+$/, "") || "vektorgrafik";
    elements.originalImage.src = url;
    elements.originalImage.hidden = false;
    elements.originalImage.previousElementSibling?.remove();
    elements.fileName.textContent = `${file.name} · ${image.naturalWidth} × ${image.naturalHeight} px`;
    elements.vectorizeButton.disabled = false;
    runVectorization();
  });
  image.addEventListener("error", () => {
    URL.revokeObjectURL(url);
    setStatus("Bildformat wird nicht unterstützt", "is-error");
  });
  image.src = url;
}

/* ---------- Vektorisierung ---------- */

function scheduleVectorization() {
  if (!state.image) return;
  window.clearTimeout(state.timer);
  state.timer = window.setTimeout(runVectorization, 300);
}

function runVectorization() {
  if (!state.image) return;
  window.clearTimeout(state.timer);
  const id = ++state.jobId;
  setStatus("Vektorisierung läuft …", "is-working");
  elements.vectorizeButton.disabled = true;

  const raster = rasterizeImage(state.image, Number(elements.detail.value));
  const options = {
    mode: selectedValue("mode"),
    colorCount: Number(elements.colorCount.value),
    threshold: Number(elements.threshold.value),
    smoothing: selectedValue("smoothing"),
    minArea: Number(elements.minArea.value),
    dropWhite: elements.dropWhite.checked,
  };
  const svgOptions = {
    outputWidth: state.image.naturalWidth,
    outputHeight: state.image.naturalHeight,
    title: state.imageName,
  };
  const meta = { width: raster.width, height: raster.height, mode: options.mode };

  if (worker) {
    state.pendingMeta = meta;
    worker.postMessage({ id, raster, options, svgOptions }, [raster.data.buffer]);
  } else {
    // Kurz warten, damit der Status sichtbar wird, bevor der Hauptthread rechnet.
    window.setTimeout(() => {
      try {
        handleResult({ id, ...window.Konturwerk.vectorizeToSvg(raster, options, svgOptions) }, meta);
      } catch (error) {
        handleResult({ id, error: String(error.message || error) }, meta);
      }
    }, 30);
  }
}

function rasterizeImage(image, maxDimension) {
  // Kleine Bilder werden bis zu 3× vergrößert: Die weich interpolierten Kanten
  // ergeben beim Nachzeichnen glattere Konturen und genauere Details.
  const scale = Math.min(3, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, width, height);
  const { data } = context.getImageData(0, 0, width, height);
  return { width, height, data };
}

function handleResult(message, meta = state.pendingMeta) {
  if (message.id !== state.jobId) return; // veraltetes Ergebnis
  elements.vectorizeButton.disabled = false;
  if (message.error) {
    setStatus("Fehler bei der Umwandlung", "is-error");
    elements.resultDetails.textContent = message.error;
    return;
  }

  state.svgText = message.svg;
  state.pngBlob = null;
  if (state.svgUrl) URL.revokeObjectURL(state.svgUrl);
  state.svgUrl = URL.createObjectURL(svgBlob());

  elements.vectorImage.src = state.svgUrl;
  elements.vectorImage.hidden = false;
  elements.vectorStage.querySelector(".empty-state")?.remove();
  elements.vectorStage.disabled = false;

  const { summary } = message;
  const sizeKb = new Blob([state.svgText]).size / 1024;
  elements.previewTitle.textContent = state.imageName;
  elements.resultSummary.textContent = meta.mode === "color"
    ? `${summary.colors.length} Farbebenen · ${summary.pathCount.toLocaleString("de-DE")} Pfade`
    : `Schwarzweiß · ${summary.pathCount.toLocaleString("de-DE")} Pfade`;
  elements.resultDetails.textContent =
    `${formatSize(sizeKb)} SVG · Arbeitsauflösung ${meta.width} × ${meta.height} px`;
  elements.swatches.replaceChildren(...summary.colors.map((color) => {
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.background = color;
    swatch.title = color;
    return swatch;
  }));
  elements.resultBar.hidden = false;
  setStatus("SVG fertig", "is-ready");
  preparePng(message.id);
}

function setStatus(text, className = "") {
  elements.status.textContent = text;
  elements.status.className = `status ${className}`.trim();
}

function formatSize(kb) {
  return kb >= 1024 ? `${(kb / 1024).toLocaleString("de-DE", { maximumFractionDigits: 1 })} MB`
    : `${Math.max(1, Math.round(kb)).toLocaleString("de-DE")} KB`;
}

/* ---------- Sichern und Teilen ---------- */

function svgBlob() {
  return new Blob([state.svgText], { type: "image/svg+xml" });
}

function svgFileName() {
  return `${state.imageName || "vektorgrafik"}-vektor.svg`;
}

async function shareSvg() {
  const file = new File([state.svgText], svgFileName(), { type: "image/svg+xml" });
  if (!(await shareFile(file))) downloadBlob(file, file.name);
}

async function sharePng() {
  if (!state.pngBlob) {
    elements.pngButton.textContent = "PNG wird erstellt …";
    return;
  }
  const file = new File([state.pngBlob], svgFileName().replace(/\.svg$/, ".png"), { type: "image/png" });
  if (!(await shareFile(file))) downloadBlob(file, file.name);
}

/** Öffnet das iOS-Teilen-Menü („In Dateien sichern“, „Bild sichern“, AirDrop …). */
async function shareFile(file) {
  if (!navigator.canShare || !navigator.canShare({ files: [file] })) return false;
  try {
    await navigator.share({ files: [file], title: file.name });
  } catch (error) {
    if (error.name !== "AbortError") return false;
  }
  return true;
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  // iOS Safari braucht die URL noch einen Moment nach dem Klick.
  window.setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/**
 * Rendert die SVG schon nach der Umwandlung als PNG vor, damit das Teilen
 * direkt im Tipp-Ereignis passieren kann (Safari verlangt das).
 */
function preparePng(id) {
  elements.pngButton.disabled = true;
  elements.pngButton.textContent = "PNG wird erstellt …";
  const image = new Image();
  image.addEventListener("load", () => {
    if (id !== state.jobId) return;
    const longest = Math.max(state.image.naturalWidth, state.image.naturalHeight);
    const scale = Math.min(4096 / longest, Math.max(1, 2048 / longest));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(state.image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(state.image.naturalHeight * scale));
    canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      if (id !== state.jobId || !blob) return;
      state.pngBlob = blob;
      elements.pngButton.disabled = false;
      elements.pngButton.textContent = "Als PNG für Fotos";
    }, "image/png");
  });
  image.src = state.svgUrl;
}

/* ---------- Vollbild ---------- */

function openViewer() {
  if (!state.svgUrl) return;
  elements.viewerImage.src = state.svgUrl;
  elements.viewer.showModal();
}

document.querySelectorAll("[data-app-version]").forEach((element) => {
  element.textContent = `Version ${APP_VERSION}`;
});

/* ---------- Installation als App ---------- */

(function setupInstallHint() {
  const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = window.navigator.standalone || window.matchMedia("(display-mode: standalone)").matches;
  let dismissed = false;
  try { dismissed = localStorage.getItem("konturwerk-install-hint") === "hidden"; } catch { /* privat */ }
  if (isIos && !standalone && !dismissed) elements.installHint.hidden = false;
  elements.installHintClose.addEventListener("click", () => {
    elements.installHint.hidden = true;
    try { localStorage.setItem("konturwerk-install-hint", "hidden"); } catch { /* privat */ }
  });
})();

if ("serviceWorker" in navigator && window.isSecureContext) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js", { updateViaCache: "none" })
      .then((registration) => registration.update())
      .catch(() => {});
  });
}
