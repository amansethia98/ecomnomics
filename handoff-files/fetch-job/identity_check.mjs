// Local identity precheck using the repo's own @rakazo/contracts code (same logic the server runs).
// stdin: JSON {kind: "business"|"payout", platform, report, periodStart, periodEnd, restaurantId, name, city, csv?|fileBase64?}
// stdout: JSON {ok, reject, warnings, periods:[{start,end}], restaurantId} — never any file content.
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
registerHooks({
  resolve(spec, ctx, next) {
    try { return next(spec, ctx); } catch (e) {
      if (spec.endsWith(".js") && ctx.parentURL?.startsWith("file:")) {
        const ts = new URL(spec.replace(/\.js$/, ".ts"), ctx.parentURL);
        if (existsSync(fileURLToPath(ts))) return next(ts.href, ctx);
      }
      throw e;
    }
  },
});
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const id = await import("@rakazo/contracts/identity");
const expected = { platform: input.platform, report: input.report, restaurantId: input.restaurantId,
  name: input.name, city: input.city, periodStart: input.periodStart, periodEnd: input.periodEnd };
let out;
try {
  if (input.kind === "business") {
    const mp = await import("/app/packages/contracts/src/metric-parse.ts");
    const ev = mp.evaluateBusinessReport(input.csv, expected);
    const obs = ev.observed;
    out = { ok: ev.ok, reject: ev.ok ? null : ev.reason, layout: !ev.ok && ev.layout === true, warnings: ev.ok ? ev.warnings : [],
      restaurantId: obs?.restaurantId ?? null, periods: (obs?.periods ?? []).map((p) => ({ start: p.start, end: p.end })),
      rows: ev.ok ? ev.rows.length : 0 };
  } else {
    const pay = await import("@rakazo/contracts/payout");
    const parsed = await pay.parsePayoutWorkbook(new Uint8Array(Buffer.from(input.fileBase64, "base64")), input.platform, null);
    if (!parsed.ok) out = { ok: false, parseFailed: true, layout: parsed.layout === true, reject: parsed.reason, warnings: [], restaurantId: parsed.observed?.restaurantId ?? null, periods: [], parserVersion: pay.PAYOUT_PARSER_VERSION };
    else {
      const a = id.checkObservedIdentity(parsed.payout.observed, expected);
      out = { ok: !a.reject, reject: a.reject, warnings: [...parsed.payout.warnings, ...a.warnings],
        restaurantId: parsed.payout.observed.restaurantId, periods: parsed.payout.observed.periods.map((p) => ({ start: p.start, end: p.end })),
        cycle: [parsed.payout.cycleStart, parsed.payout.cycleEnd], parserVersion: pay.PAYOUT_PARSER_VERSION,
        orders: parsed.payout.orders?.length ?? null };
    }
  }
} catch (e) { out = { ok: false, reject: "local_check_error: " + String(e?.message ?? e).slice(0, 200), warnings: [], periods: [] }; }
process.stdout.write(JSON.stringify(out));
