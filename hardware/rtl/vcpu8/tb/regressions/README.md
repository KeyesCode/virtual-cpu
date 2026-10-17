# Regression corpus

Every directory here is one program that once made `make verify` fail. `make verify` replays all
of them on every run, next to the fixtures, examples, directed programs and random programs.

A directory holds:

- `case.json`: format `vcpu8-verify-case/1`, with the case's name, seed and shape (for random
  programs), step limit, where it came from (`promotedFrom`, `origin`), the runner it first failed
  on (`foundOn`) and the first field that differed (`firstMismatch`);
- `program.hex`: the 256-byte image that is run, which stays valid even if the random generator
  changes;
- `program.asm`: its source, when it has one;
- `found.txt`: the failure report from when it was found.

Add one with `make -C hardware/rtl/vcpu8 promote CASE=build/failures/<name>` (or a case saved
under `build/mutants/<id>/failures/`). Replay one alone with
`make -C hardware/rtl/vcpu8 replay CASE=tb/regressions/<name>`.

| Case          | Found on                   | Why it is kept                                                                                               |
| ------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `random-s262` | mutant `field-b-unchecked` | The only random program in seeds 1–1000 that executes an RR register byte with field b ≥ 8.                  |
| `random-s6`   | mutant `alu-shr-carry`     | A random memory program whose `SHR R4` shifts a 1 out of bit 0; the lock-step FLAGS compare flags that step. |
