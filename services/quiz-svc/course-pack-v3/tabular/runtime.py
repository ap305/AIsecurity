"""Trusted privacy/recommendation scoring; no student imports or checkpoint loads.

Only publisher reference modules enter this interpreter. Every student function,
model and joblib checkpoint stays in its own worker. The grader owns labels,
membership, truth indexes, aggregation and the final score.
"""
from __future__ import annotations

import copy
import hashlib
import importlib.util
import math
import logging
import pathlib
import sys
from types import SimpleNamespace

from tabular_codec import pack, unpack
from judge_runtime import ConfigurationError, SubmissionError
from platform_student import invoke, expose, StudentExecutionError, EvaluationInfrastructureError, EvaluationTimeoutError


class InfrastructureFailure(BaseException):
    def __init__(self, timeout=False):
        self.timeout = timeout


def require(condition, message='学生接口或返回值无效'):
    if not condition:
        raise SubmissionError(message)


def clamp(value):
    value = float(value)
    require(math.isfinite(value))
    return max(0.0, min(1.0, value))


class Participant:
    def __init__(self, worker, role):
        self.worker, self.role = worker, role
        self.qi_cache = None
        self.qi_targets, self.qi_offset, self.qi_results = None, 0, []

    def call(self, operation, values, capability=None):
        try:
            args = [self.role, operation, pack(values)]
            if capability is not None:
                args.append(capability)
            result = unpack(invoke(self.worker, 'course_tabular_call', args))
            if isinstance(result, dict) and result.get('__course_exception__') == 'ValueError':
                raise ValueError('student interface rejected values')
            return result
        except EvaluationTimeoutError:
            raise InfrastructureFailure(True) from None
        except EvaluationInfrastructureError:
            raise InfrastructureFailure() from None
        except StudentExecutionError:
            logging.exception('Private worker-interface diagnostic')
            raise SubmissionError('学生代码或参数执行失败') from None

    def function(self, name):
        if name == 'qi_distance':
            return self.qi_distance
        return lambda *args, **kwargs: self.call('call', {'name': name, 'args': args, 'kwargs': kwargs})

    def qi_distance(self, row, table, columns, context=None, weights=None):
        import numpy as np
        key = (id(table), id(context), tuple(columns), id(weights))
        if self.qi_cache != key:
            self.call('qi_context', [table, columns, context, weights])
            self.qi_cache = key
            self.qi_offset, self.qi_results = 0, []
        if self.qi_targets is None:
            raw = self.call('qi_distance', {'row': row})
        else:
            require(self.qi_offset < len(self.qi_targets) and row.equals(self.qi_targets.iloc[self.qi_offset]), '公开目标批次顺序不匹配')
            if not self.qi_results:
                batch = self.qi_targets.iloc[self.qi_offset:self.qi_offset + 100]
                self.qi_results = self.call('qi_batch', {'rows': batch})
                require(isinstance(self.qi_results, list) and len(self.qi_results) == len(batch))
            raw = self.qi_results.pop(0)
            self.qi_offset += 1
        result = np.asarray(raw, dtype=np.float64)
        require(result.shape == (len(table),) and np.isfinite(result).all() and (result >= 0).all(), 'QI距离必须为长度匹配的非负有限向量')
        return result

    def model(self):
        import torch
        participant = self

        class RemoteModel(torch.nn.Module):
            def forward(self, images):
                result = participant.call('predict', {'images': images})
                require(torch.is_tensor(result) and result.ndim == 2 and result.shape[0] == images.shape[0] and result.shape[1] == 10 and bool(torch.isfinite(result).all()), '模型须返回有限的[N,10] logits')
                return result
        return RemoteModel().eval()

    def protect(self, gradients, clip_norm, noise, topk, seed):
        return self.call('protect', {'gradients': gradients, 'clip_norm': clip_norm, 'noise': noise, 'topk': topk, 'seed': seed})

    def dlg(self, model, gradients, **kwargs):
        # The archive passed hidden truth for diagnostics. It must not reach a student worker.
        kwargs = {key: value for key, value in kwargs.items() if key not in ('reference_images', 'reference_labels')}
        return self.call('dlg', {'state': model.state_dict(), 'gradients': gradients, 'kwargs': kwargs})

    def mia(self, query, images, labels, **kwargs):
        import numpy as np
        calls = 0
        budget = len(images) * int(kwargs.get('budget', 1))

        def capability_query(encoded):
            nonlocal calls
            value = unpack(encoded)
            require(isinstance(value, np.ndarray) and value.ndim == 4 and value.shape[1:] == (1, 28, 28) and len(value) > 0)
            calls += len(value)
            require(calls <= budget, '成员推断查询超出固定预算')
            return pack(query(value))
        result = self.call('mia', {'images': images, 'labels': labels, 'kwargs': kwargs}, expose(methods={'query': capability_query}))
        require(calls > 0, '成员推断必须真实查询目标')
        return result

    def forget(self, reference, model, *args, **kwargs):
        import torch
        import numpy as np
        calls = 0
        budget = sum(len(x) for x in (args[0], args[2], kwargs.get('retain_x', []))) * 3

        def capability_query(encoded):
            nonlocal calls
            images = unpack(encoded)
            require(torch.is_tensor(images) and images.ndim == 4 and images.shape[1:] == (3, 32, 32) and len(images) > 0)
            calls += len(images)
            require(calls <= budget, '遗忘验证查询超出固定预算')
            with torch.inference_mode():
                return pack(model(images))
        result = self.call('forget', {'args': args, 'kwargs': kwargs}, expose(methods={'query': capability_query}))
        require(calls > 0 and isinstance(result, dict), '遗忘验证必须真实查询目标')
        # Original A25 trusted a student-reported aggregate. Recompute it from
        # real predictions in the grader; returning verification_auc=1 cannot win.
        positive = reference.per_sample_stats(model, args[0], args[1])['loss']
        negative = reference.per_sample_stats(model, args[2], args[3])['loss']
        expected = float(reference._auc_from_losses(positive, negative))
        reported = result.get('verification_auc')
        require(isinstance(reported, (int, float)) and math.isfinite(reported) and abs(reported - expected) <= 1e-7, '遗忘验证AUC与真实模型预测不一致')
        result['verification_auc'] = expected
        return result

    def detector(self):
        owner = self

        class Detector:
            last_defense = None
            def score(self, matrix):
                return owner.call('detector', {'method': 'score', 'args': [matrix]})
            def defend(self, matrix, budget):
                self.last_defense = owner.call('detector', {'method': 'defend', 'args': [matrix, budget]})
                return self.last_defense
        return Detector()


def reference_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def reference_model(evaluator, context, relative='backend/weights/victim.pt'):
    module = evaluator._load_source_module(context, 'defense.py', 'reference_model')
    state = evaluator._teacher_state(context, relative, '冻结参考模型')
    return evaluator._construct_model(module, state, '冻结参考模型', teacher=True)


def configured(evaluator, context, participant):
    """Reuse original baseline formulas, replacing every student boundary with RPC."""
    number = context.id[1:]
    symbols = evaluator.ENTRY_SYMBOLS[context.id]
    context.student_module = SimpleNamespace(**{name: participant.function(name) for name in symbols})
    if number in ('23', '24', '25'):
        construct = evaluator._construct_model
        evaluator._student_state = lambda *_args: {'remote': True}
        evaluator._construct_model = lambda reference, state, what, teacher=False: construct(reference, state, what, teacher=True) if teacher else participant.model()
    if context.id == 'A23':
        context.student_module.attack = participant.mia
    elif context.id == 'A24':
        def dlg(model, gradients, tv_weight=0, **kwargs):
            return participant.dlg(model, gradients, tv_weight=tv_weight, **kwargs)
        context.student_module.dlg_attack = dlg
    elif context.id == 'D24':
        context.student_module._protect_core = lambda gradients, clip, noise, topk, gen: participant.protect(gradients, clip, noise, topk, int(gen.initial_seed()))
    elif context.id == 'A25':
        attack_reference = evaluator._load_source_module(context, 'attack.py', 'metric_reference')
        context.student_module.attack = lambda model, *args, **kwargs: participant.forget(attack_reference, model, *args, **kwargs)
    elif context.id == 'D30':
        evaluator._reconstruct_detector = lambda _ctx: participant.detector()
        reference = reference_module(pathlib.Path(context.code_dir) / 'defense.py', 'reco30_reference_defense')
        context.student_module.average_attack_probe = reference.average_attack_probe
    elif context.id == 'A26':
        load = evaluator._load_source_module
        def load_batched(course, filename, name):
            module = load(course, filename, name)
            if filename == 'attack.py':
                original = module.attack
                def batched(table, targets, *args, **kwargs):
                    participant.qi_targets = targets
                    return original(table, targets, *args, **kwargs)
                module.attack = batched
            return module
        evaluator._load_source_module = load_batched
    elif number == '31':
        evaluator._student_ckpt = lambda _ctx: SimpleNamespace(tensors=participant.call('mf_parameters', {}))
        if context.id == 'A31':
            module = context.student_module
            def rating_push(train, target_item, budget):
                result = participant.call('rating_push', {'train': train, 'target': target_item, 'budget': budget,
                                                         'model': module.fit_mf(train)})
                poisoned, changed, written = validate_poison31(result, train, target_item, budget)
                result.update(poisoned=poisoned, used=int(changed.sum()), compliant=True, written_target=written)
                return result
            module.rating_push_attack = rating_push
    return context


def paired23(e, c, attack, defense):
    import numpy as np
    data = e._load_23_bench(c)
    candidate = data['candidate']
    images, labels = np.asarray(candidate['images'], dtype=np.float32), np.asarray(candidate['labels'], dtype=np.int64)
    membership = np.asarray(candidate['membership'], dtype=np.int64)
    victim, protected = reference_model(e, c), defense.model()

    def run(model):
        counter = {'n': 0}
        r = attack.mia(e._make_query_fn(model, counter), images, labels, budget=e._A23_QUERY_BUDGET, fpr_target=e._FPR_TARGET, public=data['public'], seed=e._ATTACK_SEED, use_shadow=False)
        require(isinstance(r, dict) and 'scores' in r)
        scores = np.asarray(r['scores'], dtype=np.float64).reshape(-1)
        require(scores.shape == membership.shape and bool(np.isfinite(scores).all()))
        return e._mi_auc(membership, scores)
    before, after = run(victim), run(protected)
    reduction = 0.0 if before <= .5 else clamp((before - after) / (before - .5))
    clean = e._accuracy(victim, data['clean_test'])
    utility = clamp(e._accuracy(protected, data['clean_test']) / clean) if clean > 0 else 0.0
    return e._attack_score_mit(after), .7 * reduction + .3 * utility, {'aucBefore': before, 'aucAfter': after, 'utilityRetention': utility}


def paired24(e, c, attack, defense):
    import torch
    reference_attack = e._load_source_module(c, 'attack.py', 'pair_attack')
    reference_defense = e._load_source_module(c, 'defense.py', 'pair_defense')
    ds, bench = e._dataset_module(), e._load_24_bench(c)
    images, labels = e._attack_batch_24(c, ds, bench)
    victim = reference_model(e, c)
    plain = reference_attack.compute_batch_gradients(victim, images, labels)
    per_sample = reference_defense.per_sample_gradients(victim, images, labels)
    protected = defense.protect(per_sample, float(reference_defense.CLIP_NORM), float(reference_defense.NOISE_MULTIPLIER), float(reference_defense.TOPK_RATIO), e._ATTACK_SEED + 1)
    protected = protected[0] if isinstance(protected, tuple) else protected
    require(isinstance(protected, (list, tuple)) and len(protected) == len(plain))
    require(all(torch.is_tensor(g) and g.shape == p.shape and bool(torch.isfinite(g).all()) for g, p in zip(protected, plain)), '保护梯度的形状或数值无效')
    kwargs = {'batch_size': e._A24_BATCH, 'iters': int(reference_attack.DLG_ITERS), 'lr': float(reference_attack.DLG_LR), 'label_mode': str(reference_attack.DLG_LABEL_MODE), 'seed': e._ATTACK_SEED, 'ssim_every': 0}
    before = e._recon_metrics(reference_attack, attack.dlg(victim, plain, **kwargs), images, labels)
    after = e._recon_metrics(reference_attack, attack.dlg(victim, protected, **kwargs), images, labels)
    initial, final = float(before['paired']['ssim']), float(after['paired']['ssim'])
    reduction = clamp((initial - final) / initial) if initial > 1e-8 else 0.0
    clean = float(reference_defense.evaluate_accuracy(defense.model(), bench, split='test'))
    denominator = e._read_pipeline_baseline(c)
    utility = clamp(clean / denominator) if denominator > 1e-8 else 0.0
    return after['attack_score'], .7 * reduction + .3 * utility, {'ssimBefore': initial, 'ssimAfter': final, 'utilityRetention': utility}


def paired25(e, c, attack, defense):
    import numpy as np
    reference = e._load_source_module(c, 'attack.py', 'pair_attack')
    sp = e._split_25(e._dataset_module(), e._load_25_bench(c))
    victim, unlearned = reference_model(e, c), defense.model()

    def run(model):
        result = attack.forget(reference, model, sp['forget_x'], sp['forget_y'], sp['reference_x'], sp['reference_y'], retain_x=sp['retain_x'], retain_y=sp['retain_y'], fpr=e._FPR_TARGET)
        return float(result['verification_auc'])
    initial, final = run(victim), run(unlearned)
    reduction = clamp((initial - final) / (initial - .5)) if initial > .5 else 0.0
    before = float(np.mean(reference.per_sample_stats(victim, sp['retain_x'], sp['retain_y'])['correct']))
    after = float(np.mean(reference.per_sample_stats(unlearned, sp['retain_x'], sp['retain_y'])['correct']))
    retention = clamp(after / before) if before > 0 else 0.0
    return e._attack_score_mit(final), .7 * reduction + .3 * retention, {'aucBefore': initial, 'aucAfter': final, 'retainRetention': retention}


def paired26(e, c, attack, defense):
    import numpy as np
    reference_attack = e._load_source_module(c, 'attack.py', 'pair_attack')
    reference_defense = e._load_source_module(c, 'defense.py', 'pair_defense')
    bench = e._load_26_bench(c)
    release, targets = bench['release_train'], bench['targets']
    true_index = np.asarray(bench['target_true_index'], dtype=np.int64)
    for name in ('_best_numeric_cut', '_best_categorical_cut'):
        setattr(reference_defense, name, defense.function(name))
    table = reference_defense.defend(release, k=e._A26_K, seed=e._SEED)['table']
    require(len(table) == len(release))
    valid = e._validate_anon_26(c, reference_defense, release, table, e._A26_K)
    require(valid['k_anonymity_ok'] and valid['checks'].get('columns_preserved') and valid['checks'].get('qi_field_type_ok'))
    require(all(valid['checks'].get(key) is not False for key in ('sex_intact', 'race_intact', 'income_intact')))
    reference_attack.qi_distance = attack.function('qi_distance')
    attack.qi_targets = targets
    arguments = {'qi_columns': list(bench['qi_primary']), 'sensitive': list(bench['sensitive']), 'label': bench['label'], 'seed': e._SEED, 'truth_df': release}
    initial = reference_attack.attack(release, targets, true_index, **arguments)
    final = reference_attack.attack(table, targets, true_index, **arguments)
    # true_index and truth_df stay inside the trusted reference attack. Only
    # qi_distance(target-row, released-table, public-QI-context) crosses RPC.
    denominator = float(initial['reid_rate']) - float(final['reid_rate_base'])
    reduction = clamp((float(initial['reid_rate']) - float(final['reid_rate'])) / denominator) if denominator > 1e-12 else 0.0
    ncp = e._ncp_26(release, table, list(getattr(reference_defense, 'DEFENSE_DIMS', bench['qi_primary'])))
    utility = clamp(1 - ncp) if ncp is not None else 0.0
    return clamp(final['attack_score']), .7 * reduction + .3 * utility, {'reidBefore': float(initial['reid_rate']), 'reidAfter': float(final['reid_rate']), 'utilityRetention': utility}


def paired30(e, c, attack, defense):
    import numpy as np
    ds, data = e._load_data(c)
    train, test = np.asarray(data['train'], dtype=np.float32), np.asarray(data['test'], dtype=np.float32)
    target, budget = int(data['target']['item']), int(data['budget'])
    attack_module = SimpleNamespace(**{name: attack.function(name) for name in e.ENTRY_SYMBOLS['A30']})
    e._check_over_budget(attack_module, train, target, budget)
    raw = attack_module.build_fake_profiles(train, target_item=target, n_fake=budget)
    valid = e._validate_profiles(raw, train, target, budget)
    profiles = valid['profiles']
    detector = defense.detector()
    e._reconstruct_detector = lambda _ctx: detector
    c.student_module = SimpleNamespace(average_attack_probe=lambda *_args, **_kw: (profiles, target))
    evaluated = e._handler_d30(c)
    result = detector.last_defense
    kept = np.asarray(result['kept_users'], dtype=np.int64)
    clean = np.asarray(result['clean_ratings'], dtype=np.float32)
    before = ds.predict_scores(train, ds.fit_itemknn(train, e.KNN_NEIGHBORS), ds.item_stats(train)[1])
    after = ds.predict_scores(clean, ds.fit_itemknn(clean, e.KNN_NEIGHBORS), ds.item_stats(clean)[1])
    base_hr, _ = ds.hr_at_k(before, target, e.K_MAIN)
    real_positions = np.flatnonzero(kept < len(train))
    ranks = ds.ranks_of(after, target)
    final_hr = float(np.sum(ranks[real_positions] <= e.K_MAIN)) / len(train)
    attack_metric = clamp((final_hr - float(base_hr)) / e.ATTACK_TARGET_DHR)
    return attack_metric, clamp(evaluated['score'] / 100), {'exposureBefore': float(base_hr), 'exposureAfter': final_hr, 'retainedRealUsers': int(len(real_positions))}


def validate_poison31(result, train, target, budget):
    import numpy as np
    require(isinstance(result, dict) and 'poisoned' in result)
    poisoned = np.asarray(result['poisoned'], dtype=np.float32)
    require(poisoned.shape == train.shape and not np.isinf(poisoned).any())
    observed = ~np.isnan(poisoned)
    require(np.all((poisoned[observed] >= 1) & (poisoned[observed] <= 5)) and np.all(poisoned[observed] == np.floor(poisoned[observed])), '评分必须为1至5整数')
    require(not np.any(np.isnan(poisoned) & ~np.isnan(train)), '不能删除真实评分')
    same = (poisoned == train) | (np.isnan(poisoned) & np.isnan(train))
    changed = ~same
    require(int(changed.sum()) <= budget, '真实改写数量超出固定预算')
    return poisoned, changed, changed[:, target].copy()


def paired31(e, c, attack, defense):
    import numpy as np
    ds, data = e._load_data(c)
    train, test = np.asarray(data['train'], dtype=np.float32), np.asarray(data['test'], dtype=np.float32)
    target, budget = int(data['target']['item']), min(1000, int(data['budget']))
    # Validate both uploaded models through numerical RPC. They qualify for
    # their original offline baseline; pair results use actual retrained data.
    for participant in (attack, defense):
        e._mf_from_ckpt(SimpleNamespace(tensors=participant.call('mf_parameters', {})), *train.shape)
    proxy = e._mf_from_ckpt(e._load_teacher_ckpt(c, e.CLEAN_MF_ASSET), *train.shape, teacher=True)
    result = attack.call('rating_push', {'train': train, 'target': target, 'budget': budget, 'model': proxy})
    poisoned, changed, written = validate_poison31(result, train, target, budget)
    # Five bounded trusted fits: 80 epochs each, 400 maximum. No submitted
    # module/class/checkpoint deserialization runs in this grader interpreter.
    hyper = dict(dim=32, lr=.0005, reg=.05, epochs=80, batch=2048)
    clean_model = ds.fit_mf(train, seed=42, **hyper)
    poison_model = ds.fit_mf(poisoned, seed=42, **hyper)
    users, items, ratings = ds.to_arrays(poisoned)
    functions = SimpleNamespace(mad_scale=defense.function('mad_scale'), robust_weights=defense.function('robust_weights'))
    weights, protected = None, None
    for iteration in range(3):
        protected = ds.fit_mf(poisoned, seed=42 + iteration, huber_delta=1.0, sample_weights=weights, **hyper)
        residuals = ratings - ds.predict_pairs(protected, users, items)
        _scale, weights, _behavior = e._check_weight_functions(functions, residuals)
    candidate, pool = ~np.isnan(train), np.isnan(train[:, target])
    clean_prediction = ds.predict_matrix(clean_model, rated_mask=candidate)
    poison_prediction = ds.predict_matrix(poison_model, rated_mask=candidate)
    defended_prediction = ds.predict_matrix(protected, rated_mask=candidate)
    before = e._hr_target(pool, ds.ranks_of(clean_prediction, target))
    attacked = e._hr_target(pool, ds.ranks_of(poison_prediction, target), exclude=written)
    defended = e._hr_target(pool, ds.ranks_of(defended_prediction, target), exclude=written)
    attack_gain, remaining = attacked - before, defended - before
    reduction = clamp((attack_gain - remaining) / attack_gain) if attack_gain > 1e-9 else (1.0 if remaining <= 1e-9 else 0.0)
    clean_ndcg, _ = ds.ndcg_at_k(clean_prediction, test, e.K_MAIN)
    defense_ndcg, _ = ds.ndcg_at_k(defended_prediction, test, e.K_MAIN)
    utility = clamp(defense_ndcg / clean_ndcg) if clean_ndcg > 1e-12 else 1.0
    # Hash includes shape, mask and float32 values with a canonical NaN payload.
    digest = hashlib.sha256(str(poisoned.shape).encode() + np.isnan(poisoned).tobytes() + np.nan_to_num(poisoned, nan=0).astype('<f4').tobytes()).hexdigest()
    # The compact digest is private acceptance evidence; numeric metrics remain
    # compatible with the platform's strict finite-number metric protocol.
    logging.warning('trusted MF pair input sha256=%s; fits=5 epochs=400 dim=32 seed=42/43/44', digest)
    return clamp(remaining / e.ATTACK_TARGET_DHR), .7 * reduction + .3 * utility, {
        'exposureBefore': float(before), 'exposurePoisoned': float(attacked), 'exposureAfter': float(defended),
        'utilityRetention': utility, 'actualChanges': int(changed.sum()), 'trainingEpochs': 400,
        'trainingDataDigestPrefix': int(digest[:12], 16)}


PAIRED = {'23': paired23, '24': paired24, '25': paired25, '26': paired26, '30': paired30, '31': paired31}


def evaluate(evaluator, course, context):
    number, role = course.id[1:], context['role']
    if context['phase'] == 'baseline':
        result = evaluator.evaluate(configured(evaluator, course, Participant(context['student'], role)))
        score = result.get('score')
        require(isinstance(score, (int, float)) and math.isfinite(score) and 0 <= score <= 100, '基线评测分数无效')
        return {'qualificationMetric': float(score) / 100, 'referenceScore': float(score)}
    if context['phase'] != 'opponent' or not context.get('opponent'):
        raise ConfigurationError('对抗阶段缺少另一名学生的冻结提交')
    attack_worker = context['student'] if role == 'attack' else context['opponent']
    defense_worker = context['opponent'] if role == 'attack' else context['student']
    attack_metric, defense_metric, details = PAIRED[number](evaluator, course, Participant(attack_worker, 'attack'), Participant(defense_worker, 'defense'))
    return {'successMetric': clamp(attack_metric if role == 'attack' else defense_metric), 'attackMetric': clamp(attack_metric), 'defenseMetric': clamp(defense_metric), **details}
