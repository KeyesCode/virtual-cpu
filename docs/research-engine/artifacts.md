# Artifact storage

`@vcpu/artifact-storage` keeps the bytes every experiment produces: candidate sources, patches, reports, agent outputs, logs and waveforms. Objects are named by the SHA-256 of their content, stored once, checked for credentials and expired by a retention policy.

**The store holds bytes and the database holds metadata.** The `artifact` table (see [data-model.md](data-model.md)) links an object's `content_hash` to its experiment, agent run, name and kind. The store knows nothing about experiments. Several rows can point at one object, which is how deduplication works across experiments.

## Interface

`ArtifactStore` (`packages/artifact-storage/src/store.ts`) is backend-neutral: no method takes or returns a path, so an S3-compatible backend can implement it later.

| Method                        | Does                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------- |
| `put(source, meta, options?)` | Stores a buffer, a string or a stream. Returns `{ sha256, size, mediaType, deduplicated }`. |
| `get(sha256)`                 | Returns the whole object and checks it against its digest.                                  |
| `openReadStream(sha256)`      | Returns a stream, for downloads too large to buffer. Not checked while streaming.           |
| `has(sha256)`                 | Whether the bytes are stored. False for unknown objects and for pruned ones.                |
| `stat(sha256)`                | The metadata, including pruned objects. `null` if the store never held the object.          |
| `delete(sha256)`              | Removes the bytes and the metadata.                                                         |
| `prune(sha256, reason, at)`   | Removes the bytes and keeps the metadata, marked `pruned`.                                  |
| `list(filter?)`               | Objects in digest order, filtered by digest `prefix`, `kind` and `includePruned`.           |

`meta` is `{ kind, name?, mediaType? }`, checked by `ArtifactMetaSchema`. `name` is for people, not a storage key. When `mediaType` is not given, the store infers it from the extension of `name`. Failing that, content with no NUL byte in its first 8000 bytes is `text/plain`, and anything else is `application/octet-stream`.

`putFile(store, path, meta)` streams a local file. `putDirectory(store, dir, meta)` stores each regular file under `dir`, then a JSON manifest (`application/vnd.vcpu.artifact-directory+json`) of `{ path, sha256, size, mediaType }` entries sorted by path. The manifest and the files all get `meta.kind`. Symbolic links are refused, not followed.

### Errors

| Error                    | When                                                                                                       | `failureClass`                                        |
| ------------------------ | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `ArtifactRefusedError`   | `reason` is `secret:<pattern>`, `size:artifact`, `size:experiment` or `invalid-meta`. Nothing was written. | `policy-violation`, or `budget-exceeded` for `size:*` |
| `ArtifactNotFoundError`  | No stored bytes. `pruned` says whether retention removed them.                                             | n/a                                                   |
| `ArtifactIntegrityError` | Stored bytes do not match their digest, or two contents share one.                                         | `infrastructure-failure`                              |
| `ArtifactStorageFailure` | The backend failed. `code` holds the errno, such as `ENOSPC`.                                              | `infrastructure-failure`, so retryable                |

A malformed digest (anything but 64 lowercase hex characters) throws a `TypeError`. Digests are the only input that becomes a path, so a caller cannot reach outside the store's root.

## Kinds

The kinds come from `ARTIFACT_KINDS` in `@vcpu/research-core`. The `artifact` table's `ck_artifact_kind` constraint uses the same list.

| Kind                       | Holds                                    |
| -------------------------- | ---------------------------------------- |
| `candidate-source`         | The candidate's RTL                      |
| `patch`                    | The diff from the baseline               |
| `test-vectors`             | Generated stimulus and expected results  |
| `verification-report`      | `verify.json` and unit test results      |
| `synthesis-report`         | Yosys statistics and netlists            |
| `timing-report`            | OpenSTA reports                          |
| `power-report`             | Power estimates, where available         |
| `agent-output`             | What an agent returned                   |
| `tool-log`                 | stdout and stderr of EDA commands        |
| `waveform`                 | FST or VCD traces, when enabled          |
| `experiment-config`        | The configuration an experiment ran with |
| `reproducibility-manifest` | Everything needed to rerun an experiment |

When the same bytes are stored as more than one kind, the metadata records every kind, and retention keeps them for the longest rule among those kinds.

## Local-disk layout

`LocalDiskArtifactStore.fromEnv()` opens the store at `RESEARCH_ARTIFACT_ROOT`, resolved against the repository root. The default is `.research/artifacts`, which is git-ignored.

```text
.research/artifacts/
  objects/<aa>/<bb>/<sha256>             the bytes, mode 0444, written once
  objects/<aa>/<bb>/<sha256>.meta.json   kinds, size, media type, name, storedAt, pruned
  tmp/                                   puts in progress; emptied when the store opens
```

`<aa>` and `<bb>` are the first two and the next two hex characters of the digest.

### How a put works

1. Stream the source into `tmp/<id>.part`, updating the SHA-256, the size and the secret scanner on each chunk. Refuse as soon as the size passes `maxArtifactBytes` or a secret pattern matches.
2. fsync the file and make it read-only.
3. If the object already exists, compare sizes. Equal sizes mean a hit: nothing is written and the put returns `deduplicated: true`. Different sizes would mean a hash collision or a corrupted object, so the put fails with `ArtifactIntegrityError`.
4. Otherwise, check the experiment budget, stage the sidecar as `tmp/<id>.meta.json`, rename the object into `objects/`, then rename the sidecar beside it.

The object rename is the commit point. A crash before it leaves nothing under `objects/`, and the next `open` empties `tmp/`. A crash between the two renames leaves an object whose sidecar is still in `tmp/`. The next `open` moves that sidecar into place. Puts of the same digest are serialised within a process, so of two concurrent puts of the same bytes, one writes and the other reports `deduplicated: true`.

## Size limits

- **Per artifact:** `maxArtifactBytes`, default 1 GiB. Enforced while streaming, so an oversized source is never fully written.
- **Per experiment:** the caller creates one `ExperimentByteBudget(limitBytes)` per experiment, from the campaign's `maxArtifactBytes`, and passes it to every put. A put that would overrun it is refused with `size:experiment`. Deduplicated puts write nothing, so they cost nothing and are never refused by the budget. The bytes are reserved before the commit and released if the commit fails.

## Secret scanning

Every put is scanned before it can commit. A match refuses the put with `reason: 'secret:<pattern>'`, and nothing is stored. The patterns are in `SECRET_PATTERNS` in `packages/artifact-storage/src/secrets.ts`.

| Pattern          | Matches                                                                                                                    |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `anthropic-key`  | `sk-ant-` followed by at least 16 key characters                                                                           |
| `openai-key`     | `sk-` (also `sk-proj-`) followed by at least 32 key characters                                                             |
| `github-token`   | `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_` with at least 36 characters, and `github_pat_`                                      |
| `aws-access-key` | `AKIA` or `ASIA` followed by exactly 16 uppercase letters or digits                                                        |
| `private-key`    | A PEM `-----BEGIN … PRIVATE KEY-----` header                                                                               |
| `bearer-token`   | `Bearer` followed by a token of at least 20 characters                                                                     |
| `env-secret`     | A line like `NAME_TOKEN=value`, also `_SECRET`, `_PASSWORD`, `_API_KEY` and similar, with a value of at least 8 characters |

Each pattern has a left boundary, so it does not fire inside a longer identifier or hash. Each also needs a minimum length, so `Bearer <token>` or an empty `RESEARCH_API_TOKEN=` in documentation passes. The Project 3 RTL, its JSON reports and the Yosys statistics all pass. `.env.example` is refused because it contains `POSTGRES_PASSWORD=research`.

Text is scanned in full, in chunks that overlap by 1024 characters, so a key split across two chunks is still found. Content counts as text if its media type is textual or its first chunk has no NUL byte. Binary content, such as an FST waveform, is scanned only up to its first 1 MiB (`binaryScanLimitBytes`).

## Retention

`RetentionEngine.apply(now, policy, store, { dryRun })` lists the store, works out each object's age from its `storedAt`, and prunes the objects the policy expires. Pruning removes the bytes and keeps the metadata with `pruned: true`, `prunedAt` and `prunedReason`. The report lists each pruned digest with its kinds, size, age and rule. With `dryRun` nothing changes. Putting pruned bytes again restores them, with a new `storedAt`.

`DEFAULT_RETENTION_POLICY`:

| Kinds                                                                                                                                                                                    | Kept    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `reproducibility-manifest`, `experiment-config`, `candidate-source`, `patch`, `test-vectors`, `verification-report`, `synthesis-report`, `timing-report`, `power-report`, `agent-output` | Forever |
| `tool-log`                                                                                                                                                                               | 30 days |
| `waveform`                                                                                                                                                                               | 14 days |
| Any kind without a rule                                                                                                                                                                  | Forever |

A policy is `{ rules: [{ kind, maxAgeDays | null }], defaultMaxAgeDays | null }`, where `null` means forever. `RetentionPolicySchema` validates it.

## Adding a backend

`runArtifactStoreContractTests(name, factory)` from `@vcpu/artifact-storage/contract-tests` is the store's behaviour as a Vitest suite. It covers round trips, deduplication, concurrency, `has`, `stat` and `list`, delete, prune and restore, size limits, kind validation and secret refusal. A new backend passes a factory that returns a fresh, empty store, configured with the `maxArtifactBytes` and `clock` the suite asks for. `src/local-disk.test.ts` runs it against a temp directory. Tests specific to the local store, such as crash recovery and layout, live in the same file.
