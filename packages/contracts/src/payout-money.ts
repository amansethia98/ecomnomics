/** Integer paise from a money cell. Half a paise rounds away from zero. */
export function rupeesToPaise(input: unknown): number | null {
  const text = moneyText(input);
  if (text == null) return null;
  let body = text;
  let negative = false;
  if (body.startsWith("(") && body.endsWith(")")) {
    negative = true;
    body = body.slice(1, -1);
  }
  if (body.startsWith("+")) body = body.slice(1);
  if (body.startsWith("-")) {
    negative = !negative;
    body = body.slice(1);
  }
  if (!/^\d+(\.\d+)?$/.test(body)) return null;
  const [whole, frac = ""] = body.split(".");
  const numerator = BigInt(whole + frac) * 100n;
  const denom = 10n ** BigInt(frac.length);
  const towardZero = numerator / denom;
  const remainder = numerator % denom;
  const paise = remainder * 2n >= denom ? towardZero + 1n : towardZero;
  const signed = negative ? -paise : paise;
  if (signed > BigInt(Number.MAX_SAFE_INTEGER) || signed < BigInt(-Number.MAX_SAFE_INTEGER)) {
    return null;
  }
  return Number(signed);
}

/** A discount cell may be negative or wrapped in parentheses. The cost is its size. */
export function discountPaise(input: unknown): number {
  const parsed = rupeesToPaise(input);
  return parsed == null ? 0 : Math.abs(parsed);
}

export function costPaise(input: unknown): number {
  const parsed = rupeesToPaise(input);
  return parsed == null ? 0 : Math.abs(parsed);
}

export function signedPaise(input: unknown): number {
  return rupeesToPaise(input) ?? 0;
}

function moneyText(input: unknown): string | null {
  if (input == null) return null;
  if (typeof input === "number") {
    if (!Number.isFinite(input)) return null;
    return input.toString();
  }
  const text = String(input).replace(/₹/g, "").replace(/,/g, "").replace(/\s+/g, "").trim();
  if (!text || text === "-" || text === "#REF!" || text.toLowerCase() === "na") return null;
  return text;
}
