"""Add Douli wake commands to an existing LVGL assets image; never flash a device."""

import argparse
import hashlib
import json
from pathlib import Path
import struct


HEADER = struct.Struct("<III")
ENTRY = struct.Struct("<32sIIHH")
DEFAULT_COMMANDS = Path(__file__).resolve().parents[1] / "firmware" / "wake-words.json"


def unpack_assets(data):
    if len(data) < HEADER.size:
        raise ValueError("Truncated assets header")
    count, checksum, length = HEADER.unpack_from(data)
    if not 0 < count < 1000 or not count * ENTRY.size <= length <= len(data) - HEADER.size:
        raise ValueError("Invalid assets length or file count")
    if sum(data[HEADER.size:HEADER.size + length]) & 0xffff != checksum:
        raise ValueError("Assets checksum mismatch")
    payload_start = HEADER.size + count * ENTRY.size
    end = HEADER.size + length
    assets, names, spans = [], set(), []
    for i in range(count):
        raw_name, size, offset, width, height = ENTRY.unpack_from(data, HEADER.size + i * ENTRY.size)
        name = raw_name.split(b"\0", 1)[0].decode("ascii")
        if not name or name in names or b"\0" not in raw_name:
            raise ValueError("Invalid or duplicate asset name")
        start = payload_start + offset
        stop = start + 2 + size
        if stop > end or data[start:start + 2] != b"ZZ":
            raise ValueError(f"Invalid asset bounds or marker: {name}")
        if any(start < previous_end and stop > previous_start for previous_start, previous_end in spans):
            raise ValueError(f"Overlapping asset: {name}")
        names.add(name)
        spans.append((start, stop))
        assets.append((name, data[start + 2:stop], width, height))
    return assets


def pack_assets(assets):
    table, payload = bytearray(), bytearray()
    for name, data, width, height in assets:
        table.extend(ENTRY.pack(name.encode("ascii"), len(data), len(payload), width, height))
        payload.extend(b"ZZ" + data)
    body = table + payload
    return HEADER.pack(len(assets), sum(body) & 0xffff, len(body)) + body


def add_wake_commands(data, requested, partition_size):
    assets = unpack_assets(data)
    files = {name: content for name, content, _, _ in assets}
    if "index.json" not in files:
        raise ValueError("Missing index.json")
    index = json.loads(files["index.json"])
    model = index.get("multinet_model")
    if not isinstance(model, dict) or model.get("language") != "cn":
        raise ValueError("Expected an existing Chinese MultiNet configuration")
    if index.get("srmodels") not in files:
        raise ValueError("Missing speech model referenced by index.json")
    commands = model.get("commands")
    if not isinstance(commands, list) or not commands:
        raise ValueError("Missing existing MultiNet commands")
    if not isinstance(requested, list) or not requested:
        raise ValueError("No wake commands requested")
    for command in requested:
        if (not isinstance(command, dict) or set(command) != {"command", "text", "action"}
                or command["action"] != "wake"
                or any(not isinstance(value, str) or not value.strip() for value in command.values())):
            raise ValueError("Invalid wake command")
        matches = [item for item in commands if item.get("command") == command["command"]]
        if matches and matches != [command]:
            raise ValueError(f"Conflicting existing command: {command['command']}")
        if not matches:
            commands.append(dict(command))
    updated = [
        (name, json.dumps(index, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
         if name == "index.json" else content, width, height)
        for name, content, width, height in assets
    ]
    packed = pack_assets(updated)
    # esptool erases whole flash sectors, so check the rounded size too.
    if (len(packed) + 4095) // 4096 * 4096 > partition_size:
        raise ValueError("Updated assets exceed the verified partition size")
    if unpack_assets(packed) != updated:
        raise ValueError("Assets round-trip verification failed")
    return packed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True, help="Assets extracted from a current device backup")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--partition-size", type=lambda value: int(value, 0), required=True,
                        help="Actual assets partition size, verified from the device partition table")
    parser.add_argument("--commands", type=Path, default=DEFAULT_COMMANDS)
    args = parser.parse_args()
    original = args.input.read_bytes()
    commands = json.loads(args.commands.read_text(encoding="utf-8"))
    packed = add_wake_commands(original, commands, args.partition_size)
    # Refuse to overwrite the backup or an existing output.
    with args.output.open("xb") as output:
        output.write(packed)
    report = {
        "inputSha256": hashlib.sha256(original).hexdigest(),
        "outputSha256": hashlib.sha256(packed).hexdigest(),
        "assetBytes": len(packed),
        "partitionSize": args.partition_size,
        "wakeWords": [command["text"] for command in commands],
        "changedAssets": ["index.json"],
        "flashed": False,
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
