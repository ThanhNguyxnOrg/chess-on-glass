# 15. Kiến trúc refactor: seam đa nền tảng cho ChessOnGlass

Ngày: **2026-11-07**. Phạm vi: nguồn sơ cấp cho các seam (chụp màn hình theo OS, TTS, keyring, định tuyến audio, nhận media, định danh phiên/frame) và bản đồ can thiệp theo file. Chỉ đọc source/tài liệu chính chủ; không cài, không build, không gọi API trả phí, không sửa RESEARCH.md. Không khảo sát lại transport/DAT/kính/giấy phép đã có trong RESEARCH.md §8–§14.
**Đề xuất nghiên cứu, chưa được duyệt; không phải thiết kế.**

Thang bằng chứng như RESEARCH.md: **Đã xác minh** (đọc trực tiếp source/tài liệu), **Chỉ mục** (chỉ trích tìm kiếm), **Suy luận/Đề xuất**. Nguồn đọc ngày 2026-11-07; link `main`/`master` là nguồn động. Nguồn cục bộ: các file trong `src/` đọc tại workspace này.

## 1. Phát hiện theo seam

### 1.1 Chụp màn hình theo OS (Windows trước)

- **screenshot-desktop** (npm 1.15.8; metadata MIT, nhưng root repo không thấy file LICENSE — kiểm 2026-11-07): `index.ts` chọn backend theo `process.platform`; `lib/darwin/index.ts` gọi `screencapture`; `lib/win32/index.ts` trích `screenCapture_1.3.3.bat` + `app.manifest` ra thư mục riêng, file .bat tự tìm `csc.exe` (.NET Framework) để **biên dịch C# ngay lúc chạy** rồi chụp bằng GDI (cửa sổ foreground/desktop). Trên Windows nó **không tương đương `screencapture -l`** (chụp cửa sổ chỉ định kể cả khi bị che) mà repo đang dựa vào. [Đã xác minh; https://github.com/bencevans/screenshot-desktop]
- **node-screenshots** (0.2.8; **license không thống nhất: npm metadata ghi Apache-2.0, GitHub repo hiện detect MIT — phải đọc LICENSE thực tế trước khi dùng**): binding napi của XCap; prebuild `win32-x64/ia32/arm64-msvc`, `darwin-x64/arm64`, `linux-x64-gnu/musl`, arm64, loong64; API `Monitor.all()`/`Window.all()`, `captureImage()`, `toJpeg()`. README chỉ liệt kê Node 16/18/20. [Đã xác minh; https://github.com/nashaofu/node-screenshots]
- **XCap** (Apache-2.0, 0.9.8, Rust): Windows ≥ 8.1 chụp màn hình/cửa sổ ✓; Linux Wayland ⛔ "not fully supported"; Cargo feature `wgc` map tới `windows/Graphics_Capture` + `WinRT_Graphics_Capture`. [Đã xác minh; https://github.com/nashaofu/xcap]
- **windows-capture** (MIT, 2.0.1, Rust): Windows Graphics Capture API + DXGI Desktop Duplication; "updates frames only when required". Là crate Rust, không phải binding Node. [Đã xác minh; https://github.com/NiiightmareXD/windows-capture]
- **Microsoft Windows.Graphics.Capture**: lấy frame từ màn hình/cửa sổ; có UI chọn do hệ thống hiển thị + viền vàng quanh đối tượng đang bị chụp; chỉ desktop/MR headset. [Đã xác minh; https://learn.microsoft.com/en-us/windows/uwp/audio-video-camera/screen-capture]
- **OBS Studio** là bằng chứng cấu trúc "một interface source, nhiều backend theo OS": `win-capture` (BitBlt + "WindowsGraphicsCapture" trong `window-capture.c`; DXGI Desktop Duplication trong `duplicator-monitor-capture.c`), `mac-capture` (ScreenCaptureKit `SCStream`, `API_AVAILABLE(macos(12.5))`, trong `mac-sck-video-capture.m`; CGDisplayStream fallback), `linux-capture` (xshm) + `linux-pipewire` (portal). [Đã xác minh; https://github.com/obsproject/obs-studio]
- **python-mss** (thuần ctypes, không dependency): backend theo OS — `mss/darwin.py` (CoreGraphics), `mss/windows/gdi.py`, `mss/linux/{xlib,xcb,xgetimage,xshmgetimage}.py`. Tham khảo cách đóng gói seam mỏng. [Đã xác minh; https://github.com/BoboTiG/python-mss]
- **Đề xuất:** giữ seam `capture(windowId) → JPEG`; Windows-first chọn node-screenshots (đường napi sẵn cho Node) hoặc binding WGC riêng; không dựng lại helper csc.exe. [Suy luận/Đề xuất]

### 1.2 TTS

- **Windows:** lớp `System.Speech.Synthesis.SpeechSynthesizer` (assembly `System.Speech`, tài liệu .NET) — đường không cần cài thêm. [Đã xác minh lớp/assembly; https://learn.microsoft.com/en-us/dotnet/api/system.speech.synthesis.speechsynthesizer — việc có giọng tiếng Việt trên mọi bản Windows là Suy luận cần thử]
- **macOS:** `say` (đang dùng, `src/speak.ts:81–86`); `AVSpeechSynthesizer` (AVFAudio, macOS 10.14+) nếu cần in-process. [Đã xác minh; https://developer.apple.com/documentation/avfaudio/avspeechsynthesizer]
- **Linux:** `espeak-ng` (GPL-3.0; CLI + shared library + DLL + bản SAPI5 cho Windows; >100 ngôn ngữ) và `speech-dispatcher` (GPL-2.0; lớp "device independent" qua giao thức SSIP; hỗ trợ ESpeak-NG, Piper, Edge TTS, Festival…). [Đã xác minh; https://github.com/espeak-ng/espeak-ng, https://github.com/brailcom/speechd]
- **Piper** (`piper-tts` 1.8.0, GPL-3.0-or-later): neural TTS chạy local, nhúng espeak-ng; wheels `win_amd64`, macOS x86_64/arm64, manylinux x86_64/aarch64; có CLI/HTTP/Python/C API. [Đã xác minh; https://github.com/OHF-Voice/piper1-gpl, https://pypi.org/pypi/piper-tts]
- **edge-tts** (7.3.1; repo license NOASSERTION): dùng dịch vụ TTS online của Edge qua websocket, **không phải API chính thức**, cần mạng; không nên làm default. [Đã xác minh; https://github.com/rany2/edge-tts]
- **Prior art tách dịch vụ:** Wyoming (MIT) — protocol TCP JSONL+PCM giữa các service voice, **không auth/không mã hóa theo thiết kế** (chỉ mạng tin cậy); Home Assistant dùng cho Piper. OVOS plugin manager: discovery TTS/STT bằng entry point. [Đã xác minh; https://github.com/rhasspy/wyoming, https://github.com/OpenVoiceOS/ovos-plugin-manager]
- **Đề xuất:** tách `TtsEngine { speak(text) → ok/fail }` khỏi `Route { target/device }`; adapter Windows (SAPI) trước, piper sau; Wyoming chỉ nên học cách tách service, không bê nguyên vì thiếu auth. [Suy luận/Đề xuất]

### 1.3 Keyring

- **keytar**: repo `archived=true` (2022-12-12); README nêu macOS Keychain / Linux `libsecret` (Secret Service) / Windows Credential Vault → không dùng cho code mới. [Đã xác minh; https://github.com/atom/node-keytar + GitHub API]
- **@napi-rs/keyring** (2.1.2, MIT): binding napi của keyring-rs; `new Entry(service, account).setPassword()/getPassword()/deletePassword()`; Linux tự chọn Secret Service, **fallback keyutils trong kernel — chỉ trong RAM, mất khi reboot** (README cảnh báo); có thể pin store. [Đã xác minh; https://github.com/Brooooooklyn/keyring-node]
- **keyring-rs** (đang bảo trì): native store trên Mac/Windows/*nix; tách `keyring-core` + store crate riêng. [Đã xác minh; https://github.com/open-source-cooperative/keyring-rs]
- **Đề xuất:** interface `Secrets` giữ ngữ nghĩa hiện có (`readSecret`/`saveSecret` + đọc lại để kiểm tra, `src/keychain.ts:31–39`), implement bằng @napi-rs/keyring; khi không có store phải quyết định fallback rõ ràng, không âm thầm lưu file. [Suy luận/Đề xuất]

### 1.4 Định tuyến audio ảo (bơm tiếng vào cuộc gọi)

- Driver và giấy phép Windows/macOS/Linux đã khảo sát ở RESEARCH.md §10 (Virtual Audio Driver, BlackHole, VB-Cable, PipeWire/PulseAudio) — không lặp lại.
- Bổ sung: Microsoft có **Application loopback** (`ActivateAudioInterfaceAsync`) giới hạn *thu* audio theo một process; system loopback *thu* toàn bộ audio của endpoint. Đây là API phía capture, không phải cơ chế bơm audio như một microphone ảo. [Đã xác minh; https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/]
- **Đề xuất:** coi đây là capability tùy chọn `AudioRoute("virtual-mic")`; mặc định phát ra thiết bị thường/tai nghe hoặc chỉ text; chỉ mở khi driver thỏa gate ký & license §10. [Suy luận/Đề xuất]

### 1.5 Nhận media (transport)

- Transport đã khảo sát ở §9 (JPEG/MJPEG/WebSocket/RTSP/WebRTC) — không lặp lại.
- Hệ quả thiết kế mới: một interface source cần hai dạng — pull (webcam/replay: `grab()`) và push (ingress mạng: frame đến bất đồng bộ) — chuẩn hóa về "hộp thư frame mới nhất thắng" (bỏ frame cũ khi nghẽn). Prior art: OBS async source — `OBS_SOURCE_ASYNC`, đẩy frame bằng `obs_source_output_video`, mỗi frame có timestamp. [Đã xác minh; `libobs/obs-source.h` + `libobs/obs.h` trong repo OBS]
- `Source` hiện tại (`src/capture.ts:19–27`) đúng hướng pull nhưng thiếu khai báo capability (camera? audio? display?) — cần thêm vì yêu cầu (b). [Suy luận từ code local]

### 1.6 Định danh phiên/frame & độ mới

- **RFC 3550 (RTP)**: mỗi packet có `sequence number` + `timestamp` + `SSRC`; sequence numbering/timestamping là dịch vụ chuẩn của protocol thời gian thực, cho phép bên nhận dựng lại thứ tự dù không bảo đảm giao hàng/không chống out-of-order. Từ vựng tham chiếu, không bê nguyên. [Đã xác minh; https://www.rfc-editor.org/rfc/rfc3550]
- **OBS**: `struct obs_source_frame` có trường `uint64_t timestamp`. [Đã xác minh; `libobs/obs.h`]
- **Local:** `Frame` chỉ có `{jpeg, t}` với t = giây từ lúc source bắt đầu (`src/capture.ts:19–22`); event dùng `frame_t` (`src/main.ts:285`); `feed.ts:113–127` giữ `corners` cũ giữa các lần locate; `newGame()`/`setBoard()` không có token thế hệ để vô hiệu kết quả async đang bay. [Đã xác minh code local; §12 đã nêu cùng điểm]
- **Đề xuất:** `FrameMeta = { sessionId, seq, sourceId, capturedAtMonotonic, capturedAtWall }`; mỗi tác vụ async (vision, locate, engine) chụp `(sessionId, seq)` khi bắt đầu và chỉ commit khi vẫn khớp session + state version hiện tại; kết quả quá tuổi bị loại. `new_game`/đổi nguồn/undo tăng `sessionId`. [Suy luận/Đề xuất]

## 2. Bản đồ seam theo file hiện tại

| File | Mức | Lý do (một dòng) |
|---|---|---|
| src/macos.ts | **Thay** | Toàn bộ là macOS (osascript/screencapture/plutil/say/caffeinate); thay bằng adapter nền tảng, không để logic chung gọi trực tiếp. |
| src/capture.ts | **Tách lớp** | Giữ `Frame`/`Source`/`toJpeg`/`JpegSplitter`/`Replay`/`VideoFile`; tách `CallWindow` thành adapter macOS; thêm session/seq + mailbox latest-wins. |
| src/speak.ts | **Tách lớp** | Giữ `Speaker` (queue, generation, `clear`, callback) làm hợp đồng `Voice`; phần `say` + BlackHole chuyển vào TtsEngine/Route adapter. |
| src/keychain.ts | **Thay** | `security` chỉ có trên macOS; thay bằng `Secrets` (@napi-rs/keyring), giữ ngữ nghĩa read/save + đọc lại kiểm tra. |
| src/config.ts | **Tách lớp** | `dataDir()` đóng cứng `~/Library/Application Support`; tách đường dẫn theo OS; client/provider giữ nguyên. |
| src/cli.ts | **Tách lớp** | Lệnh và flow giữ; bỏ giả định mac (`open` ở dòng 233, doctor mac, test-call BlackHole/WhatsApp) và cho `run` chọn source/output theo capability. |
| src/feed.ts | **Giữ** (sửa nhỏ) | Overlay/recorder ffmpeg dùng lại; chỉ thêm kiểm tra freshness khi tái dùng `corners`. |
| src/web.ts | **Giữ** | Server loopback đủ cho MVP; ingress/auth cho nguồn mạng là giai đoạn sau (§9/§11). |
| src/main.ts | **Tách lớp** | Vòng lặp/điều khiển giữ; tách khỏi giả định "call/WhatsApp" trong thông báo, thêm session/freshness; `Voice`/`Advisor` đã là interface tốt. |
| src/engine.ts | **Tách lớp** | Phần UCI giữ; phần tải/cài (`stockfish-macos-universal.tar.gz`, `tar`/`chmod` dòng 64–69) tách thành installer theo OS/arch. |
| Lõi cờ (match/tracker/watch/game/vision parsing/evals) | **Giữ** | Đã chạy trên Windows theo §14; chỉ đụng khi Frame có metadata mới. |

Ghi chú: bảng là đề xuất mức can thiệp, chưa được duyệt; `src/doctor.ts` và `package.json:15` (`rm -rf`, `cp`, `chmod`) cũng cần rà khi làm CLI/build cross-platform. [Suy luận/Đề xuất]

## 3. Điểm chưa biết & bằng chứng cần để chốt

1. **Chụp cửa sổ bị che/không tiêu điểm trên Windows** có thay được `screencapture -l` không (WGC/DXGI; hành vi minimized, RDP, video call). → Spike node-screenshots hoặc WGC trên WhatsApp call; ghi điều kiện capture.
2. **node-screenshots với Node ≥ 22**: prebuild npm 0.2.8 có, nhưng README chỉ liệt kê tới Node 20; ABI chưa xác nhận. → Chạy thử trên máy tham chiếu (Node 26 theo §14).
3. **Giọng TTS Windows theo locale**: bản Windows tiếng Anh có sẵn giọng Việt hay không; độ trễ `SpeechSynthesizer`. → Liệt kê voices trên máy sạch, đo p50/p95.
4. **Piper tiếng Việt**: model cộng đồng nào, license từng voice, kích thước, chất lượng. → Đọc model card/license + phát thử.
5. **Bơm audio vào mic trên Windows**: WhatsApp Windows có cho chọn microphone ảo không; chọn driver nào theo gate ký §10. → Test máy sạch + verify chữ ký kernel như §10.
6. **@napi-rs/keyring trên Windows** khi Credential Manager lỗi/bị khóa; fallback Linux keyutils không persistent (README). → Thử lỗi + chốt fallback.
7. **Ngữ nghĩa session/seq**: chưa có chuẩn ngoài để bê nguyên (RTP chỉ là từ vựng); cần test ảnh trùng/out-of-order/reset giữa async/pause theo ma trận §12.D. → Viết acceptance test trước khi refactor.
8. **Backend macOS/Linux**: ScreenCaptureKit fallback, Wayland (XCap ⛔, portal chưa thử), espeak-ng vs speech-dispatcher vs piper. → Spike khi tới giai đoạn 2 OS.
9. **Build/CLI cross-platform**: `rm -rf`/`cp`/`chmod` (`package.json:15`), `tar`+`chmod` (`src/engine.ts:64–69`), `open` (`src/cli.ts:233`). → Chuyển sang thao tác Node thuần + test từng OS.

Không thêm dependency, không sửa file nào khác; các đề xuất trên chờ người dùng chọn hướng rồi mới thành thiết kế. [Ràng buộc phạm vi]
