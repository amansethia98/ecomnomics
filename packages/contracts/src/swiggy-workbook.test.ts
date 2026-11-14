import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { evaluateBusinessReport, parseCsv } from "./metric-parse.js";
import { IngestMetricReportSchema } from "./restaurant-agent.js";
import { swiggyWorkbookCsv, writeSwiggyWorkbook } from "./swiggy-workbook.js";

const swiggyDaily = {
  platform: "swiggy" as const,
  report: "daily" as const,
  restaurantId: "900001",
  name: "Test Kitchen",
  city: "Testcity",
  periodStart: "2026-11-02",
  periodEnd: "2026-11-09",
};

const sampleCsv = readFileSync(
  new URL("../fixtures/metrics/swiggy_daily_sample.csv", import.meta.url),
  "utf8",
);

function sampleRows(): string[][] {
  return parseCsv(sampleCsv);
}

describe("swiggy workbook", () => {
  it("reads the same business-report rows as the csv twin", () => {
    const fromSheet = swiggyWorkbookCsv(writeSwiggyWorkbook(sampleRows()));
    expect(fromSheet).toBeTruthy();
    expect(evaluateBusinessReport(fromSheet ?? "", swiggyDaily)).toEqual(
      evaluateBusinessReport(sampleCsv, swiggyDaily),
    );
  });

  it("reads a workbook written by the spreadsheet library as the same rows", async () => {
    const bytes = await excelRows(sampleRows());
    const fromSheet = swiggyWorkbookCsv(bytes);
    expect(fromSheet).toBeTruthy();
    expect(evaluateBusinessReport(fromSheet ?? "", swiggyDaily)).toEqual(
      evaluateBusinessReport(sampleCsv, swiggyDaily),
    );
  });

  it("uses a cached formula result and does not read a macro", () => {
    const csv = swiggyWorkbookCsv(
      storedZip([
        [
          "xl/worksheets/sheet1.xml",
          `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>cached</t></is></c><c r="B1" t="str"><f>1+1</f><v>2</v></c><c r="C1"><f>SUM(9,9)</f></c></row></sheetData></worksheet>`,
        ],
        ["xl/vbaProject.bin", "Sub Auto_Open"],
      ]),
    );
    expect(csv).toBe("cached,2,");
    expect(csv).not.toContain("SUM");
    expect(csv).not.toContain("Auto_Open");
  });

  it("reads shared strings, inline strings, and cached number text", () => {
    const csv = swiggyWorkbookCsv(
      storedZip([
        [
          "xl/sharedStrings.xml",
          `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>2nd Nov 2026</t></si></sst>`,
        ],
        [
          "xl/worksheets/sheet1.xml",
          `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>inline</t></is></c><c r="C1"><v>36</v></c><c r="D1" s="1"><v>44927</v></c></row></sheetData></worksheet>`,
        ],
      ]),
    );
    expect(csv).toBe("2nd Nov 2026,inline,36,44927");
  });

  it("rejects a corrupt file and any part that declares a document type or entity", () => {
    expect(swiggyWorkbookCsv(Uint8Array.from([1, 2, 3, 4]))).toBeNull();
    const sheet = `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>ok</t></is></c></row></sheetData></worksheet>`;
    expect(
      swiggyWorkbookCsv(
        storedZip([
          [
            "xl/worksheets/sheet1.xml",
            `<!DOCTYPE worksheet [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>&xxe;</t></is></c></row></sheetData></worksheet>`,
          ],
        ]),
      ),
    ).toBeNull();
    expect(
      swiggyWorkbookCsv(
        storedZip([
          ["xl/worksheets/sheet1.xml", `<!doctype worksheet [<!entity x "no">]>${sheet}`],
        ]),
      ),
    ).toBeNull();
    expect(
      swiggyWorkbookCsv(
        storedZip([
          ["xl/workbook.xml", `<!DOCTYPE workbook><workbook><sheets/></workbook>`],
          ["xl/worksheets/sheet1.xml", sheet],
        ]),
      ),
    ).toBeNull();
    expect(
      swiggyWorkbookCsv(
        storedZip([
          [
            "xl/sharedStrings.xml",
            `<!DOCTYPE sst [<!ENTITY secret "hidden">]><sst><si><t>&secret;</t></si></sst>`,
          ],
          ["xl/worksheets/sheet1.xml", sheet],
        ]),
      ),
    ).toBeNull();
    expect(
      swiggyWorkbookCsv(
        storedZip([
          [
            "xl/workbook.xml",
            `<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Business Report" sheetId="1" r:id="rId1"/></sheets></workbook>`,
          ],
          [
            "xl/_rels/workbook.xml.rels",
            `<!ENTITY leak "hidden"><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
          ],
          ["xl/worksheets/sheet1.xml", sheet],
        ]),
      ),
    ).toBeNull();
  });

  it("caps zip entries and decompressed size while inflating", () => {
    const sheet = `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>ok</t></is></c></row></sheetData></worksheet>`;
    const padding = (count: number) =>
      Array.from({ length: count }, (_unused, index) => ({
        name: `xl/media/${index}.bin`,
        data: "x",
      }));
    expect(
      swiggyWorkbookCsv(
        zipParts([{ name: "xl/worksheets/sheet1.xml", data: sheet }, ...padding(511)]),
      ),
    ).toBe("ok");
    expect(
      swiggyWorkbookCsv(
        zipParts([{ name: "xl/worksheets/sheet1.xml", data: sheet }, ...padding(512)]),
      ),
    ).toBeNull();

    expect(
      swiggyWorkbookCsv(
        zipParts([
          {
            name: "xl/worksheets/sheet1.xml",
            data: sheet,
            declaredSize: 8 * 1024 * 1024 + 1,
          },
        ]),
      ),
    ).toBeNull();

    expect(
      swiggyWorkbookCsv(
        zipParts([
          {
            name: "xl/worksheets/sheet1.xml",
            data: deflateRawSync(Buffer.alloc(50_000, 0)),
            method: 8,
            declaredSize: 64,
          },
        ]),
      ),
    ).toBeNull();

    const chunk = Buffer.alloc(8 * 1024 * 1024);
    const heavy = (count: number) =>
      Array.from({ length: count }, (_unused, index) => ({
        name: `xl/worksheets/extra-${index}.xml`,
        data: chunk,
      }));
    expect(
      swiggyWorkbookCsv(zipParts([{ name: "xl/worksheets/sheet1.xml", data: sheet }, ...heavy(2)])),
    ).toBe("ok");
    expect(
      swiggyWorkbookCsv(zipParts([{ name: "xl/worksheets/sheet1.xml", data: sheet }, ...heavy(3)])),
    ).toBeNull();
  });

  it("ignores zip-slip names and other paths outside the workbook", () => {
    const sheet = `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>safe</t></is></c></row></sheetData></worksheet>`;
    const csv = swiggyWorkbookCsv(
      zipParts([
        { name: "xl/worksheets/sheet1.xml", data: sheet },
        { name: "../../etc/passwd", data: "SECRET", declaredSize: 50 * 1024 * 1024 },
        { name: "/etc/passwd", data: "SECRET" },
        { name: "xl/worksheets/../../secret.xml", data: "SECRET" },
        { name: "xl/vbaProject.bin", data: "Sub Auto_Open" },
      ]),
    );
    expect(csv).toBe("safe");
    expect(csv).not.toContain("SECRET");
    expect(
      swiggyWorkbookCsv(zipParts([{ name: "../xl/worksheets/sheet1.xml", data: sheet }])),
    ).toBeNull();
  });

  it("rejects a sheet that leaves a row unclosed", () => {
    const xml = `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>ok</t></is></c></row>${"<row>".repeat(20_000)}</sheetData></worksheet>`;
    expect(swiggyWorkbookCsv(storedZip([["xl/worksheets/sheet1.xml", xml]]))).toBeNull();
  });

  it("keeps the csv body and requires a hashed swiggy workbook", () => {
    const base = {
      outletId: "outlet",
      platform: "swiggy" as const,
      report: "daily" as const,
      periodStart: "2026-11-02",
      periodEnd: "2026-11-09",
      runId: "fetch-1",
      source: "business-report",
      capturedAt: "2026-11-09T05:00:00.000Z",
    };
    expect(IngestMetricReportSchema.parse({ ...base, csv: "Restaurant ID" }).format).toBe("csv");
    expect(
      IngestMetricReportSchema.safeParse({
        ...base,
        format: "xlsx",
        fileBase64: "YQ==",
        rawSha256: "a".repeat(64),
      }).success,
    ).toBe(true);
    expect(
      IngestMetricReportSchema.safeParse({ ...base, format: "xlsx", fileBase64: "YQ==" }).success,
    ).toBe(false);
    expect(
      IngestMetricReportSchema.safeParse({
        ...base,
        platform: "zomato",
        format: "xlsx",
        fileBase64: "YQ==",
        rawSha256: "a".repeat(64),
      }).success,
    ).toBe(false);
  });
});

async function excelRows(rows: string[][]): Promise<Uint8Array> {
  const { Workbook } = createRequire(import.meta.url)("exceljs") as {
    Workbook: new () => import("exceljs").Workbook;
  };
  const workbook = new Workbook();
  const sheet = workbook.addWorksheet("Business Report");
  for (const values of rows) {
    const row = sheet.addRow([]);
    values.forEach((value, index) => {
      const cell = row.getCell(index + 1);
      cell.value = value;
      cell.numFmt = "@";
    });
  }
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}

function storedZip(files: ReadonlyArray<readonly [string, string]>): Uint8Array {
  return zipParts(files.map(([name, data]) => ({ name, data })));
}

function zipParts(
  files: ReadonlyArray<{
    name: string;
    data: Buffer | string;
    method?: 0 | 8;
    declaredSize?: number;
  }>,
): Uint8Array {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const fileName = Buffer.from(file.name);
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data);
    const method = file.method ?? 0;
    const declaredSize = file.declaredSize ?? data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(declaredSize, 22);
    local.writeUInt16LE(fileName.length, 26);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(method, 10);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(declaredSize, 24);
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
