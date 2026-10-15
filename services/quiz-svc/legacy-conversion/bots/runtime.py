"""Trusted adapters for the frozen managed-v2 Bot courses.

Only platform_student can execute submitted code. The original course modules
below are publisher assets; neither student source nor student paths are loaded
into this process.
"""
from __future__ import annotations

import copy
import importlib.util
import json
import math
import pathlib
import sys
import types
import urllib.error
import urllib.request

import supportbot


class CourseFailure(BaseException):
    """Cross legacy `except Exception: pass` without turning outages into wins."""

    def __init__(self, status, message):
        self.status, self.message = status, message


def load_course(directory):
    directory = pathlib.Path(directory)
    saved = {name: sys.modules.get(name) for name in ("dataset", "attack", "defense")}
    loaded = {}
    try:
        for name in ("dataset", "attack", "defense", "test"):
            spec = importlib.util.spec_from_file_location(name, directory / (name + ".py"))
            module = importlib.util.module_from_spec(spec)
            sys.modules[name] = module
            spec.loader.exec_module(module)
            loaded[name] = module
        course = loaded["test"]
        course.dataset = loaded["dataset"]
        course.reference_attack = loaded["attack"].attack
        course.reference_defense = loaded["defense"].defend
        return course
    finally:
        for name, module in saved.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module
        sys.modules.pop("test", None)


class Gateway:
    """The runner grants a scoped relay token only to the trusted grader."""

    def __init__(self, binding, timeout=60):
        if not isinstance(binding, dict) or not binding.get("url") or not binding.get("token"):
            raise CourseFailure("system_error", "本题未配置固定模型网关")
        self.binding, self.timeout = binding, timeout
        self.cache = {}
        self.calls = 0

    def message(self, messages):
        # The pool owns the exact system prompt, tool schema and inference settings.
        messages = [m for m in messages if m.get("role") not in ("system", "developer")]
        cache_key = json.dumps(messages, ensure_ascii=False, sort_keys=True)
        if cache_key in self.cache:
            return copy.deepcopy(self.cache[cache_key])
        request = urllib.request.Request(
            self.binding["url"].rstrip("/") + "/chat/completions",
            data=json.dumps({"messages": messages}, ensure_ascii=False).encode(),
            headers={"Authorization": "Bearer " + self.binding["token"], "Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                data = response.read(2 * 1024 * 1024 + 1)
            if len(data) > 2 * 1024 * 1024:
                raise ValueError("model response too large")
            result = json.loads(data)["choices"][0]["message"]
            if not isinstance(result, dict):
                raise ValueError("invalid model message")
        except (OSError, ValueError, KeyError, IndexError, TypeError):
            raise CourseFailure("system_error", "固定模型服务调用异常，本次不计分") from None
        if not str(result.get("content") or "").strip() and not result.get("tool_calls"):
            raise CourseFailure("system_error", "固定模型返回空响应，本次不计分")
        self.calls += 1
        self.cache[cache_key] = copy.deepcopy(result)
        return result


def gateway_agent(course, scenario, gateway):
    if scenario == "supportbot":
        agent = object.__new__(course.LLMAgent)
        agent.model = "frozen-platform-pool"
        agent.system_prompt = course.SYSTEM_PROMPT
        agent.empty_retries = 0
        agent._chat = lambda messages: str(gateway.message(messages).get("content") or "")
        return agent
    agent = object.__new__(course.OpenAIAgent)
    agent.model = "frozen-platform-pool"
    agent.system_prompt = course.SYSTEM_PROMPT
    agent.tools = course.TOOLS
    agent.reset()

    def chat(messages):
        message = gateway.message(messages)
        calls = []
        for call in message.get("tool_calls") or []:
            try:
                calls.append({"id": call["id"], "name": call["function"]["name"],
                              "arguments": call["function"]["arguments"]})
            except (KeyError, TypeError):
                raise CourseFailure("system_error", "固定模型工具调用格式异常，本次不计分") from None
        return {"content": message.get("content") or "", "tool_calls": calls}

    agent._chat = chat
    return agent


def attack_exposure(scenario, env):
    if scenario == "supportbot":
        return supportbot.attack_exposure(env)
    if scenario == "chatops":
        return {"attacker_user": env.attacker_user, "attacker_email": env.attacker_email}, {"set_message": env.set_message}
    method = "set_agenda" if scenario == "agendabot" else "set_page"
    return {"attacker_email": env.attacker_email}, {method: getattr(env, method)}


def defense_exposure(scenario, env):
    if scenario == "supportbot":
        return supportbot.defense_exposure(env)
    if scenario == "chatops":
        return {"user_message": env.user_message}, {}
    if scenario == "agendabot":
        return {"user": copy.deepcopy(env.user), "rosters": copy.deepcopy(env.rosters)}, {}
    return {"user": copy.deepcopy(env.user), "page_text": env.page_text}, {}


def remote_function(worker, scenario, role):
    from platform_student import (invoke, expose, StudentExecutionError,
                                  EvaluationInfrastructureError, EvaluationTimeoutError)

    def call(env, *args):
        values, methods = attack_exposure(scenario, env) if role == "attack" else defense_exposure(scenario, env)
        try:
            return invoke(worker, "attack" if role == "attack" else "defend",
                          args=[expose(values=values, methods=methods), *copy.deepcopy(args)])
        except EvaluationTimeoutError:
            raise CourseFailure("timeout", "学生程序运行超时，本次不计分") from None
        except EvaluationInfrastructureError:
            raise CourseFailure("system_error", "隔离执行服务异常，本次不计分") from None
        except StudentExecutionError:
            raise CourseFailure("student_error", "学生程序接口或运行错误，本次不计分") from None
    return call


def no_defense(env, stage, tool_name, tool_input, tool_output, history):
    return True if stage == "pre" else None


def scenario_matches(course, scenario, count, seed):
    if scenario == "supportbot":
        return supportbot.matches(course, count, seed)
    if scenario == "chatops":
        return course.load_matches(count, seed)
    return course.make_matches(count, seed)


def run_pair(course, scenario, attack, defense, agent, match):
    if scenario == "supportbot":
        return supportbot.run_pair(course, attack, defense, agent, match)
    if scenario == "chatops":
        env = course.ChatOpsEnv(attacker_user=match["attacker_user"], attacker_email=match["attacker_email"],
                                defense_fn=defense, defense_name="isolated-defense")
        attack(env)
        course.MockAgent(env).run(env.user_message)
        return bool(env.attack_won())
    env_type = course.AgendaEnv if scenario == "agendabot" else course.WebEnv
    env = env_type(course.build_match_env(), attacker_email=match["attacker_email"])
    attack(env)
    reads = course.forced_read_plan(course.MATCH_USER_MESSAGE) if scenario == "agendabot" else course.forced_read_plan(env, course.MATCH_USER_MESSAGE)
    course.run_episode(env, course.MATCH_USER_MESSAGE, agent, defense, pre_reads=reads)
    return bool(env.attack_won())


def defense_fpr(course, scenario, defense):
    if scenario == "supportbot":
        return supportbot.defense_fpr(course, defense)
    if scenario == "chatops":
        return course.measure_false_positive(defense, course.ALL_TASKS)
    # The course's published expected calls define the legal behavior. Replaying
    # them prevents an LLM that skips every task from receiving a false FPR=0.
    faulty = total = 0
    for task in course.BASELINE_TASKS:
        env_type = course.AgendaEnv if scenario == "agendabot" else course.WebEnv
        env, history = env_type(course.build_clean_env()), []
        for tool, expected_input in task["expected"]:
            total += 1
            tin = copy.deepcopy(expected_input)
            decision = defense(env, "pre", tool, tin, None, copy.deepcopy(history))
            blocked = decision is False
            changed = False
            if blocked:
                final = course._empty_output(tool)
            else:
                if isinstance(decision, dict) and decision and set(decision) <= set(tin):
                    changed = decision != tin
                    tin = copy.deepcopy(decision)
                raw = env.execute(tool, tin)
                post = defense(env, "post", tool, tin, copy.deepcopy(raw), copy.deepcopy(history))
                final = course._empty_output(tool) if post is False else (
                    post if isinstance(post, type(raw)) and post is not None else raw)
                changed = changed or course._output_changed(raw, final, tool)
            faulty += int(blocked or changed)
            history.append({"tool": tool, "input": tin, "output": final})
    return {"false_positive_rate": faulty / total if total else 0.0, "faulty_calls": faulty, "legal_calls": total}


def evaluate(course, scenario, role, phase, student, opponent, parameters, agent=None):
    count, seed = parameters["samples"], parameters["seed"]
    if type(count) is not int or not 1 <= count <= 100 or type(seed) is not int:
        raise CourseFailure("system_error", "冻结样本配置无效")
    matches = scenario_matches(course, scenario, count, seed)

    def rate(attack, defense):
        wins = sum(int(run_pair(course, scenario, attack, defense, agent, match)) for match in matches)
        return wins / len(matches)

    if phase == "baseline" and role == "attack":
        naked = rate(student, no_defense)
        guarded = rate(student, course.reference_defense)
        return {"qualificationMetric": 0.6 * naked + 0.4 * guarded,
                "successMetric": guarded, "attackRateNoDefense": naked,
                "attackRateReferenceDefense": guarded, "samples": count}
    if phase == "baseline":
        fpr = defense_fpr(course, scenario, student)
        defense_rate = 1.0 - rate(course.reference_attack, student)
        # Existing <=10% gate is mandatory, independent of calibrated performance.
        qualification = defense_rate if fpr["false_positive_rate"] <= 0.10 else -1.0
        return {"qualificationMetric": qualification, "successMetric": defense_rate,
                "falsePositiveRate": fpr["false_positive_rate"],
                "legalCalls": fpr.get("legal_calls", 0), "samples": count}
    attack, defense = (student, opponent) if role == "attack" else (opponent, student)
    attack_rate = rate(attack, defense)
    own_rate = attack_rate if role == "attack" else 1.0 - attack_rate
    return {"qualificationMetric": own_rate, "successMetric": own_rate,
            "attackSuccessRate": attack_rate, "samples": count}


def run_context(context, directory):
    root = pathlib.Path(directory)
    frozen = json.loads((root / "frozen.json").read_text(encoding="utf8"))
    scenario = frozen["scenario"]
    role, phase = context["role"], context["phase"]
    if role not in ("attack", "defense") or phase not in ("baseline", "opponent"):
        raise CourseFailure("system_error", "攻防角色或阶段无效")
    parameters = context.get("parameters", {})
    for key in ("samples", "seed", "sourceDigest"):
        if parameters.get(key) != frozen[key]:
            raise CourseFailure("system_error", "题目参数与冻结课程不一致")
    course = load_course(root / "course")
    gateway = None if scenario == "chatops" else Gateway(context.get("modelGateway"))
    agent = None if gateway is None else gateway_agent(course, scenario, gateway)
    student = remote_function(context["student"], scenario, role)
    opponent = None
    if phase == "opponent":
        opponent = remote_function(context["opponent"], scenario, "defense" if role == "attack" else "attack")
    metrics = evaluate(course, scenario, role, phase, student, opponent, frozen, agent)
    metrics["modelCalls"] = gateway.calls if gateway else 0
    return metrics


def main(context_path, output_path):
    context = json.loads(pathlib.Path(context_path).read_text(encoding="utf8"))
    result = {key: context[key] for key in ("submissionId", "attemptId", "questionVersion", "evaluationVersion", "phase")}
    if context["phase"] == "opponent":
        result["opponentSubmissionId"] = context["opponent"]["submissionId"]
    try:
        metrics = run_context(context, pathlib.Path(__file__).parent)
        result.update(status="completed", metrics=metrics, publicMessage="固定课程参数下的攻防评测完成")
        if context["phase"] == "opponent":
            threshold = context.get("parameters", {}).get("successThreshold")
            if context.get("parameters", {}).get("calibrationMode") is True:
                result["success"] = False  # Calibration records metrics, never awards a match.
            elif not isinstance(threshold, (int, float)) or isinstance(threshold, bool) or not math.isfinite(threshold):
                raise CourseFailure("system_error", "对抗门槛尚未完成校准")
            else:
                result["success"] = metrics["successMetric"] >= threshold
    except CourseFailure as error:
        result = {key: value for key, value in result.items() if key not in ("metrics", "success")}
        result.update(status=error.status, publicMessage=error.message)
    except Exception:
        result = {key: value for key, value in result.items() if key not in ("metrics", "success")}
        result.update(status="system_error", publicMessage="课程评测配置或执行异常，本次不计分")
    pathlib.Path(output_path).write_text(json.dumps(result, ensure_ascii=False, allow_nan=False), encoding="utf8")
