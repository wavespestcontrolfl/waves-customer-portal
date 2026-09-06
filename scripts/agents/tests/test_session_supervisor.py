import argparse
from contextlib import ExitStack
import importlib.util
import json
import os
import shutil
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('supervisor', Path(__file__).parents[1] / 'session-supervisor.py')
supervisor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(supervisor)


class SupervisorTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.record = self.root / 'saved.jsonl'
        self.record.touch()
        self.job = {'provider': 'codex', 'session': '00000000-0000-4000-8000-000000000001',
                    'worktree': str(self.root), 'repo': 'example/project', 'branch': 'feat/task',
                    'pr': 7, 'owner_pid': 987654, 'owner_stamp': 'original', 'transcript': str(self.record),
                    'status': 'watching', 'revision': 'one', 'launch_id': 'launch-one', 'reason': 'waiting',
                    'attempts': 0, 'runs': [], 'last_run': 0, 'fingerprint': 'stable', 'changed_at': 1}
        self.fresh = {'fingerprint': 'stable', 'head': 'a' * 40, 'closed': False,
                      'merged': False, 'draft': False, 'ready': True}
        self.key = 'codex:' + self.job['session']

    def store(self):
        supervisor.atomic_json(self.root / 'jobs.json', {self.key: self.job})

    def inspection(self):
        stack = ExitStack()
        stack.enter_context(patch.object(supervisor, 'session_busy', return_value=False))
        stack.enter_context(patch.object(supervisor, 'snapshot', return_value=self.fresh))
        stack.enter_context(patch.object(supervisor, 'repository', return_value=self.job['repo']))
        stack.enter_context(patch.object(supervisor, 'git', side_effect=lambda cwd, *args:
                                        self.job['branch'] if args[0] == 'branch' else self.fresh['head']))
        return stack

    def test_no_enrolled_jobs_means_no_commands_and_dry_run_writes_nothing(self):
        root = self.root / 'absent'
        with patch.object(supervisor, 'command', side_effect=AssertionError('unexpected command')):
            supervisor.tick(root)
        self.assertFalse(root.exists())

    def test_live_original_process_skips_before_reading_github(self):
        with patch.object(supervisor, 'process_stamp', return_value='original'), \
                patch.object(supervisor, 'snapshot', side_effect=AssertionError('github read')):
            self.assertEqual(supervisor.inspect_job(self.job, 1000)['reason'], 'session_open')

    def test_pid_reuse_does_not_masquerade_as_original_owner(self):
        result = subprocess.CompletedProcess([], 1, stdout='')
        with patch.object(supervisor, 'process_stamp', return_value='reused'), \
                patch.object(supervisor, 'command', return_value='[]'), \
                patch.object(supervisor.subprocess, 'run', return_value=result):
            self.assertFalse(supervisor.session_busy(self.job))

    def test_another_process_holding_transcript_prevents_duplicate_resume(self):
        result = subprocess.CompletedProcess([], 0, stdout='12345\n')
        with patch.object(supervisor, 'process_stamp', return_value=None), \
                patch.object(supervisor, 'command', return_value='[]'), \
                patch.object(supervisor.subprocess, 'run', return_value=result):
            self.assertTrue(supervisor.session_busy(self.job))

    def test_claude_live_idle_and_permission_waiting_sessions_are_not_taken_over(self):
        self.job['provider'] = 'claude'
        for status in ['idle', 'waiting', 'busy']:
            sessions = [{'sessionId': self.job['session'], 'kind': 'interactive', 'status': status}]
            with patch.object(supervisor, 'process_stamp', return_value=None), \
                    patch.object(supervisor, 'command', return_value=json.dumps(sessions)):
                self.assertTrue(supervisor.session_busy(self.job))

    def test_other_claude_session_in_worktree_blocks_a_codex_resume(self):
        sessions = [{'sessionId': 'different', 'cwd': self.job['worktree'],
                     'kind': 'interactive', 'state': 'idle'}]
        with patch.object(supervisor, 'process_stamp', return_value=None), \
                patch.object(supervisor, 'command', return_value=json.dumps(sessions)):
            self.assertTrue(supervisor.session_busy(self.job))

    def test_live_codex_worktree_or_cd_argument_blocks_resume(self):
        for cwd, args in [(self.job['worktree'], ''), ('/tmp', 'codex --cd ' + self.job['worktree']),
                          ('/tmp', 'codex -C' + self.job['worktree']),
                          ('/tmp', 'codex -C=' + self.job['worktree']),
                          ('/tmp', 'codex --cd=/unrelated')]:
            with self.subTest(cwd=cwd, args=args), \
                    patch.object(supervisor, 'command', side_effect=lambda argv:
                                 f'p1234\nccodex\nn{cwd}\n' if argv[0] == 'lsof' else args):
                self.assertEqual(supervisor.worktree_busy(self.job), 'unrelated' not in args)

    def test_flattened_whitespace_in_worktree_argument_fails_closed(self):
        job = {**self.job, 'worktree': str(self.root / 'task with spaces')}
        for flag in ['--cd ', '-C', '-C=']:
            with patch.object(supervisor, 'command', side_effect=lambda argv:
                              'p1234\nccodex\nn/tmp\n' if argv[0] == 'lsof' else 'codex ' + flag + job['worktree']):
                self.assertTrue(supervisor.worktree_busy(job))

    @unittest.skipUnless(shutil.which('lsof') and shutil.which('cc'), 'requires lsof and a C compiler')
    def test_real_other_process_in_worktree_blocks_resume(self):
        executable = self.root / 'codex'
        subprocess.run(['cc', '-x', 'c', '-', '-o', str(executable)],
                       input='#include <unistd.h>\nint main(void) { sleep(30); return 0; }\n',
                       text=True, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        process = subprocess.Popen([str(executable)], cwd=self.root, start_new_session=True)
        try:
            deadline = time.monotonic() + 3
            busy = False
            while not busy and time.monotonic() < deadline:
                busy = supervisor.worktree_busy(self.job)
                if not busy:
                    time.sleep(0.1)
            self.assertTrue(busy)
        finally:
            process.terminate()
            process.wait()

    def test_zombie_only_group_is_drained_but_live_child_keeps_fence(self):
        for states, active in [('123 Z\n456 S\n', False), ('123 Z\n123 S\n', True)]:
            with patch.object(supervisor, 'command', return_value=states):
                self.assertEqual(supervisor.group_active(123), active)

    def test_pause_and_complete_never_inspect_or_resume(self):
        with patch.object(supervisor, 'session_busy', side_effect=AssertionError('provider called')):
            for status in ['paused', 'blocked', 'complete']:
                self.job['status'] = status
                self.assertEqual(supervisor.inspect_job(self.job, 1000)['action'], 'skip')

    def test_branch_head_repository_and_missing_transcript_fail_closed(self):
        with self.inspection():
            with patch.object(supervisor, 'git', return_value='other'):
                self.assertEqual(supervisor.inspect_job(self.job, 1000)['reason'], 'branch_changed')
            with patch.object(supervisor, 'git', side_effect=['feat/task', 'b' * 40]):
                self.assertEqual(supervisor.inspect_job(self.job, 1000)['reason'], 'head_changed')
            with patch.object(supervisor, 'repository', return_value='other/repository'):
                self.assertEqual(supervisor.inspect_job(self.job, 1000)['reason'], 'repository_changed')
            self.record.unlink()
            self.assertEqual(supervisor.inspect_job(self.job, 1000)['reason'], 'missing_workspace_or_session')

    def test_quiet_period_and_no_progress_limits_bound_resumes(self):
        with self.inspection():
            self.fresh['fingerprint'] = 'new'
            decision = supervisor.inspect_job(self.job, 1000)
            self.assertEqual(decision['action'], 'observe')
            self.job.update({k: v for k, v in decision.items() if k != 'action'})
            self.assertEqual(supervisor.inspect_job(self.job, 1030)['action'], 'skip')
            self.assertEqual(supervisor.inspect_job(self.job, 1061)['action'], 'resume')
            self.job['attempts'] = supervisor.MAX_ATTEMPTS
            self.assertEqual(supervisor.inspect_job(self.job, 1061)['reason'], 'resume_limit')
            self.job['attempts'] = 0
            self.job['runs'] = [1000] * supervisor.MAX_DAILY_RUNS
            self.assertEqual(supervisor.inspect_job(self.job, 1061)['reason'], 'resume_limit')

    def test_limits_keep_observing_and_recover_on_new_evidence_or_daily_expiry(self):
        self.job['attempts'] = supervisor.MAX_ATTEMPTS
        self.store()
        with self.inspection(), patch.object(supervisor, 'resume') as resume:
            supervisor.tick(self.root, execute=True)
            limited = supervisor.read_jobs(self.root)[self.key]
            self.assertEqual(limited['status'], 'watching')
            self.assertEqual(limited['reason'], 'resume_limit')
            self.fresh['fingerprint'] = 'late-review'
            supervisor.tick(self.root, execute=True)
            changed = supervisor.read_jobs(self.root)[self.key]
            self.assertEqual(changed['attempts'], 0)
            self.assertEqual(changed['fingerprint'], 'late-review')
            resume.assert_not_called()
            changed.update({'runs': [1000] * supervisor.MAX_DAILY_RUNS, 'changed_at': 1})
            self.assertEqual(supervisor.inspect_job(changed, 1100)['reason'], 'resume_limit')
            self.assertEqual(supervisor.inspect_job(changed, 87500)['action'], 'resume')

    def test_orphan_in_paused_job_fences_other_jobs_and_is_reaped(self):
        process = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'],
                                   start_new_session=True)
        self.addCleanup(lambda: process.poll() is None and process.kill())
        self.job.update({'status': 'paused', 'worker_pid': process.pid,
                         'worker_stamp': supervisor.process_stamp(process.pid)})
        self.store()
        waiter = threading.Thread(target=process.wait)
        waiter.start()
        with patch.object(supervisor, 'inspect_job', side_effect=AssertionError('queue launched')):
            supervisor.tick(self.root, execute=False)
            self.assertIsNone(process.poll())
            supervisor.tick(self.root, execute=True)
        waiter.join(timeout=3)
        self.assertIsNotNone(process.poll())
        self.assertEqual(supervisor.read_jobs(self.root)[self.key]['reason'], 'orphaned_worker')

    def test_lost_worker_result_blocks_even_when_its_group_has_exited(self):
        for pid, launch in [(987654, 'launch-one'), (None, None)]:
            self.job.update({'status': 'running', 'worker_pid': pid, 'worker_stamp': 'old',
                             'launch_id': launch, 'launch_pending': False})
            self.store()
            with patch.object(supervisor, 'group_active', return_value=False), \
                    patch.object(supervisor, 'inspect_job', side_effect=AssertionError('lost disposition retried')):
                supervisor.tick(self.root, execute=True)
            job = supervisor.read_jobs(self.root)[self.key]
            self.assertEqual(job['status'], 'blocked')
            self.assertEqual(job['reason'], 'interrupted_worker')
            self.assertEqual(supervisor.inspect_job(job, 1000)['action'], 'skip')

    def test_unknown_launch_fences_queue_even_after_pause(self):
        self.job.update({'status': 'paused', 'launch_pending': True})
        self.store()
        with patch.object(supervisor, 'inspect_job', side_effect=AssertionError('queue launched')):
            supervisor.tick(self.root, execute=True)

    def test_pending_without_a_result_or_draft_never_spawns_model(self):
        with self.inspection():
            self.fresh['ready'] = False
            self.assertEqual(supervisor.inspect_job(self.job, 1000)['action'], 'skip')
            self.fresh['draft'] = True
            self.assertEqual(supervisor.inspect_job(self.job, 1000)['reason'], 'draft')

    def test_closed_unmerged_pr_finishes_without_resuming(self):
        with self.inspection():
            self.fresh['closed'] = True
            self.assertEqual(supervisor.inspect_job(self.job, 1000)['action'], 'complete')

    def test_interrupted_launch_is_not_blindly_retried(self):
        self.job['status'] = 'launching'
        self.assertEqual(supervisor.inspect_job(self.job, 1000)['reason'], 'interrupted_launch')

    def test_pause_revision_wins_over_stale_worker_write(self):
        self.store()
        args = argparse.Namespace(job=self.key, action='pause', execute=True)
        supervisor.control(self.root, args)
        self.assertFalse(supervisor.update_job(self.root, self.key, 'one', {'status': 'watching'}))
        self.assertEqual(supervisor.read_jobs(self.root)[self.key]['status'], 'paused')

    def test_retry_cannot_reclaim_a_worktree_enrolled_to_another_session(self):
        self.job['status'] = 'paused'
        other = {**self.job, 'status': 'watching', 'session': '00000000-0000-4000-8000-000000000002'}
        jobs = {self.key: self.job, 'codex:' + other['session']: other}
        supervisor.atomic_json(self.root / 'jobs.json', jobs)
        with self.assertRaises(ValueError):
            supervisor.control(self.root, argparse.Namespace(job=self.key, action='retry', execute=True))
        self.assertEqual(supervisor.read_jobs(self.root), jobs)

    def test_concurrent_tick_cannot_launch_a_second_worker(self):
        self.store()
        with supervisor.locked(self.root, 'tick'), \
                patch.object(supervisor, 'inspect_job', side_effect=AssertionError('second tick entered')):
            supervisor.tick(self.root, execute=True)

    def test_corrupt_state_is_not_replaced_with_an_empty_queue(self):
        (self.root / 'jobs.json').write_text('{bad')
        with self.assertRaises(ValueError):
            supervisor.read_jobs(self.root)
        self.assertEqual((self.root / 'jobs.json').read_text(), '{bad')

    def test_paginated_review_endpoints_and_late_inline_change_wake_signal(self):
        info = {'head': {'repo': {'full_name': 'example/project'}, 'ref': 'feat/task', 'sha': 'a' * 40},
                'state': 'open', 'merged': False, 'draft': False}
        endpoints = []
        late = {'id': 101, 'updated_at': 'later'}

        def gh(repo, endpoint):
            endpoints.append(endpoint)
            if endpoint == 'pulls/7':
                return [info]
            if endpoint == 'pulls/7/comments?per_page=100':
                return [[], [late]]  # Finding is on page two.
            return [[]]

        with patch.object(supervisor, 'gh_json', side_effect=gh), \
                patch.object(supervisor, 'command', return_value='{"statusCheckRollup":[]}'):
            first = supervisor.snapshot(self.job)
            late['updated_at'] = 'changed'
            second = supervisor.snapshot(self.job)
        self.assertNotEqual(first['fingerprint'], second['fingerprint'])
        self.assertIn('issues/7/comments?per_page=100', endpoints)
        self.assertIn('pulls/7/reviews?per_page=100', endpoints)
        self.assertIn('pulls/7/comments?per_page=100', endpoints)

    def test_human_comments_and_reviews_change_wake_fingerprint(self):
        info = {'head': {'repo': {'full_name': 'example/project'}, 'ref': 'feat/task', 'sha': 'a' * 40},
                'state': 'open', 'merged': False, 'draft': False}
        comments, reviews = [], []
        def gh(repo, endpoint):
            if endpoint == 'pulls/7':
                return [info]
            if endpoint.startswith('issues/'):
                return [comments]
            if '/reviews?' in endpoint:
                return [reviews]
            return [[]]
        with patch.object(supervisor, 'gh_json', side_effect=gh), \
                patch.object(supervisor, 'command', return_value='{"statusCheckRollup":[]}'):
            empty = supervisor.snapshot(self.job)
            comments.append({'id': 1, 'updated_at': 'later', 'user': {'login': 'human'}})
            comment = supervisor.snapshot(self.job)
            reviews.append({'id': 2, 'submitted_at': 'later', 'state': 'CHANGES_REQUESTED'})
            review = supervisor.snapshot(self.job)
        self.assertTrue(comment['ready'])
        self.assertNotEqual(empty['fingerprint'], comment['fingerprint'])
        self.assertNotEqual(comment['fingerprint'], review['fingerprint'])

    def test_same_result_ci_rerun_changes_wake_fingerprint(self):
        info = {'head': {'repo': {'full_name': 'example/project'}, 'ref': 'feat/task', 'sha': 'a' * 40},
                'state': 'open', 'merged': False, 'draft': False}
        check = {'name': 'tests', 'conclusion': 'FAILURE', 'status': 'COMPLETED',
                 'detailsUrl': 'https://example.invalid/job/1', 'completedAt': 'first'}
        with patch.object(supervisor, 'gh_json', side_effect=lambda repo, ep: [info] if ep == 'pulls/7' else [[]]), \
                patch.object(supervisor, 'command', side_effect=lambda *a, **k: json.dumps({'statusCheckRollup': [check]})):
            first = supervisor.snapshot(self.job)
            check['completedAt'] = 'rerun'
            second = supervisor.snapshot(self.job)
        self.assertNotEqual(first['fingerprint'], second['fingerprint'])

    def test_codex_intermediate_commentary_does_not_break_final_disposition(self):
        rows = [{'type': 'item.completed', 'item': {'type': 'agent_message', 'text': 'Working on it'}},
                {'type': 'item.completed', 'item': {'type': 'agent_message',
                 'text': '{"state":"waiting","reason":"waiting_review"}'}}]
        self.assertEqual(supervisor.disposition('\n'.join(map(json.dumps, rows)), 'codex')['state'], 'waiting')

    def test_blocking_reasons_override_inconsistent_model_states_for_both_clis(self):
        for provider in ['codex', 'claude']:
            for state in ['waiting', 'complete']:
                for reason in ['permission', 'owner_decision', 'quota', 'infrastructure']:
                    value = {'state': state, 'reason': reason}
                    raw = json.dumps({'structured_output': value}) if provider == 'claude' else json.dumps({
                        'type': 'item.completed', 'item': {'type': 'agent_message', 'text': json.dumps(value)}})
                    self.assertEqual(supervisor.disposition(raw, provider), {'state': 'blocked', 'reason': reason})
        with self.assertRaises(ValueError):
            supervisor.disposition(json.dumps({'structured_output': {'state': 'complete', 'reason': 'waiting_ci'}}), 'claude')

    def test_claude_permission_denial_overrides_successful_final_claim(self):
        raw = json.dumps({'permission_denials': [{}], 'structured_output': {'state': 'complete', 'reason': 'completed'}})
        self.assertEqual(supervisor.disposition(raw, 'claude'), {'state': 'blocked', 'reason': 'permission'})

    def test_claiming_complete_while_pr_open_blocks_instead(self):
        self.store()
        with patch.object(supervisor, 'inspect_job', return_value={'action': 'resume', 'reason': 'pr_ready'}), \
                patch.object(supervisor, 'resume', return_value={'state': 'complete', 'reason': 'completed'}), \
                patch.object(supervisor, 'snapshot', return_value=self.fresh):
            supervisor.tick(self.root, execute=True)
        self.assertEqual(supervisor.read_jobs(self.root)[self.key]['status'], 'blocked')

    def test_real_child_resume_uses_exact_session_and_no_permission_override(self):
        self.store()
        executable = self.root / 'codex'
        captured = self.root / 'arguments.json'
        executable.write_text('#!' + sys.executable + '\nimport json,sys\n'
                              + 'from pathlib import Path\n'
                              + f'Path({str(captured)!r}).write_text(json.dumps(sys.argv[1:]))\n'
                              + 'sys.stdin.read()\n'
                              + 'print(json.dumps({"type":"item.completed","item":{"type":"agent_message",'
                              + '"text":"{\\"state\\":\\"waiting\\",\\"reason\\":\\"waiting_ci\\"}"}}))\n')
        executable.chmod(0o700)
        env = {**supervisor.environment(), 'PATH': str(self.root) + ':' + os.environ['PATH']}
        with patch.object(supervisor, 'environment', return_value=env):
            result = supervisor.resume(self.root, self.key, self.job)
        argv = json.loads(captured.read_text())
        self.assertIn(self.job['session'], argv)
        self.assertIn('--cd', argv)
        self.assertFalse(any('bypass' in value or 'last' in value or 'model' in value for value in argv))
        self.assertEqual(result, {'state': 'waiting', 'reason': 'waiting_ci'})

    def test_failed_or_empty_identity_after_spawn_reaps_child_before_clearing_fence(self):
        popen = subprocess.Popen
        for lookup in [None, OSError('ps unavailable')]:
            with self.subTest(lookup=lookup):
                self.store()
                process = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'],
                                           stdin=subprocess.PIPE, start_new_session=True)
                self.addCleanup(lambda p=process: p.poll() is None and p.kill())
                with patch.object(supervisor, 'inspect_job', return_value={'action': 'resume', 'reason': 'pr_ready'}), \
                        patch.object(supervisor.subprocess, 'Popen', side_effect=lambda argv, **kw:
                                     process if argv[0] == 'codex' else popen(argv, **kw)), \
                        patch.object(supervisor, 'process_stamp', side_effect=lookup, return_value=None):
                    supervisor.tick(self.root, execute=True)
                self.assertIsNotNone(process.poll())
                self.assertFalse(supervisor.group_active(process.pid))
                job = supervisor.read_jobs(self.root)[self.key]
                self.assertEqual(job['status'], 'blocked')
                self.assertFalse(job['launch_pending'])

    def test_pause_before_worker_identity_is_saved_clears_only_its_launch_fence(self):
        self.job.update({'status': 'launching', 'launch_pending': True})
        self.store()
        popen = subprocess.Popen
        process = popen([sys.executable, '-c', 'import time; time.sleep(30)'],
                        stdin=subprocess.PIPE, start_new_session=True)
        self.addCleanup(lambda: process.poll() is None and process.kill())
        stamp = supervisor.process_stamp(process.pid)
        def pause_before_identity(pid):
            supervisor.control(self.root, argparse.Namespace(job=self.key, action='pause', execute=True))
            return stamp
        with patch.object(supervisor.subprocess, 'Popen', side_effect=lambda argv, **kw:
                          process if argv[0] == 'codex' else popen(argv, **kw)), \
                patch.object(supervisor, 'process_stamp', side_effect=pause_before_identity):
            result = supervisor.resume(self.root, self.key, self.job)
        self.assertEqual(result['state'], 'blocked')
        self.assertFalse(supervisor.group_active(process.pid))
        jobs = supervisor.read_jobs(self.root)
        self.assertEqual(jobs[self.key]['status'], 'paused')
        self.assertFalse(jobs[self.key]['launch_pending'])
        self.assertTrue(supervisor.reconcile_workers(self.root, jobs, False))

    def test_stale_cleanup_cannot_clear_a_replacement_launch(self):
        self.job.update({'launch_id': 'replacement', 'launch_pending': True})
        self.store()
        supervisor.clear_worker(self.root, self.key, 'launch-one')
        self.assertTrue(supervisor.read_jobs(self.root)[self.key]['launch_pending'])

    def test_unconfirmed_cleanup_retains_launch_fence(self):
        self.store()
        with patch.object(supervisor, 'inspect_job', return_value={'action': 'resume', 'reason': 'pr_ready'}), \
                patch.object(supervisor, 'resume', side_effect=OSError('cleanup unconfirmed')):
            supervisor.tick(self.root, execute=True)
        self.assertTrue(supervisor.read_jobs(self.root)[self.key]['launch_pending'])

    def test_exited_cli_leader_does_not_leave_its_tool_process_running(self):
        self.store()
        executable = self.root / 'codex'
        child_pid = self.root / 'child.pid'
        executable.write_text('#!' + sys.executable + '\nimport json,subprocess,sys\n'
                              + 'from pathlib import Path\n'
                              + 'sys.stdin.read()\n'
                              + 'child=subprocess.Popen([sys.executable,"-c","import time; time.sleep(30)"])\n'
                              + f'Path({str(child_pid)!r}).write_text(str(child.pid))\n'
                              + 'print(json.dumps({"type":"item.completed","item":{"type":"agent_message",'
                              + '"text":"{\\\"state\\\":\\\"waiting\\\",\\\"reason\\\":\\\"waiting_ci\\\"}"}}))\n')
        executable.chmod(0o700)
        env = {**supervisor.environment(), 'PATH': str(self.root) + ':' + os.environ['PATH']}
        with patch.object(supervisor, 'environment', return_value=env):
            result = supervisor.resume(self.root, self.key, self.job)
        self.assertEqual(result['state'], 'waiting')
        status = subprocess.run(['ps', '-p', child_pid.read_text(), '-o', 'stat='],
                                stdout=subprocess.PIPE, text=True).stdout.strip()
        self.assertTrue(not status or status.startswith('Z'))
        self.assertFalse(supervisor.group_active(supervisor.read_jobs(self.root)[self.key]['worker_pid']))

    def test_pause_during_real_child_run_terminates_only_its_worker(self):
        self.store()
        executable = self.root / 'codex'
        executable.write_text('#!' + sys.executable + '\nimport sys,time\nsys.stdin.read()\ntime.sleep(30)\n')
        executable.chmod(0o700)
        env = {**supervisor.environment(), 'PATH': str(self.root) + ':' + os.environ['PATH']}
        result = []
        with patch.object(supervisor, 'environment', return_value=env):
            worker = threading.Thread(target=lambda: result.append(supervisor.resume(self.root, self.key, self.job)))
            worker.start()
            deadline = time.monotonic() + 5
            while 'worker_pid' not in supervisor.read_jobs(self.root)[self.key] and time.monotonic() < deadline:
                time.sleep(0.01)
            pid = supervisor.read_jobs(self.root)[self.key]['worker_pid']
            supervisor.control(self.root, argparse.Namespace(job=self.key, action='pause', execute=True))
            worker.join(timeout=6)
        self.assertFalse(worker.is_alive())
        self.assertIsNone(supervisor.process_stamp(pid))
        self.assertEqual(result[0]['reason'], 'owner_decision')
        self.assertEqual(supervisor.read_jobs(self.root)[self.key]['status'], 'paused')

    def test_finish_and_retry_refuse_an_active_worker_without_changing_state(self):
        process = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'], start_new_session=True)
        try:
            self.job.update({'status': 'running', 'worker_pid': process.pid,
                             'worker_stamp': supervisor.process_stamp(process.pid)})
            self.store()
            with patch.object(supervisor, 'snapshot', return_value={**self.fresh, 'merged': True}):
                for action in ['finish', 'retry']:
                    with self.assertRaises(ValueError):
                        supervisor.control(self.root, argparse.Namespace(job=self.key, action=action, execute=True))
                    self.assertEqual(supervisor.read_jobs(self.root)[self.key], self.job)
                self.job.update({'status': 'launching', 'worker_pid': None, 'launch_pending': True})
                self.store()
                with self.assertRaises(ValueError):
                    supervisor.control(self.root, argparse.Namespace(job=self.key, action='finish', execute=True))
                self.assertEqual(supervisor.read_jobs(self.root)[self.key], self.job)
        finally:
            process.terminate()
            process.wait()

    def test_finish_requires_merged_pr_and_stops_future_wakeups(self):
        self.store()
        args = argparse.Namespace(job=self.key, action='finish', execute=True)
        with patch.object(supervisor, 'snapshot', return_value=self.fresh):
            with self.assertRaises(ValueError):
                supervisor.control(self.root, args)
            self.fresh['merged'] = True
            supervisor.control(self.root, args)
        self.assertEqual(supervisor.read_jobs(self.root)[self.key]['status'], 'complete')

    def test_enrollment_refuses_duplicate_worktree_and_read_only_preview_has_no_state(self):
        args = argparse.Namespace(session=self.job['session'], provider='codex', worktree=str(self.root),
                                  pr=7, owner_pid=1234, execute=False)
        def git(cwd, *argv):
            if argv == ('rev-parse', '--show-toplevel'):
                return str(self.root.resolve())
            if argv == ('branch', '--show-current'):
                return 'feat/task'
            return self.fresh['head']
        state = self.root / 'new-state'
        with patch.object(supervisor, 'git', side_effect=git), \
                patch.object(supervisor, 'repository', return_value=self.job['repo']), \
                patch.object(supervisor, 'transcript', return_value=str(self.record)), \
                patch.object(supervisor, 'process_stamp', return_value='owner'), \
                patch.object(supervisor, 'snapshot', return_value=self.fresh):
            supervisor.enroll(state, args)
            self.assertFalse(state.exists())
            args.execute = True
            supervisor.enroll(state, args)
            args.session = '00000000-0000-4000-8000-000000000002'
            with self.assertRaises(ValueError):
                supervisor.enroll(state, args)
            existing = supervisor.read_jobs(state)
            existing_key = next(iter(existing))
            args.session = self.job['session']
            for pending, alive in [(True, False), (False, True)]:
                existing[existing_key].update({'status': 'paused', 'launch_pending': pending})
                supervisor.atomic_json(state / 'jobs.json', existing)
                with patch.object(supervisor, 'group_active', return_value=alive):
                    with self.assertRaises(ValueError):
                        supervisor.enroll(state, args)
                self.assertEqual(supervisor.read_jobs(state), existing)
        self.assertEqual(len(supervisor.read_jobs(state)), 1)

    def test_install_uses_reviewed_copy_and_launchd_runs_execute_tick(self):
        launch_home = self.root / 'home'
        launch_home.mkdir()
        state = launch_home / '.local/share/waves-session-supervisor'
        with patch.dict(os.environ, {'CODEX_HOME': str(launch_home / 'codex-custom'),
                                     'CLAUDE_CONFIG_DIR': str(launch_home / 'claude-custom'),
                                     'SSH_AUTH_SOCK': '/custom/ssh-agent.sock'}), \
                patch.object(supervisor.sys, 'platform', 'darwin'), \
                patch.object(supervisor.Path, 'home', return_value=launch_home), \
                patch.object(supervisor.shutil, 'which', return_value='/usr/bin/tool'), \
                patch.object(supervisor, 'command', return_value='') as run:
            supervisor.install(state)
            self.assertFalse(state.exists())
            supervisor.install(state, execute=True)
            data = supervisor.plistlib.loads((launch_home / 'Library/LaunchAgents/com.waves.session-supervisor.plist').read_bytes())
            self.assertEqual(data['ProgramArguments'][-2:], ['tick', '--execute'])
            self.assertEqual(Path(data['ProgramArguments'][1]).read_bytes(), Path(supervisor.__file__).read_bytes())
            self.assertEqual(data['StartInterval'], 60)
            self.assertEqual(data['EnvironmentVariables']['CODEX_HOME'], str(launch_home / 'codex-custom'))
            self.assertEqual(data['EnvironmentVariables']['CLAUDE_CONFIG_DIR'], str(launch_home / 'claude-custom'))
            self.assertEqual(data['EnvironmentVariables']['SSH_AUTH_SOCK'], '/custom/ssh-agent.sock')
            self.assertEqual(sum(c.args[0][:2] == ['launchctl', 'bootstrap'] for c in run.call_args_list), 1)
            with patch.object(supervisor.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0)):
                with self.assertRaises(ValueError):
                    supervisor.install(state, execute=True)
            preserved = {'job': {'status': 'paused'}}
            supervisor.atomic_json(state / 'jobs.json', preserved)
            with patch.object(supervisor.subprocess, 'run', return_value=subprocess.CompletedProcess([], 113)):
                supervisor.install(state, execute=True)
            self.assertEqual(supervisor.read_jobs(state), preserved)
            self.assertEqual(sum(c.args[0][:2] == ['launchctl', 'bootstrap'] for c in run.call_args_list), 2)

    def test_default_launchd_ssh_socket_is_inherited_instead_of_pinned_across_logins(self):
        home = self.root / 'home'
        state = home / 'state'
        with patch.dict(os.environ, {'SSH_AUTH_SOCK': '/per-login/socket'}), \
                patch.object(supervisor.sys, 'platform', 'darwin'), \
                patch.object(supervisor.Path, 'home', return_value=home), \
                patch.object(supervisor.shutil, 'which', return_value='/usr/bin/tool'), \
                patch.object(supervisor, 'command', return_value='/per-login/socket'):
            supervisor.install(state, execute=True)
        data = supervisor.plistlib.loads((home / 'Library/LaunchAgents/com.waves.session-supervisor.plist').read_bytes())
        self.assertNotIn('SSH_AUTH_SOCK', data['EnvironmentVariables'])

    def test_child_environment_drops_production_and_integration_credentials(self):
        with patch.dict(os.environ, {'DATABASE_URL': 'do-not-inherit', 'ANTHROPIC_API_KEY': 'do-not-inherit',
                                     'STRIPE_SECRET_KEY': 'do-not-inherit', 'NODE_OPTIONS': 'do-not-inherit',
                                     'SSH_AUTH_SOCK': '/current/ssh-agent.sock'}):
            self.assertFalse(set(['DATABASE_URL', 'ANTHROPIC_API_KEY', 'STRIPE_SECRET_KEY', 'NODE_OPTIONS'])
                             & set(supervisor.environment()))
            self.assertEqual(supervisor.environment()['SSH_AUTH_SOCK'], '/current/ssh-agent.sock')


if __name__ == '__main__':
    unittest.main()
