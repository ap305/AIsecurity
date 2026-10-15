# Managed v2 Bot conversion

This directory owns the reproducible conversion of ChatOps, SupportBot,
AgendaBot and WebBot into eight PRD questions. `sources/` contains the exact
allowlisted server v2 assets and the original question text. No credentials,
LLM caches, user submissions or generated evaluation results belong here.

Build from the checked-in sources:

```powershell
python -B services/quiz-svc/legacy-conversion/bots/build.py --source services/quiz-svc/legacy-conversion/bots/sources --questions services/quiz-svc/legacy-conversion/bots/sources/questions.json --output .test-artifacts/bot-conversion
python -B -m unittest discover -s services/quiz-svc/legacy-conversion/bots/tests -p "test_*.py"
pnpm --filter quiz-svc exec tsx --test legacy-conversion/bots/tests/rpc.test.ts
```

The builder emits one immutable package per scenario plus `metadata.json`.
Each metadata entry contains the question ID, replacement statement, compatible
student template, administrator reference solution, full source provenance,
definition, package path and calibration recipe. The installer must import the
package, add its ID, create/freeze the declared model pool and calibrate before
publishing. Null thresholds and `calibrationRequired: true` deliberately prevent
an uncalibrated conversion from being treated as ready.

For each role, run the official reference through the actual isolated RPC worker
in both baseline and opponent phases. Baseline runs retain the original fixed
reference pool; opponent runs contain exactly the specified official pair.
Temporarily set `calibrationMode: true` in the evaluation parameters, then freeze
the returned `qualificationMetric` and `successMetric` as the corresponding
thresholds. By the approved course decision, only an exactly-zero Bot reference
opponent win rate uses `1 / frozen samples` (at least one successful sample).
Nonzero reference rates, including rates below `1 / samples`, and baseline
thresholds stay unchanged. The original zero measurement and sample count remain
in the audit evidence. This rule does not apply to ML margins. Remove calibration
mode and repeat publication self-tests against the new definition; equality
passes and a normal zero-win matchup fails. Failed or non-finite runs cannot calibrate.
`calibrate.py` can validate recorded results and materialize calibrated metadata;
the deployment installer may perform the same validated operation itself.

The installer applies this policy after reading the original completed reference
proofs, without changing package files or calibration fingerprints. Re-running
`calibrate` can therefore reuse unchanged official measurements. `verify` and
`publish` recompute frozen thresholds from those proofs and reject missing or
inconsistent decision evidence. Changed formal definitions require fresh
verification. Never edit the state while another conversion run is active.

| Scenario | Samples | Agent | Fixed model parameters |
| --- | ---: | --- | --- |
| ChatOps | 20 | Original deterministic teaching simulator | No model gateway |
| SupportBot | 3 | Real LLM, original textual tool protocol | temperature 0, seed 42, max_tokens 10000, enable_thinking false |
| AgendaBot | 4 | Real LLM, original tools and forced agenda read | Same; own frozen tool schema/system prompt |
| WebBot | 3 | Real LLM, original tools and forced page read | Same; own frozen tool schema/system prompt |

The original 60/40 attack baseline metric is retained. Defense uses its win rate
against the official attack, with the published FPR <= 0.10 gate enforced first
(`qualificationMetric=-1` on failure). Pair results report the current role's
win rate for the designated pair. Final pool scoring is exclusively platform
logic. Normal behavior checks replay the original expected legal calls, avoiding
the old false-zero FPR when an LLM simply omitted a task. The original ChatOps
numeric `fpr_gate` truthiness bug is corrected. Source and correction details are
recorded in metadata.

Student code is never imported by the grader. `platform_student.invoke/expose`
passes explicit read-only values and allowlisted synchronous callbacks. The worker
gets only the public bootstrap and formatting/backend helpers; hidden tasks,
authoritative mutable environments, reference programs and scoring code remain
in the evaluator. Only the evaluator receives the scoped model gateway token.
RPC, model and timeout failures propagate out of legacy exception handlers and
do not become valid attack failures or defense wins.

The three real-model courses require actual gateway acceptance and calibration;
offline MockAgent tests are only adapter regressions. Tests also run reference
programs in separate RPC worker processes, exercise real callback writes, verify
that defenders cannot access target identities, and check exception propagation.
