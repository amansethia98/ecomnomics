"""Blank-day guard (added 15 Nov 2026, "blankday"). No model, no network.

A platform sometimes serves a day it has not filled in yet as a column of zeros (Zomato, Sat 14 Nov 2026:
orders 0, sales 0, rating 0.00, online 0%). Stored as real data that becomes "sales down 100%".

A daily-report column (one civil day) is BLANK when, for a recent day:
  rule all_zero:        every order, sales and rate cell is zero or empty (at least one order row present), or
  rule rating0_orders0: a rating cell is 0 (or 0.00) and the order count is zero.
Only days at most LAG_DAYS old (IST, default 3; env ECOM_BLANK_LAG_DAYS) can be blank: an older all-zero day is a
real closed day and is stored as usual. Works on the CSV both platforms post (Zomato raw CSV, Swiggy converted CSV),
by metric label only, so it is generic for any restaurant / outlet / app.

Blank columns are cut out of the CSV before upload. The server then records them as `missingPeriods`
(the file is a gap there, nothing is stored for that day), so the scheduled 7-day window (and later backfill)
fetches the day again on following nights. A file whose every column is blank is not posted at all.
"""
import csv, io, os, re
from datetime import date, datetime, timedelta

PREFIX = 6   # Restaurant ID, Restaurant name, Subzone/Area, City, Overview, Metric
LAG_DAYS = int(os.environ.get('ECOM_BLANK_LAG_DAYS', '3'))

_ORDER = re.compile(r'order', re.I)
_SALES = re.compile(r'sales|revenue|gmv|\baov\b', re.I)
_RATE = re.compile(r'rating|online|availability|accuracy|\bkpt\b|prep time', re.I)
_RATING = re.compile(r'rating', re.I)
_DELIVERED = re.compile(r'delivered orders?', re.I)


def cell_value(text):
    """None for empty / '-' / NA / unreadable, else a float. Strips Rs, %, min, commas."""
    t = (text or '').strip()
    if not t or t == '-' or t.lower() in ('na', 'n/a'):
        return None
    t = re.sub(r'^rs\.?', '', t.replace('₹', ''), flags=re.I)
    t = re.sub(r'mins?$', '', t, flags=re.I).replace('%', '').replace(',', '').strip()
    try:
        return float(t)
    except ValueError:
        return None


def label_date(label):
    """'14 Nov, 2026' (Zomato), '14th Nov 2026' (Swiggy), '2026-11-14' -> date; None if unreadable."""
    t = re.sub(r'(\d+)(st|nd|rd|th)\b', r'\1', (label or '').strip(), flags=re.I).replace(',', ' ')
    t = re.sub(r'\s+', ' ', t).strip()
    for fmt in ('%d %b %Y', '%d %B %Y', '%Y-%m-%d', '%d-%m-%Y', '%d/%m/%Y'):
        try:
            return datetime.strptime(t, fmt).date()
        except ValueError:
            pass
    return None


def _table(csv_text):
    return list(csv.reader(io.StringIO(csv_text.lstrip('\ufeff'))))


def find_blank_days(csv_text, today, lag_days=None):
    """[{'col': i, 'date': 'YYYY-MM-DD', 'rule': ...}] for each blank column (i = index into the date columns)."""
    lag = LAG_DAYS if lag_days is None else lag_days
    if isinstance(today, str):
        today = date.fromisoformat(today)
    try:
        table = _table(csv_text)
    except csv.Error:
        return []
    if not table or len(table[0]) <= PREFIX:
        return []
    header = table[0]
    rows = [r for r in table[1:] if any(c.strip() for c in r) and len(r) > PREFIX]
    if not rows:
        return []
    out = []
    for i, label in enumerate(header[PREFIX:]):
        day = label_date(label)
        if day is None or day > today or (today - day).days > lag:
            continue
        col = PREFIX + i
        orders, considered, ratings, delivered = [], [], [], []
        for r in rows:
            metric = r[5] if len(r) > 5 else ''
            v = cell_value(r[col]) if col < len(r) else None
            if _ORDER.search(metric):
                orders.append(v)
            if _ORDER.search(metric) or _SALES.search(metric) or _RATE.search(metric):
                considered.append(v)
            if _RATING.search(metric) and not re.search(r'rated', metric, re.I):
                ratings.append(v)
            if _DELIVERED.search(metric):
                delivered.append(v)
        zero = lambda xs: all(x is None or x == 0 for x in xs)
        no_orders = zero(delivered) if delivered else (bool(orders) and zero(orders))
        if orders and zero(considered):
            out.append({'col': i, 'date': day.isoformat(), 'rule': 'all_zero'})
        elif ratings and any(x == 0 for x in ratings) and no_orders:
            out.append({'col': i, 'date': day.isoformat(), 'rule': 'rating0_orders0'})
    return out


def date_columns(csv_text):
    try:
        t = _table(csv_text)
    except csv.Error:
        return 0
    return max(0, len(t[0]) - PREFIX) if t else 0


def drop_columns(csv_text, cols):
    """The same CSV without the given date columns (indexes into the date columns)."""
    drop = {PREFIX + c for c in cols}
    nl = '\r\n' if '\r\n' in csv_text else '\n'
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator=nl)
    for r in _table(csv_text):
        w.writerow([c for j, c in enumerate(r) if j not in drop])
    return buf.getvalue()


def guard(csv_text, today, lag_days=None):
    """(csv_to_post or None if every column is blank, blank_list). Unchanged text when nothing is blank."""
    blanks = find_blank_days(csv_text, today, lag_days)
    if not blanks:
        return csv_text, []
    if len(blanks) >= date_columns(csv_text):
        return None, blanks
    return drop_columns(csv_text, [b['col'] for b in blanks]), blanks
