# Native Runtime Bridge (optional local companion)

The web app remains **virtual-runtime first**. A browser page cannot safely execute host programs, load `.node` add-ons, or obtain an OS path from a File System Access handle. Those capabilities are provided only by the separately launched `apps/native-bridge` Node companion. Connecting it never changes `shell.exec`, `javascript.exec`, or Virtual Runtime package policy; host operations use separately named `host.*` tools.

## Start and pair

Create a host-owned JSON configuration. Roots, command templates, and HTTPS destinations are allowlists; absent entries are unavailable.

```json
{
  "roots": [{ "id": "work", "path": "C:/src/project", "nickname": "Work", "mode": "readwrite" }],
  "commands": [{ "id": "node-version", "executable": "C:/Program Files/nodejs/node.exe", "args": ["--version"] }],
  "networkProfiles": [{ "id": "docs", "origin": "https://docs.example.com" }],
  "stateDirectory": "C:/Users/me/.browser-agent-native"
}
```

```sh
pnpm --dir apps/native-bridge start -- \
  --config native-bridge.json --port 0 \
  --allow-origin https://browser-agent-wzp100-app.pages.dev \
  --allow-origin http://localhost:5173
```

The program prints one JSON record with a random loopback endpoint and a one-time 256-bit pairing code. Paste both in **Settings → Native Runtime Bridge**. The pairing code and returned bearer token are memory-only; reload, disconnect, expiry, or daemon restart requires pairing again. Do not place pairing material in a project, `.env`, issue, or log.

## Security model

- The server binds only to `127.0.0.1`, uses a random port by default, has no public health endpoint, and accepts exact configured Origins only. CORS/PNA preflight is origin-pinned.
- Pairing is one-use, expiring, and returns a 256-bit session token. Every post-pair request requires exact Origin, bearer token, and a strict monotonic `X-BA-Sequence` counter. Grants are held by the daemon and can be revoked immediately.
- The product injects only opaque, app-local `grantHandle` references into an Agent run environment. The daemon grant id and session bearer remain memory-only in the browser bridge client; a `host.*` tool resolves a handle only after that individual call has passed visible browser confirmation. `readOnly` projects never expose `host.*`; `auto` does not bypass bridge confirmation or grants.
- Filesystem roots are host-configured aliases. All paths are relative POSIX paths, reject traversal, drive/UNC/backslash/NUL/internal paths, and reject traversed symlinks. Direct host mutations are intentionally marked outside browser `ProjectFileService` ChangeSet/rollback support.
- Commands are fixed IDs resolving to absolute executables with fixed or regex-constrained arguments. PATH lookup and known command/shell interpreters (`cmd`, PowerShell, `bash`, `dash`, `ksh`, `csh`, `zsh`, and related variants) are rejected at configuration time. Configure only trusted executable templates; environment is scrubbed, output/time are bounded, and cancellation/revocation kills the process tree.
- HTTP is only configured exact HTTPS origins and GET/HEAD. The bridge resolves DNS itself, refuses loopback/private/link-local/CGNAT/multicast addresses, pins the request lookup to a validated address, uses no browser cookies/credentials, does not auto-follow redirects, and bounds time/body size. DNS has independently scoped hostname suffixes.
- Output is emitted to an authenticated SSE stream as `stream.chunk` events while final results remain bounded. Operations have IDs and can be cancelled. The daemon writes metadata-only, hash-chained JSONL audit records; secrets, bodies, content, authorization fields, command arguments, and URL/path/query values are redacted before hashing/persisting.

## Capability coverage

| Capability | State |
| --- | --- |
| Host scoped file list/read/write/mkdir/move/delete | Product `host.fs.*` tools; configured roots, scoped grants, per-call confirmation; move/delete require `rename: true`/`delete: true` in the write scope |
| Fixed-template subprocesses and output stream/cancel | Product `host.command.run`; no arbitrary shell |
| HTTPS and DNS | Product `host.network.fetch` and `host.dns.lookup`; configured profiles/scopes; private targets blocked |
| Timers/stream transport | Product `host.timer.wait` is bounded/cancellable. Command/HTTPS `stream.chunk` and `operation.end` SSE events are delivered only as ephemeral current-run progress; they are not persisted. |
| Browser DOM, Worker, isolated storage | **Unavailable to agents.** Internal adapter helpers are not registered as product tools; app DOM/cookies/local storage are never exposed. |
| Native extensions | **Disabled by default**. No generic Node child or `.node` loader is provided. It may only be enabled in a future signed-artifact, OS-sandboxed extension runner; a Node `vm` is not adequate. |

## Residual risks

Loopback does not defend against malware already running as the same OS user. Node path checks also cannot fully close symlink/reparse-point TOCTOU races against a hostile concurrent local process. Treat configured roots and command templates as high-trust host policy, use an OS sandbox/native descriptor-relative helper for hostile-local-process threat models, and inspect the daemon audit journal. Generic native extension execution remains unavailable rather than falling back to an unrestricted Node process.
