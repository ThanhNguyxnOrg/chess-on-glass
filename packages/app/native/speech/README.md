# SpeechHelper

A minimal .NET Framework 4.8 x64 helper around `System.Speech` for
ChessOnGlass. It supports exactly two commands:

- `SpeechHelper list-voices` — prints `{"voices":[{"id","name","locale"}]}`.
- `SpeechHelper speak` — reads `{"text","voiceId"}` as UTF-8 JSON from stdin
  and speaks it through the default audio device, then exits.

Design rules:

- Text travels on stdin, never on the command line; input is capped.
- No PowerShell, WMI, network API, file access, arbitrary commands or voice
  downloads. Speech is fully local; a missing voice falls back to the
  installed default and never to an online service.
- Short-lived process per operation, so aborting kills the active utterance.

Build (either path):

```sh
# With a .NET SDK / Visual Studio (preferred):
dotnet build SpeechHelper.csproj -c Release -o bin

# Without an SDK, the in-box compiler on Windows:
node scripts/build-speech-helper.mjs
```

`scripts/build-speech-helper.mjs` prefers `dotnet build` and falls back to the
in-box csc.exe with the Framework `System.Speech.dll`, writing
`bin/SpeechHelper.exe`. Building the helper proves compilation only; audible
output is a separate real-machine check.
