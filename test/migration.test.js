import test from 'node:test';
import assert from 'node:assert/strict';
import { simulate } from '../src/simulator.js';

const MAC = '00:11:22:33:44:55';

function baseTopology() {
  return {
    name: 'base',
    vsi: 'VSI-100',
    vlan: 100,
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

test('正常迁移：withdrawal 收敛后无错误 PW、无环路', () => {
  const scenario = {
    ...baseTopology(),
    events: [
      { ts: 1, type: 'learn', pe: 'PE1', mac: MAC, source: 'PE1-AC', sourceType: 'ac', seq: 0 },
      { ts: 2, type: 'learn', pe: 'PE2', mac: MAC, source: 'PW-1-2', sourceType: 'pw', seq: 0 },
      { ts: 3, type: 'learn', pe: 'PE3', mac: MAC, source: 'PW-1-3', sourceType: 'pw', seq: 0 },
      { ts: 4, type: 'learn', pe: 'PE3', mac: MAC, source: 'PE3-AC', sourceType: 'ac', seq: 1 },
      { ts: 5, type: 'withdraw', from: 'PE3', target: 'PE1', mac: MAC, seq: 1 },
      { ts: 5, type: 'withdraw', from: 'PE3', target: 'PE2', mac: MAC, seq: 1 },
      { ts: 6, type: 'learn', pe: 'PE1', mac: MAC, source: 'PW-1-3', sourceType: 'pw', seq: 1 },
      { ts: 6, type: 'learn', pe: 'PE2', mac: MAC, source: 'PW-2-3', sourceType: 'pw', seq: 1 },
      {
        ts: 7,
        type: 'traffic',
        pe: 'PE2',
        dstMac: MAC,
        ingressPort: 'PE2-AC',
      },
    ],
  };

  const report = simulate(scenario);
  assert.equal(report.converged, true);
  assert.equal(report.findings.loops.length, 0);
  assert.equal(report.findings.wrongPws.length, 0);

  const frame = report.timeslices.at(-1).frames[0];
  assert.equal(frame.result, 'delivered');
  assert.deepEqual(frame.path.at(-1), { pe: 'PE3', outPort: 'PE3-AC', outType: 'ac', kind: 'known-unicast' });
});

test('旧 PE 晚学习：旧 PE 仍指向旧伪线，输出错误 PW 与 PW 发夹环路', () => {
  const scenario = {
    ...baseTopology(),
    config: { broadcastPwLimit: 5 },
    events: [
      { ts: 1, type: 'learn', pe: 'PE1', mac: MAC, source: 'PE1-AC', sourceType: 'ac', seq: 0 },
      { ts: 2, type: 'learn', pe: 'PE2', mac: MAC, source: 'PW-1-2', sourceType: 'pw', seq: 0 },
      { ts: 3, type: 'learn', pe: 'PE3', mac: MAC, source: 'PW-1-3', sourceType: 'pw', seq: 0 },
      { ts: 4, type: 'learn', pe: 'PE3', mac: MAC, source: 'PE3-AC', sourceType: 'ac', seq: 1 },
      { ts: 5, type: 'withdraw', from: 'PE3', target: 'PE1', mac: MAC, seq: 1 },
      { ts: 5, type: 'flush', pe: 'PE1', mac: MAC, seq: 1, messageId: 'old-pe-flush' },
      { ts: 7, type: 'learn', pe: 'PE1', mac: MAC, source: 'PW-1-2', sourceType: 'pw' },
      {
        ts: 8,
        type: 'traffic',
        pe: 'PE2',
        dstMac: MAC,
        ingressPort: 'PE2-AC',
      },
    ],
  };

  const report = simulate(scenario);
  assert.equal(report.converged, false);

  const staleOnOldPe = report.findings.staleBindings.find((item) => item.pe === 'PE1' && item.reason === 'old-pe-late-learn');
  assert.ok(staleOnOldPe, '应识别旧 PE 晚学习产生的过期绑定');

  const wrongPw = report.findings.wrongPws.find((item) => item.pe === 'PE1' && item.pw === 'PW-1-2');
  assert.ok(wrongPw, '应输出仍指向旧伪线 PW-1-2 的错误 PW');

  const frame = report.timeslices.find((slice) => slice.ts === 8).frames[0];
  assert.equal(frame.result, 'loop');
  assert.ok(frame.loops.some((loop) => loop.type === 'pw-hairpin'));
  assert.equal(frame.loops[0].pe, 'PE1');

  const refreshNodes = report.nodesToRefresh.map((node) => node.pe);
  assert.ok(refreshNodes.includes('PE1'));
  assert.ok(refreshNodes.includes('PE2'));
});

test('重复 flush 与重复 withdrawal 被幂等去重', () => {
  const scenario = {
    ...baseTopology(),
    events: [
      { ts: 1, type: 'learn', pe: 'PE1', mac: MAC, source: 'PE1-AC', sourceType: 'ac', seq: 0 },
      { ts: 2, type: 'learn', pe: 'PE2', mac: MAC, source: 'PW-1-2', sourceType: 'pw', seq: 0 },
      { ts: 3, type: 'flush', pe: 'PE2', mac: MAC, messageId: 'flush-x' },
      { ts: 3, type: 'flush', pe: 'PE2', mac: MAC, messageId: 'flush-x' },
      { ts: 4, type: 'withdraw', from: 'PE1', target: 'PE2', mac: MAC, messageId: 'w-x', seq: 1 },
      { ts: 4, type: 'withdraw', from: 'PE1', target: 'PE2', mac: MAC, messageId: 'w-x', seq: 1 },
    ],
  };

  const report = simulate(scenario);
  assert.equal(report.findings.duplicateEvents.length, 2);
  assert.deepEqual(
    report.findings.duplicateEvents.map((item) => item.reason).sort(),
    ['duplicate-flush', 'duplicate-withdrawal'],
  );

  const slice3 = report.timeslices.find((slice) => slice.ts === 3);
  const flushResults = slice3.events.filter((event) => event.messageId === 'flush-x');
  assert.equal(flushResults[0].accepted, true);
  assert.equal(flushResults[1].accepted, false);
});
