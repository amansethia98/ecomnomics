/** ISO dates, interpreted as civil days. India has no daylight-saving shift. */

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

export function addIsoDays(iso: string, days: number): string {
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** 0 is Sunday. */
export function isoWeekday(iso: string): number {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1)).getUTCDay();
}

/** Inclusive start, exclusive end. */
export function daysBetween(start: string, end: string): string[] {
  const days: string[] = [];
  for (let cursor = start; cursor < end; cursor = addIsoDays(cursor, 1)) days.push(cursor);
  return days;
}

export function monthIndex(name: string): number | undefined {
  const index = MONTHS.indexOf(name.toLowerCase().slice(0, 3));
  return index === -1 ? undefined : index;
}

export function isoDate(year: number, monthIndex: number, day: number): string | undefined {
  if (monthIndex < 0 || monthIndex > 11 || day < 1 || day > 31) return undefined;
  const date = new Date(Date.UTC(year, monthIndex, day));
  if (date.getUTCMonth() !== monthIndex || date.getUTCDate() !== day) return undefined;
  return date.toISOString().slice(0, 10);
}

/** Monday of an ISO week, and the following Monday. */
export function isoWeekRange(
  year: number,
  week: number,
): { start: string; end: string } | undefined {
  if (week < 1 || week > 53) return undefined;
  const january4 = new Date(Date.UTC(year, 0, 4));
  const january4Day = january4.getUTCDay() || 7;
  const monday = new Date(january4);
  monday.setUTCDate(january4.getUTCDate() - january4Day + 1 + (week - 1) * 7);
  const start = monday.toISOString().slice(0, 10);
  const thursday = addIsoDays(start, 3);
  if (Number(thursday.slice(0, 4)) !== year) return undefined;
  return { start, end: addIsoDays(start, 7) };
}

export function nextMonth(iso: string): string {
  const [year, month] = iso.split("-").map(Number);
  if (month === 12) return `${(year ?? 0) + 1}-01-01`;
  return `${year}-${String((month ?? 0) + 1).padStart(2, "0")}-01`;
}
