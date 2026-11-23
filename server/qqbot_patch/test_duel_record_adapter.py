import copy
import unittest

from duel_record_adapter import to_report


class AdapterTests(unittest.TestCase):
    def setUp(self):
        def state(pid, hp, block=0, energy=0):
            return dict(id=pid, hp=hp, block=block, energy=energy, orbs=[], powers=[])
        before = [state(2, 75, energy=2), state(1, 6, block=0)]
        after = [state(2, 75, energy=1), state(1, 0)]
        self.record = dict(mode='alternating_immediate', first=2, rear=1, winner=[2], turns=[
            dict(turn=1, actor=2, draw=['STRIKE_DEFECT'], before=before,
                 plays=[dict(card='STRIKE_DEFECT', before=before, after=after)], after=after)])

    def test_identity_order_and_localized_cards(self):
        report = to_report(self.record, {'1': '甲', '2': '乙'})
        self.assertIn('先手：乙', report)
        self.assertIn('出牌：打击', report)
        self.assertIn('HP 75:0', report)
        self.assertIn('胜者：乙', report)

    def test_wrong_winner_is_rejected(self):
        record = copy.deepcopy(self.record)
        record['winner'] = [1]
        with self.assertRaises(ValueError):
            to_report(record)

    def test_legacy_simultaneous_record_is_rejected(self):
        with self.assertRaises(ValueError):
            to_report({'mode': 'simultaneous'})


if __name__ == '__main__':
    unittest.main()
