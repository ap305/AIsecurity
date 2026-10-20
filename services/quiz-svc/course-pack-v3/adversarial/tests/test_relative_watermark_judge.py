"""Rubric binding and existing quality-gate contracts, not real-model scores."""
from __future__ import annotations
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import class_runtime as runtime
import build_classes

TEST_ROOT = Path(__file__).resolve().parents[5] / '.test-artifacts'
ORIGINAL = 'Original comparison prompt with five dimensions and overall.'
SINGLE_QUALITY = 'Original absolute single-text quality prompt.'


def parameters():
    prompt = ORIGINAL + ' ' + runtime.WATERMARK_RELATIVE_JUDGE_APPENDIX
    return {'number': '03', 'samples': 4, 'seed': 42, 'judgeRubric': runtime.WATERMARK_RELATIVE_JUDGE_ID,
            'judgePromptSha256': hashlib.sha256(prompt.encode()).hexdigest()}


class FixtureJudge:
    _json_object = staticmethod(json.loads)

    def similarity(self, original, candidate):
        raw = self._chat(self._system, original + '\n' + candidate, '')
        return self._parse_json_float(raw, 'overall')

    def quality(self, text):
        return self._parse_json_float(self._chat(self._quality_system, text, ''), 'quality')


class Teacher:
    def __init__(self):
        self.watermark = types.SimpleNamespace(generate=lambda *_args, **_kwargs: 'plain control')

    def generate(self, _env, request):
        return {'text': 'watermarked ' + request['prompt']}


class Detector:
    def detect(self, text):
        return {'is_watermarked': text.startswith('watermarked'), 'score': float(text.startswith('watermarked'))}


class FixtureGateway:
    def __init__(self, similarity):
        self.similarity, self.messages = similarity, []

    def message(self, messages):
        self.messages.append(messages)
        return {'content': json.dumps({'overall': self.similarity, 'quality': 1.})}


def fake_course(attack):
    samples = [{'sample_id': str(i), 'prompt': 'source ' + str(i), 'language': 'en'} for i in range(4)]
    dataset = types.SimpleNamespace(BigramLM=type('Bigram', (), {}),
        build_samples=lambda _natural: ({'public': samples[:2], 'hidden': samples[2:]}, ['human control']))
    return types.SimpleNamespace(dataset=dataset, reference_modules={'defense': types.SimpleNamespace(
        WatermarkDefense=Teacher, WatermarkDetector=Detector)}, reference_attack=attack,
        LLMQualityJudge=FixtureJudge, _JUDGE_SYSTEM=ORIGINAL, _JUDGE_QUALITY_SYSTEM=SINGLE_QUALITY,
        SIM_THRESHOLD=.85, VALID_TEXT_RATIO=.95, AUC_THRESHOLD=.80, QUALITY_THRESHOLD=.90,
        roc_auc=lambda *_: 1., quality_retention=lambda judge, wm, nw: judge.quality(wm[0]) / judge.quality(nw[0]))


class RelativeWatermarkJudgeTests(unittest.TestCase):
    def evaluate(self, candidate, similarity, role='attack'):
        TEST_ROOT.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=TEST_ROOT) as temporary:
            root = Path(temporary)
            (root / 'public').mkdir()
            (root / 'public/bigram.json').write_text('{}', encoding='utf8')
            (root / 'course/data').mkdir(parents=True)
            (root / 'course/data/natural_texts.jsonl').write_text('{"text":"fixture"}\n', encoding='utf8')
            (root / 'detection-order.key').write_text('1' * 64, encoding='ascii')
            course = fake_course(lambda _env, task: {'text': task['watermarked_text'] if candidate is None else candidate})
            gateway = FixtureGateway(similarity)
            rpc_module = types.SimpleNamespace(invoke=lambda *_a, **_k: self.fail('No student invocation in trusted-reference fixture'), expose=lambda: None)
            with patch.dict(sys.modules, {'platform_student': rpc_module}):
                result = runtime.evaluate_watermark(course, root, role, 'baseline', None, None, parameters(), gateway)
            return result, gateway.messages

    def test_appendix_is_exact_and_default_or_other_course_is_unchanged(self):
        course = types.SimpleNamespace(_JUDGE_SYSTEM=ORIGINAL)
        self.assertEqual(runtime.watermark_judge_system(course, {'number': '03'}), ORIGINAL)
        self.assertEqual(runtime.watermark_judge_system(course, {'number': '27'}), ORIGINAL)
        self.assertEqual(runtime.watermark_judge_system(course, parameters()), ORIGINAL + ' ' + runtime.WATERMARK_RELATIVE_JUDGE_APPENDIX)
        for bad in ({**parameters(), 'number': '27'}, {**parameters(), 'judgeRubric': 'other'},
                    {**parameters(), 'judgePromptSha256': '0' * 64}):
            with self.assertRaises(runtime.CourseFailure):
                runtime.watermark_judge_system(course, bad)
        with self.assertRaises(ValueError):
            build_classes.build_pair('.', '27', 'attack', 'unused', relative_watermark_judge=True)

    def test_negative_judge_responses_still_fail_original_hard_gate(self):
        for candidate, value in [('unrelated content', .1), ('altered factual answer', .2), ('only one retained word', .3)]:
            with self.subTest(candidate=candidate):
                result, messages = self.evaluate(candidate, value)
                self.assertEqual(result['rawAttackMetric'], 1.)
                self.assertEqual(result['qualificationMetric'], -1.)
                self.assertEqual(result['successMetric'], 0.)
                self.assertEqual(len(messages), 4)
                self.assertTrue(all(m[0]['content'] == ORIGINAL + ' ' + runtime.WATERMARK_RELATIVE_JUDGE_APPENDIX for m in messages))

    def test_identity_is_always_judged_and_never_replaced_with_a_synthetic_one(self):
        result, messages = self.evaluate(None, .2)
        self.assertEqual(len(messages), 4)
        self.assertEqual(result['semanticSimilarity'], .2)
        self.assertEqual(result['qualificationMetric'], -1.)

    def test_equal_threshold_and_original_single_text_quality_prompt_are_retained(self):
        result, _ = self.evaluate('edited text', .85)
        self.assertEqual(result['qualityGatePassed'], True)
        self.assertEqual(result['qualificationMetric'], 100.)
        _, messages = self.evaluate('edited text', .9, role='defense')
        self.assertEqual([m[0]['content'] for m in messages[-2:]], [SINGLE_QUALITY, SINGLE_QUALITY])


if __name__ == '__main__':
    unittest.main()
