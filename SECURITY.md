# Security

Report vulnerabilities privately to info@growth-choice.com. Include reproduction steps and the package version; never include credentials.

The audit fetches public HTTP(S) URLs. It validates both DNS address families and every redirect, rejects embedded credentials, bounds response size, and enforces request deadlines. DNS rebinding remains a limitation because DNS validation and connection lookup are separate. Deployments accepting untrusted input need independent network egress restrictions. Never rely on this library as the only SSRF boundary.

No runtime dependencies or credentials are required. Development dependencies should be checked with npm audit before release.
