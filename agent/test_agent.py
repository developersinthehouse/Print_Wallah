import pathlib
import tempfile
import unittest
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


if __name__ == "__main__":
    unittest.main()
