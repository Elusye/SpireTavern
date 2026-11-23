using System.Reflection;
using System.Text.Json;
using HarmonyLib;
using MegaCrit.Sts2.Core.Combat;
using MegaCrit.Sts2.Core.Commands;
using MegaCrit.Sts2.Core.Entities.Cards;
using MegaCrit.Sts2.Core.Entities.Creatures;
using MegaCrit.Sts2.Core.Entities.Players;
using MegaCrit.Sts2.Core.GameActions.Multiplayer;
using MegaCrit.Sts2.Core.Hooks;
using MegaCrit.Sts2.Core.Models;
using MegaCrit.Sts2.Core.Models.Cards;
using MegaCrit.Sts2.Core.Models.Characters;
using MegaCrit.Sts2.Core.Models.Orbs;
using MegaCrit.Sts2.Core.Models.Relics;
using MegaCrit.Sts2.Core.Models.Powers;
using MegaCrit.Sts2.Core.Runs;
using MegaCrit.Sts2.Core.Saves;
using MegaCrit.Sts2.Core.Unlocks;
using MegaCrit.Sts2.Core.ValueProps;

namespace QQBotEnemyTest;

// Deliberately bounded adapter. Does not emulate arbitrary original damage/death hooks.
internal static class DuelPrototype
{
    internal static bool Active;
    internal static bool OwnsCombat;
    internal static bool Planning;
    internal static Player? Actor;
    internal static Player[] Fighters = Array.Empty<Player>();
    private static readonly ThrowingPlayerChoiceContext context = new();
    private static readonly Dictionary<Creature, int> blocks = new();
    private static readonly List<(Creature Target, int Damage)> hits = new();
    private static readonly List<(PowerModel Power, Creature Target, decimal Amount, Creature? Source, CardModel? Card)> powers = new();
    private static readonly List<object> rounds = new();
    internal static readonly HashSet<string> supported = LegacyCardCatalog.Allowed;
    internal static Creature[] Opponents(Creature creature) => Fighters.Where(p => p != (creature.Player ?? creature.PetOwner) && p.Creature.IsAlive).Select(p => p.Creature).ToArray();
    internal static bool IsFighter(Creature creature) => Fighters.Any(p => p.Creature == creature || creature.PetOwner == p);
    internal static int PendingBlock(Creature creature) => blocks.GetValueOrDefault(creature);
    internal static bool AddBlock(Creature creature, decimal amount)
    {
        if (!Planning || !IsFighter(creature)) return false;
        blocks[creature] = blocks.GetValueOrDefault(creature) + (int)Math.Floor(amount);
        return true;
    }
    internal static bool AddPower(PowerModel power, Creature target, decimal amount, Creature? source, CardModel? card)
    {
        if (!Planning || !IsFighter(target)) return false;
        if (source == target && power is StrengthPower or DexterityPower or FocusPower) return false;
        if (power is not WeakPower && power is not VulnerablePower) throw new NotSupportedException("Unsupported duel power: " + power.Id);
        powers.Add((power, target, amount, source, card));
        return true;
    }
    internal static IEnumerable<DamageResult> Capture(IEnumerable<Creature> targets, decimal amount, ValueProp props,
        Creature? dealer, CardModel? card, CardPlay? play, ModifyDamageHookType type)
    {
        var results = new List<DamageResult>();
        foreach (var data in targets)
        {
            if (!IsFighter(data)) throw new NotSupportedException("Duel damage escaped opponent routing");
            decimal value = Hook.ModifyDamage(Fighters[0].RunState, data.CombatState, data, dealer,
                amount, props, card, play, type, CardPreviewMode.None, out _);
            hits.Add((data, Math.Max(0, (int)Math.Floor(value))));
            results.Add(new DamageResult(data, props));
        }
        return results;
    }

    private static object View(Player p) => new { id = p.NetId, hp = p.Creature.CurrentHp, block = p.Creature.Block,
        energy = p.PlayerCombatState!.Energy, orbs = p.PlayerCombatState.OrbQueue.Orbs.Select(o => o.Id.Entry).ToArray(),
        powers = p.Creature.Powers.Select(v => new { id = v.Id.Entry, amount = v.Amount }).ToArray() };

    private static async Task PlayLeftToRight(Player p, List<string> played)
    {
        Actor = p;
        using var selection = CardSelectCmd.PushSelector(new VakuuCardSelector());
        int count = 0;
        while (true)
        {
            // Re-evaluate every card after every play, including dynamic costs and energy gain.
            var card = p.PlayerCombatState!.Hand.Cards.FirstOrDefault(c => c.CanPlay());
            if (card == null) break;
            if (++count > 50) throw new InvalidOperationException("Duel play cap reached");
            if (!supported.Contains(card.Id.Entry)) throw new NotSupportedException("Card not adapted: " + card.Id.Entry);
            await card.SpendResources();
            await CardCmd.AutoPlay(context, card, card.TargetType == TargetType.AnyEnemy ? Opponents(p.Creature).Single() : null,
                AutoPlayType.Default, skipXCapture: true, skipCardPileVisuals: true);
            played.Add(card.Id.Entry);
        }
        await p.PlayerCombatState!.OrbQueue.BeforeTurnEnd(context);
    }

    private static async Task Settle()
    {
        Planning = false;
        // Both defenses exist before either HP is changed. Compute both losses before applying either.
        foreach (var p in Fighters) p.Creature.GainBlockInternal(blocks.GetValueOrDefault(p.Creature));
        var losses = Fighters.ToDictionary(p => p.Creature, _ => 0);
        foreach (var hit in hits)
        {
            decimal blocked = hit.Target.DamageBlockInternal(hit.Damage, ValueProp.Unpowered);
            losses[hit.Target] += Math.Max(0, hit.Damage - (int)blocked);
        }
        foreach (var p in Fighters) p.Creature.SetCurrentHpInternal(Math.Max(0, p.Creature.CurrentHp - losses[p.Creature]));
        // Old statuses expire once per exchange; newly queued statuses begin on the following exchange.
        foreach (var p in Fighters)
            foreach (var power in p.Creature.Powers.Where(v => v is WeakPower or VulnerablePower).ToArray())
                await PowerCmd.TickDownDuration(power);
        foreach (var power in powers)
            if (power.Target.IsAlive) await PowerCmd.Apply(context, power.Power, power.Target, power.Amount, power.Source, power.Card);
    }

    public static Task Run(Player first, Action<string, int, int> check) => AlternatingDuel.Run(first, check);

    public static async Task RunSimultaneous(Player first, Action<string, int, int> check)
    {
        var second = Player.CreateForNewRun<Defect>(new UnlockState(SaveManager.Instance.Progress), 2UL);
        ((RunState)first.RunState).AddPlayerDebug(second, -1);
        second.ResetCombatState();
        var combat = (CombatState)first.Creature.CombatState!;
        combat.AddPlayer(second);
        second.PlayerCombatState!.Phase = PlayerTurnPhase.Play;
        Fighters = new[] { first, second };
        Active = true;
        try
        {
            // Regression: simultaneous lethal hits must be a draw, regardless of application order.
            foreach (var p in Fighters) { p.Creature.SetCurrentHpInternal(6); p.Creature.LoseBlockInternal(p.Creature.Block); }
            Planning = true;
            blocks.Clear(); hits.Clear(); powers.Clear();
            hits.Add((first.Creature, 6)); hits.Add((second.Creature, 6));
            await Settle();
            check("Simultaneous lethal first HP", first.Creature.CurrentHp, 0);
            check("Simultaneous lethal second HP", second.Creature.CurrentHp, 0);
            // SetCurrentHpInternal avoids death hooks; only this bounded prototype may restore fixtures this way.
            first.Creature.SetCurrentHpInternal(80); second.Creature.SetCurrentHpInternal(75);
            Planning = true; blocks.Clear(); hits.Clear(); powers.Clear();
            AddBlock(first.Creature, 5); AddBlock(second.Creature, 5);
            hits.Add((first.Creature, 12)); hits.Add((second.Creature, 12));
            check("Intent leaves first HP unchanged", first.Creature.CurrentHp, 80);
            check("Intent leaves second block unchanged", second.Creature.Block, 0);
            await Settle();
            check("Both intents use first defense", first.Creature.CurrentHp, 73);
            check("Both intents use second defense", second.Creature.CurrentHp, 68);
            first.Creature.SetCurrentHpInternal(80); second.Creature.SetCurrentHpInternal(75);

            // Verify a real status card does not change HP or weaken the other plan before settlement.
            Planning = true; blocks.Clear(); hits.Clear(); powers.Clear(); Actor = second;
            await PlayerCmd.SetEnergy(3, second);
            var statusCard = combat.CreateCard<Neutralize>(second);
            await CardPileCmd.Add(statusCard, PileType.Hand, skipVisuals: true);
            await statusCard.SpendResources();
            await CardCmd.AutoPlay(context, statusCard, first.Creature, AutoPlayType.Default,
                skipXCapture: true, skipCardPileVisuals: true);
            check("Status card leaves target HP unchanged during plan", first.Creature.CurrentHp, 80);
            check("Weak is deferred during plan", first.Creature.GetPower<WeakPower>()?.Amount ?? 0, 0);
            await Settle();
            check("Status card damage committed", first.Creature.CurrentHp, 77);
            check("Weak becomes active after settlement", first.Creature.GetPower<WeakPower>()?.Amount ?? 0, 1);
            await PowerCmd.Remove<WeakPower>(first.Creature);
            first.Creature.SetCurrentHpInternal(80);
            await ValidateExpansion(first, second, combat, check);

            foreach (var p in Fighters)
            {
                await CardPileCmd.RemoveFromCombat(p.PlayerCombatState!.AllPiles.SelectMany(pile => pile.Cards).ToArray());
                foreach (var original in p.Deck.Cards)
                    await CardPileCmd.Add(combat.CreateCard(original.CanonicalInstance, p), PileType.Discard, skipVisuals: true);
            }
            // Extra frost card is an explicit fixture for routing/passive coverage, not a changed starter deck.
            await CardPileCmd.Add(combat.CreateCard<Coolheaded>(second), PileType.Discard, skipVisuals: true);
            foreach (var p in Fighters) await CardPileCmd.Shuffle(context, p);
            Actor = second;
            // ResetCombatState already supplies Defect's three slots; no UI-only slot animation needed.
            check("Defect starts with three orb slots", second.PlayerCombatState.OrbQueue.Capacity, 3);
            await OrbCmd.Channel<LightningOrb>(context, second);
            await OrbCmd.Channel<FrostOrb>(context, second);
            check("Orb opponent route", combat.GetOpponentsOf(second.Creature).Single() == first.Creature ? 1 : 0, 1);
            check("Auto-target route", combat.HittableEnemies.Single() == first.Creature ? 1 : 0, 1);

            bool finished = false;
            for (int round = 1; round <= 100; round++)
            {
                combat.RoundNumber = round;
                blocks.Clear(); hits.Clear(); powers.Clear();
                var draws = new List<object>();
                foreach (var p in Fighters)
                {
                    p.Creature.LoseBlockInternal(p.Creature.Block);
                    p.PlayerCombatState!.Phase = PlayerTurnPhase.Play;
                    await PlayerCmd.SetEnergy(3, p);
                    Actor = p;
                    await CardPileCmd.Draw(context, 5, p);
                    draws.Add(new { id = p.NetId, cards = p.PlayerCombatState.Hand.Cards.Select(c => c.Id.Entry).ToArray() });
                }
                int hp1 = first.Creature.CurrentHp, hp2 = second.Creature.CurrentHp;
                Planning = true;
                var played1 = new List<string>(); var played2 = new List<string>();
                await PlayLeftToRight(first, played1);
                check($"Round {round} first plan preserves both HP", first.Creature.CurrentHp + second.Creature.CurrentHp, hp1 + hp2);
                await PlayLeftToRight(second, played2);
                check($"Round {round} both plans preserve both HP", first.Creature.CurrentHp + second.Creature.CurrentHp, hp1 + hp2);
                var intents = Fighters.Select(p => new { id = p.NetId, block = blocks.GetValueOrDefault(p.Creature),
                    damageReceived = hits.Where(h => h.Target == p.Creature).Sum(h => h.Damage) }).ToArray();
                await Settle();
                rounds.Add(new { round, draws, played1, played2, intents, result = Fighters.Select(View).ToArray() });
                if (Fighters.Any(p => p.Creature.IsDead)) { finished = true; break; }
                foreach (var p in Fighters)
                {
                    await FlushHand(p);
                    p.PlayerCombatState.IncrementTurnNumber();
                }
            }
            check("Duel reaches death without round truncation", finished ? 1 : 0, 1);
            var winner = Fighters.Where(p => p.Creature.IsAlive).Select(p => p.NetId).ToArray();
            var path = System.IO.Path.Combine(System.IO.Path.GetDirectoryName(System.Environment.GetEnvironmentVariable("QQBOT_TEST_OUTPUT"))!, "duel.json");
            System.IO.File.WriteAllText(path, JsonSerializer.Serialize(new { gameVersion = GameBuild.Version, winner,
                draw = winner.Length == 0, supportedCards = supported, rounds,
                limitations = "Bounded basic-card intent adapter; no damage/death reaction hooks; unsupported cards fail closed. Fixture adds frost card and starting frost orb. Not production." }, new JsonSerializerOptions { WriteIndented = true }));
        }
        finally { Planning = false; Active = false; Actor = null; }
    }

    private static async Task ValidateExpansion(Player first, Player second, CombatState combat, Action<string,int,int> check)
    {
        Planning = true; Actor = first; blocks.Clear(); hits.Clear(); powers.Clear();
        await PlayerCmd.SetEnergy(30, first);
        using var selection = CardSelectCmd.PushSelector(new VakuuCardSelector());
        async Task Play<T>() where T : CardModel
        {
            var card = combat.CreateCard<T>(first);
            await CardPileCmd.Add(card, PileType.Hand, skipVisuals: true);
            await card.SpendResources();
            await CardCmd.AutoPlay(context, card, card.TargetType == TargetType.AnyEnemy ? second.Creature : null,
                AutoPlayType.Default, skipXCapture: true, skipCardPileVisuals: true);
        }
        await CardPileCmd.RemoveFromCombat(first.PlayerCombatState!.Hand.Cards.ToArray());
        await Play<DefendIronclad>();
        check("Virtual block visible to own cards", first.Creature.Block, 5);
        await Play<BodySlam>();
        check("Body Slam uses queued block", hits.Last().Damage, 5);
        await Play<Inflame>();
        check("Inflame strength applies to own intent", first.Creature.GetPower<StrengthPower>()?.Amount ?? 0, 2);
        await Play<TwinStrike>();
        check("Twin Strike two hits", hits.Count, 3);
        check("Twin Strike modified damage", hits.Last().Damage, 7);
        await Play<Footwork>();
        int defense = blocks[first.Creature];
        await Play<ShrugItOff>();
        check("Dexterity modifies queued block", blocks[first.Creature] - defense, 10);
        int draw = first.PlayerCombatState.Hand.Cards.Count;
        await Play<PommelStrike>();
        check("Pommel Strike draws during planning", first.PlayerCombatState.Hand.Cards.Count - draw, 1);
        await Play<BladeDance>();
        check("Blade Dance creates shivs", first.PlayerCombatState.Hand.Cards.Count(c => c is Shiv), 3);
        var shiv = first.PlayerCombatState.Hand.Cards.OfType<Shiv>().First();
        await shiv.SpendResources();
        await CardCmd.AutoPlay(context, shiv, second.Creature, AutoPlayType.Default,
            skipXCapture: true, skipCardPileVisuals: true);
        check("Generated Shiv uses strength", hits.Last().Damage, 6);
        int preparedHand = first.PlayerCombatState.Hand.Cards.Count;
        await Play<Prepared>();
        check("Prepared draws then automatically discards one", first.PlayerCombatState.Hand.Cards.Count, preparedHand);
        await PlayerCmd.SetEnergy(3, first);
        int before = hits.Count;
        await Play<Skewer>();
        check("Skewer captures X energy", first.PlayerCombatState.Energy, 0);
        check("Skewer uses captured X hits", hits.Count - before, 3);
        await PowerCmd.Remove<StrengthPower>(first.Creature);
        await PowerCmd.Remove<DexterityPower>(first.Creature);
        await PlayerCmd.SetEnergy(30, first);
        await Play<StrikeSilent>(); check("Silent Strike damage", hits.Last().Damage, 6);
        await Play<DefendSilent>();
        await Play<StrikeRegent>(); check("Regent Strike damage", hits.Last().Damage, 6);
        await Play<DefendRegent>();
        await Play<StrikeNecrobinder>(); check("Necrobinder Strike damage", hits.Last().Damage, 6);
        await Play<DefendNecrobinder>();
        first.PlayerCombatState.Stars = 0;
        await Play<Venerate>();
        check("Venerate generates two stars", first.PlayerCombatState.Stars, 2);
        int statuses = powers.Count;
        await Play<FallingStar>();
        check("Falling Star spends two stars", first.PlayerCombatState.Stars, 0);
        check("Falling Star damage intent", hits.Last().Damage, 8);
        check("Falling Star queues two debuffs", powers.Count - statuses, 2);
        first.PlayerCombatState.Stars = 3;
        before = hits.Count;
        await Play<Stardust>();
        check("Star X spends stars", first.PlayerCombatState.Stars, 0);
        check("Star X uses three hits", hits.Count - before, 3);
        check("Random opponent targets other player", hits.Last().Target == second.Creature ? 1 : 0, 1);
        defense = blocks[first.Creature];
        await Play<Defy>();
        check("Defy block", blocks[first.Creature] - defense, 6);
        await Play<Reap>();
        check("Reap produces damage intent", hits.Last().Damage > 0 ? 1 : 0, 1);
        draw = first.PlayerCombatState.Hand.Cards.Count;
        await Play<Soul>();
        check("Soul draws two cards", first.PlayerCombatState.Hand.Cards.Count - draw, 2);
        // Unplayed ethereal cards exhaust while retained cards survive the flush.
        var ethereal = combat.CreateCard<Defy>(first);
        var retained = combat.CreateCard<Reap>(first);
        await CardPileCmd.Add(ethereal, PileType.Hand, skipVisuals: true);
        await CardPileCmd.Add(retained, PileType.Hand, skipVisuals: true);
        await FlushHand(first);
        check("Unplayed ethereal card exhausted", ethereal.Pile?.Type == PileType.Exhaust ? 1 : 0, 1);
        check("Retained card stays in hand", retained.Pile?.Type == PileType.Hand ? 1 : 0, 1);
        Actor = second;
        await PlayerCmd.SetEnergy(10, second);
        async Task OrbCard<T>() where T : CardModel
        {
            var card = combat.CreateCard<T>(second);
            await CardPileCmd.Add(card, PileType.Hand, skipVisuals: true);
            await card.SpendResources();
            await CardCmd.AutoPlay(context, card, card.TargetType == TargetType.AnyEnemy ? first.Creature : null,
                AutoPlayType.Default, skipXCapture: true, skipCardPileVisuals: true);
        }
        await OrbCard<Defragment>();
        await OrbCard<BallLightning>();
        await OrbCard<ColdSnap>();
        check("Ball Lightning creates lightning", second.PlayerCombatState!.OrbQueue.Orbs.Count(o => o is LightningOrb), 1);
        check("Cold Snap creates frost", second.PlayerCombatState.OrbQueue.Orbs.Count(o => o is FrostOrb), 1);
        check("Focus modifies lightning passive", (int)second.PlayerCombatState.OrbQueue.Orbs.First(o => o is LightningOrb).PassiveVal, 4);
        check("Focus modifies frost passive", (int)second.PlayerCombatState.OrbQueue.Orbs.First(o => o is FrostOrb).PassiveVal, 3);
        await PowerCmd.Remove<FocusPower>(second.Creature);
        second.PlayerCombatState.OrbQueue.Clear();
        second.PlayerCombatState.OrbQueue.AddCapacity(3);
        Planning = false; blocks.Clear(); hits.Clear(); powers.Clear();
        check("Expansion probes leave both HP unchanged", first.Creature.CurrentHp + second.Creature.CurrentHp, 155);
    }

    private static async Task FlushHand(Player player)
    {
        Actor = player;
        foreach (var card in player.PlayerCombatState!.Hand.Cards.ToArray())
        {
            if (card.Keywords.Contains(CardKeyword.Ethereal) && Hook.ShouldEtherealTrigger(player.Creature.CombatState, card))
                await CardCmd.Exhaust(context, card, causedByEthereal: true, skipVisuals: true);
            else if (!card.ShouldRetainThisTurn)
                await CardPileCmd.Add(card, PileType.Discard, skipVisuals: true);
        }
    }
}

[HarmonyPatch(typeof(Creature), "get_Block")]
internal static class DuelVirtualBlockPatch
{
    private static void Postfix(Creature __instance, ref int __result)
    {
        if (DuelPrototype.Planning && DuelPrototype.Actor?.Creature == __instance)
            __result += DuelPrototype.PendingBlock(__instance);
    }
}

// Second player's scene node does not exist in the headless harness. Skip presentation only.
[HarmonyPatch(typeof(CardModel), "PlayPowerCardFlyVfx")]
internal static class DuelPowerVisualPatch
{
    private static bool Prefix(ref Task __result)
    {
        if (!DuelPrototype.Active) return true;
        __result = Task.CompletedTask;
        return false;
    }
}

[HarmonyPatch(typeof(MegaCrit.Sts2.Core.Nodes.Combat.NPlayerHand), "RefreshLayout")]
internal static class DuelHandLayoutPatch
{
    // The headless adapter drives model piles, not physical holders. Do not lay out stale animation holders.
    private static bool Prefix() => !DuelPrototype.Active;
}

[HarmonyPatch(typeof(CombatState), nameof(CombatState.GetOpponentsOf))]
internal static class DuelOpponentsPatch
{
    private static bool Prefix(Creature creature, ref IReadOnlyList<Creature> __result)
    {
        if (!DuelPrototype.Active || !DuelPrototype.IsFighter(creature)) return true;
        __result = DuelPrototype.Opponents(creature); return false;
    }
}
[HarmonyPatch(typeof(CombatState), "get_HittableEnemies")]
internal static class DuelAutoTargetPatch
{
    private static bool Prefix(ref IReadOnlyList<Creature> __result)
    {
        if (!DuelPrototype.Active || DuelPrototype.Actor == null) return true;
        __result = DuelPrototype.Opponents(DuelPrototype.Actor.Creature); return false;
    }
}
[HarmonyPatch(typeof(Creature), nameof(Creature.GainBlockInternal))]
internal static class DuelBlockPatch
{
    private static bool Prefix(Creature __instance, decimal amount) => !DuelPrototype.AddBlock(__instance, amount);
}
[HarmonyPatch]
internal static class DuelDamagePatch
{
    private static MethodBase TargetMethod() => AccessTools.Method(typeof(CreatureCmd), "Damage", new[] {
        typeof(PlayerChoiceContext), typeof(IEnumerable<Creature>), typeof(decimal), typeof(ValueProp),
        typeof(Creature), typeof(CardModel), typeof(CardPlay) });
    private static bool Prefix(IEnumerable<Creature>? targets, decimal amount, ValueProp props, Creature? dealer,
        CardModel? cardSource, CardPlay? cardPlay, ref Task<IEnumerable<DamageResult>> __result)
    {
        if (!DuelPrototype.Planning) return true;
        __result = Task.FromResult(DuelPrototype.Capture(targets ?? Array.Empty<Creature>(), amount, props, dealer, cardSource, cardPlay, ModifyDamageHookType.All));
        return false;
    }
}
[HarmonyPatch(typeof(PowerCmd), "Apply", new[] { typeof(PlayerChoiceContext), typeof(PowerModel), typeof(Creature), typeof(decimal), typeof(Creature), typeof(CardModel), typeof(bool) })]
internal static class DuelPowerPatch
{
    private static bool Prefix(PowerModel power, Creature target, decimal amount, Creature? applier, CardModel? cardSource, ref Task __result)
    {
        if (!DuelPrototype.AddPower(power, target, amount, applier, cardSource)) return true;
        __result = Task.CompletedTask; return false;
    }
}
