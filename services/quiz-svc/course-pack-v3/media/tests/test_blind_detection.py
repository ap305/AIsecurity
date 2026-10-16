"""Image/audio detector call-order shortcuts must not reveal ground truth."""
import importlib.util
from pathlib import Path
import sys
from types import SimpleNamespace as NS
import unittest
import numpy as np

ROOT=Path(__file__).resolve().parents[1]
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path)
    module=importlib.util.module_from_spec(spec)
    sys.modules[name]=module
    spec.loader.exec_module(module)
    return module
load('judge_runtime',ROOT.parent/'basic/judge_runtime.py')
blind=load('blind_detection',ROOT/'blind_detection.py')

def auc(labels,scores):
    labels,scores=np.asarray(labels),np.asarray(scores)
    delta=scores[labels==1][:,None]-scores[labels==0]
    return float(np.mean((delta>0)+.5*(delta==0)))

class PrivateOrderTests(unittest.TestCase):
    def context(self):
        return NS(code_dir=Path('/private'),private_order_seed=bytes(range(32)))

    def test_image_detector_cannot_identify_clean_and_attacked_by_call_count(self):
        images=np.array([np.full((2,2,3),label,dtype=np.uint8) for label in [0]*8+[1]*8])
        test={'images':images,'labels':np.array([0]*8+[1]*8)}
        pool=[('one',NS(apply=lambda image:image.copy())),('two',NS(apply=lambda image:image.copy()))]
        legacy=NS(build_attack_pool=lambda:pool,check_legality=lambda *args:(True,[]),roc_auc=auc,
                  accuracy=lambda labels,scores:float(np.mean((scores>=.5)==labels)),
                  eer=lambda labels,scores:1-auc(labels,scores),
                  attack_success_rate=lambda scores,valid:float(np.mean((scores<.5)&valid)))
        class CounterDetector:
            def __init__(self): self.calls=0
            def predict(self,image):
                self.calls+=1
                return float(self.calls>8)  # Perfect under original clean-first, fake-rest schedule.
        detector=CounterDetector()
        evaluator=NS(_code_module=lambda name:NS(load_benchmark=lambda **kwargs:(None,test)),
                     _restore_student_defense_11=lambda *args:detector)
        result=blind.image_defense11(evaluator,self.context(),legacy,blind.mixed_predictions)
        self.assertLess(result['score'],90.)
        self.assertEqual(detector.calls,32)
        evaluator._restore_student_defense_11=lambda *args:NS(predict=lambda image:float(image[0,0,0]))
        honest=blind.image_defense11(evaluator,self.context(),legacy,blind.mixed_predictions)
        self.assertEqual(honest['score'],100.)
        self.assertEqual(honest['metrics']['robust_auc'],1.)

    def test_audio_detector_cannot_identify_bona_spoof_stages_by_call_count(self):
        audios=np.array([[float(label)]*8 for label in [0]*8+[1]*8])
        test={'audios':audios,'labels':np.array([0]*8+[1]*8),'sample_ids':list(range(16))}
        attack=NS(attack=lambda request:{'audio':request['audio'].copy()})
        gmm=NS(means_=np.zeros(2),covariances_=np.zeros(2),weights_=np.zeros(1))
        class Detector:
            def __init__(self,honest=False):
                self.calls=0; self.honest=honest
                self._gmm_bona=self._gmm_spoof=gmm
                self.params={}
            def defend(self,request):
                self.calls+=1
                return {'spoof_probability':float(request['audio'][0]) if self.honest else float(self.calls>8)}
        detector=Detector()
        evaluator=NS(_restore_student_defense_12=lambda ctx:detector,
            _code_module=lambda name:NS(default_pool=lambda:[attack]),
            _a12_defend_many=lambda model,items,rate:np.array([model.defend({'audio':item})['spoof_probability'] for item in items]))
        def metrics(bona,spoof,threshold):
            area=auc(np.r_[np.zeros(len(bona)),np.ones(len(spoof))],np.r_[bona,spoof])
            return {'AUC':area,'EER':1-area}
        legacy=NS(THRESHOLD=.5,all_detection_metrics=metrics,efficiency=lambda *args:1.,
                  defense_score=lambda robust,clean,area,eff:100*(.4*(1-robust)+.3*(1-clean)+.3*area))
        result=blind.audio_defense12(evaluator,self.context(),legacy,test,16000,0,1,blind.private_order)
        self.assertLess(result['score'],90.)
        self.assertEqual(detector.calls,24)
        detector=Detector(honest=True)
        honest=blind.audio_defense12(evaluator,self.context(),legacy,test,16000,0,1,blind.private_order)
        self.assertEqual(honest['score'],100.)
        self.assertEqual(honest['metrics']['clean']['AUC'],1.)

if __name__=='__main__': unittest.main()
