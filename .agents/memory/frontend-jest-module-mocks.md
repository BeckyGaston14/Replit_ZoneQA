---
name: Frontend Jest module mocks
description: Environment-specific module and hoisting constraints in focused CRA/Jest tests.
---

Focused frontend tests must mock `react-router-dom` and unresolved `@/` imports as
virtual modules when importing app-level components. Jest mock factories should
call through closures instead of reading later-declared mock constants while the
factory is initialized.

**Why:** This project's focused Jest resolver does not consistently resolve the
runtime aliases/router package, and hoisted mock factories can execute before
`const` mocks initialize.

**How to apply:** Follow existing virtual-router mocks in narrow tests. For API
mocks referenced by a factory, expose wrapper functions that invoke the assigned
mock at call time rather than embedding the mock object during factory setup.