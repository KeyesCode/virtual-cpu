# VCPU-8 CPU research data

This folder holds small, committed summaries of measurements on the VCPU-8 RTL, so that a change to the design shows up as a reviewable diff. Raw tool output does not belong here: full logs, netlists and reports stay in `hardware/rtl/vcpu8/build/`, which is git-ignored and rebuilt by the make targets.

Every file here is written by a make target, never by hand, and records the git commit and tool versions it came from. Every number in it comes from a command that was actually run.

| Path                                       | Written by                                  | Contents                                                                                                                                                                          |
| ------------------------------------------ | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [synth/baseline.json](synth/baseline.json) | `make -C hardware/rtl/vcpu8 synth-baseline` | The synthesis summary: generic Yosys cell, flip-flop and gate counts, logic depth, memory inference, iCE40 and ECP5 utilisation, nextpnr Fmax estimates and the reviewed warnings |
| [synth/baseline.md](synth/baseline.md)     | `make -C hardware/rtl/vcpu8 synth-baseline` | The same summary as tables                                                                                                                                                        |

`make -C hardware/rtl/vcpu8 synth-compare` reruns synthesis and prints every difference from the committed baseline. Rewrite the baseline only on purpose, with `make synth-baseline`, and commit it together with the change that moved the numbers. [docs/hardware/synthesis-guide.md](../../docs/hardware/synthesis-guide.md) explains what each figure means and what it does not.
