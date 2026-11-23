using System.Diagnostics;
using System.Text.Json;
using Godot;
using MegaCrit.Sts2.Core.Entities.Players;
using MegaCrit.Sts2.Core.Nodes;

namespace QQBotEnemyTest;

internal static class ResidentHost
{
    private static void Atomic(string path, object value)
    {
        System.IO.File.WriteAllText(path+".tmp",JsonSerializer.Serialize(value));
        System.IO.File.Move(path+".tmp",path,true);
    }
    internal static async Task Run(string directory)
    {
        var runs=System.IO.Path.GetFullPath(System.Environment.GetEnvironmentVariable("QQBOT_RUNS_ROOT")!);
        System.IO.Directory.CreateDirectory(directory);
        NGame.Instance!.GetTree().Paused=true;
        Atomic(System.IO.Path.Combine(directory,"ready.json"),new{modelHash=GameBuild.ModelHash,version=GameBuild.Version});
        while(true)
        {
            var request=System.IO.Path.Combine(directory,"request.json");
            if(!System.IO.File.Exists(request)) {await Task.Delay(50);continue;}
            string id;
            using(var json=JsonDocument.Parse(System.IO.File.ReadAllText(request)))
                id=json.RootElement.GetProperty("run").GetString()!;
            System.IO.File.Delete(request);
            if(id.Length!=32 || !id.All(Uri.IsHexDigit)) throw new ArgumentException("Invalid resident run ID");
            var run=System.IO.Path.Combine(runs,id);
            bool passed=false;string? error=null;
            var timer=Stopwatch.StartNew();
            try
            {
                NGame.Instance.GetTree().Paused=false;
                DuelConfig.Reload(System.IO.Path.Combine(run,"input.json"));
                System.Environment.SetEnvironmentVariable("QQBOT_TEST_OUTPUT",System.IO.Path.Combine(run,"result.json"));
                System.Environment.SetEnvironmentVariable("QQBOT_BENCH_PHASES",System.IO.Path.Combine(run,"phases.jsonl"));
                ResourceProbe.Mark("resident_match_begin");
                passed=await MechanicSuite.Run("duel");
            }
            catch(Exception ex) {error=ex.ToString();GD.PrintErr("[QQBOT_RESIDENT] "+ex);}
            finally
            {
                try
                {
                    DuelPrototype.Active=false;DuelPrototype.Actor=null;
                    await NGame.Instance.ReturnToMainMenu();
                    DuelPrototype.Fighters=Array.Empty<Player>();
                    for(int frame=0;frame<5;frame++)
                        await NGame.Instance.ToSignal(NGame.Instance.GetTree(),SceneTree.SignalName.ProcessFrame);
                    ResourceProbe.Mark("resident_match_cleaned");
                }
                catch(Exception ex) {passed=false;error=ex.ToString();GD.PrintErr("[QQBOT_RESIDENT_CLEANUP] "+ex);}
                NGame.Instance.GetTree().Paused=true;
            }
            using var process=Process.GetCurrentProcess();
            Atomic(System.IO.Path.Combine(directory,"done-"+id+".json"),new{
                passed,error,seconds=timer.Elapsed.TotalSeconds,workingBytes=process.WorkingSet64,modelHash=GameBuild.ModelHash});
        }
    }
}
