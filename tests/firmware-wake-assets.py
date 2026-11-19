import importlib.util
import json
from pathlib import Path
import struct
import unittest


spec = importlib.util.spec_from_file_location(
    "wake_assets", Path(__file__).resolve().parents[1] / "scripts" / "prepare-firmware-wake-assets.py"
)
assets = importlib.util.module_from_spec(spec)
spec.loader.exec_module(assets)
COMMANDS = json.loads(assets.DEFAULT_COMMANDS.read_text(encoding="utf-8"))


class WakeAssetsTest(unittest.TestCase):
    def setUp(self):
        self.index = {
            "version": 1, "srmodels": "srmodels.bin", "text_font": "font.bin",
            "multinet_model": {"language": "cn", "threshold": 0.2, "duration": 3000,
                               "commands": [COMMANDS[0]]},
        }
        self.original = assets.pack_assets([
            ("index.json", json.dumps(self.index).encode(), 0, 0),
            ("srmodels.bin", bytes(range(256)), 0, 0),
            ("font.bin", b"unchanged font", 16, 32),
        ])

    def test_only_commands_change_and_repeated_updates_are_idempotent(self):
        updated = assets.add_wake_commands(self.original, COMMANDS, 8192)
        before = assets.unpack_assets(self.original)
        after = assets.unpack_assets(updated)
        self.assertEqual(before[1:], after[1:])
        index = json.loads(after[0][1])
        self.assertEqual(index["multinet_model"].pop("commands"), COMMANDS)
        del self.index["multinet_model"]["commands"]
        self.assertEqual(index, self.index)
        self.assertEqual(updated, assets.add_wake_commands(updated, COMMANDS, 8192))

    def test_corrupt_and_truncated_backups_are_rejected(self):
        damaged = bytearray(self.original)
        damaged[-1] ^= 1
        for data in (b"", self.original[:11], self.original[:-1], damaged):
            with self.subTest(length=len(data)), self.assertRaises(ValueError):
                assets.add_wake_commands(data, COMMANDS, 8192)

    def test_partition_limit_includes_sector_rounding(self):
        with self.assertRaisesRegex(ValueError, "partition size"):
            assets.add_wake_commands(self.original, COMMANDS, 4095)

    def test_conflicting_commands_are_rejected(self):
        wrong = [{**COMMANDS[0], "text": "incorrect label"}]
        with self.assertRaisesRegex(ValueError, "Conflicting"):
            assets.add_wake_commands(self.original, wrong, 8192)

    def test_other_commands_are_preserved(self):
        other = {"command": "kai deng", "text": "开灯", "action": "command"}
        self.index["multinet_model"]["commands"].append(other)
        original = assets.unpack_assets(self.original)
        original[0] = ("index.json", json.dumps(self.index).encode(), 0, 0)
        updated = assets.add_wake_commands(assets.pack_assets(original), COMMANDS, 8192)
        commands = json.loads(assets.unpack_assets(updated)[0][1])["multinet_model"]["commands"]
        self.assertEqual(commands, [COMMANDS[0], other, COMMANDS[1]])

    def test_invalid_offsets_are_rejected_even_with_valid_checksum(self):
        damaged = bytearray(self.original)
        struct.pack_into("<I", damaged, 12 + 36, 0xffffffff)
        struct.pack_into("<I", damaged, 4, sum(damaged[12:]) & 0xffff)
        with self.assertRaisesRegex(ValueError, "bounds"):
            assets.unpack_assets(damaged)


if __name__ == "__main__":
    unittest.main()
