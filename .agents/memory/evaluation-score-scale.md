---
name: Evaluation score scale
description: The non-negotiable visual and accessibility meaning of evaluation-dimension scores.
---

Evaluation scores must always be rendered against an absolute minimum of 0 and
maximum of 10. Never scale a chart to the largest score in the current record or
normalize dimensions relative to one another.

**Why:** Auto-scaling made a score such as 7.9 appear almost perfect even though
it represents exactly 79% of the full evaluation range.

**How to apply:** Use consistent 0, 2, 4, 6, 8, and 10 references where useful;
carry the 0–10 meaning into tooltips, accessible alternatives, print/export, and
score bars. Treat null or missing dimensions as unavailable and do not coerce or
plot them as zero.