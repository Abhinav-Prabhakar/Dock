"""Dock live API server package.

Importing this package makes the backend/ directory importable (so
``from simulator import ...`` etc. resolve) regardless of the cwd the
server was launched from.
"""

import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))
