# Generated test reports

This directory intentionally contains no committed generated reports.

Historical reports were removed because they embedded obsolete authentication
assumptions and known development credentials. Generate reports locally from
the current tests, which use cookie sessions, CSRF protection, and credentials
supplied through the test environment. Never commit credentials, session
cookies, CSRF tokens, activation links, or other setup secrets in a report.