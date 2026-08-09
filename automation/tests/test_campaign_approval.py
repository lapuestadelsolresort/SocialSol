import unittest

from campaign_approval import ApprovalError, bind_approval_request, verify_slack_message


def payload(message):
    return {"payload": {"ok": True, "messages": [message]}}


class CampaignApprovalTests(unittest.TestCase):
    def test_request_binding_requires_matching_brief_id(self):
        import campaign_approval
        original = campaign_approval.read_slack_message
        campaign_approval.read_slack_message = lambda *args, **kwargs: payload({
            "ts": "200.1", "bot_id": "B1", "text": "Brief: planner-partner-prospecting",
        })
        try:
            updated = bind_approval_request(
                [{"brief_id": "planner-partner-prospecting"}],
                brief_id="planner-partner-prospecting",
                channel_id="C1",
                request_ts="200.1",
            )
            self.assertEqual(updated[0]["approval_request"]["slack_ts"], "200.1")
        finally:
            campaign_approval.read_slack_message = original

    def test_real_human_thread_reply_is_accepted(self):
        result = verify_slack_message(
            payload({
                "ts": "200.2",
                "thread_ts": "200.1",
                "user": "U-JASON",
                "text": "launch it",
            }),
            slack_ts="200.2",
            approver_user_id="U-JASON",
            request_ts="200.1",
        )
        self.assertEqual(result["quoted_text"], "launch it")

    def test_fake_timestamp_fails(self):
        with self.assertRaisesRegex(ApprovalError, "did not resolve"):
            verify_slack_message(
                payload({"ts": "200.2", "user": "U-JASON", "text": "go"}),
                slack_ts="999.9",
                approver_user_id="U-JASON",
            )

    def test_wrong_user_fails(self):
        with self.assertRaisesRegex(ApprovalError, "configured approver"):
            verify_slack_message(
                payload({"ts": "200.2", "user": "U-OTHER", "text": "go"}),
                slack_ts="200.2",
                approver_user_id="U-JASON",
            )

    def test_unrelated_channel_message_fails_thread_binding(self):
        with self.assertRaisesRegex(ApprovalError, "not a reply"):
            verify_slack_message(
                payload({"ts": "200.2", "user": "U-JASON", "text": "go"}),
                slack_ts="200.2",
                approver_user_id="U-JASON",
                request_ts="200.1",
            )

    def test_bot_message_fails(self):
        with self.assertRaisesRegex(ApprovalError, "bot/app"):
            verify_slack_message(
                payload({"ts": "200.2", "user": "U-JASON", "text": "go", "bot_id": "B1"}),
                slack_ts="200.2",
                approver_user_id="U-JASON",
            )


if __name__ == "__main__":
    unittest.main()
