import { type NetworkInterfaceInfo, networkInterfaces } from 'node:os';

/** 一个可用的本机地址及其所属网卡 */
export interface IpCandidate {
  /** IPv4 地址 */
  address: string;
  /** 网卡名称（用于展示，帮助用户判断该选哪一个） */
  iface: string;
}

/**
 * 虚拟网卡 / 容器网卡的特征。
 *
 * 这些网卡上的地址通常只有本机或虚拟网络内部可达：
 * 手机扫码拿到 WSL、Docker、VMware 的地址只会得到「无法访问此网站」。
 */
const VIRTUAL_IFACE_RE =
  /(vethernet|wsl|docker|br-|vmnet|vmware|vbox|virtualbox|hyper-v|tailscale|zerotier|utun|tun\d|tap\d|ppp|loopback|npcap|openvpn|wireguard|vpn)/i;

/**
 * 私网段优先级（数值越小越优先）。
 *
 * 家用/办公路由器最常见的是 192.168.x.x，其次是 10.x.x.x；
 * 172.16-31 更多出现在 Docker / WSL / 企业内网，因此排在其后。
 * 169.254（APIPA）说明没拿到 DHCP，基本不可用，排在最后。
 */
function privateRank(address: string): number {
  if (address.startsWith('192.168.')) return 0;
  if (address.startsWith('10.')) return 1;
  const matched = /^172\.(\d{1,3})\./.exec(address);
  if (matched) {
    const second = Number(matched[1]);
    if (second >= 16 && second <= 31) return 2;
  }
  // 没拿到 DHCP 的自动地址：对其它设备一定不可达，无条件排最后
  if (address.startsWith('169.254.')) return 30;
  // 100.64/10（CGNAT）常见于 Tailscale 等组网工具
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address)) return 7;
  return 5;
}

/** 是否为私网地址（含回环） */
export function isPrivateAddress(address: string): boolean {
  if (!address) return false;
  if (address === '127.0.0.1' || address === '::1') return true;
  if (address.startsWith('192.168.') || address.startsWith('10.') || address.startsWith('127.')) return true;
  const matched = /^172\.(\d{1,3})\./.exec(address);
  if (matched) {
    const second = Number(matched[1]);
    return second >= 16 && second <= 31;
  }
  return false;
}

/** 是否为回环地址（IPv4 / IPv6 / IPv4-mapped） */
export function isLoopbackAddress(address: string): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/**
 * 按「可达概率」排序候选地址。
 *
 * 物理网卡优先、私网段优先，同级按地址排序保证结果稳定。
 * 纯函数，便于单测。
 */
export function rankIpCandidates(list: IpCandidate[]): IpCandidate[] {
  return list
    .slice()
    .sort((a, b) => {
      const rankA = privateRank(a.address) + (VIRTUAL_IFACE_RE.test(a.iface) ? 10 : 0);
      const rankB = privateRank(b.address) + (VIRTUAL_IFACE_RE.test(b.iface) ? 10 : 0);
      if (rankA !== rankB) return rankA - rankB;
      return a.address.localeCompare(b.address);
    });
}

/** 收集本机全部非回环 IPv4 地址（已按可达概率排序，去重） */
export function getIpCandidates(): IpCandidate[] {
  const nif = networkInterfaces();
  const list: IpCandidate[] = [];
  const seen = new Set<string>();
  for (const iface of Object.keys(nif)) {
    const items: NetworkInterfaceInfo[] = nif[iface] || [];
    for (const item of items) {
      if (item.internal || !item.address || item.family !== 'IPv4') continue;
      if (item.address.startsWith('127.') || seen.has(item.address)) continue;
      seen.add(item.address);
      list.push({ address: item.address, iface });
    }
  }
  return rankIpCandidates(list);
}

/**
 * 取最可能被局域网其它设备访问的地址。
 *
 * 只用于启动日志这类「给个大概」的场景；页面上的二维码应使用
 * `/localsend/api/network` 返回的完整候选列表，让用户自己选。
 */
export function getIp(): string | undefined {
  return getIpCandidates()[0]?.address;
}
