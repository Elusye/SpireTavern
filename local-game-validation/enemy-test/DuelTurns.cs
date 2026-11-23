using MegaCrit.Sts2.Core.Combat;
using MegaCrit.Sts2.Core.Commands;
using MegaCrit.Sts2.Core.Entities.Cards;
using MegaCrit.Sts2.Core.Entities.Creatures;
using MegaCrit.Sts2.Core.Entities.Players;
using MegaCrit.Sts2.Core.GameActions.Multiplayer;
using MegaCrit.Sts2.Core.Hooks;
using MegaCrit.Sts2.Core.Models;
using MegaCrit.Sts2.Core.Models.Powers;

namespace QQBotEnemyTest;

// A side in co-op means every player. Dispatch relative side events for one PvP actor instead.
internal static class DuelTurns
{
    internal static Player? CurrentPlayer;
    private static readonly ThrowingPlayerChoiceContext context = new();
    internal static Player? Owner(AbstractModel model) => model switch {
        CardModel c => c.Owner, RelicModel r => r.Owner, PowerModel p => p.Owner.Player ?? p.Owner.PetOwner,
        MonsterModel m => m.Creature.PetOwner, _ => null
    };
    private static Creature[] Participants(Player p) => p.Creature.CombatState!.Allies
        .Where(c => c == p.Creature || c.PetOwner == p).ToArray();
    private static bool Ended => DuelPrototype.Fighters.Any(p => p.Creature.IsDead);

    private static async Task AutoPhase(Player actor, bool beforePlay)
    {
        actor.PlayerCombatState!.Phase=beforePlay?PlayerTurnPhase.AutoPrePlay:PlayerTurnPhase.AutoPostPlay;
        foreach(int pass in beforePlay?new[]{0,1,2}:new[]{1})
        foreach(var model in actor.Creature.CombatState!.IterateHookListeners().Distinct().ToArray())
        {
            if(Ended) return;
            var owner=Owner(model);
            if(owner==null || !DuelPrototype.Fighters.Contains(owner)) continue;
            var previous=DuelPrototype.Actor;
            DuelPrototype.Actor=owner;
            context.PushModel(model);
            try {
                if(!beforePlay) await model.AfterAutoPostPlayPhaseEntered(context,actor);
                else if(pass==0) await model.AfterAutoPrePlayPhaseEnteredEarly(context,actor);
                else if(pass==1) await model.AfterAutoPrePlayPhaseEntered(context,actor);
                else await model.AfterAutoPrePlayPhaseEnteredLate(context,actor);
                model.InvokeExecutionFinished();
            }
            finally {context.PopModel(model);DuelPrototype.Actor=previous;}
        }
    }

    private static async Task Dispatch(Player actor, int phase)
    {
        var combat = actor.Creature.CombatState!;
        var participants = Participants(actor);
        // Snapshot: hooks may create/remove cards, pets or powers while dispatching.
        int[] passes = phase == 2 ? new[] {0,1,2} : phase is 1 or 3 ? new[] {0,1} : new[] {0};
        foreach (int pass in passes)
        foreach (var model in combat.IterateHookListeners().Distinct().ToArray())
        {
            if (Ended) return;
            var owner = Owner(model);
            if (owner == null || !DuelPrototype.Fighters.Contains(owner)) continue;
            if (model is OblivionPower oblivion && phase == 3)
            {
                if (pass == 0 && oblivion.Applier == actor.Creature) await PowerCmd.Remove(oblivion);
                continue;
            }
            // Duration debuffs tick once after their affected owner's action; Doom is actor-scoped below.
            if (model is WeakPower or VulnerablePower or FrailPower or DoomPower) continue;
            var side = owner == actor ? CombatSide.Player : CombatSide.Enemy;
            var previous = DuelPrototype.Actor;
            DuelPrototype.Actor = owner;
            try
            {
                context.PushModel(model);
                if (phase == 0) await model.BeforeSideTurnStart(context, side, participants, combat);
                if (phase == 1 && pass == 0) await model.AfterSideTurnStart(side, participants, combat);
                if (phase == 1 && pass == 1) await model.AfterSideTurnStartLate(side, participants, combat);
                if (phase == 2 && pass == 0) await model.BeforeSideTurnEndVeryEarly(context, side, participants);
                if (phase == 2 && pass == 1) await model.BeforeSideTurnEndEarly(context, side, participants);
                if (phase == 2 && pass == 2) await model.BeforeSideTurnEnd(context, side, participants);
                if (phase == 3 && pass == 0) await model.AfterSideTurnEnd(context, side, participants);
                if (phase == 3 && pass == 1) await model.AfterSideTurnEndLate(context, side, participants);
                model.InvokeExecutionFinished();
            }
            finally { context.PopModel(model); DuelPrototype.Actor = previous; }
        }
    }

    internal static async Task<string[]> Start(Player actor, bool opening)
    {
        var combat = actor.Creature.CombatState!;
        var state = actor.PlayerCombatState!;
        DuelPrototype.Actor = actor;
        CurrentPlayer = actor;
        state.Phase = PlayerTurnPhase.Start;
        foreach (var other in DuelPrototype.Fighters.Where(p => p != actor)) other.PlayerCombatState!.Phase = PlayerTurnPhase.None;
        foreach (var creature in Participants(actor)) creature.BeforeTurnStart(CombatSide.Player);
        await Dispatch(actor, 0);
        if (Ended) return Array.Empty<string>();
        // First-turn native block clearing is skipped, but the PvP opening guard must expire.
        foreach (var creature in Participants(actor))
        {
            if (Hook.ShouldClearBlock(combat, creature, out var preventer)) creature.LoseBlockInternal(creature.Block);
            else await Hook.AfterPreventingBlockClear(combat, preventer!, creature);
            await Hook.AfterBlockCleared(combat, creature);
        }
        if (Hook.ShouldPlayerResetEnergy(combat, actor)) state.ResetEnergy();
        else state.AddMaxEnergyToCurrent();
        if (opening) await PlayerCmd.SetEnergy(2, actor);
        await Hook.AfterEnergyReset(combat, actor);
        await Hook.BeforeHandDraw(combat, actor, context);
        decimal draw = Hook.ModifyHandDraw(combat, actor, 5, out var modifiers);
        await Hook.AfterModifyingHandDraw(combat, modifiers);
        if (state.TurnNumber == 1)
        {
            var innate = state.DrawPile.Cards.Where(c => c.Keywords.Contains(CardKeyword.Innate)).ToArray();
            foreach (var card in innate) state.DrawPile.MoveToTopInternal(card);
            draw = Math.Min(CardPile.MaxCardsInHand, Math.Max(draw, innate.Length));
        }
        await CardPileCmd.Draw(context, draw, actor, fromHandDraw: true);
        var drawn = state.Hand.Cards.Select(c => c.Id.Entry + (c.IsUpgraded ? "+" : "")).ToArray();
        await Hook.AfterPlayerTurnStart(combat, context, actor);
        await Dispatch(actor, 1);
        if (!Ended) await state.OrbQueue.AfterTurnStart(context);
        if (!Ended) await AutoPhase(actor,true);
        state.Phase = PlayerTurnPhase.Play;
        return drawn;
    }

    internal static async Task End(Player actor)
    {
        var combat = actor.Creature.CombatState!;
        var state = actor.PlayerCombatState!;
        DuelPrototype.Actor = actor;
        var durations = actor.Creature.Powers.Where(p => p is WeakPower or VulnerablePower or FrailPower).ToArray();
        await AutoPhase(actor,false);
        if (Ended) return;
        state.Phase=PlayerTurnPhase.End;
        await Dispatch(actor, 2);
        if (Ended) return;
        await state.OrbQueue.BeforeTurnEnd(context);
        foreach (var card in state.Hand.Cards.ToArray())
        {
            if (Ended) return;
            if (card.HasTurnEndInHandEffect) await card.OnTurnEndInHandWrapper(context);
            else if (card.Keywords.Contains(CardKeyword.Ethereal) && Hook.ShouldEtherealTrigger(combat, card))
                await CardCmd.Exhaust(context, card, causedByEthereal: true, skipVisuals: true);
        }
        if (Ended) return;
        await Hook.BeforeFlush(combat, actor);
        var retain = state.Hand.Cards.Where(c => !Hook.ShouldFlush(combat, actor) || c.ShouldRetainThisTurn).ToArray();
        var flush = state.Hand.Cards.Except(retain).ToArray();
        if (flush.Length > 0) await CardPileCmd.Add(flush, PileType.Discard, skipVisuals: true);
        await Hook.AfterFlush(combat, actor, context, flush, retain);
        state.EndOfTurnCleanup();
        await Dispatch(actor, 3);
        foreach (var power in durations)
            if (!Ended && actor.Creature.Powers.Contains(power)) await PowerCmd.Decrement(power);
        // Native Doom queries a whole co-op side. Scope the terminal check to this actor and pets.
        if (!Ended) await DoomPower.DoomKill(DoomPower.GetDoomedCreatures(Participants(actor)));
        state.IncrementTurnNumber();
    }
}
