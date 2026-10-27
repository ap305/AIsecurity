"""Pinned original-author D02 contract, opt-in for a fresh calibrated revision."""
from __future__ import annotations

import ast
import hashlib

VERSION = 'v3-261012-d02-original300-v12'
ARENA_POOL_VERSION = 'v3-261012-response-snapshot4-v11'
SAMPLES = 300
TIMEOUT_MS = 86400000
EXECUTION_PROFILE = 'd02-original300-v12'
# Four 300-request passes, with the existing maximum of three HTTP attempts.
MAX_MODEL_CALLS = 4 * SAMPLES * 3
POOL_KEY = 'V3-261012-API-D02-ORIGINAL300'
ORIGINAL_HASHES = {
    'test.py': '981cf15d8884bf260e67ce1389d1bb79d36e4c9660d8190eb7237574f5ced696',
    'defense.py': '013ff7608d8e2864cc5806e9e681c53770d3a043796450c6bab6d9a55f2c9a22',
    'dataset.py': '98758caefeb6b7351091b38f41ffc7feacdedea69001dd5f615eb8c04197aae5',
    'attack.py': '0118034dd2d6da1126f3f2182499e9b30c843a2a89ceba31ff87cc48438ce284',
}
POLICY = {
    'kind': 'original-author-d02-evaluation', 'publicSamples': 150, 'hiddenSamples': 150,
    'reference': 'Original DataIsolationDefense without empty-injection passthrough',
    'rankShiftWeights': {'pair': 0.60, 'foot': 0.25, 'top': 0.15},
    'topK': 'max(10, ceil(0.1 * N))',
    'cleanRankShiftMaximum': 5, 'cleanValidRateMinimum': 0.99,
    'requiresFreshCalibration': True, 'historicalScoresUnchanged': True,
    'supersedesForD02': {
        'evaluationVersion': ARENA_POOL_VERSION, 'qualificationSamples': 20,
        'reference': 'v5 empty-injection passthrough reference',
        'evaluationTimeoutMs': 3600000, 'historicalPatchEvidenceRetained': True,
    },
}


def reference_source(original: bytes) -> str:
    if hashlib.sha256(original).hexdigest() != ORIGINAL_HASHES['defense.py']:
        raise ValueError('D02 original defense bytes differ from the uploaded author source')
    nodes = [node for node in ast.parse(original.decode('utf-8-sig')).body
             if isinstance(node, ast.FunctionDef) and node.name == 'defend']
    if len(nodes) != 1:
        raise ValueError('Expected one original defend function')
    return ast.unparse(ast.Module(body=nodes, type_ignores=[])) + '\n'


def evaluation(evaluation: dict) -> dict:
    if evaluation.get('number') != '02' or evaluation.get('role') != 'defense':
        raise ValueError('Original 300-sample restoration is restricted to D02')
    return {**evaluation, 'version': VERSION, 'samples': SAMPLES, 'maxModelCalls': MAX_MODEL_CALLS, 'timeoutMs': TIMEOUT_MS,
            'parameters': {**evaluation.get('parameters', {}), 'arenaPoolVersion': ARENA_POOL_VERSION}}


def restore_metadata(row: dict) -> None:
    """Update current D02 declarations while retaining historical patch records."""
    qualification = row.get('qualificationContract')
    if isinstance(qualification, dict):
        qualification.update(samples=SAMPLES, officialReferenceCodeUnchanged=False,
            originalAuthorReferenceBodyUnchanged=True, opponentPhaseUnchanged=False,
            opponentMetricFormulaUnchanged=True,
            referenceImplementation='Original author DataIsolationDefense; predecessor empty-injection passthrough removed')
    transport = row.get('gatewayTransportPolicy')
    if isinstance(transport, dict):
        transport.update(unchangedModelPoolAndEvaluationDeadline=False,
            underlyingModelAndInferenceParametersUnchanged=True,
            maxModelCalls=MAX_MODEL_CALLS, evaluationTimeoutMs=TIMEOUT_MS)


def question_content(content: str) -> str:
    content = content.replace('固定20个样本，公开和隐藏各10个且各占50%；模型池与官方参考算法不变。',
                              '固定300个样本，公开和隐藏各150个且各占50%；采用上传题包原始DataIsolationDefense参考实现。')
    content = content.replace('100 - defense_mean_rank_shift（越小越好）',
                              '100 - defense_mean_rank_shift（得分越大越好，RankShift越小越好）')
    return ('**原题评测恢复**：公开和隐藏各150条样本，保留原RankShift三项权重、Top-K定义和清洁门禁；'
            '校准参考为原始DataIsolationDefense，不含空注入直通分支。平台最终仍按学生对手池胜率计分。\n\n' + content)
