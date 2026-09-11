import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

spec = importlib.util.spec_from_file_location('agent', Path(__file__).parents[1] / 'agent/gpu_agent.py')
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)


class AgentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.config = {'server_id': 'test-server', 'name': 'Test', 'state_dir': self.temp.name,
                       'github_repository': 'owner/repo', 'github_branch': 'status'}
        self.gpus = [{'uuid': 'GPU-A', 'index': 0, 'name': 'GPU', 'memory_total_mib': 24000,
                      'memory_used_mib': 2000, 'utilization': 0, 'process_count': 1}]

    def tearDown(self):
        self.temp.cleanup()

    def test_uuid_is_used_instead_of_reboot_sensitive_index(self):
        self.assertEqual(agent.normalize_gpu_selection('0,GPU-A', self.gpus), ['GPU-A'])

    def test_failed_collection_is_unknown_and_preserves_topology(self):
        agent.atomic_json(Path(self.temp.name)/'snapshot.json', {'gpus': self.gpus})
        with patch.object(agent, 'collect_gpus', side_effect=OSError()):
            result = agent.make_snapshot(self.config)
        self.assertFalse(result['collector_ok'])
        self.assertEqual(result['gpus'][0]['uuid'], 'GPU-A')
        self.assertIsNone(result['gpus'][0]['utilization'])

    def test_pid_reuse_does_not_report_success_and_private_fields_are_not_uploaded(self):
        jobs = [{'id': 'x', 'name': 'Trial', 'gpu_uuids': ['GPU-A'], 'status': 'running',
                 'started_at': agent.now_iso(), '_pid': 123, '_pid_identity': 'old',
                 'secret': 'must-not-leak'}]
        agent.atomic_json(Path(self.temp.name)/'jobs.json', jobs)
        with patch.object(agent, 'collect_gpus', return_value=self.gpus), patch.object(agent, 'pid_identity', return_value='new'):
            result = agent.make_snapshot(self.config)
        job = result['jobs'][0]
        self.assertEqual(job['status'], 'stopped')
        self.assertEqual(job['end_source'], 'observed')
        self.assertTrue(job['ended_at'])
        self.assertNotIn('_pid', job)
        self.assertNotIn('secret', job)

    def test_conflict_reloads_sha_before_retry(self):
        conflict = HTTPError('https://api.github.com',409,'Conflict',{},io.BytesIO())
        responses = [{'sha':'old'}, conflict, {'sha':'new'}, {}]
        with patch.dict('os.environ', {'GPU_TIMELINE_TOKEN':'test-only'}), \
             patch.object(agent, 'github_request', side_effect=responses) as request, \
             patch.object(agent.time, 'sleep'):
            agent.publish(self.config, {'updated_at':'test'})
        self.assertEqual(request.call_args_list[1].args[3]['sha'], 'old')
        self.assertEqual(request.call_args_list[3].args[3]['sha'], 'new')

    def test_requires_explicit_timezone(self):
        with self.assertRaises(ValueError):
            agent.parse_time('2026-09-12T09:00:00')
        self.assertIsNotNone(agent.parse_time('2026-09-12T09:00:00+09:00').tzinfo)


if __name__ == '__main__':
    unittest.main()
