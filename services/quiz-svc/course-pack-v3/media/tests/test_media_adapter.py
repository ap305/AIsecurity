"""Meaningful boundary and target-denominator regression tests."""
import ast
import importlib.util
from pathlib import Path
import sys
import types
import tempfile
import unittest
from unittest.mock import patch
import numpy as np

ROOT = Path(__file__).resolve().parents[1]


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name,path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name]=module
    spec.loader.exec_module(module)
    return module


class AdapterTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        runtime = types.ModuleType('platform_student')
        for name in ('StudentExecutionError','EvaluationInfrastructureError','EvaluationTimeoutError'):
            setattr(runtime,name,type(name,(Exception,),{}))
        runtime.invoke=lambda *args: (_ for _ in ()).throw(AssertionError('unexpected RPC'))
        runtime.expose=lambda **kwargs: None
        sys.modules['platform_student']=runtime
        load_module('basic_codec',ROOT.parent/'basic'/'codec.py')
        load_module('judge_runtime',ROOT.parent/'basic'/'judge_runtime.py')
        load_module('basic_adapter',ROOT.parent/'basic'/'adapter.py')
        load_module('blind_detection',ROOT/'blind_detection.py')
        cls.adapter=load_module('media_adapter_test',ROOT/'adapter.py')
    def test_each_target_in_same_image_has_independent_patch_and_denominator(self):
        source=np.zeros((8,8,3),dtype=np.uint8)
        targets=[{'image_id':7,'image':source,'bbox':[i,0,i+1,1]} for i in (0,2,4)]
        rendered=[]
        def apply(image,box,patch,rng):
            rendered.append(box)
            return image, {'box':box}
        dataset=types.SimpleNamespace(apply_patch=apply,apply_occlusion=lambda image,box,params,rng:(image,params))
        calls=[]
        detector=types.SimpleNamespace(predict=lambda image: calls.append(1) or [{}])
        def evaluate(targets,predictions):
            self.assertEqual([t['image_id'] for t in targets],[0,1,2])
            self.assertEqual(set(predictions),{0,1,2})
            return {'recall':1.,'confs':[]}
        legacy=types.SimpleNamespace(compute_eligible=lambda *args:targets,evaluate_targets=evaluate)
        result=self.adapter.independent05(dataset,legacy,detector,{'hidden_test':[]},np.zeros((3,32,32)),42)
        self.assertEqual(result[3],3)
        self.assertEqual(len(rendered),3)
        self.assertEqual(len(calls),9)
    def test_invalid_qualification_cannot_pass_zero_reference_threshold(self):
        evaluator=types.SimpleNamespace(evaluate=lambda ctx:{'score':0.,'metrics':{'qualified':False}})
        ctx=types.SimpleNamespace(id='A11')
        with patch.object(self.adapter,'configure',return_value=(None,None)):
            result=self.adapter.evaluate(evaluator,ctx,'baseline',{})
        self.assertLess(result['metrics']['qualificationMetric'],0)
        self.assertEqual(result['metrics']['legalityGate'],0)
    def test_paired_patch_batch_size_shortcut_cannot_detect_attacks(self):
        clean = [np.full((2,2,3),index,dtype=np.uint8) for index in range(8)]
        targets = [{'image':image,'bbox':[0,0,1,1]} for image in clean]
        dataset = types.SimpleNamespace(SEED=42,
            load_benchmark=lambda **kwargs:{'hidden_test':[{'image':image} for image in clean]},
            apply_patch=lambda image,*args:(image+100,{}))
        legacy = types.SimpleNamespace(compute_eligible=lambda *args:targets,
                                      evaluate_targets=lambda *args:{'recall':0})
        evaluator = types.SimpleNamespace(_preflight_data=lambda *args:None,
            _code_module=lambda name:dataset,_load_legacy=lambda ctx:legacy,
            _teacher_detector_05=lambda *args:types.SimpleNamespace(predict=lambda image:[{}]))
        batches=[]
        model = types.SimpleNamespace(predict_many=lambda images:batches.append(len(images)) or
                                      np.full(len(images),1. if len(images)==1 else 0.))
        defense = types.SimpleNamespace(call=lambda *args:model)
        ctx = types.SimpleNamespace(role='defense',code_dir=Path('/private'),private_order_seed=bytes(range(32)))
        with patch.object(self.adapter,'patch05',return_value=np.zeros((3,32,32))):
            result=self.adapter.paired05(evaluator,ctx,None,defense)
        self.assertEqual(batches,[16])
        self.assertEqual(result['metrics']['defense_successes'],0)
        self.assertEqual(result['score'],0.)
    def test_baseline_half_order_shortcut_fails_but_real_image_scores_restore(self):
        images=[np.zeros((2,2,3),dtype=np.uint8) for _ in range(40)]
        bundle={'hidden_test':[{'image':image,'annotations':[{'bbox':[0,0,1,1]}]} for image in images]}
        dataset=types.SimpleNamespace(apply_patch=lambda image,*args:(image+100,{}))
        def stats(labels,predicted):
            tpr=float(np.mean(predicted[labels==1])); fpr=float(np.mean(predicted[labels==0]))
            return {'tpr':tpr,'fpr':fpr,'balanced_accuracy':(tpr+1-fpr)/2}
        def auc(labels,scores):
            delta=scores[labels==1][:,None]-scores[labels==0]
            return float(np.mean((delta>0)+.5*(delta==0)))
        legacy=types.SimpleNamespace(tpr_fpr_tnr=stats,auroc=auc,
                                     defense_score=lambda balanced,area:.7*balanced+.3*area)
        ctx=types.SimpleNamespace(private_order_seed=bytes(range(32)))
        seen=[]
        cheat=types.SimpleNamespace(predict_many=lambda batch:seen.append(len(batch)) or
                                    np.r_[np.zeros(len(batch)//2),np.ones(len(batch)-len(batch)//2)])
        result=self.adapter.defense05(None,ctx,types.SimpleNamespace(call=lambda *args:cheat),
                                      dataset,legacy,None,bundle,None,42)
        self.assertEqual(seen,[80])
        self.assertFalse(result['metrics']['qualified'])
        honest=types.SimpleNamespace(predict_many=lambda batch:[float(image.max()>50) for image in batch])
        result=self.adapter.defense05(None,ctx,types.SimpleNamespace(call=lambda *args:honest),
                                      dataset,legacy,None,bundle,None,42)
        self.assertEqual(result['score'],100.)
        self.assertTrue(result['metrics']['qualified'])
    def test_private_mix_is_frozen_and_inverse_mapping_keeps_actual_predictions(self):
        ctx=types.SimpleNamespace(private_order_seed=bytes(range(32)))
        samples=list(range(40)); seen=[]
        def predict(batch):
            seen.append(list(batch)); return batch
        actual=self.adapter.mixed_predictions(ctx,samples,predict,'fixture')
        repeated=self.adapter.mixed_predictions(ctx,samples,predict,'fixture')
        np.testing.assert_array_equal(actual,samples)
        np.testing.assert_array_equal(repeated,samples)
        self.assertEqual(seen[0],seen[1])
        self.assertNotEqual(seen[0],samples)
        with self.assertRaises(self.adapter.ConfigurationError):
            self.adapter.private_order(types.SimpleNamespace(),40,'fixture')
    def test_public_data_loader_does_not_ship_formal_synthetic_generators(self):
        builder=load_module('media_builder_privacy_test',ROOT/'build.py')
        with tempfile.TemporaryDirectory(dir=ROOT/'tests') as temp:
            course=Path(temp)
            code=course/'backend/code'
            code.mkdir(parents=True)
            (code/'dataset.py').write_text('def synthesize(seed=42): return "formal images"\n'
                'def generate_dataset(seed=42): return "formal labeled audio"\n'
                'def _generate_utterance(): return "secret"\n',encoding='utf8')
            for number in ('10','12'):
                public=builder.public_dataset(course,number)
                names={node.name for node in ast.walk(ast.parse(public)) if isinstance(node,ast.FunctionDef)}
                self.assertIn('load_benchmark',names)
                self.assertFalse(names & {'synthesize','generate_dataset','_generate_utterance'})
                self.assertNotIn('formal labeled audio',public)
    def test_prepared_practice_cache_cannot_copy_formal_samples(self):
        builder=load_module('media_builder_overlap_test',ROOT/'build.py')
        with tempfile.TemporaryDirectory(dir=ROOT/'tests') as temp:
            root=Path(temp); image_course=root/'A10'; audio_course=root/'A12'; public=root/'public'
            for course in (image_course,audio_course):
                (course/'backend/code/data').mkdir(parents=True)
            public.mkdir()
            np.savez(image_course/'backend/code/data/synth_images.npz',images=np.zeros((1,2,2,3),dtype=np.uint8))
            np.savez(audio_course/'backend/code/data/synth_cache.npz',audios=np.zeros((1,8),dtype=np.float32))
            np.savez(public/'media10-training.npz',images=np.ones((1,2,2,3),dtype=np.uint8))
            np.savez(public/'media12-training.npz',audios=np.ones((1,8),dtype=np.float32))
            np.savez(public/'media12-validation.npz',audios=np.full((1,8),2,dtype=np.float32))
            courses={'A10':image_course,'A12':audio_course}
            builder.verify_public_assets(courses,public)
            np.savez(public/'media10-training.npz',images=np.zeros((1,2,2,3),dtype=np.uint8))
            with self.assertRaisesRegex(ValueError,'overlaps'):
                builder.verify_public_assets(courses,public)
    def test_no_student_checkpoint_deserialization_in_grader(self):
        source=(ROOT/'grade.py').read_text(encoding='utf8')+(ROOT/'adapter.py').read_text(encoding='utf8')
        for forbidden in ('torch.load(', 'load_joblib(', 'pickle.loads(', 'exec('):
            self.assertNotIn(forbidden,source)
        worker=(ROOT/'bootstrap.py').read_text(encoding='utf8')
        self.assertIn('def initialize(value)',worker)
        self.assertIn('worker role cannot change',worker)
        self.assertIn("checkpoints.load('/materials/weights.bin'",worker)
    def test_all_sources_parse(self):
        for path in ROOT.rglob('*.py'):
            ast.parse(path.read_text(encoding='utf8'))


if __name__=='__main__': unittest.main()
