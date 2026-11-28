import test from 'node:test';
import assert from 'node:assert/strict';
import { simulate } from '../src/simulator.js';

const MAC = '00:aa:bb:cc:dd:01';

function topology() {
  return {
    name: 'mobility-events',
    vsi: 'VSI-200',
    vlan: 200,
    pes: [
      { id: 'PE1', acs: ['PE1-AC'] },
      { id: 'PE2', acs: ['PE2-AC'] },
    ],
    pws: [{ id: 'PW-1-2', endpoints: ['PE1', 'PE2'] }],
  };
}

test('MAC 快速回迁：新序号绑定保留，乱序到达的旧 withdrawal 不删除新绑定', () => {
  const scenario = {
    ...topology(),
    events: [
      { ts: 1, type: 'learn', pe: 'PE1', mac: MAC, source: 'PE1-AC', sourceType: 'ac', seq: 1 },
      { ts: 2, type: 'learn', pe: 'PE2', mac: MAC, source: 'PW-1-2', sourceType: 'pw', seq: 1 },
      { ts: 2, type: 'learn', pe: 'PE2', mac: MAC, source: 'PE2-AC', sourceType: 'ac', seq: 2 },
      { ts: 3, type: 'learn', pe: 'PE1', mac: MAC, source: 'PE1-AC', sourceType: 'ac', seq: 3 },
      { ts: 4, type: 'withdraw', from: 'PE2', target: 'PE1', mac: MAC, seq: 2 },
      { ts: 4, type: 'learn', pe: 'PE2', mac: MAC, source: 'PW-1-2', sourceType: 'pw', seq: 3 },
      {
        ts: 5,
        type: 'traffic',
        pe: 'PE2',
        dstMac: MAC,
        ingressPort: 'PE2-AC',
      },
    ],
  };

  const report = simulate(scenario);
  const finalSlice = report.timeslices.at(-1);
  const pe1Entry = finalSlice.bindings.PE1[0];
  assert.equal(pe1Entry.seq, 3);
  assert.equal(pe1Entry.source, 'PE1-AC');

  const frame = finalSlice.frames[0];
  assert.equal(frame.result, 'delivered');
  assert.equal(frame.path[0].pe, 'PE2');
  assert.equal(frame.path.at(-1).pe, 'PE1');
});

test('flush 乱序：旧序号 flush 不能删除更高序号的新绑定', () => {
  const scenario = {
    ...topology(),
    events: [
      { ts: 1, type: 'learn', pe: 'PE1', mac: MAC, source: 'PE1-AC', sourceType: 'ac', seq: 1 },
      { ts: 2, type: 'learn', pe: 'PE2', mac: MAC, source: 'PE2-AC', sourceType: 'ac', seq: 2 },
      { ts: 3, type: 'learn', pe: 'PE1', mac: MAC, source: 'PE1-AC', sourceType: 'ac', seq: 3 },
      { ts: 4, type: 'flush', pe: 'PE1', mac: MAC, seq: 2, messageId: 'late-flush' },
    ],
  };

  const report = simulate(scenario);
  const finalSlice = report.timeslices.at(-1);
  assert.equal(finalSlice.bindings.PE1.length, 1);
  assert.equal(finalSlice.bindings.PE1[0].seq, 3);

  const flushEvent = finalSlice.events.find((event) => event.kind === 'flush');
  assert.deepEqual(flushEvent.results[0].removed, false);
  assert.equal(flushEvent.results[0].reason, 'newer-binding-exists');
});

test('旧 PE 晚学习：低序号的重复学习被拒绝并记录原因', () => {
  const scenario = {
    ...topology(),
    events: [
      { ts: 1, type: 'learn', pe: 'PE1', mac: MAC, source: 'PE1-AC', sourceType: 'ac', seq: 1 },
      { ts: 2, type: 'learn', pe: 'PE2', mac: MAC, source: 'PW-1-2', sourceType: 'pw', seq: 1 },
      { ts: 3, type: 'learn', pe: 'PE2', mac: MAC, source: 'PE2-AC', sourceType: 'ac', seq: 2 },
      { ts: 4, type: 'learn', pe: 'PE2', mac: MAC, source: 'PW-1-2', sourceType: 'pw', seq: 1 },
    ],
  };

  const report = simulate(scenario);
  const reject = report.findings.rejectedLearns.find((item) => item.pe === 'PE2');
  assert.ok(reject);
  assert.equal(reject.reason, 'stale-sequence');

  const finalEntry = report.timeslices.at(-1).bindings.PE2[0];
  assert.equal(finalEntry.seq, 2);
  assert.equal(finalEntry.source, 'PE2-AC');
});

test('老化：显式 age 事件移除绑定，后续流量转为未知单播', () => {
  const scenario = {
    ...topology(),
    config: { broadcastPwLimit: 5 },
    events: [
      { ts: 1, type: 'learn', pe: 'PE1', mac: MAC, source: 'PE1-AC', sourceType: 'ac' },
      { ts: 2, type: 'learn', pe: 'PE2', mac: MAC, source: 'PW-1-2', sourceType: 'pw' },
      { ts: 3, type: 'age', pe: 'PE2', mac: MAC },
      {
        ts: 4,
        type: 'traffic',
        pe: 'PE2',
        dstMac: MAC,
        ingressPort: 'PE2-AC',
      },
    ],
  };

  const report = simulate(scenario);
  assert.equal(report.timeslices.find((slice) => slice.ts === 3).bindings.PE2.length, 0);

  const frame = report.timeslices.at(-1).frames[0];
  assert.equal(frame.result, 'flooded-unknown-unicast');
  assert.deepEqual(frame.floods[0].reason, 'no-binding');
});
