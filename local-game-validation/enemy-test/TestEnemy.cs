using MegaCrit.Sts2.Core.Commands;
using MegaCrit.Sts2.Core.Entities.Creatures;
using MegaCrit.Sts2.Core.Helpers;
using MegaCrit.Sts2.Core.Localization;
using MegaCrit.Sts2.Core.Models;
using MegaCrit.Sts2.Core.MonsterMoves.Intents;
using MegaCrit.Sts2.Core.MonsterMoves.MonsterMoveStateMachine;
using MegaCrit.Sts2.Core.Rooms;

namespace QQBotEnemyTest;

// Reuses shipped visuals/localization; no asset pack or extra game mechanics needed.
public sealed class QQBotTrainingDummy : MonsterModel
{
    public const int Health = 60;
    public const int AttackDamage = 6;
    public override int MinInitialHp => Health;
    public override int MaxInitialHp => Health;
    public override LocString Title => MonsterModel.L10NMonsterLookup("BIG_DUMMY.name");
    protected override string VisualsPath => SceneHelper.GetScenePath("creature_visuals/defect");

    protected override MonsterMoveStateMachine GenerateMoveStateMachine()
    {
        var attack = new MoveState("QQBOT_ATTACK", Attack, new SingleAttackIntent(AttackDamage));
        attack.FollowUpState = attack;
        return new MonsterMoveStateMachine(new List<MonsterState> { attack }, attack);
    }

    private async Task Attack(IReadOnlyList<Creature> targets)
    {
        TestRun.Record("enemy_attack_start", new { damage = AttackDamage });
        await DamageCmd.Attack(AttackDamage).FromMonster(this).Execute(null);
        TestRun.Record("enemy_attack_end", new { damage = AttackDamage });
    }
}

// Not added to any act's random encounter pool.
public sealed class QQBotTestEncounter : EncounterModel
{
    public override RoomType RoomType => RoomType.Monster;
    public override bool ShouldGiveRewards => false;
    public override IEnumerable<MonsterModel> AllPossibleMonsters => new[] { ModelDb.Monster<QQBotTrainingDummy>() };
    protected override IReadOnlyList<(MonsterModel, string?)> GenerateMonsters() =>
        new (MonsterModel, string?)[] { (ModelDb.Monster<QQBotTrainingDummy>().ToMutable(), null) };
}
