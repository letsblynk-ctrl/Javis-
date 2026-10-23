# Jarvis fürs iPad

Dieselbe Jarvis wie auf dem PC, aber als Webseite für Safari auf dem iPad: pinker Orb, Stimme, Begrüßung mit Wetter, Aufgaben und neuen Team-Nachrichten, Start per Siri-Kurzbefehl und Doppelklatschen, solange die Seite offen ist.

Alles läuft im Browser. Deine Schlüssel (Anthropic, ElevenLabs, Team-Code) trägst du auf dem iPad in den Einstellungen ein. Sie bleiben im Speicher dieses Geräts und kommen nie ins Repo.

## Einrichten

1. **GitHub Pages einschalten** (einmalig, geht im iPad-Browser): Repo → Settings → Pages → *Deploy from a branch* → Branch `main`, Ordner `/docs` → Save. Nach ein bis zwei Minuten ist Jarvis erreichbar unter
   `https://letsblynk-ctrl.github.io/Javis-/`
2. Die Adresse in **Safari** öffnen, oben rechts auf das Zahnrad tippen und Name, Anrede, Stadt (Bad Kissingen), Anthropic-Key, ElevenLabs-Key und optional das Team-Cockpit eintragen. Speichern.
3. Unter iPad-Einstellungen → Apps → Safari → Mikrofon auf **Erlauben** stellen, damit Safari nicht jedes Mal fragt.

## Siri-Kurzbefehl

Kurzbefehle-App → neuer Kurzbefehl:
1. *Medien wiedergeben* bzw. Spotify-Aktion für deinen Startsong (die Seite selbst darf Spotify nicht starten).
2. *URL öffnen*: `https://letsblynk-ctrl.github.io/Javis-/?activate=1`

Den Kurzbefehl „Jarvis“ nennen, dann reicht „Hey Siri, Jarvis“. Die Seite begrüßt sofort und hört danach zu. Blockiert Safari den Ton, erscheint groß „Tippen, um Jarvis zu hören“. Ein Tippen genügt, danach spielt Jarvis ohne Hinweis.

Wichtig: „URL öffnen“ öffnet immer **Safari**, nicht das Home-Bildschirm-Icon. Safari und das Icon haben getrennte Speicher. Wenn du beides nutzt, überträgst du die Einstellungen unter *Einstellungen übertragen* (Code kopieren, auf der anderen Seite einfügen).

## Klatsch-Modus

Unten auf **Klatsch-Modus** tippen. Solange die Seite offen ist und das iPad auf dem Ständer steht, weckt Doppelklatschen Jarvis. Die Erkennung entspricht `jarvis/clap.py` (Schwelle 0,35, Klatscher höchstens 120 ms, Abstand 120–700 ms, danach 8 s Pause) und steht in `clap.js`. Unter Einstellungen → Klatsch-Modus kannst du die Schwelle mit der Pegelanzeige einstellen.

Der Bildschirm wird per Wake Lock wach gehalten. Klappt das nicht, sagt Jarvis Bescheid. Dann unter Einstellungen → Anzeige & Helligkeit → Automatische Sperre auf „Nie“ stellen.

## Was im Browser anders ist als auf dem PC

- Kein Apps-Starten und kein Bildschirm-Sehen. Websites, Google, YouTube und Spotify zeigt Jarvis als Button zum Antippen.
- Aufgaben: lokale Liste auf dem iPad plus das Team-Cockpit. Obsidian gibt es hier nicht.
- Nachrichten und Websuche laufen über Claudes eigene Websuche.

## Test

`node docs/clap.test.js` prüft die Klatsch-Erkennung mit simulierten Pegelverläufen.
