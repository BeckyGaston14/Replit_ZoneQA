---
name: Project testing recency
description: Defines the durable eligibility scope for a project's Last Tested Date.
---

A project's Last Tested Date is the latest explicit ISO Test Date from an active Test Case currently linked to that project, a completed standard Test Run linked to that Test Case, or a recorded canonical Bassett run whose project link agrees with the Test Case's current project.

Exclude reusable Test Bank definitions, archived Test Cases, orphaned records, cross-project Bassett links, failed or in-progress executions, and unrelated Bassett-only runs.

**Why:** Project recency must reflect trustworthy testing activity and update correctly after reassignment or archival without inventing dates from creation or modification timestamps.

**How to apply:** Use the same derivation for project lists, project detail/history, exports, and dashboard data. Missing eligible dates remain unknown and display as “Not Yet Tested.”