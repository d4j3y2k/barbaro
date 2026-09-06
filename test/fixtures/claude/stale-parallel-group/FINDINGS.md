# Stale pointer with parallel tool results

This is a constructed regression fixture, not a new producer capture. It
combines the maintained sanitized `parallel-group` topology with closing-record
templates from `turn-duration-close`, exactly as the alpha6 publication probe
does. Original row producer labels are retained; they do not assert a new live
capture of this combined sequence.

The pointer still selects a closed prior turn. Later rows contain a new prompt,
two tool-use rows with one assistant message id, their unique sibling results,
a final answer and a closing record. The new turn must publish at its Stop
without waiting for a rewritten pointer. Both tool results must survive, and
updating the pointer or resetting the runner must not change canonical bytes.

The paired test mutations cover competing response groups, duplicate or foreign
tool-result identities, a result claiming the wrong source call, and a downstream
semantic fork. Those variants remain withheld.
