import datetime
import json
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "profiles" / "karry" / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

import seeds_farm_tick  # noqa: E402
import seeds_lib  # noqa: E402
import seeds_slack  # noqa: E402


def _write_seeds(path: Path, seeds: list[dict]) -> None:
    path.write_text(
        "".join(json.dumps(seed, ensure_ascii=False) + "\n" for seed in seeds),
        encoding="utf-8",
    )


class SeedBuryCountdownTest(unittest.TestCase):
    def test_low_seed_gets_pending_bury_since_on_first_lifecycle_scan(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "seeds.jsonl"
            _write_seeds(path, [{
                "id": "seed-low",
                "kind": "idea",
                "title": "low seed",
                "maturity": 10,
                "status": "active",
                "context": {},
            }])

            original_scan = seeds_farm_tick.scan_seed_evidence
            seeds_farm_tick.scan_seed_evidence = lambda seed, now=None: {"confidence": 0.34}
            try:
                result = seeds_farm_tick.apply_seed_auto_lifecycle(
                    path=path,
                    now=datetime.datetime(2026, 5, 12, 9, 0, 0),
                )
            finally:
                seeds_farm_tick.scan_seed_evidence = original_scan

            seed = seeds_lib.load_all(path)[0]
            self.assertEqual(result["pending_bury_started"], 1)
            self.assertEqual(result["low"], 1)
            self.assertEqual(result["mid_questions"], [])
            self.assertEqual(seed["pending_bury_since"], "2026-05-12")
            self.assertEqual(seed["status"], "active")

    def test_low_seed_pending_for_four_days_is_auto_archived(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "seeds.jsonl"
            _write_seeds(path, [{
                "id": "seed-old-low",
                "kind": "idea",
                "title": "old low seed",
                "maturity": 10,
                "status": "active",
                "pending_bury_since": "2026-05-08",
                "context": {},
            }])

            original_scan = seeds_farm_tick.scan_seed_evidence
            seeds_farm_tick.scan_seed_evidence = lambda seed, now=None: {"confidence": 0.34}
            try:
                result = seeds_farm_tick.apply_seed_auto_lifecycle(
                    path=path,
                    now=datetime.datetime(2026, 5, 12, 9, 0, 0),
                )
            finally:
                seeds_farm_tick.scan_seed_evidence = original_scan

            seed = seeds_lib.load_all(path)[0]
            self.assertEqual(result["auto_buried"], 1)
            self.assertEqual(seed["status"], "archived")
            self.assertEqual(seed["archive_reason"], "auto-bury")
            self.assertTrue(seed["archived_at"].startswith("2026-05-12T09:00:00"))

    def test_low_seed_card_renders_auto_archive_countdown(self):
        yesterday = (datetime.datetime.now().date() - datetime.timedelta(days=1)).isoformat()
        seed = {
            "id": "seed-card",
            "kind": "idea",
            "title": "card seed",
            "maturity": 10,
            "status": "active",
            "source": "test",
            "pending_bury_since": yesterday,
            "_auto_water_confidence": 0.34,
        }

        blocks = seeds_slack.render_active_seed_blocks(seed, include_actions=False, compact=True)
        text = blocks[0]["text"]["text"]
        self.assertIn("T-2d 自动归档", text)


if __name__ == "__main__":
    unittest.main()
