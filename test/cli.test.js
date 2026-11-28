import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, '../src/cli.js');
const scenario = resolve(here, '../examples/migration-scenario.json');

test('CLI 输出 JSON 报告，并以退出码 2 报告发现的问题', () => {
  const run = spawnSync(process.execPath, [cli, scenario], { encoding: 'utf8' });
  assert.equal(run.status, 2);

  const report = JSON.parse(run.stdout);
  assert.equal(report.vsi, 'VSI-100');
  assert.ok(report.findings.loops.some((loop) => loop.type === 'pw-hairpin'));
  assert.ok(report.findings.wrongPws.some((item) => item.pw === 'PW-1-2'));
  assert.ok(report.findings.duplicateEvents.some((item) => item.reason === 'duplicate-flush'));
  assert.ok(report.findings.duplicateEvents.some((item) => item.reason === 'duplicate-withdrawal'));
  assert.ok(report.nodesToRefresh.some((node) => node.pe === 'PE1'));
});

test('CLI 缺少参数时退出码为 2 并打印用法', () => {
  const run = spawnSync(process.execPath, [cli], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /离线离散事件仿真/);
});
