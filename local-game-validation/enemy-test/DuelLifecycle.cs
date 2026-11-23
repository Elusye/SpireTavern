using MegaCrit.Sts2.Core.Combat;
using MegaCrit.Sts2.Core.Commands;
using MegaCrit.Sts2.Core.Entities.Cards;
using MegaCrit.Sts2.Core.Entities.Players;
using MegaCrit.Sts2.Core.GameActions.Multiplayer;
using MegaCrit.Sts2.Core.Models.Cards;
using MegaCrit.Sts2.Core.Models.Characters;
using MegaCrit.Sts2.Core.Models.Powers;
using MegaCrit.Sts2.Core.Models.Orbs;
using MegaCrit.Sts2.Core.Models.Relics;
using MegaCrit.Sts2.Core.Nodes.Rooms;
using MegaCrit.Sts2.Core.Runs;
using MegaCrit.Sts2.Core.Saves;
using MegaCrit.Sts2.Core.Unlocks;
using MegaCrit.Sts2.Core.ValueProps;

namespace QQBotEnemyTest;

internal static class DuelLifecycle
{
    internal static async Task Run(Player actor, Action<string,int,int> check)
    {
        var context = new ThrowingPlayerChoiceContext();
        var opponent = Player.CreateForNewRun<Ironclad>(new UnlockState(SaveManager.Instance.Progress),2UL);
        ((RunState)actor.RunState).AddPlayerDebug(opponent,-1);
        opponent.ResetCombatState();
        var combat=(CombatState)actor.Creature.CombatState!;
        combat.AddPlayer(opponent);
        NCombatRoom.Instance!.AddCreature(opponent.Creature);
        DuelPrototype.Fighters=new[]{actor,opponent};
        DuelPrototype.Active=true;
        DuelPrototype.OwnsCombat=true;
        DuelPrototype.Planning=false;
        using var selector=CardSelectCmd.PushSelector(new VakuuCardSelector());
        async Task Play<T>() where T:MegaCrit.Sts2.Core.Models.CardModel
        {
            DuelPrototype.Actor=actor;
            var card=combat.CreateCard<T>(actor);
            await CardPileCmd.Add(card,PileType.Hand,skipVisuals:true);
            await card.SpendResources();
            await CardCmd.AutoPlay(context,card,card.TargetType==TargetType.AnyEnemy?opponent.Creature:null,
                AutoPlayType.Default,skipXCapture:true,skipCardPileVisuals:true);
        }
        async Task Next()
        {
            await DuelTurns.End(actor);
            await DuelTurns.Start(opponent,false);
            await DuelTurns.End(opponent);
            await DuelTurns.Start(actor,false);
        }
        try
        {
            foreach(var p in DuelPrototype.Fighters)
            {
                await CardPileCmd.RemoveFromCombat(p.PlayerCombatState!.AllPiles.SelectMany(pile=>pile.Cards).ToArray());
                for(int i=0;i<20;i++) await CardPileCmd.Add(combat.CreateCard<StrikeIronclad>(p),PileType.Draw,skipVisuals:true);
                p.PlayerCombatState.Phase=PlayerTurnPhase.Play;
                await CreatureCmd.SetMaxAndCurrentHp(p.Creature,1000);
                await PlayerCmd.SetEnergy(20,p);
            }
            await Play<DemonForm>();
            await DuelTurns.End(actor);
            await DuelTurns.Start(opponent,false);
            check("Demon Form does not trigger on opponent turn",actor.Creature.GetPower<StrengthPower>()?.Amount??0,0);
            await DuelTurns.End(opponent);
            await DuelTurns.Start(actor,false);
            check("Demon Form grants strength at own next turn",actor.Creature.GetPower<StrengthPower>()?.Amount??0,3);
            await Play<Barricade>();
            await CreatureCmd.GainBlock(actor.Creature,5,ValueProp.Unpowered,null);
            await Next();
            check("Barricade preserves block at own next turn",actor.Creature.Block,5);
            await PowerCmd.Remove<BarricadePower>(actor.Creature);
            await PowerCmd.Remove<DemonFormPower>(actor.Creature);
            actor.Creature.LoseBlockInternal(actor.Creature.Block);
            await PlayerCmd.SetEnergy(10,actor);
            await Play<Delay>();
            await Next();
            check("Delay grants energy after reset",actor.PlayerCombatState!.Energy,4);
            await Play<MachineLearning>();
            await Next();
            check("Machine Learning increases actual next hand draw",actor.PlayerCombatState.Hand.Cards.Count,6);
            int hp=opponent.Creature.CurrentHp;
            await Play<DeadlyPoison>();
            check("Poison does not deal damage immediately",opponent.Creature.CurrentHp,hp);
            await DuelTurns.End(actor);
            await DuelTurns.Start(opponent,false);
            check("Poison triggers at affected player's start",hp-opponent.Creature.CurrentHp,5);
            check("Poison loses exactly one stack",opponent.Creature.GetPower<PoisonPower>()?.Amount??0,4);
            await DuelTurns.End(opponent);
            check("Poison does not trigger again at end",hp-opponent.Creature.CurrentHp,5);
            await DuelTurns.Start(actor,false);
            await Play<GoForTheEyes>();
            check("Eye attack applies Weak to a player target",opponent.Creature.GetPower<WeakPower>()?.Amount??0,1);
            await PowerCmd.Remove<PoisonPower>(opponent.Creature);
            await PowerCmd.Remove<WeakPower>(opponent.Creature);
            await PlayerCmd.SetEnergy(3,actor);
            await Play<Oblivion>();
            await Play<StrikeIronclad>();
            check("Oblivion adds Doom for a subsequent card",opponent.Creature.GetPower<DoomPower>()?.Amount??0,3);
            await DuelTurns.End(actor);
            check("Oblivion expires at its applier's turn end",opponent.Creature.GetPower<OblivionPower>()?.Amount??0,0);
            await PowerCmd.Remove<DoomPower>(opponent.Creature);
            await DuelTurns.Start(opponent,false);
            await DuelTurns.End(opponent);
            await DuelTurns.Start(actor,false);
            // Left-to-right rescan: a later zero-cost energy card unlocks an earlier attack.
            await CardPileCmd.RemoveFromCombat(actor.PlayerCombatState.Hand.Cards.ToArray());
            await PlayerCmd.SetEnergy(0,actor);
            var strike=combat.CreateCard<StrikeIronclad>(actor);
            var turbo=combat.CreateCard<Turbo>(actor);
            await CardPileCmd.Add(strike,PileType.Hand,skipVisuals:true);
            await CardPileCmd.Add(turbo,PileType.Hand,skipVisuals:true);
            check("Later energy card is first playable",actor.PlayerCombatState.Hand.Cards.First(c=>c.CanPlay())==turbo?1:0,1);
            await turbo.SpendResources();
            await CardCmd.AutoPlay(context,turbo,null,AutoPlayType.Default,skipXCapture:true,skipCardPileVisuals:true);
            check("Rescan unlocks earlier attack",actor.PlayerCombatState.Hand.Cards.First(c=>c.CanPlay())==strike?1:0,1);
            await CardPileCmd.RemoveFromCombat(actor.PlayerCombatState.AllPiles.SelectMany(p=>p.Cards).ToArray());
            await PlayerCmd.SetEnergy(3,actor);
            var empty=combat.CreateCard<MegaCrit.Sts2.Core.Models.Cards.Void>(actor);
            await CardPileCmd.Add(empty,PileType.Draw,skipVisuals:true);
            await CardPileCmd.Draw(context,1,actor);
            check("Void loses energy when actually drawn",actor.PlayerCombatState.Energy,2);
            var dazed=combat.CreateCard<Dazed>(actor);
            var burn=combat.CreateCard<Burn>(actor);
            var wound=combat.CreateCard<Wound>(actor);
            await CardPileCmd.Add(dazed,PileType.Hand,skipVisuals:true);
            await CardPileCmd.Add(burn,PileType.Hand,skipVisuals:true);
            await CardPileCmd.Add(wound,PileType.Hand,skipVisuals:true);
            actor.Creature.LoseBlockInternal(actor.Creature.Block);
            check("Wound remains unplayable",wound.CanPlay()?1:0,0);
            int ownHp=actor.Creature.CurrentHp;
            await DuelTurns.End(actor);
            check("Burn triggers in unplayed hand",ownHp-actor.Creature.CurrentHp,2);
            check("Unplayed Dazed exhausts",dazed.Pile?.Type==PileType.Exhaust?1:0,1);
            check("Unplayed Void exhausts",empty.Pile?.Type==PileType.Exhaust?1:0,1);
            check("Wound flushes to discard",wound.Pile?.Type==PileType.Discard?1:0,1);
            var debris=combat.CreateCard<Debris>(actor);
            await PlayerCmd.SetEnergy(1,actor);
            await CardPileCmd.Add(debris,PileType.Hand,skipVisuals:true);
            await debris.SpendResources();
            await CardCmd.AutoPlay(context,debris,null,AutoPlayType.Default,skipXCapture:true,skipCardPileVisuals:true);
            check("Debris pays one energy",actor.PlayerCombatState.Energy,0);
            check("Played Debris exhausts",debris.Pile?.Type==PileType.Exhaust?1:0,1);
            await OrbCmd.AddSlots(actor,3);
            await OrbCmd.Channel<PlasmaOrb>(context,actor);
            await DuelTurns.Start(actor,false);
            check("Plasma adds energy after turn-start reset",actor.PlayerCombatState.Energy,4);
            await PowerCmd.Apply<DoomPower>(context,opponent.Creature,opponent.Creature.CurrentHp+1,actor.Creature,null);
            await DuelTurns.End(opponent);
            check("Doom kills only the affected PvP player",opponent.Creature.CurrentHp,0);
            check("PvE victory does not revive the defeated player",opponent.Creature.IsDead?1:0,1);
            check("PvP survivor remains alive",actor.Creature.IsAlive?1:0,1);
        }
        finally {DuelPrototype.Active=false;DuelPrototype.Actor=null;}
    }
}
