# Harness-serialized calls within one response

Synthetic maintained fixture derived from the parent/group/call-result topology
of Claude 2.1.261 responses. The private structural capture and review records
are not shipped.

All identifiers, paths, commands and output bodies are synthetic. No raw private
content or hidden reasoning is copied. Two harmless nonterminal text rows retain
the response-group edges; the final empty assistant row preserves the edge and
group of an omitted reasoning row. Three same-response calls have interleaved
results and an inline attachment before the last call. The last-prompt pointer
names the last call. Tests move it to each result and other call positions.
The closing Stop summary/duration is an explicit fixture continuation after the
captured native terminal prefix, allowing bounded own-Stop publication checks.

V4 recognizes the native prefix; v5 incorrectly rejects it because its initial
response closure cannot cross its own result or attachment rows. The correction
must validate the complete connected component without weakening refusals for
reused/disconnected message IDs, foreign or mixed-content bridges, ambiguous
pairings, missing settlement, rewinds or source mutation.
