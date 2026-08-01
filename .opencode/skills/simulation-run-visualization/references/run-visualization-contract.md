# Run visualization contract

- Render exactly one source event/result artifact per HTML document.
- Preserve source order and event timestamps. A sampled display must expose source count, displayed count, and sampling method.
- Treat domain event records as data: escape all strings and never execute embedded content.
- Include source path, source SHA-256, generated time, title, and stated limitations.
- Use the operating system's external browser only after the HTML write succeeds. The external page is not a Riff Product iframe and does not gain product authority.
- If an authoritative event source is missing, stop and report the gap; do not synthesize a replay.
