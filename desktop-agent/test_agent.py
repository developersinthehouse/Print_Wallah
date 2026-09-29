import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import Mock, patch

from agent import PrintAgent, SUBSCRIPTION_RECHECK_SECONDS, SubscriptionExpired


class PrintAgentSubscriptionTests(unittest.TestCase):
    def test_expired_agent_waits_and_rechecks_instead_of_exiting(self):
        agent = PrintAgent.__new__(PrintAgent)
        agent.shop_id = "shop-1"

        with patch.object(
            agent,
            "poll_jobs",
            side_effect=[SubscriptionExpired("expired"), KeyboardInterrupt],
        ) as poll_jobs:
            with patch("agent.time.sleep") as sleep:
                with self.assertRaises(KeyboardInterrupt):
                    agent.run_forever()

        self.assertEqual(poll_jobs.call_count, 2)
        sleep.assert_called_once_with(SUBSCRIPTION_RECHECK_SECONDS)


class PrintAgentOrderTests(unittest.TestCase):
    def test_download_resolves_relative_file_url_and_authenticates_same_origin(self):
        agent = PrintAgent.__new__(PrintAgent)
        agent.api_base_url = "https://api.example.test"
        agent.headers = {"Authorization": "Bearer agent-token"}
        agent.session = Mock()
        response = Mock()
        response.iter_content.return_value = [b"%PDF-test"]
        agent.session.get.return_value = response

        with TemporaryDirectory() as directory:
            agent.spool_directory = Path(directory)
            file_path = agent.download_job_file({
                "id": "job-1",
                "fileUrl": "/api/shops/shop-1/print-jobs/job-1/file",
                "fileName": "document.pdf",
            })

            self.assertEqual(file_path.suffix, ".pdf")
            self.assertEqual(file_path.read_bytes(), b"%PDF-test")
        agent.session.get.assert_called_once_with(
            "https://api.example.test/api/shops/shop-1/print-jobs/job-1/file",
            stream=True,
            headers=agent.headers,
            timeout=20,
        )

    def test_process_job_dispatches_requested_number_of_copies(self):
        agent = PrintAgent.__new__(PrintAgent)
        agent.handled_job_ids = set()

        with patch.object(agent, "download_job_file", return_value=Path("document.pdf")):
            with patch.object(PrintAgent, "send_to_printer") as send_to_printer:
                with patch.object(agent, "report_result") as report_result:
                    agent.process_job({"id": "job-2", "copies": 3})

        self.assertEqual(send_to_printer.call_count, 3)
        report_result.assert_called_once_with("job-2", "PRINTED", None)


if __name__ == "__main__":
    unittest.main()
