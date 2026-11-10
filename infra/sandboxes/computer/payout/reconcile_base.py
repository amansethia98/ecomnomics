"""Workbook helpers shared with the existing settlement command.

The implementation lives in ``rakazo-zomato-reconcile``. Loading that file
keeps one copy of the reader and the workbook writer.
"""

from __future__ import annotations

import importlib.machinery
import importlib.util
import sys
from pathlib import Path


def _source() -> Path:
    here = Path(__file__).resolve().parent
    candidates = [
        here.parent / "rakazo-zomato-reconcile",
        Path("/usr/local/bin/rakazo-zomato-reconcile"),
    ]
    for path in candidates:
        if path.is_file():
            return path
    raise ImportError("rakazo-zomato-reconcile is not installed")


def _load():
    path = _source()
    loader = importlib.machinery.SourceFileLoader("rakazo_zomato_reconcile", str(path))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    if spec is None:
        raise ImportError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    loader.exec_module(module)
    return module


_impl = _load()


def __getattr__(name: str):
    return getattr(_impl, name)
