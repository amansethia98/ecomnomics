import type { Cell, CellValue } from "exceljs";
import { openPayoutWorkbook } from "./payout-workbook.js";

const PHONE = /(?:\+91[\s-]?)?[6-9]\d{9}/g;

/** A copy of the workbook with bank references reduced to four characters, and phones and customer ids removed. */
export async function redactPayoutWorkbook(bytes: Uint8Array): Promise<Uint8Array> {
  const workbook = await openPayoutWorkbook(bytes);
  for (const sheet of [...workbook.worksheets]) {
    const name = sheet.name.replace(/\s+/g, " ").trim().toLowerCase();
    if (name === "hsummary" || name === "hdiscount") workbook.removeWorksheet(sheet.id);
  }
  for (const sheet of workbook.worksheets) {
    for (const table of sheet.getTables() as unknown as Array<{ name: string }>) {
      sheet.removeTable(table.name);
    }
    let utrColumns = new Set<number>();
    let phoneColumns = new Set<number>();
    let customerColumns = new Set<number>();
    sheet.eachRow((row) => {
      const labels = new Map<number, string>();
      row.eachCell({ includeEmpty: false }, (cell, column) => {
        labels.set(column, cellText(cell.value).toLowerCase());
      });
      const joined = [...labels.values()].join(" ");
      const header =
        /\border id\b|\bparticular\b/.test(joined) ||
        (labels.size >= 4 && /\butr\b|\bphone\b|\bcustomer id\b/.test(joined));
      if (header) {
        utrColumns = new Set();
        phoneColumns = new Set();
        customerColumns = new Set();
        for (const [column, label] of labels) {
          if (/\butr\b/.test(label)) utrColumns.add(column);
          if (label.includes("phone")) phoneColumns.add(column);
          if (isCustomerId(label)) customerColumns.add(column);
        }
        return;
      }
      if (redactLabelValue(row, labels)) return;
      row.eachCell({ includeEmpty: false }, (cell, column) => {
        if (utrColumns.has(column)) {
          cell.value = utrLast4(cellText(cell.value)) ?? "";
          return;
        }
        if (phoneColumns.has(column) || customerColumns.has(column)) {
          cell.value = "";
          return;
        }
        redactText(cell);
      });
    });
  }
  const written = await workbook.xlsx.writeBuffer();
  return new Uint8Array(written);
}

function redactLabelValue(
  row: {
    eachCell: (
      options: { includeEmpty: false },
      visit: (cell: Cell, column: number) => void,
    ) => void;
  },
  labels: Map<number, string>,
): boolean {
  if (labels.size > 3) return false;
  let matched = false;
  for (const [column, label] of labels) {
    const kind = /\butr\b/.test(label)
      ? "utr"
      : label.includes("phone")
        ? "phone"
        : isCustomerId(label)
          ? "customer"
          : isSecretLabel(label)
            ? "secret"
            : null;
    if (!kind) continue;
    matched = true;
    row.eachCell({ includeEmpty: false }, (cell, other) => {
      if (other === column) return;
      cell.value = kind === "utr" ? (utrLast4(cellText(cell.value)) ?? "") : "";
    });
  }
  return matched;
}

function isCustomerId(label: string): boolean {
  return label.includes("customer id") || label === "customer" || label.includes("customer name");
}

function isSecretLabel(label: string): boolean {
  return (
    /\b(pan|tan|gstin|mid)\b/.test(label) || label === "address" || label.includes("legal entity")
  );
}

function redactText(cell: Cell): void {
  if (typeof cell.value === "string") {
    cell.value = cell.value.replace(PHONE, "");
  }
}

function cellText(value: CellValue): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object" && "richText" in value && Array.isArray(value.richText)) {
    return value.richText.map((part) => part.text).join("");
  }
  if (typeof value === "object" && "result" in value) return cellText(value.result as CellValue);
  if (typeof value === "object" && "text" in value && typeof value.text === "string") {
    return value.text;
  }
  return "";
}

function utrLast4(value: string): string | null {
  const compact = value.replace(/[^a-z0-9]/gi, "");
  if (compact.length < 4) return null;
  return compact.slice(-4);
}
