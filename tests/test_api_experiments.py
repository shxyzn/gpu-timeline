"""Real broker/parser/storage tests with no GPUs or network."""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).parents[1] / 'agent'))
import gpu_agent as agent
import shared_daemon as shared


class APIExperimentsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.config = {'server_id':'server-c', 'name':'Kimi', 'state_dir':self.temp.name}
        self.broker = shared.Broker(self.config)

    def add(self, name, uid=1001):
        return self.broker.dispatch(['add','--id',name,'--name',name,'--owner','Test','--api'],uid)

    def test_slots_reuse_lowest_after_real_completion_across_accounts(self):
        with patch.object(agent, 'collect_gpus', side_effect=AssertionError('API registration must not query GPUs')):
            refs = [self.add('exp'+str(i),1001+i)['reference'] for i in range(3)]
            self.assertEqual([j['api_slot'] for j in agent.read_jobs(self.temp.name)],[0,1,2])
            for i in (0,1):
                self.broker.dispatch(['finish','--id',refs[i]],1001+i)
            self.add('new',1004)
            self.assertEqual([j['api_slot'] for j in agent.read_jobs(self.temp.name)],[0,1,2,0])
            self.assertTrue(all(j['gpu_uuids']==[] for j in agent.read_jobs(self.temp.name)))
            self.assertEqual(self.broker.dispatch(['list'],1004)['jobs'][0]['api_slot'],0)
            self.assertIn('api-experiments-v1',self.broker.dispatch(['status'],1001)['capabilities'])
        with patch.object(agent,'collect_gpus',return_value=[]):
            snapshot=agent.make_snapshot(self.config)
        self.assertTrue(all(j['resource_type']=='api' for j in snapshot['jobs']))
        self.assertNotIn('_owner_uid',json.dumps(snapshot))

    def test_simultaneous_accounts_get_distinct_slots_under_the_shared_lock(self):
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=6) as pool:
            list(pool.map(lambda i: self.add('parallel'+str(i),2000+i), range(12)))
        jobs=agent.read_jobs(self.temp.name)
        self.assertEqual(sorted(j['api_slot'] for j in jobs),list(range(12)))
        self.assertEqual(len({j['id'] for j in jobs}),12)

    def test_live_unknown_records_keep_slot_and_resource_change_preserves_identity(self):
        ref=self.add('first')['reference'];self.add('second')
        jobs=agent.read_jobs(self.temp.name);jobs[0]['status']='unknown'
        agent.atomic_json(Path(self.temp.name)/'jobs.json',jobs)
        self.add('third');self.assertEqual(agent.read_jobs(self.temp.name)[2]['api_slot'],2)
        with self.assertRaises(ValueError): self.broker.dispatch(['update','--id',ref,'--api'],1002)
        self.broker.dispatch(['update','--id',ref,'--api'],1001)
        self.assertEqual(agent.read_jobs(self.temp.name)[0]['api_slot'],0)
        with patch.object(agent,'collect_gpus',return_value=[{'index':0,'uuid':'GPU-0'}]):
            self.broker.dispatch(['update','--id',ref,'--gpus','0'],1001)
        self.assertNotIn('api_slot',agent.read_jobs(self.temp.name)[0])
        self.add('fourth');self.assertEqual(agent.read_jobs(self.temp.name)[-1]['api_slot'],0)
        self.assertEqual(self.broker.dispatch(['list'],1001)['jobs'][0]['reference'],ref)

    def test_parser_and_run_token_guards_apply_to_api(self):
        for argv in (['add','--id','a','--name','a','--owner','a'], ['add','--id','a','--name','a','--owner','a','--api','--gpus','0']):
            with self.assertRaises(ValueError): self.broker.dispatch(argv,1001)
        result=self.broker.dispatch(['add','--id','run','--name','run','--owner','a','--api','--run-token','a'*32],1001)
        ref=result['reference']
        with self.assertRaises(ValueError): self.broker.dispatch(['update','--id',ref,'--api','--run-token','b'*32],1001)
        self.broker.dispatch(['finish','--id',ref,'--run-token','a'*32,'--exit-code','0'],1001)
        before=agent.read_jobs(self.temp.name)
        self.broker.dispatch(['update','--id',ref,'--api','--run-token','a'*32],1001)
        self.assertEqual(agent.read_jobs(self.temp.name),before)
