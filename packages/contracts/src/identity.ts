/**
 * Outlet and period checks for a fetch job.
 * This file does not load a workbook parser. Dates are Asia/Kolkata civil
 * days: `periodStart` is inclusive and `periodEnd` is exclusive, the day
 * after the last day, the same window `expectedPeriods` checks.
 */

export type {
  ExpectedReportIdentity,
  IdentityAssessment,
  ObservedReportIdentity,
  ReportPeriod,
} from "./metric-parse.js";
export {
  checkObservedIdentity,
  expectedPeriods,
  missingPlatformIdReason,
  parsePeriodLabel,
} from "./metric-parse.js";
