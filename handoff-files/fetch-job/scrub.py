"""Log scrubber: runs on every log line before it is written."""
import re
PATTERNS = [
    (re.compile(r'(?<!\d)(?:\+?91[\s-]?)?[6-9]\d{9}(?!\d)'), '[phone]'),          # Indian mobiles
    (re.compile(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'), '[email]'),
    (re.compile(r'(?i)\b(otp|code|password|passwd|pwd|pin|token|secret|cookie|authorization|bearer)\b(["\']?\s*[:=]\s*["\']?|\s+)[^\s,;"\']+'), r'\1=[redacted]'),
    (re.compile(r'\b[A-Z]{5}\d{4}[A-Z]\b'), '[pan]'),
    (re.compile(r'\b\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]\b'), '[gstin]'),
    (re.compile(r'(?<![\d.])\d{11,}(?![\d.])'), '[long-number]'),                  # UTRs, account numbers
    (re.compile(r'(?<![\w-])\d{4,8}(?=\s*(?:is your|is the)\b)', re.I), '[code]'),
    (re.compile(r'([?&](?:token|key|sig|auth|code)=)[^&\s"]+', re.I), r'\1[redacted]'),
]
def scrub(text: str) -> str:
    for rx, rep in PATTERNS:
        text = rx.sub(rep, text)
    return text

SAFE_KEYS = {"raw_sha12", "fetchId", "run", "runId", "outlet", "t"}
def scrub_obj(x):
    """Scrub every string inside a JSON-able object, so the written line stays valid JSON."""
    if isinstance(x, dict): return {k: (v if k in SAFE_KEYS else scrub_obj(v)) for k, v in x.items()}
    if isinstance(x, (list, tuple)): return [scrub_obj(v) for v in x]
    if isinstance(x, str): return scrub(x)
    return x
