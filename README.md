# Konturwerk

Eine Web-App für das iPhone (und jeden anderen Browser), die farbige Rasterbilder
in bearbeitbare SVG-Vektorgrafiken umwandelt. Sie zeigt das Ergebnis als Vorschau
an und speichert es als Datei. Die Bildverarbeitung bleibt vollständig auf dem
Gerät, es gibt keinen Server-Upload, und nach dem ersten Aufruf funktioniert die
App auch offline.

## Auf dem iPhone installieren

1. Die App einmal über HTTPS veröffentlichen (siehe unten, z. B. GitHub Pages).
2. Die Adresse in **Safari** öffnen.
3. Auf **Teilen** ⬆︎ → **Zum Home-Bildschirm** tippen.

Konturwerk liegt danach mit eigenem Symbol auf dem Home-Bildschirm und startet im
Vollbild wie eine normale App. Ein Mac, Xcode oder ein Apple-Entwicklerkonto
werden dafür nicht benötigt.

## Veröffentlichen mit GitHub Pages

Der Workflow `.github/workflows/pages.yml` testet und veröffentlicht die App bei
jedem Push auf `main`. Einmalig in GitHub unter **Settings → Pages → Build and
deployment → Source** die Option **GitHub Actions** wählen. Die Adresse lautet
dann `https://<benutzername>.github.io/<repository>/`.

Bei privaten Repositories ist GitHub Pages je nach GitHub-Tarif nur
eingeschränkt verfügbar. Alternativ lässt sich der Ordner bei jedem anderen
statischen Hoster mit HTTPS ablegen (Netlify, Cloudflare Pages …).

## Bedienung

- **Bild wählen:** aus der Fotomediathek, direkt mit der Kamera oder aus der
  Dateien-App (JPG, PNG, HEIC, WebP, GIF)
- **Farbige Ebenen** (2–24 Farben) oder **Schwarzweiß** mit Schwellwert
- **Kanten:** *Weich* (Kurven), *Kantig* (Polygone) oder *Pixel* (pixelgenau)
- **Detailgrad** und **Störflecken entfernen** zum Abwägen zwischen Detailtreue
  und Dateigröße; kleinere Bilder werden dabei bis zu 3× vergrößert
- Die Vorschau aktualisiert sich bei jeder Änderung automatisch; mit einem Tipp
  darauf öffnet sie sich im Vollbild (mit zwei Fingern zoomen).
- **In Dateien sichern / Teilen:** öffnet das iOS-Teilen-Menü
  („In Dateien sichern“, AirDrop, Mail …)
- **SVG herunterladen:** speichert die Datei in den Download-Ordner
- **Als PNG für Fotos:** die Fotos-App kann keine SVG-Dateien anzeigen; damit
  lässt sich eine gerenderte Kopie über „Bild sichern“ in die Mediathek legen.

Die SVG-Dateien enthalten pro Farbe einen Pfad (`ebene-1`, `ebene-2`, …) und
lassen sich in Affinity Designer, Illustrator, Inkscape, Figma oder Vectornator
weiterbearbeiten.

## Wie die Vektorisierung funktioniert

`vectorizer.js` enthält den Kern als reine Funktionen und läuft in einem Web
Worker (`worker.js`):

1. Farbreduktion per gewichtetem k-means auf einem Farbhistogramm. Kantenpixel
   mit Mischfarben werden bei der Farbwahl ignoriert.
2. 3×3-Mehrheitsfilter gegen Pixelrauschen.
3. Gestapelte Ebenen: Große Flächen liegen unten und reichen unter die kleineren,
   sodass keine Lücken zwischen den Farben entstehen.
4. Konturverfolgung entlang der Pixelkanten zu geschlossenen Pfaden (Löcher
   inklusive, Füllregel `nonzero`).
5. Vereinfachung mit Douglas-Peucker und Glättung zu quadratischen
   Bézierkurven mit begrenzter Abweichung.

## Lokal entwickeln

```sh
python3 -m http.server 8000   # danach http://localhost:8000 öffnen
node --test tests/*.test.js   # Tests des Vektorisierungskerns
```

Wird `index.html` direkt als Datei geöffnet, läuft die Berechnung im Hauptthread.
Offline-Modus und Installation funktionieren nur über HTTP(S).

## Warum keine native App?

Eine native iOS-App (Swift/SwiftUI) lässt sich nur mit einem Mac und Xcode
bauen und auf ein iPhone übertragen. Ohne kostenpflichtiges Entwicklerkonto
läuft sie dort nur 7 Tage. Die Web-App bietet für diesen Zweck dieselben
Funktionen (Fotoauswahl, Vorschau, Speichern in „Dateien“, Offline-Betrieb)
ohne diese Hürden.

## Versionen

Die aktuelle Version steht in der App oben neben dem Namen und in der
Fußzeile. Bei einer Änderung `APP_VERSION` in `app.js`, `CACHE` in `sw.js` und
die beiden Angaben in `index.html` gemeinsam erhöhen (ein Test prüft das).

- **1.4.0** – kleine Bilder werden vor dem Nachzeichnen vergrößert (glattere Konturen)
- **1.3.1** – Updates kommen sofort an (kein 10-Minuten-Browsercache mehr)
- **1.3.0** – Versionsnummer in der App sichtbar
- **1.2.0** – keine Fremdfarben zwischen Linien bei transparentem Hintergrund
- **1.1.0** – keine Fremdfarben durch graue Übergangspixel an Linienkanten
- **1.0.0** – erste iPhone-Version mit echter Farb-Vektorisierung
