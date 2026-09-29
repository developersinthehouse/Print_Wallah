import unittest
from unittest.mock import patch

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


if __name__ == "__main__":
    unittest.main()