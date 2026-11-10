// Minimal System.Speech helper for ChessOnGlass.
//
// Commands (exactly one argument):
//   list-voices  -> writes {"voices":[{"id","name","locale"}]} to stdout
//   speak        -> reads {"text","voiceId"} as UTF-8 JSON from stdin and
//                   speaks it with the installed voice, then exits
//
// Deliberately tiny: no PowerShell, WMI, network calls, arbitrary commands,
// file access, or voice download. Speech never leaves the machine.
using System;
using System.Linq;
using System.Speech.Synthesis;
using System.Text;
using System.Web.Script.Serialization;

public sealed class VoiceDto
{
    public string id { get; set; }
    public string name { get; set; }
    public string locale { get; set; }
}

public sealed class VoicesResponse
{
    public VoiceDto[] voices { get; set; }
}

public sealed class SpeakRequest
{
    public string text { get; set; }
    public string voiceId { get; set; }
}

internal static class Program
{
    private const int MaxInputCharacters = 8 * 1024;

    private static int Main(string[] args)
    {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);

        if (args.Length != 1)
        {
            Console.Error.WriteLine("usage: SpeechHelper <list-voices|speak>");
            return 2;
        }

        try
        {
            switch (args[0])
            {
                case "list-voices":
                    return ListVoices();
                case "speak":
                    return Speak();
                default:
                    Console.Error.WriteLine("unknown command");
                    return 2;
            }
        }
        catch (Exception error)
        {
            // Sanitized: the caller maps this to speech_unavailable.
            Console.Error.WriteLine("speech helper failed: " + error.GetType().Name);
            return 1;
        }
    }

    private static int ListVoices()
    {
        using (var synthesizer = new SpeechSynthesizer())
        {
            var voices = synthesizer
                .GetInstalledVoices()
                .Where(voice => voice.Enabled)
                .Select(voice => voice.VoiceInfo)
                .Select(info => new VoiceDto
                {
                    id = info.Name,
                    name = info.Name,
                    locale = info.Culture.Name
                })
                .ToArray();

            var serializer = new JavaScriptSerializer();
            Console.Out.Write(serializer.Serialize(new VoicesResponse { voices = voices }));
        }
        return 0;
    }

    private static int Speak()
    {
        var input = Console.In.ReadToEnd();
        if (input.Length > MaxInputCharacters)
        {
            Console.Error.WriteLine("input too large");
            return 2;
        }

        SpeakRequest request;
        try
        {
            request = new JavaScriptSerializer().Deserialize<SpeakRequest>(input);
        }
        catch
        {
            Console.Error.WriteLine("invalid request");
            return 2;
        }

        if (request == null || string.IsNullOrWhiteSpace(request.text))
        {
            Console.Error.WriteLine("invalid request");
            return 2;
        }

        using (var synthesizer = new SpeechSynthesizer())
        {
            if (!string.IsNullOrEmpty(request.voiceId))
            {
                synthesizer.SelectVoice(request.voiceId);
            }
            synthesizer.SetOutputToDefaultAudioDevice();
            synthesizer.Speak(request.text);
        }
        return 0;
    }
}
