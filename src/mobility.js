import { normalizeMac } from './topology.js';

export class MobilityPlane {
  constructor(topology) {
    this.topology = topology;
    this.tables = new Map();
    this.seenMessages = new Map();
    this.rejects = [];
    for (const peId of topology.peById.keys()) {
      this.tables.set(peId, new Map());
    }
  }

  _entryKey(mac, vlan, vsi) {
    return `${vsi ?? this.topology.vsi}|${vlan ?? 'any'}|${normalizeMac(mac)}`;
  }

  _table(peId) {
    const table = this.tables.get(peId);
    if (!table) throw new Error(`未知 PE: ${peId}`);
    return table;
  }

  learn(event) {
    const peId = event.pe;
    const mac = normalizeMac(event.mac);
    const vlan = event.vlan ?? this.topology.vlan;
    const vsi = event.vsi ?? this.topology.vsi;
    const sourceType = event.sourceType ?? (event.source === 'pw' ? 'pw' : 'ac');
    const source = event.source ?? this.topology.defaultAc(peId);
    const seq = event.seq ?? null;
    const ts = event.ts;
    const key = this._entryKey(mac, vlan, vsi);
    const table = this._table(peId);
    const existing = table.get(key);

    if (
      existing &&
      existing.source === source &&
      existing.sourceType === sourceType &&
      existing.seq === seq
    ) {
      return { kind: 'duplicate', accepted: false, reason: 'duplicate-learn', key, pe: peId };
    }

    if (existing && seq != null && existing.seq != null) {
      if (seq < existing.seq || (seq === existing.seq && sourceType === 'pw' && existing.sourceType === 'ac')) {
        const reason = seq < existing.seq ? 'stale-sequence' : 'local-ac-preferred';
        const reject = {
          kind: 'rejected-learn',
          ts,
          pe: peId,
          mac,
          vlan,
          vsi,
          source,
          sourceType,
          seq,
          currentSeq: existing.seq,
          reason,
        };
        this.rejects.push(reject);
        return { ...reject, accepted: false, key };
      }
    }

    const entry = {
      pe: peId,
      mac,
      vlan,
      vsi,
      source,
      sourceType,
      seq,
      learnedAt: ts,
      lastSeenAt: ts,
      stale: false,
    };

    if (seq != null && (!existing || (existing.seq ?? -1) < seq)) {
      entry.authoritative = true;
    } else if (seq != null && existing && existing.seq === seq && sourceType === 'ac') {
      entry.authoritative = true;
    } else if (seq == null && (!existing || existing.seq == null)) {
      entry.authoritative = true;
    } else {
      entry.authoritative = false;
      entry.stale = true;
      const reject = {
        kind: 'rejected-learn',
        ts,
        pe: peId,
        mac,
        vlan,
        vsi,
        source,
        sourceType,
        seq,
        currentSeq: existing?.seq ?? null,
        reason: 'superseded-plain-learn',
      };
      this.rejects.push(reject);
    }

    table.set(key, entry);
    return { kind: 'learn', accepted: true, key, entry };
  }

  withdraw(event) {
    const messageId = event.messageId ??
      `withdraw|${event.from ?? '*'}|to-${event.target ?? 'all'}|${event.mac}|${event.vlan ?? 'any'}|${event.vsi ?? this.topology.vsi}|${event.seq ?? ''}`;
    if (this.seenMessages.has(messageId)) {
      return { kind: 'duplicate', accepted: false, reason: 'duplicate-withdrawal', messageId };
    }
    this.seenMessages.set(messageId, event.ts);

    const mac = normalizeMac(event.mac);
    const vlan = event.vlan ?? this.topology.vlan;
    const vsi = event.vsi ?? this.topology.vsi;
    const seq = event.seq ?? null;
    const results = [];
    const targetPes = event.target ? [event.target] : [...this.tables.keys()];

    for (const peId of targetPes) {
      const table = this._table(peId);
      for (const [key, entry] of table) {
        if (entry.mac !== mac || entry.vsi !== vsi) continue;
        if (vlan != null && entry.vlan != null && entry.vlan !== vlan) continue;
        if (seq != null && entry.seq != null && entry.seq > seq) {
          results.push({ pe: peId, key, removed: false, reason: 'newer-binding-exists' });
          continue;
        }
        table.delete(key);
        results.push({ pe: peId, key, removed: true });
      }
    }

    return { kind: 'withdraw', accepted: true, messageId, results };
  }

  flush(event) {
    const messageId = event.messageId ??
      `flush|${event.pe ?? '*'}|${event.mac ?? '*'}|${event.vlan ?? 'any'}|${event.vsi ?? this.topology.vsi}`;
    if (this.seenMessages.has(messageId)) {
      return { kind: 'duplicate', accepted: false, reason: 'duplicate-flush', messageId };
    }
    this.seenMessages.set(messageId, event.ts);

    const table = this._table(event.pe);
    const mac = event.mac ? normalizeMac(event.mac) : null;
    const vlan = event.vlan ?? null;
    const vsi = event.vsi ?? this.topology.vsi;
    const results = [];

    const seq = event.seq ?? null;
    for (const [key, entry] of table) {
      if (entry.vsi !== vsi) continue;
      if (mac && entry.mac !== mac) continue;
      if (vlan != null && entry.vlan != null && entry.vlan !== vlan) continue;
      if (seq != null && entry.seq != null && entry.seq > seq) {
        results.push({ pe: event.pe, key, removed: false, reason: 'newer-binding-exists' });
        continue;
      }
      table.delete(key);
      results.push({ pe: event.pe, key, removed: true });
    }

    return { kind: 'flush', accepted: true, messageId, results };
  }

  age(event) {
    const table = this._table(event.pe);
    const mac = event.mac ? normalizeMac(event.mac) : null;
    const key = this._entryKey(mac, event.vlan ?? this.topology.vlan, event.vsi ?? this.topology.vsi);
    const entry = table.get(key);
    if (!entry) return { kind: 'age', removed: false, reason: 'no-binding', key };
    table.delete(key);
    return { kind: 'age', removed: true, key };
  }

  lookup(peId, mac, vlan, vsi) {
    const key = this._entryKey(mac, vlan, vsi);
    return this._table(peId).get(key) ?? null;
  }

  allEntries(peId) {
    return peId ? [...this._table(peId).values()] :
      [...this.tables.values()].flatMap((table) => [...table.values()]);
  }

  snapshot() {
    const out = {};
    for (const [peId, table] of this.tables) {
      out[peId] = [...table.values()].map((entry) => ({ ...entry }));
    }
    return out;
  }
}
