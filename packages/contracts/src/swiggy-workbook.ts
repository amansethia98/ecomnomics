import { inflateRawSync } from "node:zlib";

/**
 * Reads a Swiggy business-report workbook into the CSV the business-report
 * parser already checks. The first sheet's cached cell text is copied.
 * Formulas are not calculated and macros are not opened.
 *
 * No workbook library reads the upload. exceljs 4.4.0 has open critical
 * prototype-pollution advisories on load, and the npm `xlsx` package at
 * 0.18.5 is unmaintained and has open prototype-pollution and ReDoS
 * advisories. This reader inflates only the worksheet XML, with a size cap.
 */

const MAX_ZIP_ENTRIES = 512;
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 24 * 1024 * 1024;
const MAX_ROWS = 5_000;
const MAX_COLUMNS = 64;
const MAX_CELLS = 20_000;
const MAX_CSV_CHARS = 1_500_000;

export function swiggyWorkbookCsv(bytes: Uint8Array): string | null {
  try {
    const entries = readZip(Buffer.from(bytes));
    if (!entries) return null;
    const sheetPath = firstSheetPath(entries);
    const sheet = sheetPath ? entries.get(sheetPath) : undefined;
    if (!sheet) return null;
    const shared = entries.get("xl/sharedStrings.xml");
    const strings = shared ? sharedStrings(shared.toString("utf8")) : [];
    if (!strings) return null;
    const table = sheetTable(sheet.toString("utf8"), strings);
    if (!table || table.length === 0) return null;
    const csv = table.map((row) => row.map(csvField).join(",")).join("\n");
    return csv.length > 0 && csv.length <= MAX_CSV_CHARS ? csv : null;
  } catch {
    return null;
  }
}

/** Builds a workbook whose first sheet is the given text grid. Used to make synthetic fixtures. */
export function writeSwiggyWorkbook(rows: readonly (readonly string[])[]): Uint8Array {
  const strings: string[] = [];
  const indexOf = new Map<string, number>();
  const stringIndex = (value: string) => {
    const existing = indexOf.get(value);
    if (existing !== undefined) return existing;
    const next = strings.length;
    strings.push(value);
    indexOf.set(value, next);
    return next;
  };
  const sheetRows = rows.map((row, rowIndex) => {
    const cells = row.map(
      (value, column) =>
        `<c r="${columnName(column)}${rowIndex + 1}" t="s"><v>${stringIndex(value)}</v></c>`,
    );
    return `<row r="${rowIndex + 1}">${cells.join("")}</row>`;
  });
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows.join("")}</sheetData></worksheet>`;
  const shared = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${strings
    .map((value) => `<si><t>${escapeXml(value)}</t></si>`)
    .join("")}</sst>`;
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Business Report" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;
  return writeZip([
    ["xl/workbook.xml", workbook],
    ["xl/_rels/workbook.xml.rels", rels],
    ["xl/sharedStrings.xml", shared],
    ["xl/worksheets/sheet1.xml", sheet],
  ]);
}

function csvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function columnName(index: number): string {
  let name = "";
  let rest = index + 1;
  while (rest > 0) {
    rest -= 1;
    name = String.fromCharCode(65 + (rest % 26)) + name;
    rest = Math.floor(rest / 26);
  }
  return name;
}

function columnIndex(letters: string): number {
  let index = 0;
  for (const char of letters) index = index * 26 + (char.charCodeAt(0) - 64);
  return index - 1;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function rejectXml(xml: string): boolean {
  return xml.includes("<!DOCTYPE") || xml.includes("<!ENTITY");
}

function decodeXml(text: string): string | null {
  if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(text)) return null;
  let invalid = false;
  const decoded = text.replace(
    /&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g,
    (_match, entity: string) => {
      if (entity === "amp") return "&";
      if (entity === "lt") return "<";
      if (entity === "gt") return ">";
      if (entity === "quot") return '"';
      if (entity === "apos") return "'";
      const codePoint = entity.startsWith("#x")
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
        invalid = true;
        return "";
      }
      return String.fromCodePoint(codePoint);
    },
  );
  return invalid ? null : decoded;
}

function textNodes(xml: string): string | null {
  let text = "";
  for (const match of xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) {
    const decoded = decodeXml(match[1] ?? "");
    if (decoded === null) return null;
    text += decoded;
  }
  return text;
}

function sharedStrings(xml: string): string[] | null {
  if (rejectXml(xml)) return null;
  const cleaned = xml
    .replace(/<rPh\b[^>]*>[\s\S]*?<\/rPh>/g, "")
    .replace(/<phoneticPr\b[^>]*\/>/g, "");
  const strings: string[] = [];
  for (const match of cleaned.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    const text = textNodes(match[1] ?? "");
    if (text === null) return null;
    strings.push(text);
  }
  return strings;
}

function cellValue(attrs: string, body: string, strings: readonly string[]): string | null {
  const type = /\bt="([^"]*)"/.exec(attrs)?.[1] ?? "";
  if (type === "inlineStr") return textNodes(body);
  const hasValue = /<v\b[^>]*>/.test(body);
  if (/<f\b/.test(body) && !hasValue) return "";
  const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1];
  if (raw === undefined) return "";
  const decoded = decodeXml(raw);
  if (decoded === null) return null;
  if (type === "s") {
    const index = Number(decoded);
    return Number.isInteger(index) ? (strings[index] ?? "") : "";
  }
  if (type === "e" || type === "b") return type === "b" ? decoded : "";
  return decoded;
}

function sheetTable(xml: string, strings: readonly string[]): string[][] | null {
  if (rejectXml(xml)) return null;
  const table: string[][] = [];
  let cellsSeen = 0;
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = new Map<number, string>();
    let max = -1;
    let next = 0;
    const body = rowMatch[1] ?? "";
    for (const cell of body.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      cellsSeen += 1;
      if (cellsSeen > MAX_CELLS) return null;
      const attrs = cell[1] ?? "";
      const ref = /\br="([A-Z]+)\d+"/.exec(attrs)?.[1];
      const column = ref ? columnIndex(ref) : next;
      next = column + 1;
      if (column < 0 || column >= MAX_COLUMNS) return null;
      const value = cellValue(attrs, cell[2] ?? "", strings);
      if (value === null) return null;
      cells.set(column, value);
      if (column > max) max = column;
    }
    if (max < 0) continue;
    table.push(Array.from({ length: max + 1 }, (_unused, index) => cells.get(index) ?? ""));
    if (table.length > MAX_ROWS) return null;
  }
  return table;
}

function firstSheetPath(entries: Map<string, Buffer>): string | null {
  const workbook = entries.get("xl/workbook.xml")?.toString("utf8");
  const rels = entries.get("xl/_rels/workbook.xml.rels")?.toString("utf8");
  if (!workbook || !rels || rejectXml(workbook) || rejectXml(rels)) {
    return entries.has("xl/worksheets/sheet1.xml") ? "xl/worksheets/sheet1.xml" : null;
  }
  const id = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(workbook)?.[1];
  if (!id || !/^[\w.-]+$/.test(id)) return null;
  const tag = new RegExp(`<Relationship\\b(?=[^>]*\\bId="${id}")[^>]*>`).exec(rels)?.[0];
  const target = tag ? /\bTarget="([^"]+)"/.exec(tag)?.[1] : undefined;
  if (!target || target.includes("..") || target.includes("\\")) return null;
  const path = target.startsWith("/")
    ? target.slice(1)
    : target.startsWith("xl/")
      ? target
      : `xl/${target}`;
  return path.startsWith("xl/worksheets/") && path.endsWith(".xml") && entries.has(path)
    ? path
    : null;
}

function isWorkbookPart(name: string): boolean {
  return (
    name === "xl/workbook.xml" ||
    name === "xl/_rels/workbook.xml.rels" ||
    name === "xl/sharedStrings.xml" ||
    (name.startsWith("xl/worksheets/") && name.endsWith(".xml"))
  );
}

function readZip(bytes: Buffer): Map<string, Buffer> | null {
  const eocd = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0 || eocd + 22 > bytes.length) return null;
  const count = bytes.readUInt16LE(eocd + 10);
  if (count === 0 || count > MAX_ZIP_ENTRIES) return null;
  let offset = bytes.readUInt32LE(eocd + 16);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes.length) return null;
  const entries = new Map<string, Buffer>();
  let total = 0;
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50) return null;
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const uncompressedSize = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localOffset = bytes.readUInt32LE(offset + 42);
    if ((flags & 0x1) !== 0 || nameLength === 0 || nameLength > 512) return null;
    if (offset + 46 + nameLength > bytes.length) return null;
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (name.includes("..") || name.startsWith("/") || name.includes("\\")) return null;
    if (isWorkbookPart(name)) {
      if (
        uncompressedSize === 0 ||
        uncompressedSize > MAX_ENTRY_BYTES ||
        total + uncompressedSize > MAX_UNCOMPRESSED_BYTES ||
        (method !== 0 && method !== 8)
      ) {
        return null;
      }
      if (localOffset + 30 > bytes.length) return null;
      const localNameLength = bytes.readUInt16LE(localOffset + 26);
      const localExtraLength = bytes.readUInt16LE(localOffset + 28);
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
      if (dataOffset < 0 || dataOffset + compressedSize > bytes.length) return null;
      const compressed = bytes.subarray(dataOffset, dataOffset + compressedSize);
      const data =
        method === 0
          ? Buffer.from(compressed)
          : inflateRawSync(compressed, { maxOutputLength: uncompressedSize });
      if (data.length !== uncompressedSize) return null;
      total += data.length;
      entries.set(name, data);
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function writeZip(files: ReadonlyArray<readonly [string, string]>): Uint8Array {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, xml] of files) {
    const fileName = Buffer.from(name);
    const data = Buffer.from(xml);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(fileName.length, 26);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0, 10);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(fileName.length, 28);
    header.writeUInt32LE(offset, 42);
    parts.push(local, fileName, data);
    central.push(header, fileName);
    offset += local.length + fileName.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}
