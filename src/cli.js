#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { simulate } from './simulator.js';

async function main() {
  const input = process.argv[2];
  if (!input) {
    console.error('用法: vpls-mac-validator <scenario.json>');
    console.error('该工具只做离线离散事件仿真，不会发送任何真实以太网帧或 PW 控制消息。');
    process.exit(2);
  }

  const raw = await readFile(resolve(input), 'utf8');
  const scenario = JSON.parse(raw);
  const report = simulate(scenario);

  console.log(JSON.stringify(report, null, 2));

  const { findings } = report;
  const problemCount = findings.wrongPws.length +
    findings.loops.length +
    findings.staleBindings.length +
    findings.rejectedLearns.length +
    findings.suppressed.length;
  process.exit(problemCount > 0 ? 2 : 0);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(2);
});
