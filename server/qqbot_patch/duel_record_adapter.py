"""Convert native alternating-duel snapshots to the existing text-report contract."""
import re
from collections import Counter
from pathlib import Path


def card_names():
    source = Path(__file__).with_name('toys.js').read_text(encoding='utf-8')
    section = source.split('const GAME_CARDS = {', 1)[1].split('\n};', 1)[0]
    result = {}
    for name, label in re.findall(r'^\s*(\w+):\s*\["([^"]+)"', section, re.M):
        # Native IDs split acronym/word boundaries too: IAmInvincible -> I_AM_INVINCIBLE.
        separated = re.sub(r'([A-Z]+)([A-Z][a-z])', r'\1_\2', name)
        identifier = re.sub(r'(?<=[a-z0-9])(?=[A-Z])', '_', separated).upper()
        result[identifier] = label
    return result


def to_report(record, players=None):
    if record.get('mode') != 'alternating_immediate':
        raise ValueError('Unsupported duel record mode')
    turns = record.get('turns')
    if not turns:
        raise ValueError('Duel record contains no turns')
    ids = [record['first'], record['rear']]
    if ids[0] == ids[1]:
        raise ValueError('Duel requires two distinct players')
    names = card_names()
    players = players or {}

    def player(pid):
        value = players.get(str(pid), players.get(pid, f'玩家{pid}'))
        return str(value).replace('\n', ' ').replace('\r', ' ')

    def card(identifier):
        if identifier.endswith('+'):
            return names.get(identifier[:-1], identifier[:-1]) + '+'
        return names.get(identifier, identifier)

    def states(items):
        result = {s['id']: s for s in items}
        if set(result) != set(ids):
            raise ValueError('Snapshot player IDs do not match duel participants')
        return result

    def hp(items):
        current = states(items)
        return 'HP ' + ':'.join(str(current[pid]['hp']) for pid in ids)

    def orbs(items):
        counts = Counter(items)
        labels = {'LIGHTNING_ORB': '电球', 'FROST_ORB': '冰球', 'DARK_ORB': '暗球', 'PLASMA_ORB': '等离子球', 'GLASS_ORB': '玻璃球'}
        return '、'.join(f'{amount}个{labels.get(kind, kind)}' for kind, amount in counts.items()) or '无'

    def changes(before, after):
        a, b = states(before), states(after)
        pieces = []
        for pid in ids:
            delta = b[pid]['hp'] - a[pid]['hp']
            if delta:
                pieces.append(f'{player(pid)}生命{"+" if delta > 0 else ""}{delta}')
            block_delta = b[pid]['block'] - a[pid]['block']
            if block_delta:
                pieces.append(f'{player(pid)}格挡{a[pid]["block"]}→{b[pid]["block"]}')
            if a[pid].get('stars', 0) != b[pid].get('stars', 0):
                pieces.append(f'{player(pid)}星星{a[pid].get("stars", 0)}→{b[pid].get("stars", 0)}')
            if a[pid].get('ostyHp') != b[pid].get('ostyHp'):
                pieces.append(f'{player(pid)}奥斯提{a[pid].get("ostyHp") or 0}→{b[pid].get("ostyHp") or 0}')
        return ' · '.join(pieces)

    lines = ['【轮流对战】', f'先手：{player(ids[0])}　后手：{player(ids[1])}',
             '血量顺序：先手 : 后手']
    rules = record.get('rules', {})
    lines.append(f'首轮保护：先手{rules.get("firstEnergy", 2)}能量；后手{rules.get("rearOpeningBlock", 10)}临时格挡，首次行动开始清除')
    for index, turn in enumerate(turns):
        expected = ids[index % 2]
        if turn['actor'] != expected:
            raise ValueError('Record does not alternate between the two players')
        current = states(turn['before'])[turn['actor']]
        lines += [f'第{index + 1}回合', f'{player(turn["actor"])}｜能量{current["energy"]}｜{hp(turn["before"])}',
                  '抽牌：' + ('、'.join(card(c) for c in turn['draw']) or '无')]
        if turn.get('start'):
            start_detail = changes(turn['start'], turn['before'])
            if start_detail:
                lines.append('回合开始：' + start_detail)
        for play in turn['plays']:
            a, b = states(play['before']), states(play['after'])
            actor = turn['actor']
            detail = changes(play['before'], play['after'])
            lines.append(f'出牌：{card(play["card"])}｜能量{a[actor]["energy"]}→{b[actor]["energy"]}' + (f' · {detail}' if detail else ''))
        before_end = turn['plays'][-1]['after'] if turn['plays'] else turn['before']
        detail = changes(before_end, turn['after'])
        lines.append('回合结束：' + (detail + '｜' if detail else '') + hp(turn['after']))
        final = states(turn['after'])[turn['actor']]
        if final['orbs']:
            lines.append('充能球：' + orbs(final['orbs']))
        effects = {identifier + '_POWER': label for identifier, label in names.items()}
        effects.update({'WEAK_POWER': '虚弱', 'VULNERABLE_POWER': '易伤', 'STRENGTH_POWER': '力量', 'DEXTERITY_POWER': '敏捷', 'FOCUS_POWER': '集中',
                   'FRAIL_POWER': '脆弱', 'POISON_POWER': '中毒', 'DOOM_POWER': '灾厄', 'DEMON_FORM_POWER': '恶魔形态',
                   'BARRICADE_POWER': '壁垒', 'BLUR_POWER': '残影', 'ENERGY_NEXT_TURN_POWER': '下回合能量',
                   'STAR_NEXT_TURN_POWER': '下回合星星', 'MACHINE_LEARNING_POWER': '机器学习', 'NOXIOUS_FUMES_POWER': '毒雾',
                   'DARK_EMBRACE_POWER': '黑暗之拥', 'FEEL_NO_PAIN_POWER': '无惧疼痛', 'AFTERIMAGE_POWER': '余像',
                   'INFINITE_BLADES_POWER': '无尽刀刃', 'ACCURACY_POWER': '精准', 'BUFFER_POWER': '缓冲', 'LOOP_POWER': '循环'})
        status = []
        for pid, state in states(turn['after']).items():
            if state['powers']:
                status.append(player(pid) + '：' + '、'.join(f'{effects.get(p["id"], p["id"])}{p["amount"]}' for p in state['powers']))
        if status:
            lines.append('状态：' + '；'.join(status))
    winners = record.get('winner', [])
    alive = [pid for pid, s in states(turns[-1]['after']).items() if s['hp'] > 0]
    if set(winners) != set(alive) or len(alive) > 1:
        raise ValueError('Winner does not match final HP')
    lines += ['【对战结果】', ('胜者：' + player(winners[0])) if winners else '双方倒下，平局', hp(turns[-1]['after'])]
    return '\n'.join(lines)
