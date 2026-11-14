import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
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

  it("rejects a corrupt file and a file with an external entity", () => {
    expect(swiggyWorkbookCsv(Uint8Array.from([1, 2, 3, 4]))).toBeNull();
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
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, xml] of files) {
    const fileName = Buffer.from(name);
    const data = Buffer.from(xml);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(fileName.length, 26);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 6);
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
