#!/usr/bin/env python3
"""Static check for the browser-only ES modules (operator console, customer
site): every relative `import {a, b} from './x.js'` must point at a file that
really exports a and b. Node can't load these pages (three.js comes from a
CDN), so this is what catches a renamed export or a deleted module."""
import pathlib
import re
import sys

IMPORT = re.compile(r"import\s*\{([^}]*)\}\s*from\s*'(\.[^']+)'")
DECL = re.compile(r"export\s+(?:async\s+)?(?:function|class|const|let)\s+(\w+)")
LIST = re.compile(r"export\s*\{([^}]*)\}")


def exports(path: pathlib.Path) -> set[str]:
    src = path.read_text()
    names = set(DECL.findall(src))
    for group in LIST.findall(src):
        names |= {x.split(" as ")[-1].strip() for x in group.split(",") if x.strip()}
    return names


problems, checked = [], 0
for root in sys.argv[1:] or ["drafts/cargo-ship/js", "customers"]:
    for f in pathlib.Path(root).rglob("*.js"):
        for names, rel in IMPORT.findall(f.read_text()):
            checked += 1
            target = (f.parent / rel).resolve()
            if not target.exists():
                problems.append(f"{f}: missing module {rel}")
                continue
            have = exports(target)
            for name in (x.split(" as ")[0].strip() for x in names.split(",") if x.strip()):
                if name not in have:
                    problems.append(f"{f}: {rel} has no export '{name}'")
print(f"{checked} relative imports checked, {len(problems)} problems")
for p in problems:
    print("  " + p)
sys.exit(1 if problems else 0)
