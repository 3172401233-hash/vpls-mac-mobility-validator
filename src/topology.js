const BROADCAST_MAC = 'ff:ff:ff:ff:ff:ff';

export function normalizeMac(mac) {
  if (mac == null) return mac;
  const hex = String(mac).trim().toLowerCase().replace(/[^0-9a-f]/g, '');
  if (hex.length !== 12) {
    throw new Error(`非法 MAC 地址: ${mac}`);
  }
  return hex.match(/../g).join(':');
}

export function isBroadcastMac(mac) {
  return normalizeMac(mac) === BROADCAST_MAC;
}

export function buildTopology(scenario) {
  if (!scenario || typeof scenario !== 'object') {
    throw new Error('场景配置不能为空');
  }
  const vsi = scenario.vsi ?? 'default-vsi';
  const vlan = scenario.vlan ?? null;

  const peById = new Map();
  for (const peCfg of scenario.pes ?? []) {
    if (!peCfg.id) throw new Error('PE 缺少 id 字段');
    const acs = (peCfg.acs ?? [`${peCfg.id}-AC`]).map((ac) => {
      if (typeof ac === 'string') return { id: ac, vlan, up: true };
      return { id: ac.id, vlan: ac.vlan ?? vlan, up: ac.up ?? true };
    });
    if (acs.length === 0) throw new Error(`PE ${peCfg.id} 至少需要一个 AC`);
    peById.set(peCfg.id, { id: peCfg.id, acs });
  }
  if (peById.size === 0) throw new Error('场景中至少需要一个 PE');

  const pwById = new Map();
  const pwsByPe = new Map([...peById.keys()].map((id) => [id, []]));
  for (const pwCfg of scenario.pws ?? []) {
    const endpoints = pwCfg.endpoints ?? [];
    const [a, b] = endpoints;
    if (!a || !b) throw new Error(`PW ${pwCfg.id ?? '<未命名>'} 缺少 endpoints`);
    if (!peById.has(a) || !peById.has(b)) {
      throw new Error(`PW ${pwCfg.id ?? `${a}--${b}`} 引用了未知 PE`);
    }
    const pw = {
      id: pwCfg.id ?? `${a}--${b}`,
      a,
      b,
      vsi: pwCfg.vsi ?? vsi,
    };
    if (pwById.has(pw.id)) throw new Error(`PW id 重复: ${pw.id}`);
    pwById.set(pw.id, pw);
    pwsByPe.get(a).push(pw);
    pwsByPe.get(b).push(pw);
  }

  return {
    name: scenario.name ?? 'unnamed-scenario',
    vsi,
    vlan,
    peById,
    pwById,
    pwsByPe,

    pe(id) {
      const pe = peById.get(id);
      if (!pe) throw new Error(`未知 PE: ${id}`);
      return pe;
    },

    pwsOf(peId) {
      return pwsByPe.get(peId) ?? [];
    },

    pw(pwId) {
      const pw = pwById.get(pwId);
      if (!pw) throw new Error(`未知 PW: ${pwId}`);
      return pw;
    },

    remotePeOf(pwId, peId) {
      const pw = this.pw(pwId);
      if (pw.a !== peId && pw.b !== peId) {
        throw new Error(`PE ${peId} 不在 PW ${pwId} 上`);
      }
      return pw.a === peId ? pw.b : pw.a;
    },

    defaultAc(peId) {
      return this.pe(peId).acs[0].id;
    },

    vlanMatches(acVlan, vlanId) {
      return acVlan == null || acVlan === vlanId;
    },
  };
}
