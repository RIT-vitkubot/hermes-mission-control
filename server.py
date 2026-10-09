#!/usr/bin/env python3
"""Entry point: python3 server.py --port 8090 --bind 127.0.0.1,10.8.0.25"""

import sys

from mission_control.server import main

if __name__ == "__main__":
    sys.exit(main())
