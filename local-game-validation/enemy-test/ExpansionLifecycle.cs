using MegaCrit.Sts2.Core.Combat;
using MegaCrit.Sts2.Core.Commands;
using MegaCrit.Sts2.Core.Entities.Cards;
using MegaCrit.Sts2.Core.Entities.Players;
using MegaCrit.Sts2.Core.Factories;
using MegaCrit.Sts2.Core.GameActions.Multiplayer;
using MegaCrit.Sts2.Core.Models;
using MegaCrit.Sts2.Core.Models.Cards;
using MegaCrit.Sts2.Core.Models.Characters;
using MegaCrit.Sts2.Core.Models.CardPools;
using MegaCrit.Sts2.Core.Models.Relics;
using MegaCrit.Sts2.Core.Models.Powers;
using MegaCrit.Sts2.Core.Nodes.Rooms;
using MegaCrit.Sts2.Core.Runs;
using MegaCrit.Sts2.Core.Saves;
using MegaCrit.Sts2.Core.Unlocks;
using MegaCrit.Sts2.Core.ValueProps;

namespace QQBotEnemyTest;

internal static class ExpansionLifecycle
{
    internal static async Task Run(Player actor, Action<string,int,int> check)
    {
        var context=new ThrowingPlayerChoiceContext();
        var opponent=Player.CreateForNewRun<Ironclad>(new UnlockState(SaveManager.Instance.Progress),2UL);
        ((RunState)actor.RunState).AddPlayerDebug(opponent,-1);
        opponent.ResetCombatState();
        var combat=(CombatState)actor.Creature.CombatState!;
        combat.AddPlayer(opponent); NCombatRoom.Instance!.AddCreature(opponent.Creature);
        DuelPrototype.Fighters=new[]{actor,opponent};
        DuelPrototype.Active=true; DuelPrototype.OwnsCombat=true; DuelPrototype.Planning=false;
        using var selector=CardSelectCmd.PushSelector(new VakuuCardSelector());
        async Task Reset()
        {
            foreach(var p in DuelPrototype.Fighters) {
                foreach(var power in p.Creature.Powers.ToArray()) await PowerCmd.Remove(power);
                await CardPileCmd.RemoveFromCombat(p.PlayerCombatState!.AllPiles.SelectMany(v=>v.Cards).ToArray());
                await CreatureCmd.SetMaxAndCurrentHp(p.Creature,1000);
                p.Creature.LoseBlockInternal(p.Creature.Block);
                p.PlayerCombatState.Phase=PlayerTurnPhase.Play;
                await PlayerCmd.SetEnergy(20,p);
                p.PlayerCombatState.Stars=20;
            }
            DuelPrototype.Actor=actor;
            DuelTurns.CurrentPlayer=actor;
        }
        async Task Play<T>(Player? player=null) where T:CardModel
        {
            player??=actor; DuelPrototype.Actor=player;
            DuelTurns.CurrentPlayer=player;
            var card=combat.CreateCard<T>(player);
            await CardPileCmd.Add(card,PileType.Hand,skipVisuals:true);
            await card.SpendResources();
            await CardCmd.AutoPlay(context,card,card.TargetType==TargetType.AnyEnemy?
                (player==actor?opponent:actor).Creature:null,AutoPlayType.Default,skipXCapture:true,skipCardPileVisuals:true);
        }
        try {
            await Reset();
            await CardPileCmd.Add(combat.CreateCard<IAmInvincible>(actor),PileType.Draw,skipVisuals:true);
            await DuelTurns.End(actor);
            check("I Am Invincible auto-plays from draw-pile top at end",actor.Creature.Block,10);

            await Reset();
            await CardPileCmd.Add(combat.CreateCard<HowlFromBeyond>(actor),PileType.Exhaust,skipVisuals:true);
            await DuelTurns.End(actor);
            check("Howl from Beyond auto-plays from exhaust at end",opponent.Creature.CurrentHp,982);

            await Reset();
            await CardPileCmd.Add(combat.CreateCard<Bombardment>(actor),PileType.Exhaust,skipVisuals:true);
            await DuelTurns.Start(actor,false);
            check("Bombardment auto-plays from exhaust before normal play",opponent.Creature.CurrentHp,982);
            await DuelTurns.End(actor); await DuelTurns.Start(opponent,false);
            check("Bombardment does not auto-play on rival turn",opponent.Creature.CurrentHp,982);

            await Reset(); await Play<Mayhem>();
            for(int i=0;i<6;i++) await CardPileCmd.Add(combat.CreateCard<StrikeIronclad>(actor),PileType.Draw,skipVisuals:true);
            await DuelTurns.Start(actor,false);
            check("Mayhem auto-plays remaining draw-pile card before normal play",opponent.Creature.CurrentHp,994);

            await Reset(); await Play<Stampede>();
            await CardPileCmd.Add(combat.CreateCard<StrikeIronclad>(actor),PileType.Hand,skipVisuals:true);
            await DuelTurns.End(actor);
            check("Stampede auto-plays attack at end before hand flush",opponent.Creature.CurrentHp,994);

            await Reset(); await Play<Rupture>(); await Play<StrikeIronclad>(opponent);
            check("Rupture does not trigger from a rival turn attack",actor.Creature.GetPower<StrengthPower>()?.Amount??0,0);
            await Play<Bloodletting>();
            check("Rupture triggers on own turn HP loss",actor.Creature.GetPower<StrengthPower>()?.Amount??0,1);
            await Reset(); await Play<Inferno>(); await Play<StrikeIronclad>(opponent);
            check("Inferno does not retaliate during rival turn",opponent.Creature.CurrentHp,1000);
            await Play<Bloodletting>();
            check("Inferno triggers on own turn HP loss",opponent.Creature.CurrentHp,994);
            await Reset(); await Play<FlameBarrier>(); await Play<StrikeIronclad>(opponent);
            check("Flame Barrier retaliates against the attacking rival",opponent.Creature.CurrentHp,996);
            check("Flame Barrier block absorbs rival attack",actor.Creature.CurrentHp,1000);
            await DuelTurns.End(opponent);
            check("Flame Barrier expires after rival action",actor.Creature.Powers.Count,0);

            await Reset(); await Play<Reflect>();
            actor.Creature.LoseBlockInternal(actor.Creature.Block);
            await CreatureCmd.GainBlock(actor.Creature,4,ValueProp.Unpowered,null);
            await Play<StrikeIronclad>(opponent);
            check("Reflect returns only blocked damage to rival",opponent.Creature.CurrentHp,996);
            check("Reflect permits unblocked remainder",actor.Creature.CurrentHp,998);

            await Reset(); await Play<Juggernaut>();
            await CreatureCmd.GainBlock(actor.Creature,5,ValueProp.Unpowered,null);
            check("Juggernaut block reaction targets rival",opponent.Creature.CurrentHp,994);
            check("Juggernaut does not damage its owner",actor.Creature.CurrentHp,1000);

            await Reset(); await Play<Burst>(); await Play<DefendIronclad>();
            check("Burst duplicates next skill",actor.Creature.Block,10);
            await Play<DefendIronclad>(); check("Burst consumed after one skill",actor.Creature.Block,15);

            await Reset(); await Play<EchoForm>();
            await DuelTurns.End(actor); await DuelTurns.Start(opponent,false);
            await DuelTurns.End(opponent); await DuelTurns.Start(actor,false);
            await Play<StrikeIronclad>(); check("Echo Form doubles own first card next turn",opponent.Creature.CurrentHp,988);
            await Play<StrikeIronclad>(); check("Echo Form does not double own second card",opponent.Creature.CurrentHp,982);
            await DuelTurns.End(actor); await DuelTurns.Start(opponent,false);
            await Play<StrikeIronclad>(opponent); check("Echo Form does not duplicate rival cards",actor.Creature.CurrentHp,994);

            await Reset(); await Play<WellLaidPlans>();
            await CardPileCmd.Add(combat.CreateCard<DefendIronclad>(actor),PileType.Hand,skipVisuals:true);
            await CardPileCmd.Add(combat.CreateCard<DefendIronclad>(opponent),PileType.Hand,skipVisuals:true);
            await DuelTurns.End(actor); check("Well Laid Plans retains own unplayed card",actor.PlayerCombatState!.Hand.Cards.Count,1);
            await DuelTurns.Start(opponent,false); await DuelTurns.End(opponent);
            check("Well Laid Plans does not retain rival hand",opponent.PlayerCombatState!.Hand.Cards.Count,0);

            await Reset();
            var zero=combat.CreateCard<Anger>(actor);
            await CardPileCmd.Add(zero,PileType.Discard,skipVisuals:true);
            await Play<AllForOne>();
            check("All for One returns zero-cost discard",actor.PlayerCombatState!.Hand.Cards.Contains(zero)?1:0,1);

            var pool=ModelDb.AllCards.Where(c=>c.Rarity!=CardRarity.Basic);
            var generated=CardFactory.GetDistinctForCombat(actor,pool,1000,actor.RunState.Rng.CombatCardGeneration).ToArray();
            check("Random generation excludes multiplayer cards",generated.Count(c=>c.MultiplayerConstraint==CardMultiplayerConstraint.MultiplayerOnly),0);
            check("Random generation excludes Ancient cards",generated.Count(c=>c.Rarity==CardRarity.Ancient),0);
            check("Random generation excludes permanent progression and battle rewards",generated.Count(c=>DuelGeneration.Excluded.Contains(c.GetType().Name)),0);
            var colorless=CardFactory.GetDistinctForCombat(actor,ModelDb.CardPool<ColorlessCardPool>().AllCards,1000,actor.RunState.Rng.CombatCardGeneration).ToArray();
            check("Every randomly generated colorless card has an allowed model",colorless.Count(c=>!DuelPrototype.supported.Contains(c.Id.Entry)),0);
            foreach(var character in new CharacterModel[]{ModelDb.Character<Ironclad>(),ModelDb.Character<Silent>(),ModelDb.Character<Regent>(),ModelDb.Character<Necrobinder>(),ModelDb.Character<Defect>()}) {
                var options=character.CardPool.GetUnlockedCards(actor.UnlockState,CardMultiplayerConstraint.MultiplayerOnly).ToArray();
                check(character.GetType().Name+" generation pool excludes banned cards",options.Count(c=>c.MultiplayerConstraint==CardMultiplayerConstraint.MultiplayerOnly || DuelGeneration.Excluded.Contains(c.GetType().Name) || c.Rarity==CardRarity.Ancient),0);
            }
        }
        finally {DuelPrototype.Active=false;DuelPrototype.Actor=null;}
    }
}
