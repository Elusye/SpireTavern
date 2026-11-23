using System.Text.Json;
using MegaCrit.Sts2.Core.Combat;
using MegaCrit.Sts2.Core.Commands;
using MegaCrit.Sts2.Core.Entities.Cards;
using MegaCrit.Sts2.Core.Entities.Players;
using MegaCrit.Sts2.Core.GameActions.Multiplayer;
using MegaCrit.Sts2.Core.Hooks;
using MegaCrit.Sts2.Core.Models;
using MegaCrit.Sts2.Core.Models.Cards;
using MegaCrit.Sts2.Core.Models.Characters;
using MegaCrit.Sts2.Core.Models.Orbs;
using MegaCrit.Sts2.Core.Models.Powers;
using MegaCrit.Sts2.Core.Models.Relics;
using MegaCrit.Sts2.Core.Runs;
using MegaCrit.Sts2.Core.Saves;
using MegaCrit.Sts2.Core.Unlocks;

namespace QQBotEnemyTest;

internal static class AlternatingDuel
{
    private static readonly ThrowingPlayerChoiceContext context = new();
    private static object View(Player p) => new { id = p.NetId, hp = p.Creature.CurrentHp, block = p.Creature.Block,
        energy = p.PlayerCombatState!.Energy, stars = p.PlayerCombatState.Stars,
        ostyHp = p.Osty?.CurrentHp, ostyMaxHp = p.Osty?.MaxHp,
        orbs = p.PlayerCombatState.OrbQueue.Orbs.Select(o => o.Id.Entry).ToArray(),
        powers = p.Creature.Powers.Select(v => new { id = v.Id.Entry, amount = v.Amount }).ToArray() };

    private static bool Ended => DuelPrototype.Fighters.Any(p => p.Creature.IsDead);
    private static async Task Play(CardModel card)
    {
        var target = card.TargetType == TargetType.AnyEnemy ? DuelPrototype.Opponents(card.Owner.Creature).Single() : null;
        await card.SpendResources();
        await CardCmd.AutoPlay(context, card, target, AutoPlayType.Default, skipXCapture: true, skipCardPileVisuals: true);
    }

    public static async Task Run(Player first, Action<string,int,int> check)
    {
        ResourceProbe.Mark("duel_setup_start");
        var second = Player.CreateForNewRun(DuelConfig.Character(DuelConfig.Second), new UnlockState(SaveManager.Instance.Progress), 2UL);
        ((RunState)first.RunState).AddPlayerDebug(second, -1);
        second.ResetCombatState();
        var combat = (CombatState)first.Creature.CombatState!;
        combat.AddPlayer(second);
        MegaCrit.Sts2.Core.Nodes.Rooms.NCombatRoom.Instance!.AddCreature(second.Creature);
        second.PlayerCombatState!.Phase = PlayerTurnPhase.Play;
        DuelPrototype.Fighters = new[] { first, second };
        DuelPrototype.Active = true;
        DuelPrototype.OwnsCombat = true;
        DuelPrototype.Planning = false; // Native damage, block, powers and death processing stay enabled.
        var turns = new List<object>();
        var initialDecks = DuelPrototype.Fighters.Select(p => new { id=p.NetId, hp=p.Creature.CurrentHp,
            cards=p.Deck.Cards.Select(c=>c.GetType().Name+(c.IsUpgraded?"+":"")).ToArray() }).ToArray();
        try
        {
            // Choice effects also occur during draw and turn hooks, before the normal play loop.
            using var automaticChoices = CardSelectCmd.PushSelector(new VakuuCardSelector());
            if (DuelConfig.Input == null && DuelConfig.First == "Ironclad" && DuelConfig.Second == "Defect" && !DuelConfig.LegacyDeck)
            {
            // Deterministic opening-rule probes, separate from the match log.
            DuelPrototype.Actor = first;
            await PlayerCmd.SetEnergy(2, first);
            second.Creature.GainBlockInternal(10);
            check("Opening rear guard", second.Creature.Block, 10);
            var strike = combat.CreateCard<StrikeIronclad>(first);
            await CardPileCmd.Add(strike, PileType.Hand, skipVisuals: true);
            await Play(strike);
            check("Opening attack immediately consumes protection", second.Creature.Block, 4);
            check("Opening protected HP", second.Creature.CurrentHp, 75);
            check("First turn starts with two energy", first.PlayerCombatState!.Energy, 1);
            second.Creature.LoseBlockInternal(second.Creature.Block);
            check("Unused protection clears at rear turn start", second.Creature.Block, 0);
            var attack = combat.CreateCard<StrikeDefect>(second);
            DuelPrototype.Actor = second;
            await PlayerCmd.SetEnergy(3, second);
            await CardPileCmd.Add(attack, PileType.Hand, skipVisuals: true);
            await Play(attack);
            check("Rear attack deals damage immediately", first.Creature.CurrentHp, 74);
            first.Creature.SetCurrentHpInternal(80);
            DuelPrototype.Actor = first;
            await PlayerCmd.SetEnergy(3, first);
            var bash = combat.CreateCard<Bash>(first);
            await CardPileCmd.Add(bash, PileType.Hand, skipVisuals: true);
            await Play(bash);
            check("Bash applies vulnerable immediately", second.Creature.GetPower<VulnerablePower>()?.Amount ?? 0, 2);
            var followup = combat.CreateCard<StrikeIronclad>(first);
            await CardPileCmd.Add(followup, PileType.Hand, skipVisuals: true);
            await Play(followup);
            check("Same-turn attack uses vulnerable", second.Creature.CurrentHp, 58);
            await PowerCmd.Remove<VulnerablePower>(second.Creature);
            second.Creature.SetCurrentHpInternal(75);
            DuelPrototype.Actor = second;
            var neutralize = combat.CreateCard<Neutralize>(second);
            await CardPileCmd.Add(neutralize, PileType.Hand, skipVisuals: true);
            await Play(neutralize);
            check("Weak applies immediately", first.Creature.GetPower<WeakPower>()?.Amount ?? 0, 1);
            DuelPrototype.Actor = first;
            await PlayerCmd.SetEnergy(1, first);
            var weakened = combat.CreateCard<StrikeIronclad>(first);
            await CardPileCmd.Add(weakened, PileType.Hand, skipVisuals: true);
            await Play(weakened);
            check("Weak modifies immediate damage", second.Creature.CurrentHp, 71);
            await PowerCmd.Decrement(first.Creature.GetPower<WeakPower>()!);
            check("Weak expires after affected turn", first.Creature.GetPower<WeakPower>()?.Amount ?? 0, 0);
            first.Creature.SetCurrentHpInternal(80); second.Creature.SetCurrentHpInternal(75);
            DuelPrototype.Actor = second;
            await OrbCmd.Channel<LightningOrb>(context, second);
            await second.PlayerCombatState.OrbQueue.BeforeTurnEnd(context);
            check("Lightning immediately hits opposing player", first.Creature.CurrentHp, 77);
            await OrbCmd.EvokeNext(context, second);
            check("Lightning evokes immediately", first.Creature.CurrentHp, 69);
            first.Creature.SetCurrentHpInternal(80);

            }

            foreach (var relic in second.Relics) { await relic.BeforeCombatStart(); await relic.AfterRoomEntered(first.RunState.CurrentRoom!); }
            foreach (var p in DuelPrototype.Fighters)
            {
                await CardPileCmd.RemoveFromCombat(p.PlayerCombatState!.AllPiles.SelectMany(pile => pile.Cards).ToArray());
                p.PlayerCombatState.OrbQueue.Clear();
                p.PlayerCombatState.OrbQueue.AddCapacity(p.Character is Defect ? 3 : 0);
                if (DuelConfig.LegacyDeck)
                {
                    var job = p == first ? DuelConfig.First : DuelConfig.Second;
                    foreach (var name in LegacyCardCatalog.Jobs[job])
                        await CardPileCmd.Add(combat.CreateCard(LegacyCardCatalog.Canonical(name), p), PileType.Discard, skipVisuals: true);
                }
                else foreach (var original in p.Deck.Cards)
                {
                    var clone = combat.CloneCard(original);
                    clone.DeckVersion = original;
                    await CardPileCmd.Add(clone, PileType.Discard, skipVisuals: true);
                }
                await CardPileCmd.Shuffle(context, p);
            }

            int roll = System.Environment.GetEnvironmentVariable("QQBOT_DUEL_ORDER") switch {
                "1" => 0, "2" => 1, _ => System.Security.Cryptography.RandomNumberGenerator.GetInt32(2)
            };
            var order = roll == 0 ? new[] { first, second } : new[] { second, first };
            var rear = order[1];
            rear.Creature.GainBlockInternal(10);
            check("Match opening guard assigned to rear", rear.Creature.Block, 10);
            ResourceProbe.Mark("duel_start");
            for (int index = 0; index < 200 && !Ended; index++)
            {
                var actor = order[index % 2];
                var state = actor.PlayerCombatState!;
                DuelPrototype.Actor = actor;
                combat.RoundNumber = index / 2 + 1;
                var start = order.Select(View).ToArray();
                var draw = await DuelTurns.Start(actor, index == 0);
                if (Ended) { turns.Add(new { turn = index + 1, actor = actor.NetId, draw, start, before = order.Select(View).ToArray(), plays = Array.Empty<object>(), after = order.Select(View).ToArray() }); break; }
                check($"Turn {index + 1} opening energy lower bound", state.Energy >= (index == 0 ? 2 : 0) ? 1 : 0, 1);
                var before = order.Select(View).ToArray();
                var plays = new List<object>();
                using (CardSelectCmd.PushSelector(new VakuuCardSelector()))
                {
                    for (int count = 0; count < 50 && !Ended; count++)
                    {
                        var card = state.Hand.Cards.FirstOrDefault(c => c.CanPlay());
                        if (card == null) break;
                        if (!DuelPrototype.supported.Contains(card.Id.Entry)) throw new NotSupportedException("Card not verified: " + card.Id.Entry);
                        var pre = order.Select(View).ToArray();
                        await Play(card);
                        plays.Add(new { card = card.Id.Entry + (card.IsUpgraded ? "+" : ""), before = pre, after = order.Select(View).ToArray() });
                        if (count == 49 && !Ended) throw new InvalidOperationException("Card-play safety limit reached");
                    }
                    if (!Ended) await DuelTurns.End(actor);
                }
                turns.Add(new { turn = index + 1, actor = actor.NetId, draw, start, before, plays, after = order.Select(View).ToArray() });
            }
            ResourceProbe.Mark("duel_end");
            var winner = order.Where(p => p.Creature.IsAlive).Select(p => p.NetId).ToArray();
            var path = System.IO.Path.Combine(System.IO.Path.GetDirectoryName(System.Environment.GetEnvironmentVariable("QQBOT_TEST_OUTPUT"))!, "alternating-duel.json");
            System.IO.File.WriteAllText(path, JsonSerializer.Serialize(new { gameVersion = GameBuild.Version, modelHash = GameBuild.ModelHash, mode = "alternating_immediate",
                first = order[0].NetId, rear = rear.NetId, winner, turns, initialDecks, seed=DuelConfig.Seed,
                characters = new[] { new {id=first.NetId,job=DuelConfig.First},new {id=second.NetId,job=DuelConfig.Second} }, deckMode = DuelConfig.Input!=null?"saved":DuelConfig.LegacyDeck ? "legacy" : "starter",
                rules = new { firstEnergy = 2, normalEnergy = 3, rearOpeningBlock = 10, randomInitiative = true },
                limitations = "Local prototype: opponent routing plus native immediate card/damage/death commands; complete turn/relic hooks and all card pools not yet certified. Weak/vulnerable tick at affected owner's turn end. 200-turn cap fails, never awards HP victory." }, new JsonSerializerOptions { WriteIndented = true }));
            check("Alternating duel reaches death", Ended ? 1 : 0, 1);
        }
        finally { DuelPrototype.Active = false; DuelPrototype.Planning = false; DuelPrototype.Actor = null; }
    }
}
