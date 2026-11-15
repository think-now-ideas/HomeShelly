"""Prüft, dass die Version in der Karte und im CHANGELOG übereinstimmt."""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def card_version() -> str:
    text = (ROOT / "dist" / "shelly-overview-card.js").read_text(encoding="utf-8")
    m = re.search(r'const SOC_VERSION = "([0-9]+(?:\.[0-9]+){2,3})"', text)
    assert m, "SOC_VERSION nicht gefunden"
    return m.group(1)


def test_changelog_has_section():
    v = card_version()
    lines = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8").splitlines()
    heads = [l.split()[1] for l in lines if l.startswith("## ") and len(l.split()) > 1]
    assert v in heads, f"CHANGELOG.md hat keinen Abschnitt „## {v}“"
    assert heads[0] == v, "Neueste Version muss oben im CHANGELOG stehen"


def test_hacs_filename_exists():
    import json
    cfg = json.loads((ROOT / "hacs.json").read_text(encoding="utf-8"))
    assert (ROOT / "dist" / cfg["filename"]).is_file()
