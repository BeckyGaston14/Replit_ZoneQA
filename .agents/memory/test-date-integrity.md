---
name: Test Date integrity
description: Rules for execution dates, defaults, and historical records.
---

Store execution Test Date as an explicit `YYYY-MM-DD` value. New execution workflows require it, while historical records without a trustworthy value must display “Not recorded” and remain unmodified. Use the configured application timezone for form defaults; keep provider, audit, start, completion, retest, and scheduled timestamps separate.

**Why:** Deriving an execution date from creation or update timestamps invents historical facts and can shift the date at timezone boundaries.

**How to apply:** Any new run, comparison, regression, or completed retest must submit one parent Test Date. Validate it as a real calendar date and preserve the ISO value in APIs and exports.