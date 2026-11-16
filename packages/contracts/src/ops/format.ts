/** ISO dates and the brief's number format. India has no daylight-saving shift. */

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function isIsoDate(iso: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === (month ?? 1) - 1 &&
    date.getUTCDate() === day
  );
}

/** A business day can be briefed once the next civil day has started. */
export function businessDayFinished(date: string, today: string): boolean {
  return date < today;
}

/** Whole days from `from` to `to`. Negative when `to` is earlier. */
export function isoDayDiff(from: string, to: string): number {
  const [fromYear, fromMonth, fromDay] = from.split("-").map(Number);
  const [toYear, toMonth, toDay] = to.split("-").map(Number);
  const start = Date.UTC(fromYear ?? 0, (fromMonth ?? 1) - 1, fromDay ?? 1);
  const end = Date.UTC(toYear ?? 0, (toMonth ?? 1) - 1, toDay ?? 1);
  return Math.round((end - start) / 86_400_000);
}

/** 0 is Sunday. */
function isoWeekday(iso: string): number {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1)).getUTCDay();
}

/** Monday of the civil week that contains `iso`. */
export function weekMonday(iso: string): string {
  const weekday = isoWeekday(iso);
  const back = weekday === 0 ? 6 : weekday - 1;
  return addDays(iso, -back);
}

export function addDays(iso: string, days: number): string {
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** `Sat 14 Nov` */
export function formatCivilDay(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1));
  return `${WEEKDAYS[date.getUTCDay()]} ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

export function formatWeekdayName(iso: string): string {
  return WEEKDAY_NAMES[isoWeekday(iso)] ?? "day";
}

export function formatWeekdayShort(iso: string): string {
  return WEEKDAYS[isoWeekday(iso)] ?? "day";
}

/** ₹ with Indian grouping and no paise. */
export function formatRupees(paise: number): string {
  const rupees = Math.round(paise / 100);
  return `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(rupees)}`;
}

/** One decimal place, no sign. */
export function formatPct1(value: number): string {
  return (Math.round(value * 10) / 10).toFixed(1);
}

/** One decimal place with a sign. Negatives use the minus sign from the samples. */
export function formatSignedPct(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  const body = Math.abs(rounded).toFixed(1);
  if (rounded > 0) return `+${body}%`;
  if (rounded < 0) return `−${body}%`;
  return `${body}%`;
}

export function pctChange(current: number, baseline: number): number | null {
  if (baseline === 0) return null;
  return ((current - baseline) / baseline) * 100;
}

/** Clock time in Asia/Kolkata, `05:48`. */
export function formatIstClock(value: Date): string {
  const shifted = new Date(value.getTime() + 5.5 * 60 * 60 * 1000);
  const hours = String(shifted.getUTCHours()).padStart(2, "0");
  const minutes = String(shifted.getUTCMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}
