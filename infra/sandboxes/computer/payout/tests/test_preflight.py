import importlib.machinery
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[2] / 'payout-preflight'
loader = importlib.machinery.SourceFileLoader('payout_preflight', str(SCRIPT))
spec = importlib.util.spec_from_loader(loader.name, loader)
preflight = importlib.util.module_from_spec(spec)
loader.exec_module(preflight)


class PayoutPreflightTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.lib = self.root / 'usr/local/lib/rakazo/payout'
        for path in (self.lib, self.lib / 'examples', self.root / 'usr/local/share/payout-reconciliation'):
            path.mkdir(parents=True, exist_ok=True)
            path.chmod(0o755)
        self.addCleanup(self.lib.chmod, 0o755)

    def test_rejects_real_copy_0644_directory_even_as_root_before_commands(self):
        self.lib.chmod(0o644)
        with patch.object(preflight.subprocess, 'run') as run:
            errors = preflight.check_install('swiggy', self.root)
        self.assertIn('not readable/searchable', errors[0])
        run.assert_not_called()

    def test_swapped_missing_data_directory_stops_before_commands(self):
        (self.lib / 'examples').rmdir()
        with patch.object(preflight.subprocess, 'run') as run:
            self.assertTrue(preflight.check_install('zomato', self.root))
        run.assert_not_called()

    def test_swiggy_checks_only_its_installed_cli_without_financial_data(self):
        with patch.object(preflight.subprocess, 'run') as run:
            run.return_value.returncode = 0
            self.assertEqual(preflight.check_install('swiggy', self.root), [])
        self.assertEqual(run.call_args.args[0], [str(self.root / 'usr/local/bin/payout-swiggy-reconcile'), '--help'])
        self.assertEqual(run.call_count, 1)

    def test_both_and_unavailable_cli(self):
        with patch.object(preflight.subprocess, 'run') as run:
            run.return_value.returncode = 0
            self.assertEqual(preflight.check_install('both', self.root), [])
            self.assertEqual(run.call_count, 2)
            run.side_effect = PermissionError()
            self.assertIn('unavailable', preflight.check_install('swiggy', self.root)[0])


if __name__ == '__main__':
    unittest.main()
