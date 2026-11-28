import { buildTopology, normalizeMac } from './topology.js';
import { MobilityPlane } from './mobility.js';
import { forwardFrame } from './forwarding.js';

function groupEventsBySlice(events) {
  const slices = new Map();
  for (const event of events) {
    const ts = event.ts ?? 0;
    if (!slices.has(ts)) slices.set(ts, []);
    slices.get(ts).push(event);
  }
  return [...slices.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ts, items]) => [ts, [...items].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))]);
}

export function simulate(scenario) {
  const topology = buildTopology(scenario);
  const mobility = new MobilityPlane(topology);
  const config = scenario.config ?? {};
  const ageOut = config.ageOutSlices ?? null;
  const suppressionState = { counters: new Map(), records: [] };

  const timeslices = [];
  const findings = {
    wrongPws: [],
    loops: [],
    staleBindings: [],
    suppressed: [],
    rejectedLearns: [],
    blackholes: [],
    duplicateEvents: [],
  };

  const recordDuplicate = (event, result) => {
    findings.duplicateEvents.push({
      ts: event.ts,
      type: result.messageId?.startsWith('withdraw') ? 'withdrawal' : 'flush',
      messageId: result.messageId,
      reason: result.reason,
    });
  };

  for (const [ts, events] of groupEventsBySlice(scenario.events ?? [])) {
    const sliceReport = { ts, events: [], frames: [] };

    for (const event of events) {
      switch (event.type) {
        case 'learn': {
          const result = mobility.learn({ ...event, pe: event.pe ?? event.from, ts });
          sliceReport.events.push(result);
          if (!result.accepted && result.reason && result.reason !== 'duplicate-learn') {
            findings.rejectedLearns.push(result);
          }
          break;
        }
        case 'withdraw': {
          const result = mobility.withdraw({ ...event, ts });
          sliceReport.events.push(result);
          if (!result.accepted) recordDuplicate(event, result);
          break;
        }
        case 'flush': {
          const result = mobility.flush({ ...event, ts });
          sliceReport.events.push(result);
          if (!result.accepted) recordDuplicate(event, result);
          break;
        }
        case 'age': {
          sliceReport.events.push(mobility.age({ ...event, ts }));
          break;
        }
        case 'traffic': {
          const trace = forwardFrame({ ...event, ts }, topology, mobility, ts, config, suppressionState);
          sliceReport.frames.push(trace);
          if (trace.loops.length > 0) findings.loops.push(...trace.loops);
          if (trace.suppressed.length > 0) findings.suppressed.push(...trace.suppressed);
          if (trace.result === 'blackhole') findings.blackholes.push({ ts, pe: trace.ingressPe, dstMac: trace.dstMac });
          break;
        }
        default:
          throw new Error(`未知事件类型: ${event.type}`);
      }
    }

    if (ageOut != null) {
      for (const entry of mobility.allEntries()) {
        if (ts - entry.lastSeenAt >= ageOut) {
          mobility.age({ pe: entry.pe, mac: entry.mac, vlan: entry.vlan, vsi: entry.vsi, ts });
        }
      }
    }

    timeslices.push({ ...sliceReport, bindings: mobility.snapshot() });
  }

  const authority = new Map();
  for (const entry of mobility.allEntries()) {
    if (!entry.authoritative) continue;
    const key = `${entry.vsi}|${entry.vlan ?? 'any'}|${entry.mac}`;
    const current = authority.get(key);
    if (!current) {
      authority.set(key, entry);
      continue;
    }
    const currentLocal = current.sourceType === 'ac' ? 1 : 0;
    const entryLocal = entry.sourceType === 'ac' ? 1 : 0;
    if (entryLocal > currentLocal ||
      (entryLocal === currentLocal && (entry.seq ?? -1) > (current.seq ?? -1))) {
      authority.set(key, entry);
    }
  }

  const refreshByNode = new Map();
  const markRefresh = (peId, entry, reason) => {
    if (!refreshByNode.has(peId)) refreshByNode.set(peId, []);
    refreshByNode.get(peId).push({
      mac: entry.mac,
      vlan: entry.vlan,
      vsi: entry.vsi,
      source: entry.source,
      sourceType: entry.sourceType,
      reason,
    });
  };

  for (const entry of mobility.allEntries()) {
    const key = `${entry.vsi}|${entry.vlan ?? 'any'}|${entry.mac}`;
    const owner = authority.get(key);
    let stale = false;
    let reason = null;

    if (owner) {
      if (entry.pe === owner.pe) {
        stale = entry.sourceType !== owner.sourceType || entry.source !== owner.source;
        reason = 'superseded-binding';
      } else if (entry.sourceType === 'pw') {
        const pointsToOwner = topology.remotePeOf(entry.source, entry.pe) === owner.pe;
        if (!pointsToOwner) {
          stale = true;
          reason = owner.seq != null && (entry.seq == null || entry.seq < owner.seq)
            ? 'old-pe-late-learn'
            : 'wrong-pw-binding';
        }
      } else {
        stale = true;
        reason = 'duplicate-local-ac-binding';
      }
    } else if (entry.stale) {
      stale = true;
      reason = 'superseded-binding';
    }

    if (!stale) continue;

    findings.staleBindings.push({
      pe: entry.pe,
      mac: entry.mac,
      vlan: entry.vlan,
      vsi: entry.vsi,
      source: entry.source,
      sourceType: entry.sourceType,
      seq: entry.seq,
      reason: reason ?? 'stale-binding',
    });
    markRefresh(entry.pe, entry, reason ?? 'stale-binding');

    if (entry.sourceType === 'pw') {
      findings.wrongPws.push({
        pe: entry.pe,
        pw: entry.source,
        mac: entry.mac,
        vlan: entry.vlan,
        vsi: entry.vsi,
        reason: reason ?? 'stale-pw-binding',
      });
    }
  }

  const nodesToRefresh = [...refreshByNode.entries()].map(([pe, bindings]) => ({ pe, bindings }));
  const hasLoop = findings.loops.length > 0;
  const converged = findings.wrongPws.length === 0 &&
    findings.staleBindings.length === 0 &&
    !hasLoop &&
    findings.rejectedLearns.length === 0;

  return {
    scenario: topology.name,
    vsi: topology.vsi,
    vlan: topology.vlan,
    topology: {
      pes: [...topology.peById.keys()],
      pws: [...topology.pwById.values()].map((pw) => ({ id: pw.id, endpoints: [pw.a, pw.b] })),
    },
    timeslices,
    authority: [...authority.entries()].map(([key, entry]) => ({ key, ownerPe: entry.pe, source: entry.source, seq: entry.seq })),
    findings,
    nodesToRefresh,
    converged,
    convergenceTs: converged ? timeslices[timeslices.length - 1]?.ts ?? null : null,
  };
}

export { normalizeMac };
