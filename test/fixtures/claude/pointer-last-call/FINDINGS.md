# Pointer inside an unfinished response group

Synthetic regression built from existing sanitized fixtures, following the native
Claude 2.1.261 topology captured in live-v4-results.json. No raw provider history
or hidden reasoning is copied. Matched native prefix SHA-256: `bb086fd8536936e4340bad08e8d81ddc8f4ee6a5cc053f9c12d009354c4c02e5`.

`pointer-last-call` preserves a blocked Stop, same-response leading text, three
chained calls, pointer at the last call, per-call results, inline metadata and
terminal response. `pointer-first-result` selects the first result while another
same-response call is before the pointer and its result is after it. Both cases
must retain every uniquely paired call/result and publish without another prompt.
