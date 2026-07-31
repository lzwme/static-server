import { type NetworkInterfaceInfo, networkInterfaces } from 'node:os';

export function getIp() {
  const nif = networkInterfaces();
  let list: NetworkInterfaceInfo[] = [];

  for (const key of Object.keys(nif)) {
    for (const item of nif[key]!) {
      if (!item.internal && item.address && item.family === 'IPv4') list.push(item);
    }
  }

  list = list.sort((_a, b) => {
    if (b.address.startsWith('172.')) return -1;
    return 0;
  });

  // console.log(list);
  return list[0]?.address;
}

// console.log(getIp());
