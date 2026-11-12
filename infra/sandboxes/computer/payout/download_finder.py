"""Find a platform's export in a download folder by the platform's own file name.

The calculators prove the period and outlet from the name the platform gave the file, so they
take the newest file whose name matches the platform's pattern for the configured outlet. A file
under a browser's temporary name, or one renamed to look like an export, is not accepted.
"""

from __future__ import annotations

import re
from pathlib import Path

_COPY = r"(?: \(\d+\))?"
_DATE = r"\d{2} [A-Za-z]{3,9} \d{4}"


def swiggy_pattern(outlet_id: str) -> re.Pattern[str]:
    return re.compile(rf"invoice_Annexure_{re.escape(str(outlet_id))}_\d{{8}}_\d+{_COPY}\.xlsx", re.I)


def zomato_pattern(outlet_id: str) -> re.Pattern[str]:
    return re.compile(rf".+_{re.escape(str(outlet_id))}_{_DATE}_{_DATE}{_COPY}\.xlsx", re.I)


def find_download(folder: str | Path, pattern: re.Pattern[str], since: float = 0.0) -> Path:
    """The newest file in `folder` whose whole name matches `pattern`, saved at or after `since`."""
    root = Path(folder)
    if not root.is_dir():
        raise ValueError(f"Download folder not found: {root}")
    found = []
    for path in root.iterdir():
        if not pattern.fullmatch(path.name) or not path.is_file() or path.is_symlink():
            continue
        mtime = path.stat().st_mtime
        if mtime >= since - 2:
            found.append((mtime, path.name, path))
    if not found:
        raise ValueError(
            "No fresh platform export with the platform's own file name was found in "
            f"{root}. Wait for the download with rakazo-wait-download; do not rename files."
        )
    return max(found)[2]
