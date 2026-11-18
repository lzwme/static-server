/*
 * 极简 ZIP 打包（store 模式，不压缩）
 *
 * 批量下载时把多个文件打成一个 zip，由服务端边读边写，不占用额外磁盘。
 * 文件本身多为图片/视频/压缩包，压缩收益有限，因此使用 store 模式，
 * 既省 CPU 也便于流式输出。
 *
 * 结构：local file header → 文件数据 → data descriptor → ... → central directory → end of central directory
 * 由于 CRC 与长度在写完文件后才知道，这里使用 data descriptor（general purpose flag bit 3）。
 */

/** 生成 CRC32 查找表 */
function makeCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
}

const CRC_TABLE = makeCrcTable();

/** 增量计算 CRC32（可与标准 zlib.crc32 结果比对） */
export function crc32Update(crc: number, buf: Buffer): number {
  let c = (crc ^ -1) >>> 0;
  for (let i = 0; i < buf.length; i++) c = (CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  return (c ^ -1) >>> 0;
}

/** 把时间转换为 DOS 时间/日期 */
function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (Math.floor(date.getSeconds() / 2) & 0x1f),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

export interface ZipEntry {
  /** zip 中的条目名（相对路径，用 `/` 分隔） */
  name: string;
  /** 磁盘上的绝对路径 */
  path: string;
  /** 修改时间 */
  mtime: Date;
}

interface CentralRecord {
  nameBuf: Buffer;
  crc: number;
  size: number;
  offset: number;
  time: number;
  date: number;
}

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const END_SIG = 0x06054b50;

/**
 * 生成 ZIP 内容的异步迭代器，可直接 pipe 到响应流。
 *
 * 为了兼容 Windows 资源管理器 / PowerShell Expand-Archive 等工具，
 * 这里不使用 data descriptor（部分实现无法正确解析它），
 * 而是先流式扫描一遍算出 CRC32 与大小，写入 local file header，
 * 再扫描一遍输出文件内容。代价是本地文件读两遍，
 * 相比网络传输耗时通常可以忽略。
 */
export async function* createZipChunks(entries: ZipEntry[], readFile: (path: string) => AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
  const central: CentralRecord[] = [];
  let offset = 0;

  // 第一遍：流式计算每个文件的 CRC32 与大小
  const metas: { crc: number; size: number }[] = [];
  for (const entry of entries) {
    let crc = 0;
    let size = 0;
    for await (const chunk of readFile(entry.path)) {
      crc = crc32Update(crc, chunk);
      size += chunk.length;
    }
    metas.push({ crc, size });
  }

  // 第二遍：输出 local header 与文件内容
  for (const [index, entry] of entries.entries()) {
    const meta = metas[index];
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const { time, date } = dosDateTime(entry.mtime);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: store
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(meta.crc, 14);
    local.writeUInt32LE(meta.size, 18); // compressed size
    local.writeUInt32LE(meta.size, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra length

    yield local;
    yield nameBuf;

    for await (const chunk of readFile(entry.path)) {
      yield chunk;
    }

    central.push({
      nameBuf,
      crc: meta.crc,
      size: meta.size,
      offset,
      time,
      date,
    });
    offset += local.length + nameBuf.length + meta.size;
  }

  // central directory
  const cdStart = offset;
  for (const record of central) {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(CENTRAL_SIG, 0);
    header.writeUInt16LE(20, 4); // version made by
    header.writeUInt16LE(20, 6); // version needed
    header.writeUInt16LE(0x0008, 8); // flag
    header.writeUInt16LE(0, 10); // method
    header.writeUInt16LE(record.time, 12);
    header.writeUInt16LE(record.date, 14);
    header.writeUInt32LE(record.crc, 16);
    header.writeUInt32LE(record.size, 20); // compressed size
    header.writeUInt32LE(record.size, 24); // uncompressed size
    header.writeUInt16LE(record.nameBuf.length, 28);
    header.writeUInt16LE(0, 30); // extra
    header.writeUInt16LE(0, 32); // comment
    header.writeUInt16LE(0, 34); // disk
    header.writeUInt16LE(0, 36); // internal attrs
    header.writeUInt32LE(0, 38); // external attrs
    header.writeUInt32LE(record.offset, 42);
    yield header;
    yield record.nameBuf;
    offset += header.length + record.nameBuf.length;
  }

  const cdSize = offset - cdStart;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_SIG, 0);
  end.writeUInt16LE(0, 4); // disk number
  end.writeUInt16LE(0, 6); // disk with cd
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(cdStart, 16);
  end.writeUInt16LE(0, 20); // comment length
  yield end;
}
