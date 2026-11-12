import { mkdir } from "node:fs/promises";
import ExcelJS from "exceljs";

const root = new URL(".", import.meta.url);

await mkdir(root, { recursive: true });

await write("zomato-900002.xlsx", zomato("900002", "Test Kitchen"));
await write("zomato-900002-other-name.xlsx", zomato("900002", "Other Kitchen"));
await write("zomato-999002-wrong-outlet.xlsx", zomato("999002", "Test Kitchen"));
await write("swiggy-900001.xlsx", swiggy("900001", "Test Kitchen", "Paid"));
await write("swiggy-900001-pending.xlsx", swiggy("900001", "Test Kitchen", "Pending"));
await write("swiggy-900001-other-name.xlsx", swiggy("900001", "Other Kitchen", "Paid"));
await write("swiggy-999001-wrong-outlet.xlsx", swiggy("999001", "Test Kitchen", "Paid"));

async function write(name, book) {
  await book.xlsx.writeFile(new URL(name, root));
}

function zomato(id, name) {
  const book = new ExcelJS.Workbook();
  const hidden = book.addWorksheet("HSummary");
  hidden.state = "hidden";
  hidden.addRows([
    ["Restaurant ID", id],
    ["Restaurant name", name],
    ["City", "Testcity"],
    ["Area", "Testarea"],
    ["Payout cycle", "02 Nov 2026 - 08 Nov 2026"],
  ]);
  book.addWorksheet("Summary").addRows([
    ["Pay-out cycle", "#REF!"],
    ["Bank UTR", "#REF!"],
    ["Res Name", "#REF!"],
  ]);
  const orders = book.addWorksheet("Order Level");
  orders.addRows([
    ["Order level Breakup"],
    ["A section title, not the header"],
    [
      "S.No.",
      "Order ID",
      "Order date",
      "Res. name",
      "Res. ID",
      "Order status (Delivered/ Cancelled/ Rejected)",
      "Cancelled by",
      "Customer ID",
      "Customer phone",
      "Subtotal (items total)",
      "Packaging charge",
      "Restaurant discount [Promo]",
      "Restaurant Discount [BOGO, Freebies, Gold, Brand pack & others]",
      "Total GST collected from customers",
      "Base service fee",
      "Payment mechanism fee",
      "Taxes on service fees",
      "TDS 194O amount",
      "TCS amount",
      "Other order-level deductions",
      "Net Additions",
      "Order level Payout",
      "Settlement status",
      "Settlement date",
      "Bank UTR",
    ],
    ["#REF!", "#REF!", "#REF!"],
    order("Z1", "02 Nov 2026", "Delivered", "", "CUSTA", "9876543210", {
      subtotal: "100.00",
      packaging: "10.00",
      promo: "5.00",
      other: "  2.50 ",
      gst: "8.00",
      base: "10.00",
      payment: "5.00",
      tax: "2.70",
      tds: "1.00",
      tcs: "0.50",
      payout: "83.30",
      settlement: "settled",
      settledOn: "2026-11-11 05:30:00",
      utr: "UTRX900002ABCD",
    }),
    order("Z2", "03/11/2026", "cancelled", "restaurant", "CUSTB", "", {
      payout: "0",
      settlement: "Settled",
      settledOn: "11 Nov 2026",
      utr: "UTRX900002ABCD",
    }),
    order("Z3", "2026-11-08", "DELIVERED", "", "CUSTA", "9876543210", {
      subtotal: "20.005",
      payout: "20.005",
      settlement: "pending",
    }),
  ]);
  book.addWorksheet("Addition Deductions Details").addRows([
    ["A) Investments in growth services"],
    ["Type", "Invoice", "Deduction time period", "Total amount", "Adjusted amount"],
    ["Ads", "INV-ADS", "02 Nov 2026 - 08 Nov 2026", "10.00", "10.00"],
    ["Total Ads", "", "", "10.00", "10.00"],
    ["D) Adjustments from previous week"],
    ["Type", "Invoice", "Deduction time period", "Total amount", "Adjusted amount"],
    ["Prior week fee", "INV-PRIOR", "26 Oct 2026 - 01 Nov 2026", "4.00", "4.00"],
    ["Total Deductions", "", "", "10.00", "10.00"],
  ]);
  book.addWorksheet("Payout Breakup").addRows([
    ["", "Particular", "Total"],
    ["", "Number of Orders", 3],
    ["", "Subtotal (items total)", "120.01"],
    ["", "Packaging charge", "10.00"],
    ["", "Restaurant discount [Promo]", "5.00"],
    ["", "Restaurant discount [other]", "2.50"],
    ["", "Base service fee", "10.00"],
    ["", "Payment mechanism fee", "5.00"],
    ["", "Taxes on service fees", "2.70"],
    ["", "TDS 194O amount", "1.00"],
    ["", "TCS amount", "0.50"],
    ["", "GST collected from customers", "8.00"],
    ["", "Other order level deductions", "0"],
    ["", "Ads", "10.00"],
    ["I", "Net Payout", "89.31"],
  ]);
  return book;
}

function order(id, date, status, cancelledBy, customer, phone, extra) {
  const blank = extra;
  return [
    "1",
    id,
    date,
    "Test Kitchen",
    "900002",
    status,
    cancelledBy,
    customer,
    phone,
    blank.subtotal ?? "0",
    blank.packaging ?? "0",
    blank.promo ?? "0",
    blank.other ?? "0",
    blank.gst ?? "0",
    blank.base ?? "0",
    blank.payment ?? "0",
    blank.tax ?? "0",
    blank.tds ?? "0",
    blank.tcs ?? "0",
    "0",
    "0",
    blank.payout ?? "0",
    blank.settlement ?? "",
    blank.settledOn ?? "",
    blank.utr ?? "",
  ];
}

function swiggy(id, name, settlement) {
  const paid = settlement === "Paid";
  const book = new ExcelJS.Workbook();
  book.addWorksheet("Summary").addRows([
    [name],
    [`Rest. ID - ${id}`],
    ["Area - Testarea"],
    ["City - Testcity"],
    ["Payout Period", "31 October - 06 November"],
  ]);
  const orders = book.addWorksheet("Order Level");
  orders.addRows([
    ["Order level"],
    [
      "Order ID",
      "Order Date",
      "Order Status",
      "Order Category",
      "Cancelled By",
      "MFR Marked",
      "MFR Accurate",
      "Item Total",
      "Packaging Charges",
      "Restaurant Discount",
      "Commission",
      "Total Swiggy Fees",
      "GST on Service Fee",
      "GST Collected",
      "Complaint & Cancellation Charges",
      "TDS",
      "TCS",
      "Net Bill Value",
      "Net Payout for Order",
      "Settlement Status",
      "Settlement Date",
      "Bank UTR",
    ],
    ["#REF!", "#REF!", "#REF!"],
    swiggyOrder("7001", "1st Nov 2026", "delivered", "", "", "Yes", "Yes", {
      item: "200",
      packaging: "20",
      discount: " -15.00 ",
      commission: "30",
      fees: "40",
      gstFee: "7.20",
      gst: "10",
      tds: "1",
      tcs: "1",
      bill: "205",
      net: "155.80",
      settlement,
      settledOn: paid ? "09 Nov 2026" : "",
      utr: paid ? "SBI0000WXYZ" : "",
    }),
    swiggyOrder("7002", "02-11-2026", "Delivered", "TRAIN_ORDER", "", "No", "No", {
      item: "50",
      commission: "5",
      fees: "5",
      gstFee: "0.90",
      bill: "50",
      net: "44.10",
      settlement,
      settledOn: paid ? "09 Nov 2026" : "",
      utr: paid ? "SBI0000WXYZ" : "",
    }),
    swiggyOrder("7003", "7 Nov 2026", "Cancelled", "Toing", "customer", "", "", {
      settlement,
      settledOn: paid ? "09 Nov 2026" : "",
      utr: paid ? "SBI0000WXYZ" : "",
    }),
  ]);
  book.addWorksheet("Payout Breakup").addRows([
    ["", "Particulars", "Delivered", "Total"],
    ["", "Orders", 3, 3],
    ["", "Item Total", "", "250"],
    ["", "Packaging Charges", "", "20"],
    ["", "Restaurant Discounts", "", "-15"],
    ["B", "Swiggy Fees", "", "-45"],
    ["", "Commission", "", "-35"],
    ["", "GST on Service Fee", "", "-8.10"],
    ["", "GST Collected", "", "10"],
    ["", "TDS", "", "-1"],
    ["", "TCS", "", "-1"],
    ["", "Complaint & Cancellation Charges", "", "0"],
    ["D", "Growth Investment In Ads", "", "-8"],
    ["", "Weekly ad pack", "", "-8"],
    ["G", "Net Payout", "", "191.90"],
  ]);
  return book;
}

function swiggyOrder(id, date, status, category, cancelledBy, marked, accurate, extra) {
  return [
    id,
    date,
    status,
    category,
    cancelledBy,
    marked,
    accurate,
    extra.item ?? "0",
    extra.packaging ?? "0",
    extra.discount ?? "0",
    extra.commission ?? "0",
    extra.fees ?? "0",
    extra.gstFee ?? "0",
    extra.gst ?? "0",
    "0",
    extra.tds ?? "0",
    extra.tcs ?? "0",
    extra.bill ?? "0",
    extra.net ?? "0",
    extra.settlement ?? "",
    extra.settledOn ?? "",
    extra.utr ?? "",
  ];
}
