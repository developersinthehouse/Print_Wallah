import pathlib
import tempfile
import unittest
import json
from types import SimpleNamespace
from unittest.mock import patch

import print_agent


class AgentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        print_agent.STATE_PATH = pathlib.Path(self.temp.name) / "state.sqlite3"
        print_agent.init_state()
        self.config = {
            "server_url": "http://example.invalid",
            "shop_id": "SHOP1",
            "agent_token": "token",
            "printer_name": "Counter Printer",
            "print_command": ["lp", "-d", "{printer}", "-n", "{copies}", "-P", "{page_range}", "{file}"],
        }
        self.job = {
            "job_id": "job-1",
            "order_code": "PR-TEST",
            "downloadUrl": "/api/agent/SHOP1/jobs/job-1/document",
            "original_name": "job.pdf",
            "copies": 2,
            "page_count": 2,
            "config": {"pageRange": "1-2", "sourcePageCount": 6, "printPageCount": 6, "paperSize": "A4", "color": False, "duplex": False},
        }

    def tearDown(self):
        self.temp.cleanup()

    def test_job_maps_selected_pages_and_copies_to_command(self):
        calls = []

        def fake_request(_config, endpoint, method="GET", body=None, binary=False):
            calls.append((endpoint, method, body, binary))
            return b"%PDF-test" if binary else {}

        with patch.object(print_agent, "request", side_effect=fake_request), patch.object(print_agent.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout="", stderr="")) as run:
            print_agent.print_job(self.config, self.job)

        command = run.call_args.args[0]
        self.assertEqual(command[command.index("-P") + 1], "1-2")
        self.assertEqual(command[command.index("-n") + 1], "2")
        self.assertEqual(calls[-1][2]["status"], "completed")
        self.assertEqual(print_agent.previous_state("job-1"), "completed")

    def test_missing_nondefault_option_fails_without_printing(self):
        self.config["print_command"] = ["lp", "{file}"]
        with patch.object(print_agent, "request") as request, patch.object(print_agent.subprocess, "run") as run:
            print_agent.print_job(self.config, self.job)
        run.assert_not_called()
        self.assertTrue(any(call.args[3].get("status") == "failed" for call in request.call_args_list))

    def test_completed_local_job_is_acknowledged_without_a_second_print(self):
        print_agent.save_state("job-1", "completed")
        with patch.object(print_agent, "request", return_value={}) as request, patch.object(print_agent.subprocess, "run") as run:
            print_agent.print_job(self.config, self.job)
        run.assert_not_called()
        self.assertEqual(request.call_args.args[3]["status"], "completed")

    def test_config_rejects_a_missing_print_executable(self):
        config_path = pathlib.Path(self.temp.name) / "config.json"
        config_path.write_text(json.dumps({
            "server_url": "https://print.example.com",
            "shop_id": "SHOP1",
            "agent_token": "private-test-token",
            "printer_name": "Counter Printer",
            "print_command": ["missing-printer-tool", "{file}"],
        }), encoding="utf-8")

        with patch.object(print_agent, "CONFIG_PATH", config_path), patch.object(print_agent.shutil, "which", return_value=None):
            with self.assertRaisesRegex(RuntimeError, "print_command executable"):
                print_agent.read_config()

    def test_glossy_paper_type_is_forwarded_to_print_command(self):
        config = dict(self.config)
        config["allow_glossy"] = True
        config["print_command"] = [
            "printcmd", "--copies={copies}", "--pages={page_range}",
            "--paper={paper_type}", "{file}",
        ]
        job = dict(self.job)
        job["config"] = {**self.job["config"], "paperType": "glossy"}

        with patch.object(print_agent, "request", return_value=b"%PDF-test"), patch.object(
            print_agent.subprocess,
            "run",
            return_value=SimpleNamespace(returncode=0, stdout="", stderr=""),
        ) as run:
            print_agent.print_job(config, job)

        self.assertIn("--paper=glossy", run.call_args.args[0])

    def test_glossy_order_is_not_sent_to_printer_by_default(self):
        job = dict(self.job)
        job["config"] = {**self.job["config"], "paperType": "glossy"}
        with patch.object(print_agent, "request", return_value={}) as request, patch.object(print_agent.subprocess, "run") as run:
            print_agent.print_job(self.config, job)
        run.assert_not_called()
        self.assertEqual(request.call_args.args[3]["status"], "failed")
        self.assertIn("Glossy-paper jobs are disabled", request.call_args.args[3]["error"])

    def test_long_print_renews_the_specific_job_lease(self):
        heartbeat = print_agent.Heartbeat(self.config, "job-1")

        with patch.object(print_agent, "request", return_value={}) as request:
            heartbeat.renew_lease()

        self.assertEqual(request.call_args.args[1], "/api/agent/SHOP1/jobs/job-1/heartbeat")
        self.assertEqual(request.call_args.args[2], "POST")


if __name__ == "__main__":
    unittest.main()
