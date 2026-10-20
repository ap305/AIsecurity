from __future__ import annotations
import io,json,copy,sys,unittest,urllib.error,types
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import patch_gateway_pacing as subject
import test_patch_gateway_deadline as fixtures
class PacingPatchTests(unittest.TestCase):
 def setUp(self):
  self.f=fixtures.DeadlinePatchTests('test_default_is_read_only_and_requires_new_binding_and_four_proofs');self.f.setUp();self.addCleanup(self.f.doCleanups)
 def test_readonly_plan_retains_scope_and_requires_independent_proofs(self):
  before=subject.snapshot(self.f.old);r=subject.patch_build(self.f.old,self.f.new,{'kind':'synthetic TPM fixture'})
  self.assertFalse(self.f.new.exists());self.assertEqual(subject.snapshot(self.f.old),before);self.assertEqual(r['policy']['minRequestIntervalSeconds'],35);self.assertEqual(r['policy']['maxAttempts'],1);self.assertEqual(r['requiredNewPhasesForChangedQuestions'],4)
 def test_apply_changes_only_two_versions_and_runtimes(self):
  before=subject.snapshot(self.f.old);r=subject.patch_build(self.f.old,self.f.new,{'kind':'synthetic TPM fixture'},apply=True);after=subject.snapshot(self.f.new)
  self.assertEqual(subject.snapshot(self.f.old),before);self.assertEqual({n for n in before if before[n]!=after[n]},set(r['changedFiles']));self.assertEqual(r['retainedRecords']['questions'],75);self.assertEqual(r['retainedRecords']['packages'],67)
  root=json.loads((self.f.new/'manifest.json').read_bytes())
  for old,new in zip(self.f.root['questions'],root['questions']):
   expected=copy.deepcopy(old)
   if old['id']in subject.IDS:expected['definition']['evaluation']['version']=subject.VERSION
   self.assertEqual(new,expected)
 def runtime(self):
  module=types.ModuleType('synthetic_scoped_pacing');exec(compile(subject.revised_runtime((Path(subject.__file__).parent/'bot_runtime.py').read_bytes()),'<trusted-pacing>','exec'),module.__dict__);return module
 def test_cached_calls_bypass_pacing_and_uncached_calls_keep_210s_deadline(self):
  m=self.runtime();self.assertEqual(m.GATEWAY_TRANSPORT_POLICY['maxAttempts'],1);self.assertIsNone(m.GATEWAY_TRANSPORT_POLICY['retryStatus']);self.assertEqual(m.GATEWAY_TRANSPORT_POLICY['minRequestIntervalSeconds'],35);clock=[0];sleeps=[];posts=[]
  def sleep(seconds):sleeps.append(seconds);clock[0]+=seconds
  class Response(io.BytesIO):
   def __enter__(self):return self
   def __exit__(self,*args):self.close()
  def post(req,timeout):posts.append(timeout);return Response(json.dumps({'choices':[{'message':{'content':'first valid'}}]}).encode())
  with patch.object(m.time,'monotonic',lambda:clock[0]),patch.object(m.time,'sleep',sleep),patch.object(m.urllib.request,'urlopen',post):
   g=m.Gateway({'url':'http://synthetic.invalid','token':'not-real'});a=[{'role':'user','content':'a'}];self.assertEqual(g.message(a),g.message(a));g.message([{'role':'user','content':'b'}])
  self.assertEqual(posts,[210,210]);self.assertEqual(sleeps,[35,35]);self.assertEqual(g.calls,2)
 def test_explicit_503_and_unknown_transport_do_not_replay_model(self):
  for error in [urllib.error.HTTPError('http://synthetic.invalid',503,'synthetic',{},io.BytesIO()),TimeoutError('synthetic')]:
   m=self.runtime()
   with patch.object(m.time,'sleep'),patch.object(m.urllib.request,'urlopen',side_effect=error)as post:
    g=m.Gateway({'url':'http://synthetic.invalid','token':'not-real'})
    with self.assertRaises(m.CourseFailure):g.message([{'role':'user','content':'a'}])
    self.assertEqual(post.call_count,1);self.assertEqual(g.calls,1)
 def test_noncanonical_runtime_is_rejected(self):
  with self.assertRaises(ValueError):subject.revised_runtime(b'noncanonical')
if __name__=='__main__':unittest.main()
