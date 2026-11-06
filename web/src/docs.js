// ArduPilot parameter documentation for the connected firmware.
// 1. Exact version mirrored onto this site by CI (docs/<Vehicle>-<x.y.z>.json)
// 2. ArduPilot ParameterRepository for the same major.minor (raw.githubusercontent.com allows CORS)

const REPO = 'https://raw.githubusercontent.com/ArduPilot/ParameterRepository/main';

function flatten(json) {
  const docs = new Map();
  for (const [group, params] of Object.entries(json)) {
    if (group === 'json' || typeof params !== 'object' || params === null) continue;
    for (const [name, doc] of Object.entries(params)) {
      if (doc && typeof doc === 'object') docs.set(name, doc);
    }
  }
  return docs;
}

async function fetchJson(url) {
  const r = await fetch(url, { cache: 'force-cache' });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

/// Returns { docs: Map, label, exact } or a "no docs" result.
export async function loadParamDocs(vehicleName, version, official) {
  if (!vehicleName || !version) {
    return { docs: new Map(), label: 'No firmware version reported', exact: false };
  }
  const [major, minor] = version.split('.').map(Number);

  if (official) {
    try {
      const json = await fetchJson(`docs/${vehicleName}-${version}.json`);
      return { docs: flatten(json), label: `${vehicleName} ${version} — exact match for this firmware`, exact: true };
    } catch { /* not mirrored yet */ }
  }

  for (let m = minor; m >= 0; m--) {
    try {
      const json = await fetchJson(`${REPO}/${vehicleName}-${major}.${m}/apm.pdef.json`);
      const note = m === minor ? 'same major.minor, patch-level changes may be missing' : 'older docs, names may differ';
      return { docs: flatten(json), label: `${vehicleName} ${major}.${m} — ${note}`, exact: false };
    } catch { /* try older */ }
  }
  return { docs: new Map(), label: 'Parameter docs unavailable (offline?)', exact: false };
}

/// "0:Disabled, 1:Enabled" style summary of allowed values.
export function optionsText(doc) {
  if (!doc) return '';
  if (doc.Bitmask) return 'Bitmask: ' + Object.entries(doc.Bitmask).map(([k, v]) => `${k}:${v}`).join(', ');
  if (doc.Values) return Object.entries(doc.Values).map(([k, v]) => `${k}:${v}`).join(', ');
  if (doc.Range) return `${doc.Range.low} to ${doc.Range.high}${doc.Increment ? ` (step ${doc.Increment})` : ''}`;
  return '';
}

export function valueLabel(doc, value) {
  if (!doc) return '';
  if (doc.Values) {
    const hit = Object.entries(doc.Values).find(([k]) => Number(k) === Number(value));
    return hit ? hit[1] : '';
  }
  if (doc.Bitmask) {
    const bits = Object.entries(doc.Bitmask).filter(([k]) => (Number(value) >>> 0) & (1 << Number(k))).map(([, v]) => v);
    return bits.join(', ');
  }
  return '';
}
