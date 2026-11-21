# Security Policy

## Local-First Security Model

ChessOnGlass is designed to run locally without a hosted backend:

- **Loopback HTTP/SSE boundary:** The local dashboard binds exclusively to `127.0.0.1`, requires a per-session 256-bit Bearer token (`timingSafeEqual`), and verifies exact `Origin` on mutating requests.
- **OS Keyring credentials:** Provider API keys are stored in the OS secret store (Windows Credential Manager, macOS Keychain, Linux Secret Service via `@napi-rs/keyring`) and are never returned over HTTP or saved in plaintext config files.
- **Verified native binaries:** External tools (`stockfish`, `ffmpeg`) are downloaded only on explicit `install-tools` invocation and verified by SHA-256 before extraction.
- **Bounded spend:** All cloud vision calls reserve and settle against `CostLedger` and pause paid work once the configured USD limit is reached.

## Reporting a Vulnerability

If you discover a security vulnerability, please report it privately via GitHub Security Advisories on this repository rather than opening a public issue. Include steps to reproduce and the affected package/version.
