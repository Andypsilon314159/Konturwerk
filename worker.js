/* Führt die Vektorisierung im Hintergrund aus, damit die Oberfläche flüssig bleibt. */
importScripts("vectorizer.js");

self.addEventListener("message", (event) => {
  const { id, raster, options, svgOptions } = event.data;
  try {
    self.postMessage({ id, ...self.Konturwerk.vectorizeToSvg(raster, options, svgOptions) });
  } catch (error) {
    self.postMessage({ id, error: String((error && error.message) || error) });
  }
});
