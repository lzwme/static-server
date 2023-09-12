import { networkInterfaces, type NetworkInterfaceInfo } from "os";

export function getIp() {
  const nif = networkInterfaces();
  const list: NetworkInterfaceInfo[] = [];

  for (const key of Object.keys(nif)) {
    for (const item of nif[key]!) {
      if (!item.internal && item.address && item.family === 'IPv4') list.push(item);
    }
  }

  // console.log(list);
  return list[0]?.address;
}
