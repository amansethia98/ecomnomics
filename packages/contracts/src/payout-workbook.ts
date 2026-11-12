import { createRequire } from "node:module";
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";
import type { Workbook } from "exceljs";

const require = createRequire(import.meta.url);
const { Workbook: ExcelWorkbook } = require("exceljs") as { Workbook: new () => Workbook };

/** Opens a payout workbook. Platform logos use a drawing shape this reader rejects, so those parts are dropped and the file is read again. */
export async function openPayoutWorkbook(bytes: Uint8Array): Promise<Workbook> {
  const workbook = new ExcelWorkbook();
  try {
    await workbook.xlsx.load(Buffer.from(bytes) as never);
    return workbook;
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    const retry = new ExcelWorkbook();
    await retry.xlsx.load(stripDrawings(bytes) as never);
    return retry;
  }
}

function stripDrawings(bytes: Uint8Array): Buffer {
  const entries = readZip(Buffer.from(bytes)).filter(
    (entry) => !entry.name.startsWith("xl/drawings/") && !entry.name.startsWith("xl/media/"),
  );
  for (const entry of entries) {
    if (!entry.name.endsWith(".xml") && !entry.name.endsWith(".rels")) continue;
    const text = entry.data.toString("utf8");
    if (!text.includes("drawing")) continue;
    entry.data = Buffer.from(
      text
        .replace(/<Override\b[^>]*PartName="[^"]*\/drawings\/[^"]*"[^>]*\/>/g, "")
        .replace(/<Relationship\b[^>]*Target="[^"]*drawings[^"]*"[^>]*\/>/g, "")
        .replace(/<drawing\b[^>]*\/>/g, ""),
    );
  }
  return writeZip(entries);
}

interface ZipEntry {
  name: string;
  data: Buffer;
}

function readZip(bytes: Buffer): ZipEntry[] {
  const eocd = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) return [];
  const count = bytes.readUInt16LE(eocd + 10);
  let offset = bytes.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50) break;
    const method = bytes.readUInt16LE(offset + 10);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = bytes.subarray(dataOffset, dataOffset + compressedSize);
    let data = Buffer.alloc(0);
    if (compressedSize > 0 && method === 0) data = Buffer.from(compressed);
    else if (compressedSize > 0 && method === 8) data = Buffer.from(inflateRawSync(compressed));
    entries.push({ name, data });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function writeZip(entries: ZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const compressed = deflateRawSync(entry.data);
    const checksum = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(entry.data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt32LE(offset, 42);
    parts.push(local, name, compressed);
    central.push(centralHeader, name);
    offset += local.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}
