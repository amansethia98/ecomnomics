# Private-code target diagnostics

## Observed Zomato failure (11 November 2026)

The retained native audit from the isolated `f7d3eeae` verification contains one
`fill_code` refusal: `This field doesn't look like a code box; ask the user to take
over.` It records no action arguments, target ref, result body or DOM. Completed
`browser_snapshot` calls likewise retained no snapshot bodies. The conversation
export contains no six-box markup. The temporary browser/DB were already removed.
Consequently **the actual target ref and real Zomato markup are unknown**; no test
in this change claims to reproduce captured accounts.zomato.com HTML.

The refusal proves only that:

- exact HTTPS origin, focused/enabled/non-readonly input and supported input type
  checks passed (a wrapper, password/number input or mismatched origin gives a
  different refusal);
- `splitCodeGroup` found no eligible group containing the selected input, rather
  than refusing that target group as ambiguous, prefilled or wrong-length;
- `looksLikeCodeBox` rejected the selected individual field (for example a lone
  maxlength-one input, or a field lacking acceptable OTP markers).

It does **not** distinguish a stale email-field ref from an unrecognised group
layout/root. It does not establish an iframe/shadow-DOM cause. No code was entered
and no login/reconciliation completed. The split-group recognition policy is not
relaxed speculatively.

## Smallest next-run capture

Only when a later live run is separately authorised:

1. Take a fresh accessibility snapshot once the OTP screen is visible. Select a
   visible OTP input from that snapshot, not a pre-OTP phone/email ref or wrapper.
2. Make the single approved private `fill_code` attempt on the exact HTTPS origin.
   The native helper captures `codeLayout` immediately before filling, on both
   acceptance and refusal; no extra browser/model round trip is required.
3. Retain only that diagnostic and the native outcome. It includes the validated
   ref, exact origin, frame flag, document/shadow-root classification, selected
   input index, whitelisted shape/type/autocomplete/inputmode information, marker
   booleans and bounded ancestor paths/counts. It never reads input values or
   serialises text, raw HTML, raw labels/IDs/names, or URL path/query strings.
4. Use this scrubbed structural record to build a faithful regression fixture and
   make a narrowly justified recognition change if needed. Do not label the
   current synthetic six-/four-box fixtures as real Zomato/Swiggy captures.

The capture is bounded (32 nearby inputs, 12 ancestors) and is gated behind the
same-origin check and a validated native accessibility ref. Unrelated private
fields are never read. It preserves masking/redaction, navigation/focus checks,
one private claim per code, fail-closed ambiguity checks and no replay after any
partial input. Code values never go through ordinary typing or diagnostic output.

## Swiggy password investigation

The retained delivery helper used the intended mobile number and read the
password directly from `SWIGGY_PASSWORD` into a JSON private-answer payload. The
current environment value is eight characters/eight UTF-8 bytes, with no leading
or trailing whitespace; an in-memory JSON round trip preserves its digest. No
password, digest or length-changing transformation is written to this document.
There is no shell interpolation of the value. The original preflight refusal
happened before secret submission; the subsequent private answer was accepted.

The existing native password route accepts only a focused password-type input
and replaces its entire value through the native setter, rather than appending.
It verifies equality before dispatching input/change events. However, neither the
original field ref nor a post-event equality receipt was retained. Therefore the
actual rendered mobile/field and any framework mutation cannot be proven after
the fact. An `Incorrect Password` response alone is not proof of either an invalid
credential or a delivery defect.

The helper now also checks connection and exact value equality after input/change
handlers run. A reset, truncation or replacement is treated as uncertain private
entry and stops the batch without replay or submit. Synthetic tests cover exact
punctuation/JSON round trips, replacement of prefilled values, refusal to put a
password into phone/OTP controls, and synchronous field mutation/replacement.
This closes a concrete verification gap; it does not prove that gap caused the
historical Swiggy rejection, nor can DOM equality prove a site's internal server
submission payload.
