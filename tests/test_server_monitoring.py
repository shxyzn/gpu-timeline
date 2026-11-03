import base64
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'agent'))
from server_monitoring import HealthMonitor, validate_config, in_window, next_run, daily_slot, KST


def schedule(kind='interval'):
    return {'id': 'mon-'+'a'*36, 'name': '점검', 'kind': kind, 'enabled': True,
            'interval_minutes': 30, 'all_day': True, 'start_time': '09:00', 'end_time': '18:00',
            'days': list(range(7)), 'times': ['09:00', '21:00'] if kind == 'daily' else [],
            'checks': ['gpu_response', 'gpu_count']}


def configuration(kind='interval'):
    return {'server_id': 'server-a', 'revision': 1, 'updated_at': '2026-11-03T01:00:00Z',
            'enabled': True, 'expected_gpu_count': 2, 'timeout_seconds': 15,
            'temperature_warn_c': 85, 'schedules': [schedule(kind)]}


class MonitoringTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.now = datetime(2026, 11, 3, 0, 0, tzinfo=timezone.utc)
        self.calls = []
        self.output = 'GPU-a\nGPU-b\n'

        def runner(args, **kwargs):
            self.calls.append(args)
            self.assertNotIn('shell', kwargs)
            return subprocess.CompletedProcess(args, 0, self.output, '')
        self.monitor = HealthMonitor({'state_dir': self.temp.name, 'server_id': 'server-a',
                                      'github_repository': 'shxyzn/gpu-timeline'},
                                     runner=runner, clock=lambda: self.now)
        self.monitor.settings = configuration()

    def test_configuration_rejects_unapproved_commands_and_duplicate_times(self):
        c = configuration(); c['schedules'][0]['checks'] = ['reboot']
        with self.assertRaises(ValueError): validate_config(c)
        c = configuration('daily'); c['schedules'][0]['times'] = ['09:00', '09:00']
        with self.assertRaises(ValueError): validate_config(c)
        c = configuration(); c['timeout_seconds'] = 600
        with self.assertRaises(ValueError): validate_config(c)

    def test_interval_checks_are_deduplicated_and_persist_across_restarts(self):
        self.assertTrue(self.monitor.tick())
        self.assertEqual(len(self.calls), 1)  # GPU UUID query shared by both selected checks.
        self.assertEqual(self.monitor.public()['last_run']['status'], 'ok')
        self.assertFalse(self.monitor.tick())
        restarted = HealthMonitor(self.monitor.config, clock=lambda: self.now)
        self.assertFalse(restarted.tick())
        self.now += timedelta(minutes=31)
        self.assertTrue(self.monitor.tick())

    def test_daily_twice_claims_each_slot_once_including_after_restart(self):
        self.monitor.settings = configuration('daily')
        self.assertTrue(self.monitor.tick())
        self.now += timedelta(minutes=2)
        self.assertFalse(self.monitor.tick())
        restarted = HealthMonitor(self.monitor.config, clock=lambda: self.now)
        self.assertFalse(restarted.tick())
        self.now += timedelta(hours=12)
        self.assertTrue(self.monitor.tick())
        self.assertEqual(len(self.monitor.history), 2)

    def test_missed_daily_slots_do_not_cause_a_boot_storm(self):
        self.monitor.settings = configuration('daily')
        self.now += timedelta(hours=2)
        self.assertFalse(self.monitor.tick())

    def test_gpu_count_mismatch_and_timeouts_are_reported_without_raw_errors(self):
        self.output = 'GPU-a\n'
        self.monitor.tick()
        self.assertEqual(self.monitor.public()['last_run']['status'], 'warning')
        self.now += timedelta(minutes=31)
        self.monitor.runner = lambda *a, **k: (_ for _ in ()).throw(subprocess.TimeoutExpired('private-command', 15))
        self.monitor.tick()
        public = json.dumps(self.monitor.public(), ensure_ascii=False)
        self.assertIn('제한 시간', public)
        self.assertNotIn('private-command', public)

    def test_midnight_window_uses_start_day_and_next_run_advances_weekends(self):
        s = schedule(); s.update(days=[0], all_day=False, start_time='23:00', end_time='02:00')
        self.assertTrue(in_window(s, datetime(2026, 11, 3, 1, tzinfo=KST)))
        self.assertFalse(in_window(s, datetime(2026, 11, 3, 2, tzinfo=KST)))
        s.update(days=[0, 1, 2, 3, 4], start_time='09:00', end_time='18:00')
        due = next_run(s, datetime(2026, 11, 6, 17, 55, tzinfo=KST), '2026-11-06T17:50:00+09:00')
        self.assertEqual(due, datetime(2026, 11, 9, 9, tzinfo=KST))

    def test_sync_reads_only_test_config_and_preserves_last_valid_settings_on_bad_data(self):
        desired = configuration(); desired['revision'] = 2
        document = {'schema_version': 1, 'servers': [desired]}
        requests = []

        def api(method, path, token):
            requests.append((method, path))
            return {'encoding': 'base64', 'content': base64.b64encode(json.dumps(document).encode()).decode()}
        self.monitor.api = api
        with patch.dict(os.environ, {'GPU_TIMELINE_TOKEN': 'never-publish-this-token'}):
            self.assertTrue(self.monitor.sync())
            self.assertEqual(self.monitor.public()['applied_revision'], 2)
            document['servers'][0]['schedules'][0]['checks'] = ['sudo-reboot']
            self.monitor.sync()
        self.assertEqual(self.monitor.public()['applied_revision'], 2)
        self.assertIsNotNone(self.monitor.public()['config_error'])
        self.assertTrue(all(method == 'GET' and 'monitoring-test.json?ref=status' in path for method, path in requests))
        self.assertNotIn('never-publish-this-token', json.dumps(self.monitor.public()))

    def test_missing_tools_are_unsupported_and_corrupt_cached_state_cannot_break_startup(self):
        self.monitor.runner = lambda *a, **k: (_ for _ in ()).throw(FileNotFoundError())
        self.monitor.tick()
        self.assertEqual(self.monitor.public()['last_run']['status'], 'unsupported')
        self.monitor.path.write_text('[]')
        restarted = HealthMonitor(self.monitor.config)
        self.assertIsNone(restarted.settings)


if __name__ == '__main__': unittest.main()
