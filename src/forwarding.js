import { isBroadcastMac, normalizeMac } from './topology.js';

export function forwardFrame(traffic, topology, mobility, ts, config, suppressionState) {
  const ingressPe = topology.pe(traffic.pe);
  const vlan = traffic.vlan ?? topology.vlan;
  const vsi = traffic.vsi ?? topology.vsi;
  const dstMac = normalizeMac(traffic.dstMac);
  const srcMac = traffic.srcMac ? normalizeMac(traffic.srcMac) : null;
  const ingressPort = traffic.ingressPort ?? ingressPe.acs[0].id;
  const ingressType = traffic.ingressType ?? (topology.pwById.has(ingressPort) ? 'pw' : 'ac');
  const maxHops = config.maxHops ?? 8;
  const bcastLimit = config.broadcastPwLimit ?? config.floodPwLimit ?? 3;
  const suppressionCounters = suppressionState.counters;
  const suppressed = suppressionState.records;

  const trace = {
    ts,
    vsi,
    vlan,
    srcMac,
    dstMac,
    ingressPe: ingressPe.id,
    ingressPort,
    ingressType,
    path: [],
    loops: [],
    floods: [],
    suppressed: [],
    result: 'delivered',
  };

  const markSuppressed = (peId, portId) => {
    const counterKey = `${peId}|${portId}`;
    const count = (suppressionCounters.get(counterKey) ?? 0) + 1;
    suppressionCounters.set(counterKey, count);
    if (count > bcastLimit) {
      const record = { ts, pe: peId, port: portId, count, limit: bcastLimit };
      suppressed.push(record);
      trace.suppressed.push(record);
      return true;
    }
    return false;
  };

  const findAc = (peId, portId) => topology.pe(peId).acs.find((ac) => ac.id === portId);

  const deliverToAc = (peId, portId, kind) => {
    const ac = findAc(peId, portId);
    if (!ac || ac.up === false) return { delivered: false, reason: 'ac-down' };
    if (!topology.vlanMatches(ac.vlan, vlan)) return { delivered: false, reason: 'vlan-mismatch' };
    trace.path.push({ pe: peId, outPort: portId, outType: 'ac', kind });
    return { delivered: true };
  };

  const flood = (startPeId, startPort, startPortType, frameKind, seenAcSet) => {
    const queue = [{ pe: startPeId, inPort: startPort, inType: startPortType, depth: 0 }];
    const visited = new Set();
    let deliveredAny = false;

    while (queue.length > 0) {
      const hop = queue.shift();
      const visitKey = `${hop.pe}|${hop.inPort}`;
      if (visited.has(visitKey)) continue;
      visited.add(visitKey);

      for (const ac of topology.pe(hop.pe).acs) {
        if (ac.id === hop.inPort) continue;
        const acKey = `${hop.pe}|${ac.id}`;
        if (seenAcSet.has(acKey)) continue;
        const outcome = deliverToAc(hop.pe, ac.id, frameKind);
        seenAcSet.add(acKey);
        if (outcome.delivered) deliveredAny = true;
      }

      for (const pw of topology.pwsOf(hop.pe)) {
        if (hop.inType === 'pw' && pw.id === hop.inPort) continue;
        if (hop.inType === 'pw') {
          trace.loops.push({
            type: 'split-horizon-violation',
            ts,
            pe: hop.pe,
            inPort: hop.inPort,
            outPort: pw.id,
            mac: dstMac,
          });
          continue;
        }
        if (hop.depth >= maxHops) continue;
        if (markSuppressed(hop.pe, pw.id)) continue;
        const remotePe = topology.remotePeOf(pw.id, hop.pe);
        trace.path.push({ pe: hop.pe, outPort: pw.id, outType: 'pw', kind: frameKind });
        queue.push({ pe: remotePe, inPort: pw.id, inType: 'pw', depth: hop.depth + 1 });
      }
    }
    return deliveredAny;
  };

  if (isBroadcastMac(dstMac)) {
    const seenAc = new Set();
    const delivered = flood(ingressPe.id, ingressPort, ingressType, 'broadcast', seenAc);
    trace.result = delivered ? 'flooded' : (suppressed.length > 0 ? 'suppressed' : 'blackhole');
    return trace;
  }

  const pathPeSet = new Set([ingressPe.id]);
  let currentPe = ingressPe.id;
  let inPort = ingressPort;
  let inType = ingressType;

  for (let hops = 0; hops <= maxHops; hops += 1) {
    const entry = mobility.lookup(currentPe, dstMac, vlan, vsi);
    if (!entry) {
      const seenAc = new Set([`${currentPe}|${inPort}`]);
      const delivered = flood(currentPe, inPort, inType, 'unknown-unicast', seenAc);
      trace.floods.push({ ts, pe: currentPe, mac: dstMac, reason: 'no-binding' });
      trace.result = delivered ? 'flooded-unknown-unicast' : (suppressed.length > 0 ? 'suppressed' : 'blackhole');
      return trace;
    }

    if (entry.source === inPort) {
      const loopType = inType === 'pw' ? 'pw-hairpin' : 'ac-hairpin';
      trace.loops.push({
        type: loopType,
        ts,
        pe: currentPe,
        port: inPort,
        mac: dstMac,
        binding: { source: entry.source, sourceType: entry.sourceType, seq: entry.seq },
      });
      if (inType === 'pw') {
        const seenAc = new Set([`${currentPe}|${inPort}`]);
        flood(currentPe, inPort, inType, 'stale-hairpin-flood', seenAc);
      }
      trace.result = 'loop';
      return trace;
    }

    if (entry.sourceType === 'ac') {
      const outcome = deliverToAc(currentPe, entry.source, 'known-unicast');
      if (!outcome.delivered) {
        trace.result = outcome.reason === 'ac-down' ? 'blackhole' : outcome.reason;
      }
      return trace;
    }

    const pw = topology.pwById.get(entry.source);
    if (!pw) {
      trace.result = 'blackhole';
      return trace;
    }
    if (inType === 'pw') {
      trace.loops.push({
        type: 'split-horizon-violation',
        ts,
        pe: currentPe,
        inPort,
        outPort: pw.id,
        mac: dstMac,
      });
      trace.result = 'loop';
      return trace;
    }

    trace.path.push({ pe: currentPe, outPort: pw.id, outType: 'pw', kind: 'known-unicast' });
    const remotePe = topology.remotePeOf(pw.id, currentPe);
    if (pathPeSet.has(remotePe)) {
      trace.loops.push({
        type: 'pe-revisit',
        ts,
        pe: remotePe,
        mac: dstMac,
        path: trace.path.map((hop) => `${hop.pe}:${hop.outPort}`),
      });
      trace.result = 'loop';
      return trace;
    }
    pathPeSet.add(remotePe);
    currentPe = remotePe;
    inPort = pw.id;
    inType = 'pw';
  }

  trace.result = 'ttl-expired';
  return trace;
}
