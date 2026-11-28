# vpls-mac-mobility-validator

VPLS（Virtual Private LAN Service）MAC mobility 离线校验器。

虚拟机从一个 PE 迁移到另一个 PE 后，如果 MAC withdrawal / flush 与远端学习事件的到达顺序不同，旧 PE 可能仍把目的 MAC 指向旧伪线（PW），导致流量持续绕行、PW 发夹甚至二层环路。本工具把 PW、VSI、VLAN、MAC 学习、withdrawal、flush、老化和流量抽象成**离散事件**，按时间片逐步推演 MAC 归属和转发路径，并输出错误 PW、环路证据和需要刷新的节点。

## 安全说明

本项目是**纯离线仿真器**：

- 不创建、发送或接收任何真实以太网帧、MPLS 报文或 LDP/BGP 控制消息；
- 不打开 raw socket、不绑定网卡、不访问网络设备；
- 不依赖任何第三方包，只用 Node.js 内置模块处理内存中的数据结构。

所有“帧转发”“withdrawal”“flush”都只是在内存表上模拟状态变化，可安全在任意环境运行。

## 运行环境

- Node.js `24.16.0`（`engines` 字段要求 `>=24.16.0`）
- 零运行时依赖

## 快速开始

```bash
node src/cli.js examples/migration-scenario.json
echo $?   # 0=已收敛无问题；2=发现问题或输入错误
npm test  # 等价于 node --test
```

## 场景输入格式

场景是一个 JSON 文件，由拓扑、配置和按 `ts`（时间片）排序的事件数组组成。

```json
{
  "name": "scenario-name",
  "vsi": "VSI-100",
  "vlan": 100,
  "config": { "maxHops": 8, "broadcastPwLimit": 3, "ageOutSlices": 30 },
  "pes": [
    { "id": "PE1", "acs": ["PE1-AC"] },
    { "id": "PE2", "acs": [{ "id": "PE2-AC", "up": true, "vlan": 100 }] }
  ],
  "pws": [
    { "id": "PW-1-2", "endpoints": ["PE1", "PE2"] }
  ],
  "events": [ { "ts": 1, "type": "learn", "pe": "PE1", "mac": "00:11:22:33:44:55" } ]
}
```

### 事件类型

| `type` | 关键字段 | 含义 |
| --- | --- | --- |
| `learn` | `pe`、`mac`、`source`、`sourceType`(`ac`/`pw`)、`seq` | 本地或远端 MAC 学习；带 `seq` 时按 mobility 序号裁决，低序号/同序号 PW 学习被拒绝 |
| `withdraw` | `from`、`target`、`mac`、`seq`、`messageId` | MAC withdrawal，删除目的 PE 上序号不高于 `seq` 的绑定；同 `messageId` 幂等去重 |
| `flush` | `pe`、可选 `mac`/`vlan`、`seq`、`messageId` | 清空 PE 上匹配的 MAC 表项；高序号绑定受保护；重复 `messageId` 只生效一次 |
| `age` | `pe`、`mac` | 模拟老化定时器到期，删除单条绑定 |
| `traffic` | `pe`、`dstMac`、`srcMac`、`ingressPort`、`ingressType` | 注入一帧并推演转发路径；`ff:ff:ff:ff:ff:ff` 表示广播 |

同一 `ts` 内事件按数组顺序处理，可通过可选 `order` 字段显式排序，用于复现 flush/withdrawal 乱序。

## 校验逻辑

- **MAC 归属裁决**：本地 AC 学习优先于远端 PW 学习；带序号的学习按序号递增接受，旧 PE 的低序号晚学习被拒绝并记入 `rejectedLearns`。
- **错误 PW**：某 PE 上的 PW 绑定无法到达 MAC 的权威属主 PE（例如仍指向旧伪线）时，写入 `findings.wrongPws`。
- **环路证据**：
  - `pw-hairpin`：帧从某 PW 进入，该 MAC 的出接口又是同一条 PW；
  - `split-horizon-violation`：PW 入方向流量再向另一条 PW 转发，违反 VPLS 水平分割；
  - `pe-revisit`：转发路径中同一 PE 被二次访问。
- **未知单播**：无匹配绑定时在 VPLS 内泛洪，PW 入方向遵守水平分割不再向 PW 泛洪。
- **广播抑制**：同一 PW 上超过 `broadcastPwLimit` 的 BUM 副本被抑制，记录到 `findings.suppressed`，计数器跨时间片累计。
- **重复 flush / withdrawal**：按 `messageId` 幂等去重，重复事件进入 `findings.duplicateEvents`。
- **待刷新节点**：所有持有过期绑定的 PE 汇总到 `nodesToRefresh`，附 MAC、错误出接口和原因，可直接映射为需要重新下发 flush 的设备清单。

## 输出结构

`simulate(scenario)`（`src/simulator.js`）返回报告对象，CLI 将其打印为 JSON：

- `timeslices[]`：每个时间片处理后的事件结果、流量路径 `frames[]` 和全量 MAC 绑定快照 `bindings`；
- `authority[]`：每个 MAC 当前的权威属主 PE 与出接口；
- `findings`：`wrongPws`、`loops`、`staleBindings`、`suppressed`、`rejectedLearns`、`blackholes`、`duplicateEvents`；
- `nodesToRefresh[]`：需要刷新 MAC 表的 PE 及具体表项；
- `converged` / `convergenceTs`：是否已收敛（无错误 PW、无过期绑定、无环路、无被拒绝学习）。

## 目录结构

```
src/
  topology.js    # PE/AC/PW 拓扑与 MAC 规范化
  mobility.js    # MAC 学习、withdrawal、flush、老化与序号裁决
  forwarding.js  # 已知/未知单播、广播泛洪、环路与抑制判定
  simulator.js   # 时间片调度、快照与报告聚合
  cli.js         # JSON 输入 -> JSON 报告
examples/
  migration-scenario.json
test/
  migration.test.js
  mobility-events.test.js
  forwarding.test.js
  cli.test.js
```

## 测试覆盖

`node --test` 覆盖以下场景：

- 正常 VM 迁移与 withdrawal 收敛；
- 旧 PE 晚学习、错误 PW 与 PW 发夹环路；
- MAC 快速回迁（更高序号绑定不被乱序的旧 withdrawal 删除）；
- flush 乱序与重复 flush / withdrawal 幂等；
- 低序号晚学习拒绝、显式老化、未知单播泛洪；
- 广播抑制、水平分割违规、AC down 黑洞与 CLI 退出码。
