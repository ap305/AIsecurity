"""Private author-side JPEG parameter probe; never included in student packages."""
import argparse
import importlib.util
import io
import json
from pathlib import Path
import sys
import numpy as np
from PIL import Image

parser=argparse.ArgumentParser()
parser.add_argument('--package',type=Path,required=True)
args=parser.parse_args()
package=args.package.resolve()
sys.path[:0]=[str(package/'backend/code'),str(package)]
import checkpoints
import defense
spec=importlib.util.spec_from_file_location('jpeg_legacy',package/'backend/code/test.py')
legacy=importlib.util.module_from_spec(spec)
spec.loader.exec_module(legacy)
with np.load(package/'backend/code/data/test.npz',allow_pickle=False) as data:
    images=data['images'][data['labels']==1]
detectors=[]
for name,cls in [('frequency',defense.FrequencyStatDefense),('pixel',defense.PixelStatDefense)]:
    obj=checkpoints.load(package/('backend/weights/'+name+'.pt'),required=True,teacher_asset=True).load_joblib()
    det=cls();det._clf=obj['clf'];det._scaler=obj['scaler'];det._fitted=True
    detectors.append(det)
for quality in (75,85,90,95,100):
    attacked=[]
    for image in images:
        buffer=io.BytesIO()
        Image.fromarray(image).save(buffer,format='JPEG',quality=quality,subsampling=0)
        buffer.seek(0)
        attacked.append(np.asarray(Image.open(buffer).convert('RGB')))
    ssim=float(np.mean([legacy.ssim(before,after) for before,after in zip(images,attacked)]))
    valid=np.array([legacy.check_legality(before,after)[0] for before,after in zip(images,attacked)])
    asrs=[legacy.attack_success_rate(np.array([det.predict(image) for image in attacked]),valid) for det in detectors]
    print(json.dumps({'quality':quality,'subsampling':0,'ssim':ssim,'valid':float(valid.mean()),'asrs':asrs,'qualified':bool(ssim>=legacy.SSIM_MIN and valid.mean()>=legacy.VALID_RATE_MIN)}),flush=True)
