#!/usr/bin/env python3
"""Mirror ArduPilot's per-release parameter docs for the AIGC web app.

ArduPilot publishes apm.pdef.xml for every stable release under
https://autotest.ardupilot.org/Parameters/versioned/<Vehicle>/stable-X.Y.Z/. Browsers can't read that site
from another origin, so CI converts each file to the ParameterRepository JSON layout and serves it from the
app's own GitHub Pages site as docs/<Vehicle>-X.Y.Z.json.

Usage: build_param_docs.py <output_dir> [--min-version 4.4]
"""

import argparse
import json
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

BASE = "https://autotest.ardupilot.org/Parameters/versioned"
VEHICLES = ["Plane", "Copter", "Rover", "Sub"]


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "aigc-param-docs"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def list_versions(vehicle: str) -> list[str]:
    html = fetch(f"{BASE}/{vehicle}/").decode("utf-8", "replace")
    return sorted(set(re.findall(r"stable-(\d+\.\d+\.\d+)/", html)), key=lambda v: tuple(map(int, v.split("."))))


def code_list(text: str) -> dict:
    out = {}
    for item in text.split(","):
        if ":" in item:
            k, v = item.split(":", 1)
            out[k.strip()] = v.strip()
    return out


def convert(xml_bytes: bytes) -> dict:
    root = ET.fromstring(xml_bytes)
    groups: dict = {}
    for params in root.iter("parameters"):
        group = params.get("name") or "Misc"
        for p in params.findall("param"):
            name = (p.get("name") or "").split(":")[-1]
            if not name:
                continue
            doc = {}
            if p.get("humanName"):
                doc["DisplayName"] = p.get("humanName")
            if p.get("documentation"):
                doc["Description"] = p.get("documentation")
            if p.get("user"):
                doc["User"] = p.get("user")
            for child in p:
                text = (child.text or "").strip()
                if child.tag == "field":
                    field = child.get("name")
                    if field == "Range":
                        parts = text.split()
                        if len(parts) == 2:
                            doc["Range"] = {"low": parts[0], "high": parts[1]}
                    elif field in ("ReadOnly", "RebootRequired"):
                        doc[field] = text.lower() == "true"
                    elif field in ("Values", "Bitmask"):
                        doc.setdefault(field, code_list(text))
                    elif field:
                        doc[field] = text
                elif child.tag in ("values", "bitmask"):
                    item = "value" if child.tag == "values" else "bit"
                    codes = {c.get("code"): (c.text or "").strip() for c in child.findall(item) if c.get("code") is not None}
                    if codes:
                        doc["Values" if child.tag == "values" else "Bitmask"] = codes
            groups.setdefault(group, {})[name] = doc
    return groups


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("out_dir")
    ap.add_argument("--min-version", default="4.4")
    args = ap.parse_args()
    min_v = tuple(map(int, args.min_version.split(".")))
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)

    index = {}
    for vehicle in VEHICLES:
        try:
            versions = [v for v in list_versions(vehicle) if tuple(map(int, v.split(".")))[:2] >= min_v]
        except Exception as e:  # keep going: a missing vehicle shouldn't break the site
            print(f"warning: cannot list {vehicle}: {e}", file=sys.stderr)
            continue
        index[vehicle] = []
        for version in versions:
            target = out / f"{vehicle}-{version}.json"
            try:
                docs = convert(fetch(f"{BASE}/{vehicle}/stable-{version}/apm.pdef.xml"))
            except Exception as e:
                print(f"warning: {vehicle} {version}: {e}", file=sys.stderr)
                continue
            target.write_text(json.dumps(docs, separators=(",", ":")))
            index[vehicle].append(version)
            print(f"{vehicle} {version}: {sum(len(g) for g in docs.values())} params")
    (out / "index.json").write_text(json.dumps(index, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
