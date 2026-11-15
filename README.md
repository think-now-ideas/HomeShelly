# HomeShelly

Übersicht aller Shelly-Geräte für Home Assistant – als eigene Dashboard-Karte, ohne zusätzlichen Server.

Gedacht für Installationen mit vielen Shellys: Suche, Gruppierung nach Stockwerken und Räumen, Status auf einen Blick und **gestaffelte Firmware-Updates** mit Testgruppe.

## Funktionen

- **Suchfeld** über Name, Raum, Stockwerk, Modell, IP und Firmware; Treffer werden markiert, passende Gruppen klappen auf.
- **Ansichten:** Stockwerk (Stockwerk → Raum → Gerät, Reihenfolge aus Home Assistant), Liste, Grundriss (Raumkästen).
- **Filter mit Zählern:** Alle · Updates · Offline · schwaches WLAN · Hinweise.
- Stockwerke und Räume **zuklappbar**, „Alles auf-/zuklappen“; der Zustand bleibt im Browser gespeichert.
- **Je Gerät:** Status, Name (→ HA-Geräteseite), IP (→ Shelly-Weboberfläche), Modell, Firmware (→ Änderungsliste), WLAN-Balken, Leistung, Gerätetemperatur, Laufzeit, An/Aus-Schalter. Spalten wählbar.
- **Zusammenfassung** je Stockwerk und Raum: Anzahl, Watt, Updates, offline, WLAN, Hinweise.
- **Hinweise:** unerwarteter Neustart (ohne Update), hohe Gerätetemperatur, Shelly-Cloud verbunden, Neustart erforderlich, Überhitzung.
- **Gestaffelte Updates:** zuerst die Testgruppe (Geräte mit einem Label), die übrigen nach einigen Tagen; nacheinander mit Pause, Fortschritt je Zeile. Einzelnes Gerät direkt aus der Änderungsliste.
- **CSV-Export** aller Geräte.

## Voraussetzungen

- Home Assistant 2026.5 oder neuer
- Shelly-Integration von Home Assistant, Geräte in Bereichen (und Bereiche in Stockwerken)
- Bei der Shelly-Integration sind einige Entitäten standardmäßig deaktiviert. Für alle Spalten bitte aktivieren: **Signalstärke (RSSI)**, **Laufzeit/letzter Neustart**, **Cloud**. Sonst bleiben diese Spalten leer.

## Installation über HACS

1. HACS → ⋮ → **Benutzerdefinierte Repositories** → URL `https://github.com/think-now-ideas/HomeShelly`, Typ **Dashboard**.
2. „HomeShelly“ herunterladen. HACS trägt die Ressource automatisch ein.
3. Neues Dashboard oder neue Ansicht, Typ **Panel**, Karte hinzufügen → „Shelly-Übersicht“ oder per Code-Editor:

```yaml
type: custom:shelly-overview-card
```

4. Optional: ein Label (Standard `shelly_test`) anlegen und 2–3 unkritischen Shellys geben – sie bekommen Updates zuerst.

Nach einem Update: Seite neu laden; in der Companion App ggf. *Einstellungen → Companion App → Fehlerbehebung → Frontend-Cache zurücksetzen*. Die Versionsnummer steht oben rechts in der Karte.

## Optionen

| Option | Standard | Bedeutung |
|---|---|---|
| `title` | `Shellys` | Überschrift |
| `test_label` | `shelly_test` | Label der Testgruppe |
| `test_days` | `3` | Tage, die die Testgruppe stabil laufen soll |
| `temp_warn` | `70` | Gerätetemperatur in °C, ab der ein Hinweis kommt |
| `rssi_weak` | `-75` | WLAN in dBm, darunter „schwach“ |
| `pause_seconds` | `20` | Pause zwischen zwei Updates |
| `update_timeout` | `600` | Sekunden, die pro Update höchstens gewartet wird |
| `restart_hours` | `24` | Neustarts in diesem Zeitraum werden gemeldet |

Beispiel: [`examples/karte.yaml`](examples/karte.yaml)

## Grenzen

- Kein Passwort-Check der Geräte (Home Assistant gibt das nicht preis).
- Der Grundriss zeigt Räume als Kästen, keine Geräte-Positionen.
- Gestaffelte Updates und die Erinnerung an die Testgruppe laufen im Browser: Seite während der Updates offen lassen.
- Die Links zur Shelly-Weboberfläche funktionieren nur im Heimnetz bzw. per VPN.
- Änderungslisten nur, soweit die Shelly-Integration Release Notes liefert.

## Lizenz

MIT – siehe [LICENSE](LICENSE).
