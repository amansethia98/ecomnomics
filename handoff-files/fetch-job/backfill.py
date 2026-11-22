"""Generic --from/--to daily backfill windows, for any restaurant.

Chunk sizes match the server (Zomato 30, Swiggy 7). periodEnd is exclusive.
"""
from datetime import date, timedelta

ZOMATO_CHUNK_DAYS = 30
SWIGGY_CHUNK_DAYS = 7
CHUNK_DAYS = {'zomato': ZOMATO_CHUNK_DAYS, 'swiggy': SWIGGY_CHUNK_DAYS}


class BackfillError(ValueError):
    pass


def parse_day(value, flag):
    if not value or not isinstance(value, str):
        raise BackfillError(f'{flag} must be a YYYY-MM-DD date')
    try:
        return date.fromisoformat(value)
    except ValueError as e:
        raise BackfillError(f'{flag} must be a YYYY-MM-DD date') from e


def parse_range(from_s, to_s, today):
    """Inclusive civil days. Clamps --to to yesterday. Returns (start, end_inclusive)."""
    if not from_s or not to_s:
        raise BackfillError('--from and --to must be used together')
    start, end = parse_day(from_s, '--from'), parse_day(to_s, '--to')
    if start > end:
        raise BackfillError('--from must be on or before --to')
    yesterday = today - timedelta(days=1)
    if end > yesterday:
        end = yesterday
    if start > end:
        raise BackfillError('--from is after yesterday; today is never fetched')
    return start, end


def chunk_days(platform):
    if platform not in CHUNK_DAYS:
        raise BackfillError(f'unknown platform {platform}')
    return CHUNK_DAYS[platform]


def windows(platform, start, end_inclusive, report='daily', reason='backfill'):
    """Oldest-first daily windows, each at most the platform's download cap."""
    if end_inclusive < start:
        return []
    max_days = chunk_days(platform)
    out = []
    cursor = start
    end_excl = end_inclusive + timedelta(days=1)
    while cursor < end_excl:
        chunk_end = min(cursor + timedelta(days=max_days), end_excl)
        out.append({
            'report': report,
            'reasons': [reason],
            'periodStart': cursor.isoformat(),
            'periodEnd': chunk_end.isoformat(),
        })
        cursor = chunk_end
    return out


def plan(platforms, start, end_inclusive, reports=('daily',)):
    """Windows for each requested platform. --from/--to only builds daily reports."""
    wanted = set(reports)
    out = {}
    for platform in platforms:
        if 'daily' not in wanted:
            out[platform] = []
            continue
        out[platform] = windows(platform, start, end_inclusive)
    return out


def cap_reached(spent_inr, cap_inr):
    return spent_inr >= cap_inr
