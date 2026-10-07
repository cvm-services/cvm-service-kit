# vendored vocab

`service-inputs.json` is a **verbatim copy** of `vocab/service-inputs.json` from the
`contextvm-services` repo (ADR-0001 D14: "the register is shared vocabulary, so the
kit and the registry both read `vocab/service-inputs.json`").

This repo reads the vendored copy so a build does not depend on a second checkout.
It is **never hand-edited here** — it is re-copied and the hash below updated.

| field | value |
| --- | --- |
| source repo | `cvm-services/contextvm-services` |
| source path | `vocab/service-inputs.json` |
| source commit | `3f93093edde8f76c202bbeac30e1a7211133ccee` |
| copied on | 2026-10-05 |
| sha256 | `f21190037d264d891cb4fad12dcfa77516da290d89aa1989d36f75f8919b508b` |
| source blob size | 6366 bytes |

The same commit is what `cvm-registry` vendored, so the kit and the registry
enforce one register. `tests/tier_recompute_test.ts` fails if the vendored copy's
ladder disagrees with `src/vocab.ts` (`tier_tag.ranks` is checked rank by rank).

To refresh:

```sh
git -C <contextvm-services> show <commit>:vocab/service-inputs.json > vocab/service-inputs.json
sha256sum vocab/service-inputs.json
```
