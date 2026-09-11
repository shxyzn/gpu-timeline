#!/usr/bin/python3
"""Shared GPU Timeline client. Python 3.8+, stdlib only; no token or user config."""
import json
import socket
import sys

import gpu_agent

SOCKET_PATH = "/run/gpu-timeline/control.sock"


def main():
    gpu_agent.parser(shared=True).parse_args()
    data = (json.dumps({"argv": sys.argv[1:]}, ensure_ascii=False) + "\n").encode()
    if len(data) > 16384:
        print("오류: 요청이 너무 큽니다.", file=sys.stderr)
        return 1
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(40)
            connection.connect(SOCKET_PATH)
            connection.sendall(data)
            with connection.makefile("rb") as response:
                line = response.readline(2 * 1024 * 1024 + 1)
            if len(line) > 2 * 1024 * 1024 or not line.endswith(b"\n"):
                raise ValueError("응답을 확인할 수 없습니다.")
            result = json.loads(line)
    except (OSError, ValueError):
        print("공용 수집기 응답을 확인하지 못했습니다. gputl list로 저장 여부를 확인하세요. "
              "계속 실패하면 관리자에게 gpu-timeline-shared 서비스 확인을 요청하세요.", file=sys.stderr)
        return 1
    if not result.get("ok"):
        print("오류: " + result.get("error", "요청 실패"), file=sys.stderr)
        return 1
    if "message" in result:
        print(result["message"])
        print(result.get("note", ""))
    else:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
