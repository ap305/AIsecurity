"""Real subprocess HTTP-RPC smoke tests; no LLM calibration is claimed."""
from __future__ import annotations
import argparse
import ast
import json
import os
import pathlib
import secrets
import subprocess
import sys
import time
from unittest.mock import patch


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=pathlib.Path, required=True)
    parser.add_argument("--rpc", type=pathlib.Path, required=True)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    parser.add_argument("--bigram", type=pathlib.Path, required=True)
    args = parser.parse_args()
    args.source, args.rpc, args.output, args.bigram = (path.resolve() for path in (args.source, args.rpc, args.output, args.bigram))
    sys.path[:0] = [str(args.rpc.resolve()), str(pathlib.Path(__file__).resolve().parents[1])]
    import build_bots
    import bot_runtime
    import build_prompts
    import prompt_runtime
    import build_classes
    import class_runtime
    from platform_student import invoke, expose
    args.output.mkdir(parents=True, exist_ok=False)
    template = (args.rpc / "worker-template.py").read_text(encoding="utf8")
    children, logs = [], []

    def worker(package, code):
        directory = (args.output / ("worker-" + secrets.token_hex(4))).resolve()
        directory.mkdir()
        (directory / "code.py").write_text(code, encoding="utf8")
        config = dict(token=secrets.token_hex(16), maxRequestBytes=1048576, maxResponseBytes=1048576,
                      maxArrayBytes=1048576, maxObjects=16, maxCalls=10000, timeoutSeconds=90,
                      bootstrap=str((package / "public" / "bootstrap.py").resolve()))
        (directory / "config.json").write_text(json.dumps(config), encoding="utf8")
        code = template.replace("'/worker/config.json'", repr(str(directory / "config.json")))
        code = code.replace("'/materials/code.py'", repr(str(directory / "code.py")))
        code = code.replace("'/materials'", repr(str(directory)))
        code = code.replace("'/worker/public'", repr(str((package / "public").resolve())))
        code = code.replace("http.server.ThreadingHTTPServer(('0.0.0.0', 9000), Handler).serve_forever()",
                            "server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)\nprint(server.server_port,flush=True)\nserver.serve_forever()")
        (directory / "worker.py").write_text(code, encoding="utf8")
        log = (directory / "stderr.log").open("w", encoding="utf8")
        logs.append(log)
        process = subprocess.Popen([sys.executable, "-B", str(directory / "worker.py")], stdout=subprocess.PIPE, stderr=log, text=True, encoding="utf8")
        children.append(process)
        port = process.stdout.readline().strip()
        if not port.isdigit():
            raise RuntimeError("Worker startup failed")
        return dict(config, url="http://127.0.0.1:" + port, protocolVersion=2, deadline=time.time() * 1000 + 90000)

    def reference(number, role):
        source = next((args.source / "题目" / "对抗").glob("A" + number + "-*")) / "backend" / "code" / (role + ".py")
        tree = ast.parse(source.read_text(encoding="utf-8-sig"))
        names = build_classes.SYMBOLS.get(number, {}).get(role, ["attack" if role == "attack" else "defend"])
        return "\n\n".join(ast.unparse(node) for node in tree.body if isinstance(node, (ast.FunctionDef, ast.ClassDef)) and node.name in names)

    results, envelopes = [], []
    def record_result(runtime, number, phase, metrics):
        # Feed metrics computed by the real worker interaction through the actual
        # production result serializer. Only repeated evaluation is bypassed.
        context = {"submissionId": "rpc-" + number, "attemptId": "attempt-" + number + "-" + phase,
                   "questionVersion": 1, "evaluationVersion": "rpc-fixture-v1", "phase": phase,
                   "role": "attack" if phase == "opponent" else "defense", "parameters": {"successThreshold": .05},
                   "opponent": {"submissionId": "opponent-" + number}}
        context_file, output_file = args.output / "serializer-context.json", args.output / "serializer-result.json"
        context_file.write_text(json.dumps(context), encoding="utf8")
        with patch.object(runtime, "run_context", return_value=metrics):
            runtime.main(context_file, output_file)
        envelopes.append({"input": context, "result": json.loads(output_file.read_text(encoding="utf8"))})
    try:
        for number in bot_runtime.BOT_IDS:
            package = args.output / ("package-" + number)
            build_bots.build_pair(args.source, number, "attack", package)
            course = bot_runtime.load_course(package / "course")
            attack_worker = worker(package, reference(number, "attack"))
            defense_worker = worker(package, reference(number, "defense"))
            attack = bot_runtime.remote_function(attack_worker, number, "attack")
            defense = bot_runtime.remote_function(defense_worker, number, "defense")
            class ReachedModel(BaseException):
                pass
            class ModelBoundary:
                def message(self, _messages):
                    raise ReachedModel()
            match = bot_runtime.scenario_matches(course, number, 1, 42)[0]
            try:
                bot_runtime.run_pair(course, number, attack, defense, ModelBoundary(), match)
            except ReachedModel:
                pass
            else:
                raise AssertionError("Attack did not reach model invocation")
            class NoToolModelStub:
                def message(self, _messages):
                    return {"content": "Protocol fixture completed", "tool_calls": []}
            normal_failure = bot_runtime.run_pair(course, number, attack, defense, NoToolModelStub(), match)
            if normal_failure:
                raise AssertionError("An idle target model cannot satisfy the attack objective")
            fpr = bot_runtime.defense_false_positive(course, number, defense)
            if fpr != 0:
                raise AssertionError("Reference defense did not preserve all legal calls")
            paired_metrics = bot_runtime.evaluate(course, number, "attack", "opponent", attack, defense, {"samples": 1, "seed": 42}, NoToolModelStub())
            baseline_metrics = bot_runtime.evaluate(course, number, "defense", "baseline", defense, None, {"samples": 1, "seed": 42}, NoToolModelStub())
            record_result(bot_runtime, number, "opponent", paired_metrics)
            record_result(bot_runtime, number, "baseline", baseline_metrics)
            results.append({"number": number, "attackReachedModel": True, "idleModelAttackSuccess": False, "defenseFalsePositive": fpr, "samePackageTwoRoles": True})
        # A defense cannot read the private target, even though the trusted Env has it.
        leaking = worker(package, "def defend(env, *args):\n return env.attacker_email\n")
        try:
            bot_runtime.defense_false_positive(course, "22", bot_runtime.remote_function(leaking, "22", "defense"))
        except bot_runtime.CourseFailure as exc:
            assert exc.status == "student_error"
        else:
            raise AssertionError("Private target leaked")
        prompt_results = []
        for number in prompt_runtime.PROMPT_IDS:
            package = args.output / ("package-" + number)
            samples = 20 if number == "02" else 4
            build_prompts.build_pair(args.source, number, "attack", package, samples=samples)
            course = bot_runtime.load_course(package / "course")
            attack_worker = worker(package, reference(number, "attack"))
            defense_worker = worker(package, reference(number, "defense"))
            attack = prompt_runtime.remote_function(attack_worker, number, "attack")
            defense = prompt_runtime.remote_function(defense_worker, number, "defense")
            class ProtocolModelStub:
                def message(self, _messages):
                    content = "{}" if number == "02" else ('{"J_goal":0,"J_unsafe":0,"J_refusal":1,"J_relevance":0,"J_actionable":0,"appropriate":1,"over_refusal":0}' if number == "08" else "protocol-test-response")
                    return {"content": content}
            previous = os.getcwd()
            try:
                os.chdir(package / "course")
                metrics = prompt_runtime.evaluate(course, number, "attack", "opponent", attack, defense,
                                                  {"samples": samples}, ProtocolModelStub())
                baseline_metrics = prompt_runtime.evaluate(course, number, "defense", "baseline", defense, None,
                                                           {"samples": samples}, ProtocolModelStub())
                assert 0 <= baseline_metrics["successMetric"] <= 1
            finally:
                os.chdir(previous)
            assert 0 <= metrics["successMetric"] <= 1
            record_result(prompt_runtime, number, "opponent", metrics)
            record_result(prompt_runtime, number, "baseline", baseline_metrics)
            prompt_results.append({"number": number, "samePackageTwoRoles": True, "realRpc": True, "modelStub": True})
        class_results = []
        for number in build_classes.CLASS_IDS:
            package = args.output / ("package-" + number)
            built = build_classes.build_pair(args.source, number, "attack", package, samples=4 if number == "03" else None, bigram_checkpoint=args.bigram)
            course = bot_runtime.load_course(package / "course")
            attack_worker = worker(package, reference(number, "attack"))
            defense_worker = worker(package, reference(number, "defense"))
            class ClassModelStub:
                def message(self, _messages):
                    if number == "03":
                        return {"content": json.dumps({"overall": 1, "quality": 1, "semantic_consistency": 1, "factual_consistency": 1, "fluency": 1, "completeness": 1, "relevance": 1})}
                    return {"content": '{"correct":1,"reason":"protocol fixture"}'}
            previous = os.getcwd()
            try:
                os.chdir(package / "course")
                if number == "03":
                    metrics = class_runtime.evaluate_watermark(course, package.resolve(), "attack", "opponent", attack_worker, defense_worker, built["frozen"], ClassModelStub())
                    baseline_metrics = class_runtime.evaluate_watermark(course, package.resolve(), "defense", "baseline", defense_worker, None, built["frozen"], ClassModelStub())
                    class InvalidJudge:
                        def message(self, _messages):
                            return {"content": '{"semantic_consistency":NaN}'}
                    try:
                        class_runtime.evaluate_watermark(course, package.resolve(), "attack", "opponent", attack_worker, defense_worker, built["frozen"], InvalidJudge())
                    except bot_runtime.CourseFailure as error:
                        assert error.status == "system_error"
                    else:
                        raise AssertionError("Nonfinite model verdict must not become a score")
                else:
                    metrics = class_runtime.evaluate_extraction(course, number, "attack", "opponent", attack_worker, defense_worker, built["frozen"], ClassModelStub())
                    baseline_metrics = class_runtime.evaluate_extraction(course, number, "defense", "baseline", defense_worker, None, built["frozen"], ClassModelStub())
                    forged = worker(package, 'class ' + build_classes.SYMBOLS[number]["attack"][0] + ':\n def __init__(self, **kwargs): pass\n def run(self, env, verbose=False): return {"coverage":1,"leak_coverage":1,"n_leaked":9999,"score":100}\n')
                    forged_metrics = class_runtime.evaluate_extraction(course, number, "attack", "opponent", forged, defense_worker, built["frozen"], ClassModelStub())
                    assert forged_metrics["attackMetric"] == 0 and forged_metrics["queries"] == 0
                    public_text = '\n'.join(p.read_text(encoding='utf8') for p in (package / 'public').glob('*.py'))
                    for span in course.dataset.secret_spans():
                        assert span['text'] not in public_text
                assert 0 <= baseline_metrics["successMetric"] <= 1
            finally:
                os.chdir(previous)
            assert 0 <= metrics["successMetric"] <= 1
            record_result(class_runtime, number, "opponent", metrics)
            record_result(class_runtime, number, "baseline", baseline_metrics)
            class_results.append({"number": number, "samePackageTwoRoles": True, "realRpc": True, "modelStub": True,
                                  "defenseBaselineExecuted": True, "forgedScoreRejected": number != "03"})
        report = {"status": "passed", "mode": "local-real-http-rpc", "realModelCalibration": False,
                  "privateTargetDenied": True, "pairs": results, "promptPairs": prompt_results, "classPairs": class_results}
        (args.output / "result.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf8")
        (args.output / "result-envelopes.json").write_text(json.dumps(envelopes, indent=2) + "\n", encoding="utf8")
        print(json.dumps(report))
    finally:
        for child in children:
            child.terminate()
            try:
                child.communicate(timeout=3)
            except subprocess.TimeoutExpired:
                child.kill()
                child.communicate()
        for log in logs:
            log.close()


if __name__ == "__main__":
    main()
