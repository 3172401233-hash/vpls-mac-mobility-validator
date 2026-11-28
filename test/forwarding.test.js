import test from 'node:test';
import assert from 'node:assert/strict';
import { simulate } from '../src/simulator.js';

const MAC = '00:00:00:00:00:aa';
const BCAST = 'ff:ff:ff:ff:ff:ff';

function ringTopology() {
  return {
    name: 'ring',
    vsi: 'VSI-300',
    vlan: 300,
    config: { broadcastPwLimit: 1, maxHops: 6 },
    pes: [
      { id: 'PE1', acs: ['PE1-AC'] },
      { id: 'PE2', acs: ['PE2-AC'] },
      { id: 'PE3', acs: ['PE3-AC'] },
    ],
    pws: [
      { id: 'PW-1-2', endpoints: ['PE1', 'PE2'] },
      { id: 'PW-2-3', endpoints: ['PE2', 'PE3'] },
      { id: 'PW-1-3', endpoints: ['PE1', 'PE3'] },
    ],
  };
}

test('广播抑制：同一 PW 上超过阈值的 BUM 副本被丢弃并记录', () => {
  const scenario = {
    ...ringTopology(),
    events: [
      { ts: 1, type: 'traffic', pe: 'PE1', dstMac: BCAST, ingressPort: 'PE1-AC' },
      { ts: 2, type: 'traffic', pe: 'PE1', dstMac: BCAST, ingressPort: 'PE1-AC' },
      { ts: 3, type: 'traffic', pe: 'PE1', dstMac: BCAST, ingressPort: 'PE1-AC' },
    ],
  };

  const report = simulate(scenario);
  assert.ok(report.findings.suppressed.length > 0);
  const suppressedPw = report.findings.suppressed[0];
  assert.equal(suppressedPw.limit, 1);
  assert.ok(['PW-1-2', 'PW-1-3'].includes(suppressedPw.port));
});

test('未知单播：无绑定流量在 VPLS 内泛洪，且 PW 入方向不再向 PW 泛洪', () => {
  const scenario = {
    ...ringTopology(),
    config: { broadcastPwLimit: 10 },
    events: [
      { ts: 1, type: 'traffic', pe: 'PE1', dstMac: MAC, ingressPort: 'PE1-AC' },
    ],
  };

  const report = simulate(scenario);
  const frame = report.timeslices[0].frames[0];
  assert.equal(frame.result, 'flooded-unknown-unicast');
  const acHops = frame.path.filter((hop) => hop.outType === 'ac');
  assert.deepEqual(acHops.map((hop) => hop.pe).sort(), ['PE2', 'PE3']);
  const pwHops = frame.path.filter((hop) => hop.outType === 'pw');
  assert.equal(pwHops.length, 2);
});

test('水平分割：PW 入方向的已知单播若再指向另一条 PW，输出环路证据', () => {
  const scenario = {
    ...ringTopology(),
    config: { broadcastPwLimit: 10 },
    events: [
      { ts: 1, type: 'learn', pe: 'PE1', mac: MAC, source: 'PW-1-3', sourceType: 'pw' },
      { ts: 2, type: 'learn', pe: 'PE3', mac: MAC, source: 'PW-2-3', sourceType: 'pw' },
      {
        ts: 3,
        type: 'traffic',
        pe: 'PE1',
        dstMac: MAC,
        ingressPort: 'PW-1-2',
        ingressType: 'pw',
      },
    ],
  };

  const report = simulate(scenario);
  const frame = report.timeslices.at(-1).frames[0];
  assert.equal(frame.result, 'loop');
  assert.ok(frame.loops.some((loop) => loop.type === 'split-horizon-violation'));
});

test('AC down：绑定指向关闭的 AC 时流量黑洞', () => {
  const scenario = {
    name: 'ac-down',
    vsi: 'VSI-400',
    vlan: 400,
    pes: [
      { id: 'PE1', acs: ['PE1-AC'] },
      { id: 'PE2', acs: [{ id: 'PE2-AC', up: false }] },
    ],
    pws: [{ id: 'PW-1-2', endpoints: ['PE1', 'PE2'] }],
    events: [
      { ts: 1, type: 'learn', pe: 'PE2', mac: MAC, source: 'PE2-AC', sourceType: 'ac' },
      { ts: 2, type: 'learn', pe: 'PE1', mac: MAC, source: 'PW-1-2', sourceType: 'pw' },
      { ts: 3, type: 'traffic', pe: 'PE1', dstMac: MAC, ingressPort: 'PE1-AC' },
    ],
  };

  const report = simulate(scenario);
  const frame = report.timeslices.at(-1).frames[0];
  assert.equal(frame.result, 'blackhole');
  assert.equal(report.findings.blackholes[0].dstMac, MAC);
});
