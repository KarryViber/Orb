import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


SERVER_PATH = (
    Path(__file__).resolve().parents[1]
    / "profiles/karry/workspace/tools/skill-manager-mcp/server.py"
)


def load_server():
    spec = importlib.util.spec_from_file_location("skill_manager_server", SERVER_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class SkillManagerFailLoudTest(unittest.TestCase):
    def test_propose_slack_failure_raises_after_writing_pending_and_dm(self):
        server = load_server()
        with tempfile.TemporaryDirectory() as tmp:
            proposals_dir = Path(tmp)
            pending_id = "20260502090000-abcdef"
            with (
                patch.object(server, "PROPOSALS_DIR", proposals_dir),
                patch.object(server, "_new_pending_id", return_value=pending_id),
                patch.object(server, "_post_karry_dm", return_value="1746144000.000100") as dm,
                patch.dict(os.environ, {"ORB_CHANNEL": "", "ORB_THREAD_TS": ""}, clear=False),
            ):
                with self.assertRaisesRegex(RuntimeError, "Slack delivery failed: no slack channel env"):
                    server.tool_skill_propose(
                        name="unit-test-fail-loud-skill",
                        description="A reusable test skill proposal",
                        body="## When to Use\nUse in tests.\n",
                        rationale="Regression coverage for Slack delivery failures.",
                    )

            pending_path = proposals_dir / f"{pending_id}.json"
            self.assertTrue(pending_path.exists())
            payload = json.loads(pending_path.read_text(encoding="utf-8"))
            self.assertEqual(payload["pending_id"], pending_id)
            dm.assert_called_once()
            self.assertIn(str(pending_path), dm.call_args.args[0])

    def test_resend_reposts_non_archived_pending_json(self):
        server = load_server()
        with tempfile.TemporaryDirectory() as tmp:
            proposals_dir = Path(tmp)
            proposals_dir.mkdir(parents=True, exist_ok=True)
            (proposals_dir / ".archive").mkdir()
            pending_id = "20260502090100-fedcba"
            pending_path = proposals_dir / f"{pending_id}.json"
            pending_path.write_text(
                json.dumps(
                    {
                        "pending_id": pending_id,
                        "action": "update",
                        "name": "existing-skill",
                        "scope": "profile",
                        "new_body": "## When to Use\nUpdated body.\n",
                        "rationale": "Retry pending Slack approval.",
                    },
                    ensure_ascii=False,
                )
                + "\n",
                encoding="utf-8",
            )
            with (
                patch.object(server, "PROPOSALS_DIR", proposals_dir),
                patch.object(server, "_post_approval_card", return_value={"posted": True, "ts": "1.2"}) as post,
                patch.dict(os.environ, {"ORB_CHANNEL": "C123", "ORB_THREAD_TS": "9.9"}, clear=False),
            ):
                result = server.tool_skill_resend(pending_id)

            self.assertEqual(result["status"], "awaiting_user_approval")
            self.assertEqual(result["slack"]["ts"], "1.2")
            post.assert_called_once()
            rewritten = json.loads(pending_path.read_text(encoding="utf-8"))
            self.assertEqual(rewritten["channel"], "C123")
            self.assertEqual(rewritten["thread_ts"], "9.9")


if __name__ == "__main__":
    unittest.main()
