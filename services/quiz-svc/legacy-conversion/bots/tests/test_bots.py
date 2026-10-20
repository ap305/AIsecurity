import copy
import importlib.util
import io
import json
import pathlib
import sys
import tempfile
import unittest
from unittest import mock

HERE = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
import build
import calibrate
import runtime


class BotConversionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.output = pathlib.Path(cls.temporary.name)
        cls.metadata = build.build(HERE / "sources", HERE / "sources/questions.json", cls.output)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def course(self, scenario):
        return runtime.load_course(self.output / scenario / "package/course")

    def test_build_eight_questions_and_explicit_unresolved_thresholds(self):
        self.assertEqual(len(self.metadata), 8)
        for q in self.metadata:
            e = q["definition"]["evaluation"]
            self.assertIsNone(e["baselineThreshold"])
            self.assertIsNone(e["successThreshold"])
            self.assertTrue(q["calibrationRequired"])
            self.assertEqual(q["calibration"], {"baseline": "reference", "opponent": "reference"})
            self.assertNotIn("env.query(message)", q["content"])
            self.assertNotIn("queries ≤", q["content"])
            package = pathlib.Path(q["packageDirectory"])
            manifest = json.loads((package / "manifest.json").read_text(encoding="utf8"))
            self.assertEqual(set(manifest["worker"]["files"]), {"public/bootstrap.py", "public/dataset.py", "public/backend_attack.py", "public/backend_defense.py"})
            self.assertEqual(q["definition"]["kind"], "algorithm" if q["scenarioId"] == "chatops" else "agent")
            if q["scenarioId"] != "chatops":
                params = q["poolSpec"]["parameters"]
                self.assertFalse(params["enable_thinking"])
                self.assertEqual(params["maxCalls"], 500)
                self.assertEqual(params["max_tokens"], 10000)

    def test_public_helpers_have_no_hidden_data_and_compile_reference(self):
        for scenario in build.SCENARIOS:
            package = self.output / scenario / "package"
            public = package / "public"
            spec = importlib.util.spec_from_file_location("bootstrap", public / "bootstrap.py")
            bootstrap = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(bootstrap)
            sys.path.insert(0, str(public))
            old = sys.modules.pop("dataset", None)
            try:
                for role in ("attack", "defense"):
                    module = bootstrap.load_student(package / "baselines" / (role + ".py"), package)
                    self.assertTrue(callable(getattr(module, "attack" if role == "attack" else "defend")))
                dataset = sys.modules["dataset"]
                for hidden in ("BASELINE_TASKS", "HIDDEN_TASKS", "Env", "ChatOpsEnv", "make_matches", "load_matches"):
                    self.assertFalse(hasattr(dataset, hidden))
            finally:
                sys.path.pop(0)
                sys.modules.pop("dataset", None)
                if old is not None:
                    sys.modules["dataset"] = old

    def test_agenda_only_build_freezes_transport_without_changing_inference_or_deadline(self):
        output = self.output / "agenda-only"
        records = build.build(HERE / "sources", HERE / "sources/questions.json", output, scenarios=["agendabot"])
        self.assertEqual({q["questionId"] for q in records}, {"AGENDABOT-AD-ATK", "AGENDABOT-AD-DEF"})
        self.assertEqual({p.name for p in output.iterdir()}, {"agendabot", "metadata.json"})
        policy = {"requestTimeoutMs": 300000, "gatewayTimeoutSeconds": 330}
        frozen = json.loads((output / "agendabot/package/frozen.json").read_text(encoding="utf8"))
        self.assertEqual(frozen["transportPolicy"], policy)
        course = self.course("agendabot")
        for question in records:
            self.assertEqual(question["provenance"]["transportPolicy"], policy)
            self.assertEqual(question["definition"]["evaluation"]["timeoutMs"], 2700000)
            self.assertEqual(question["poolSpec"]["parameters"], {
                "temperature": 0, "seed": 42, "max_tokens": 10000,
                "systemPrompt": course.SYSTEM_PROMPT, "tools": course.TOOLS, "tool_choice": "auto",
                "enable_thinking": False, "maxCalls": 500, "requestTimeoutMs": 300000})
        for question in self.metadata:
            if question["scenarioId"] != "agendabot":
                self.assertNotIn("requestTimeoutMs", question.get("poolSpec", {}).get("parameters", {}))
                self.assertNotIn("transportPolicy", question["provenance"])
                other = json.loads((pathlib.Path(question["packageDirectory"]) / "frozen.json").read_text(encoding="utf8"))
                self.assertNotIn("transportPolicy", other)
                self.assertEqual(runtime.gateway_timeout(other), 60)
        for scenarios in ([], ["agendabot", "agendabot"], ["unknown"]):
            with self.assertRaisesRegex(ValueError, "distinct known"):
                build.build(HERE / "sources", HERE / "sources/questions.json", self.output / "invalid-scope", scenarios=scenarios)
        self.assertFalse((self.output / "invalid-scope").exists())

    def test_gateway_uses_package_policy_and_never_retries_failed_model_request(self):
        binding = {"url": "http://fixture.invalid", "token": "fixture-token", "timeout": 9999}
        frozen = {"scenario": "agendabot", "transportPolicy": dict(runtime.AGENDA_TRANSPORT_POLICY)}
        gateway = runtime.Gateway(binding, timeout=runtime.gateway_timeout(frozen))
        with mock.patch.object(runtime.urllib.request, "urlopen", side_effect=TimeoutError("private failure")) as upstream:
            with self.assertRaises(runtime.CourseFailure) as caught:
                gateway.message([{"role": "user", "content": "fixture"}])
            self.assertEqual(caught.exception.status, "system_error")
            self.assertEqual(upstream.call_count, 1)
            self.assertEqual(upstream.call_args.kwargs["timeout"], 330)
        self.assertEqual(gateway.calls, 0)
        self.assertEqual(gateway.cache, {})
        with mock.patch.object(runtime.urllib.request, "urlopen", return_value=io.BytesIO(b'{"choices":[{"message":{"content":"done"}}]}')) as upstream:
            self.assertEqual(gateway.message([{"role": "user", "content": "fixture"}]), {"content": "done"})
            request = upstream.call_args.args[0]
            self.assertEqual(json.loads(request.data), {"messages": [{"role": "user", "content": "fixture"}]})
            self.assertEqual(upstream.call_count, 1)
        for other in ({"scenario": "agendabot"}, {"scenario": "webbot"}):
            self.assertEqual(runtime.gateway_timeout(other), 60)
        for invalid in ({"scenario": "webbot", "transportPolicy": frozen["transportPolicy"]},
                        {"scenario": "agendabot", "transportPolicy": {"gatewayTimeoutSeconds": 9999}}):
            with self.assertRaises(runtime.CourseFailure):
                runtime.gateway_timeout(invalid)

    def test_run_context_ignores_caller_transport_override(self):
        for scenario, expected in (("agendabot", 330), ("webbot", 60)):
            root = self.output / scenario / "package"
            frozen = json.loads((root / "frozen.json").read_text(encoding="utf8"))
            context = {"role": "attack", "phase": "baseline", "student": {}, "modelGateway": {},
                       "parameters": {**{key: frozen[key] for key in ("samples", "seed", "sourceDigest")},
                                      "transportPolicy": {"gatewayTimeoutSeconds": 9999}},
                       "transportPolicy": {"gatewayTimeoutSeconds": 9999}}
            with mock.patch.object(runtime, "Gateway") as gateway, \
                    mock.patch.object(runtime, "gateway_agent"), \
                    mock.patch.object(runtime, "remote_function"), \
                    mock.patch.object(runtime, "evaluate", return_value={}):
                gateway.return_value.calls = 0
                runtime.run_context(context, root)
                gateway.assert_called_once_with({}, timeout=expected)

    def test_build_from_crlf_raw_bytes_keeps_all_courses_and_public_helpers_valid(self):
        source = self.output / 'crlf-source'
        for item in (HERE / 'sources').rglob('*'):
            if not item.is_file() or '__pycache__' in item.parts:
                continue
            target = source / item.relative_to(HERE / 'sources')
            target.parent.mkdir(parents=True, exist_ok=True)
            data = item.read_bytes().replace(b'\r\n', b'\n').replace(b'\n', b'\r\n')
            target.write_bytes(data)
        records = build.build(source, source / 'questions.json', self.output / 'crlf-output')
        self.assertEqual(len(records), 8)
        for question in records:
            package = pathlib.Path(question['packageDirectory'])
            for code in package.rglob('*.py'):
                compile(code.read_bytes(), str(code), 'exec')

    def test_chatops_reference_baseline_and_pair_semantics(self):
        course = self.course("chatops")
        parameters = {"samples": 20, "seed": 42}
        attack = runtime.evaluate(course, "chatops", "attack", "baseline", course.reference_attack, None, parameters)
        defense = runtime.evaluate(course, "chatops", "defense", "baseline", course.reference_defense, None, parameters)
        self.assertEqual(attack["qualificationMetric"], 0.6)
        self.assertEqual(defense["qualificationMetric"], 1.0)
        self.assertEqual(defense["falsePositiveRate"], 0.0)
        pair = runtime.evaluate(course, "chatops", "attack", "opponent", course.reference_attack, course.reference_defense, parameters)
        self.assertEqual(pair["successMetric"], 0.0)
        block_all = lambda *args: False
        blocked = runtime.evaluate(course, "chatops", "defense", "baseline", block_all, None, parameters)
        self.assertEqual(blocked["qualificationMetric"], -1)
        empty = runtime.evaluate(course, "chatops", "attack", "baseline", lambda env: None, None, parameters)
        self.assertEqual(empty["qualificationMetric"], 0)

    def test_other_courses_deterministic_plumbing_only(self):
        # These assertions check adapters, never count as real-LLM calibration.
        for scenario in ("agendabot", "webbot"):
            course = self.course(scenario)
            match = runtime.scenario_matches(course, scenario, 1, 42)[0]
            self.assertTrue(runtime.run_pair(course, scenario, course.reference_attack, runtime.no_defense, course.MockAgent(), match))
            self.assertFalse(runtime.run_pair(course, scenario, course.reference_attack, course.reference_defense, course.MockAgent(), match))
            self.assertEqual(runtime.defense_fpr(course, scenario, course.reference_defense)["false_positive_rate"], 0)
            self.assertEqual(runtime.defense_fpr(course, scenario, lambda *args: False)["false_positive_rate"], 1)

    def test_defense_view_excludes_target_and_mutable_authority(self):
        course = self.course("webbot")
        env = course.WebEnv(course.build_match_env(), attacker_email="target@example.invalid")
        values, methods = runtime.defense_exposure("webbot", env)
        self.assertNotIn("attacker_email", values)
        self.assertFalse(methods)
        values["user"]["email"] = "changed"
        self.assertNotEqual(env.user["email"], "changed")
        attack_values, attack_methods = runtime.attack_exposure("webbot", env)
        self.assertEqual(set(attack_methods), {"set_page"})
        self.assertEqual(set(attack_values), {"attacker_email"})
        self.assertFalse(attack_methods["set_page"]("x" * 201))

    def test_error_cannot_turn_into_defender_win(self):
        course = self.course("chatops")
        def broken(*args):
            raise runtime.CourseFailure("system_error", "unavailable")
        with self.assertRaises(runtime.CourseFailure):
            runtime.evaluate(course, "chatops", "attack", "baseline", broken, None, {"samples": 1, "seed": 42})
        with self.assertRaises(runtime.CourseFailure):
            runtime.evaluate(course, "chatops", "defense", "baseline", broken, None, {"samples": 1, "seed": 42})

    def test_blocked_tool_keeps_valid_model_conversation_without_execution(self):
        # A strict protocol fixture checks the real course agent message flow;
        # this is not a model calibration or a simulated course result.
        for scenario in ("agendabot", "webbot"):
            course = self.course(scenario)
            class ProtocolGateway:
                calls = 0
                def message(gateway, messages):
                    pending = set()
                    for message in messages:
                        if message["role"] == "assistant":
                            self.assertFalse(pending, "unanswered tool call before next assistant")
                            pending.update(call["id"] for call in message.get("tool_calls", []))
                        elif message["role"] == "tool":
                            self.assertIn(message["tool_call_id"], pending)
                            pending.remove(message["tool_call_id"])
                    self.assertFalse(pending, "unanswered tool call sent to model")
                    gateway.calls += 1
                    if gateway.calls <= 2:
                        return {"content": "", "tool_calls": [{"id": str(gateway.calls), "type": "function",
                            "function": {"name": "get_user_information", "arguments": "{}"}}]}
                    return {"content": "done"}
            gateway = ProtocolGateway()
            agent = runtime.gateway_agent(course, scenario, gateway)
            env_type = course.AgendaEnv if scenario == "agendabot" else course.WebEnv
            env = env_type(course.build_clean_env())
            histories = []
            def block(env, stage, name, args, output, history):
                self.assertEqual(stage, "pre")
                histories.append(copy.deepcopy(history))
                return False
            with mock.patch.object(env, "execute", side_effect=AssertionError("blocked tool executed")):
                log = course.run_episode(env, "test", agent, block)
            self.assertEqual(gateway.calls, 3)
            self.assertEqual([len(history) for history in histories], [0, 1])
            self.assertEqual([item["blocked"] for item in log], [True, True])

    def test_calibration_never_emits_success_even_with_explicit_zero_threshold(self):
        context = {"submissionId": "s", "attemptId": "a", "questionVersion": 1,
                   "evaluationVersion": "v", "phase": "opponent", "opponent": {"submissionId": "o"},
                   "parameters": {"successThreshold": 0, "calibrationMode": True}}
        source, result = self.output / "calibration-context.json", self.output / "calibration-result.json"
        for value in (0, 1):
            source.write_text(json.dumps(context), encoding="utf8")
            with mock.patch.object(runtime, "run_context", return_value={"successMetric": value}):
                runtime.main(source, result)
            actual = json.loads(result.read_text(encoding="utf8"))
            self.assertEqual(actual["status"], "completed")
            self.assertFalse(actual["success"])
            self.assertEqual(actual["metrics"]["successMetric"], value)

    def test_calibration_requires_matching_source_and_real_model(self):
        records = []
        for q in self.metadata:
            for phase in ("baseline", "opponent"):
                record = {"questionId": q["questionId"], "phase": phase,
                          **{k: q["provenance"][k] for k in ("sourceDigest", "seed", "samples")},
                          "result": {"status": "completed", "metrics": {"qualificationMetric": 0.6 if q["role"] == "attack" else 1,
                                     "successMetric": 0.05 if q["role"] == "attack" else 1, "falsePositiveRate": 0, "modelCalls": 1,
                                     "samples": q["provenance"]["samples"]}}}
                if q["definition"]["llm"]["enabled"]:
                    record.update(modelPoolId=q["definition"]["llm"]["poolId"], modelPoolRevision=1, model="fixture-model", modelVersion="revision-one")
                records.append(record)
        calibrated = calibrate.apply_calibration(self.metadata, records)
        self.assertTrue(all(not q["calibrationRequired"] for q in calibrated))
        self.assertEqual(calibrated[0]["definition"]["evaluation"]["successThreshold"], 0.05)
        all_lost = copy.deepcopy(records)
        for r in all_lost:
            r["result"]["metrics"]["qualificationMetric"] = 0
            r["result"]["metrics"]["successMetric"] = 0
        zero_calibrated = calibrate.apply_calibration(self.metadata, all_lost)
        for q in zero_calibrated:
            self.assertEqual(q["definition"]["evaluation"]["baselineThreshold"], 0)
            self.assertEqual(q["definition"]["evaluation"]["successThreshold"], 1/q["provenance"]["samples"])
            evidence = q["calibrationEvidence"]["opponentThreshold"]
            self.assertEqual(evidence["observed"], 0)
            self.assertEqual(evidence["policy"], calibrate.ZERO_REFERENCE_POLICY)
            self.assertEqual(q["calibration"]["records"][1]["result"]["metrics"]["successMetric"], 0)
        tiny_nonzero = copy.deepcopy(records)
        for r in tiny_nonzero:
            r["result"]["metrics"]["successMetric"] = 1e-12
        self.assertTrue(all(q["definition"]["evaluation"]["successThreshold"] == 1e-12
                            for q in calibrate.apply_calibration(self.metadata, tiny_nonzero)))
        for value in (0, -1, 1.5, True, "20", 101):
            changed = copy.deepcopy(self.metadata)
            changed[0]["definition"]["evaluation"]["samples"] = value
            with self.assertRaisesRegex(ValueError, "sample count"):
                calibrate.apply_calibration(changed, records)
        wrong_samples = copy.deepcopy(records)
        wrong_samples[1]["result"]["metrics"]["samples"] = 99
        with self.assertRaisesRegex(ValueError, "sample count"):
            calibrate.apply_calibration(self.metadata, wrong_samples)
        wrong = copy.deepcopy(records)
        wrong[0]["sourceDigest"] = "changed"
        with self.assertRaises(ValueError):
            calibrate.apply_calibration(self.metadata, wrong)
        no_model = copy.deepcopy(records)
        next(r for r in no_model if r.get("modelPoolId"))["result"]["metrics"]["modelCalls"] = 0
        with self.assertRaises(ValueError):
            calibrate.apply_calibration(self.metadata, no_model)

    def test_formal_bot_zero_fails_and_exactly_one_success_passes(self):
        context = {"submissionId": "s", "attemptId": "a", "questionVersion": 1,
                   "evaluationVersion": "v", "phase": "opponent", "opponent": {"submissionId": "o"},
                   "parameters": {"calibrationMode": False}}
        source, result = self.output / "formal-context.json", self.output / "formal-result.json"
        for samples in (3, 4, 20):
            context["parameters"]["successThreshold"] = 1/samples
            source.write_text(json.dumps(context), encoding="utf8")
            for value, wins in ((0, False), (1/samples, True)):
                with mock.patch.object(runtime, "run_context", return_value={"successMetric": value, "samples": samples}):
                    runtime.main(source, result)
                actual = json.loads(result.read_text(encoding="utf8"))
                self.assertEqual(actual["status"], "completed")
                self.assertEqual(actual["success"], wins)
                self.assertEqual(actual["metrics"]["successMetric"], value)


if __name__ == "__main__":
    unittest.main()
