# Nghiên cứu bên ngoài: camera/audio Meta glasses cho ChessOnGlass

Ngày khảo sát: **2026-11-07**. Chỉ nguồn sơ cấp; không khảo sát kiến trúc/code trong workspace.
Phạm vi: đường tích hợp kính, xác minh ba định danh được giao, và hướng sản phẩm; phần đọc PJChess do luồng nghiên cứu chính phụ trách.
Không cài đặt, gọi API tính phí, đổi cấu hình, thử phần cứng hoặc commit. Đây là nghiên cứu, không phải thiết kế đã được duyệt.

## Cách đọc bằng chứng

- **Đã xác minh**: nội dung tài liệu chính thức hoặc source/release từ repository của nhà phát hành.
- **Chỉ mục**: đoạn trích tìm kiếm của trang chính thức; yếu hơn đọc toàn văn, được ghi rõ bên dưới.
- **Suy luận/đề xuất**: hướng triển khai dựa trên bằng chứng, chưa đo hoặc chạy thử.
- Các trang Meta Help/blog đôi khi chỉ trả CSS/JSON; Ray-Ban, OpenAI announcement và OpenCV web có trang trả 403. Không coi thất bại tải trang là bằng chứng tính năng không tồn tại.
- Repository GitHub được đọc qua `gh api`; link nhánh `main`/`4.x` là nguồn động, không phải bản lưu bất biến.

## 1. Hai đường camera khác nhau

| Đường | Bằng chứng và giới hạn | Ý nghĩa cho sản phẩm |
| --- | --- | --- |
| WhatsApp video call | Chỉ mục FAQ WhatsApp xác nhận chia sẻ camera kính trong cuộc gọi, nhấn đúp nút capture; Meta Help nêu nút **Glasses** trong cuộc gọi. [S1][S2] | Tính năng gọi điện của người dùng, không phải bằng chứng về API cấp frame cho ứng dụng khác. |
| Wearables Device Access Toolkit (DAT) | SDK chính thức cho ứng dụng **Android/iOS**, cung cấp camera stream, ảnh, quản lý phiên và quyền. [S4][S5][S6] | Có đường tích hợp lập trình trực tiếp qua điện thoại; không cần lấy hình từ cửa sổ WhatsApp. |
| DAT audio | Có Bluetooth audio qua hệ điều hành và camera audio PCM in-band; hai đường không cùng mức hỗ trợ production. [S8][S9] | Chọn audio API theo trạng thái phát hành, không đồng nhất mọi microphone access với SDK beta. |

**Windows qua WhatsApp — suy luận khả thi cho thử nghiệm có đồng thuận:**
- WhatsApp công bố ứng dụng Windows có calling, yêu cầu Windows 10+; đây là bằng chứng cho đầu nhận cuộc gọi trên PC. [S3, chỉ mục]
- Ghép kính với điện thoại, chia sẻ POV tới người nhận dùng PC, rồi xử lý vùng video được người dùng cho phép capture là một phương án thử nghiệm, **không phải tích hợp SDK Windows được Meta chứng nhận**. [S1–S3]
- Chưa xác minh end-to-end kính → người nhận Windows, frame extraction API, độ trễ, chất lượng hay đường bơm TTS từ PC trở lại cuộc gọi. Cần thử riêng; không cam kết hoạt động chỉ vì hai đầu đều hỗ trợ gọi.
- Không suy ra ghép Bluetooth kính–PC biến camera kính thành webcam/UVC. Không tìm được tài liệu DAT native Windows trong tập nguồn đã đọc. [S4–S6]

## 2. DAT: thiết bị, OS, quyền truy cập

- **Đã xác minh:** Setup liệt kê Ray-Ban Meta **Gen 1/Gen 2**, Ray-Ban Meta Optics, **Meta glasses**, Meta Ray-Ban Display, Oakley Meta HSTN và Vanguard. Không tự gán tên “Meta glasses” thành “Gen 3”, không suy rộng sang Ray-Ban Stories. [S4]
- **Đã xác minh:** Android **10+**, Android Studio Flamingo+, Kotlin **2.2+**; iOS **17.2+**, Xcode **26.4+** theo Setup hiện hành. Đây là yêu cầu DAT, không phải khẳng định mọi bản WhatsApp có cùng mức OS. [S4][S6]
- Cần Meta AI app và Developer Mode cho development builds; app phải đăng ký xong, có quyền CAMERA trước khi stream. Bộ MockDeviceKit cho phép thử logic không có kính. [S6][S7]
- Android SDK công bố trên Maven Central, không cần access token để tải; iOS dùng Swift Package. Không nhầm quyền tải SDK với quyền dùng thiết bị hoặc phát hành ứng dụng. [S5][S6]
- README Android/iOS vẫn gọi toolkit là **developer preview**, dù SDK đã có **1.0.1**. Changelog ghi 1.0.0 ngày **2026-09-24**, 1.0.1 ngày **2026-10-09**. Số phiên bản không chứng minh general availability. [S5][S10]
- Chỉ mục bài Meta ngày **2026-05-14** nói DAT release channels hỗ trợ **tối đa 100 testers**. Đây là giới hạn được công bố ở thời điểm đó; chưa kiểm chứng quota hiện hành trong Developer Center của một tài khoản cụ thể. [S11]
- FAQ chỉ mục nói có thể tải SDK ở mọi nơi nhưng đầy đủ tính năng phụ thuộc quốc gia hỗ trợ AI glasses. **Chưa xác minh quyền truy cập đầy đủ tại Việt Nam**, không lấy menu ngôn ngữ hoặc việc mua được kính làm bằng chứng. [S12]
- iOS integration guide còn cảnh báo **chưa hỗ trợ App Store submission**, liên quan ExternalAccessory; phát hành đại trà cần xác nhận lại với Meta, không suy từ việc build/test thành công. [S13]

### Camera/audio: các giới hạn thực tế

- Android guide định nghĩa HIGH **720×1280**, MEDIUM **504×896**, LOW **360×640**; mức FPS hợp lệ **2, 7, 15, 24, 30**. Đây là lựa chọn cấu hình, không phải cam kết luôn đạt 720×1280@30. [S7]
- Guide nói hạ độ phân giải/FPS thường cải thiện chất lượng mỗi frame qua Bluetooth; mặc định phone giải mã YUV, có tùy chọn nhận HEVC nén. Chỉ một lần chụp ảnh in-stream được thực hiện tại một thời điểm. [S7]
- Cần xử lý pause/disconnect, pin và nhiệt; changelog có lỗi thermal/battery và bản 1.0.1 sửa lag/stutter/HEVC buffer corruption. Không có số đo đảm bảo chạy liên tục cả ván trong nguồn này. [S7][S10]
- **Bluetooth audio đã xác minh:** HFP là voice hai chiều mono; A2DP là phát âm thanh chất lượng cao, không thu mic. Android dùng routing hệ điều hành; iOS cần ổn định HFP trước stream. [S8]
- **In-band audio đã xác minh:** camera stream có thể nhận PCM đồng bộ video; Android guide liệt kê **16/44,1/48 kHz**, cần phê duyệt Camera + Audio Streaming ở Developer Center và quyền CAMERA + MICROPHONE. [S9]
- **Quan trọng:** in-band audio còn **experimental**, chỉ development/beta, chưa được publish vào production release channels; on-device Speech/voice invocation cũng được changelog gắn experimental. Không mô tả toolkit là “chỉ video”, cũng không hứa mọi voice feature đã sẵn sàng production. [S9][S10]
- **Suy luận:** với bản thử, ưu tiên video DAT và TTS/routing Bluetooth chuẩn; chỉ bật PCM in-band nếu thật sự cần và chấp nhận beta. Việc vừa thu tiếng vừa phát hướng dẫn phải đo trên kính thật. [S8–S10]

## 3. Đường Windows/mobile thực tế

1. **Đề xuất ưu tiên: Android companion + Windows xử lý.** Android nhận frame/quyền/phiên từ DAT, chuyển frame chọn lọc sang dịch vụ LAN có xác thực; Windows nhận diện bàn, chạy engine, trả kết quả cho phone/TTS. Phần chuyển LAN là đề xuất riêng, không phải API có sẵn trong DAT. [S6–S9]
2. **Đề xuất gọn hơn sau thử nghiệm:** xử lý trên điện thoại, giảm phụ thuộc PC; chưa có benchmark pin, nhiệt hay engine trên thiết bị đích. DAT chỉ bảo đảm bề mặt tích hợp, không bảo đảm pipeline cờ. [S4][S7]
3. **Windows-only trước khi có kính:** video có đồng thuận/webcam/ảnh có nhãn làm đầu vào đánh giá; WhatsApp chỉ là cầu nối demo cần kiểm thử, không mặc định làm nền tảng phân phối. [S1–S3, suy luận]

Android Studio có Windows build; chỉ mục tài liệu chính thức nêu Windows 10 64-bit tối thiểu. Xcode yêu cầu macOS: Windows không thay thế máy Mac cho build/sign iOS. [S14][S15]
Một lần trích xuất trang Android chỉ thấy Linux/Mac và kết luận thiếu Windows; đã đối chiếu lại bảng tải chính thức có Windows, không sử dụng kết luận trích xuất thiếu đó. [S14]
Meta Ray-Ban Display có capability hiển thị từ DAT; không suy rằng Ray-Ban Meta thông thường có màn hình hay rằng một web app Windows được quyền camera kính. [S10]

## 4. Kiểm tra đúng định danh — không phán đoán theo tên lạ

| Chuỗi được giao | Kết luận dựa trên nguồn chính thức | Giới hạn kết luận |
| --- | --- | --- |
| `gpt-6.1-sol` | **Có trong OpenAI API catalog**, hỗ trợ image input, không hỗ trợ audio; catalog hiển thị đúng chuỗi này. DevDay recap ngày **2026-09-29** công bố GPT-6.1 Sol. [S16][S17] | Không chứng minh tài khoản dự án có quyền, adapter tương thích hay chất lượng nhận bàn cờ. |
| `claude-opus-5-5` | **Có trong Claude Platform docs**, đúng API ID; text/images → text; ngày phát hành **2026-09-22**. [S18] | Không tự thay bằng dấu chấm, ID Bedrock/OpenRouter; không xác minh entitlement bằng lời gọi tính phí. |
| `sf_19` | **Tag release chính thức của Stockfish 19**; GitHub API trả `published_at: 2026-09-05T08:33:17Z`, khớp blog **2026-09-05**. [S19][S20] | Là tag engine, không phải LLM ID; chưa kiểm tra binary cụ thể mà dự án sử dụng. |

**Kết luận:** cả ba chuỗi đều có bằng chứng sơ cấp; không nên sửa/xóa chỉ vì khác kiến thức cũ. Không đọc tài liệu local nên không khẳng định vị trí hay cách repo đang dùng chúng.
Stockfish 19 còn siết validation FEN/UCI và có thể kết thúc process với `info string CRITICAL ERROR`; **đề xuất** kiểm tra vị trí và xử lý engine exit trước khi gửi kết quả nhận dạng ảnh. [S19]

## 5. Tracking bàn cờ: hỗ trợ, không thay nhận dạng

- OpenCV mô tả homography là ánh xạ giữa các mặt phẳng; có ích để chuẩn hóa mặt bàn nhìn nghiêng. **Suy luận:** quân 3D/tay che bàn không được giải quyết chỉ bằng một homography. [S21]
- `goodFeaturesToTrack` + `calcOpticalFlowPyrLK` hỗ trợ theo dõi điểm; giả định độ sáng tương đối ổn định/chuyển động lân cận tương tự. Tài liệu cảnh báo điểm mất vẫn có thể bị bám nhầm, khuyên tìm lại góc định kỳ và backward-check. [S22]
- **Đề xuất:** khóa vùng bàn → theo dõi hình học → tái phát hiện khi confidence giảm → chỉ ghi nước sau frame ổn định và kiểm tra hợp lệ; gặp che khuất thì hỏi xác nhận, không tự bịa FEN. [S21][S22]

## 6. Ba hướng sản phẩm có giới hạn rõ

1. **Ưu tiên: tự ghi PGN + phân tích sau ván.** Người chơi đồng ý ghi hình; không phát gợi ý trong ván; cho sửa nước chưa chắc, chỉ phân tích khi kết thúc. Phù hợp thử pipeline video/validation trước audio beta. [S7][S9][S19, suy luận]
2. **Huấn luyện giao hữu có đồng thuận.** Hai bên bật chế độ training trước ván; lời giải thích theo yêu cầu, không tối ưu “gợi ý bí mật”. Video DAT + Bluetooth TTS là ứng viên cần kiểm thử. [S7–S9, đề xuất]
3. **Cờ dễ tiếp cận.** Đọc tên ô/nước vừa đi và trạng thái đã xác nhận cho người thị lực kém; có lặp lại/xác nhận thủ công. Tách chức năng tiếp cận khỏi gợi ý chiến thuật; thử với người dùng đích trước khi hứa độ tin cậy. [S8][S22, đề xuất]

Không thiết kế hỗ trợ ngầm trong giải đấu; mặc định thông báo ghi hình, tối thiểu hóa lưu video, có dừng/xóa và đồng thuận của người tham gia. Đây là ràng buộc sản phẩm đề xuất, không phải xác nhận tuân thủ luật tại mọi quốc gia.

## 7. Khoảng trống có thể đóng bằng thử nghiệm giới hạn

- Kiểm tra một cặp kính/firmware/phone cụ thể, khả dụng tại Việt Nam, Developer Center access/quota và quyền phân phối; chưa đăng nhập dashboard hoặc thay đổi thiết lập. [S4][S11–S13]
- Chạy thử có đồng thuận 15–30 phút: FPS nhận thực, p50/p95 độ trễ, tỷ lệ bàn đúng, nước bỏ sót, mất kết nối, nhiệt/pin; các con số là **kế hoạch đo**, không phải kết quả.
- Xác nhận route mic/TTS và WhatsApp → Windows nếu chọn demo; không coi mock stream là phép thử Bluetooth/phần cứng. [S1–S3][S9]
- Ngày nguồn khác nhau: dự định publishing GA “2026” trong bài **2025-09-18** không chứng minh đã mở; SDK **2026-10-09** vẫn preview và iOS guide được chỉ mục cập nhật **2026-10-29** vẫn cảnh báo App Store. Giữ cả hai mốc, xác nhận trạng thái trước phát hành. [S5][S10][S13][S23]
- FAQ liệt kê thiết bị ít hơn Setup **2026-10-29**; dùng danh sách Setup và changelog, nhưng không suy rằng mọi capability có trên mọi mẫu kính. Không gặp ngày nguồn tương lai sau 2026-11-07 trong bằng chứng được dùng. [S4][S10][S12]

## Nguồn sơ cấp

- [S1] WhatsApp, About WhatsApp on Meta AI glasses (chỉ mục): https://faq.whatsapp.com/836703167795647
- [S2] Meta Help, share your view (chỉ mục): https://www.meta.com/help/ai-glasses/2144534879236727/
- [S3] WhatsApp download, Windows calling/OS (chỉ mục): https://www.whatsapp.com/download
- [S4] Meta DAT Setup (toàn văn trích xuất; ngày cập nhật từ chỉ mục): https://wearables.developer.meta.com/docs/develop/dat/getting-started-toolkit/
- [S5] Meta SDK README iOS: https://github.com/facebook/meta-wearables-dat-ios/blob/main/README.md ; Android: https://github.com/facebook/meta-wearables-dat-android/blob/main/README.md
- [S6] Meta Android getting started: https://github.com/facebook/meta-wearables-dat-android/blob/main/plugins/mwdat-android/skills/getting-started/SKILL.md
- [S7] Meta Android camera streaming: https://github.com/facebook/meta-wearables-dat-android/blob/main/plugins/mwdat-android/skills/camera-streaming/SKILL.md
- [S8] Meta microphones and speakers (chỉ mục cập nhật 2026-10-12): https://wearables.developer.meta.com/docs/develop/dat/microphones-and-speakers/
- [S9] Meta Android audio streaming: https://github.com/facebook/meta-wearables-dat-android/blob/main/plugins/mwdat-android/skills/audio-streaming/SKILL.md
- [S10] Meta Android changelog: https://github.com/facebook/meta-wearables-dat-android/blob/main/CHANGELOG.md
- [S11] Meta Display developer preview, 2026-05-14 (chỉ mục): https://developers.meta.com/blog/build-for-display-glasses/
- [S12] Meta Wearables FAQ (chỉ mục): https://developers.meta.com/wearables/faq/
- [S13] Meta iOS integration (nội dung trích xuất; chỉ mục cập nhật 2026-10-29): https://wearables.developer.meta.com/docs/develop/dat/build-integration-ios/
- [S14] Google Android Studio Windows (chỉ mục): https://developer.android.com/studio/install ; https://developer.android.com/studio
- [S15] Apple Xcode host support: https://developer.apple.com/support/xcode/
- [S16] OpenAI model catalog: https://developers.openai.com/api/docs/models/gpt-6.1-sol
- [S17] OpenAI DevDay recap, 2026-09-29 (chỉ mục): https://openai.com/index/devday-2026-recap/
- [S18] Anthropic model overview: https://platform.claude.com/docs/en/models/opus-5-5/overview
- [S19] Stockfish release, đọc GitHub API theo tag: https://github.com/official-stockfish/Stockfish/releases/tag/sf_19
- [S20] Stockfish announcement: https://stockfishchess.org/blog/2026/stockfish-19/
- [S21] OpenCV homography, source tutorial: https://github.com/opencv/opencv/blob/4.x/doc/tutorials/features2d/homography/homography.markdown
- [S22] OpenCV optical flow, source tutorial: https://github.com/opencv/opencv/blob/4.x/doc/tutorials/others/optical_flow.markdown
- [S23] Meta DAT introduction, 2025-09-18 (chỉ mục): https://developers.meta.com/blog/introducing-meta-wearables-device-access-toolkit/

## 8. Mở rộng phạm vi: ít phụ thuộc app/hãng, vẫn giữ AI mạnh

Yêu cầu làm rõ ngày 2026-11-07: người dùng chấp nhận Node/Stockfish/FFmpeg và Docker cho backend; mục tiêu là bỏ phụ thuộc bắt buộc vào WhatsApp, BlackHole, macOS hay một hãng kính. Kính IoT tự chế là khả năng tương lai, chưa chọn phần cứng. Các mục dưới là nghiên cứu/đề xuất, không phải thiết kế đã duyệt hoặc tính năng đã triển khai.

### BlackHole và ranh giới Docker

- BlackHole là macOS audio loopback driver, chuyển tiếng từ ứng dụng này thành đầu vào cho ứng dụng khác. Trong repo, `src/speak.ts:81–86` chạy `say` và chọn BlackHole khi phát vào cuộc gọi. Nó không nhận diện cờ và không kết nối camera. [O1]
- Gửi kết quả/âm thanh trực tiếp tới client do mình kiểm soát có thể loại bỏ nhu cầu loopback vào WhatsApp. Đây là thay đổi đường truyền, không chỉ đóng gói driver. Thiết bị camera-only có thể dùng một điện thoại khác làm đầu ra âm thanh. [Đề xuất]
- Docker có ích cho backend nhận hình qua mạng. Docker Desktop không bảo đảm hỗ trợ mọi USB device; USB/IP cần thêm thiết lập và đặc quyền, không phải phép thay thế tự động cho camera/Bluetooth/audio của host. [O2]
- Mạng container và host là hai phạm vi cần cấu hình; publish port không tự thêm authentication. Server hiện tại ở `src/web.ts:21,80–96` được thiết kế cho loopback, không có cơ chế ghép cặp thiết bị. Không chỉ đổi bind sang mọi interface rồi đưa lên LAN/Internet. [O3; code local]
- `Source` hiện có ở `src/capture.ts:19–26` nhận JPEG + thời gian; `Advisor` và `Voice` ở `src/main.ts:31–37` đã tách tương đối khỏi thiết bị. Có thể tận dụng, nhưng metadata phiên/sequence, network ingress, output client và adapter ngoài macOS chưa có. [Code local; đề xuất]

### Paper và opensource nhận diện cờ

| Công trình | Đã quan sát từ paper/code | Giới hạn áp dụng |
| --- | --- | --- |
| Wölflein & Arandjelović, Determining Chess Game State From an Image (2021), chesscog | Pipeline định vị bàn, occupancy và loại quân từ ảnh; có dữ liệu tổng hợp và hướng dẫn fine-tune. Code MIT. [P1][P2] | Photo-to-position, không chứng minh tracker camera đeo liên tục; quyền dataset/checkpoint phải kiểm tra riêng. |
| Masouris & van Gemert, End-to-End Chess Recognition (VISAPP 2024), ChessReD | Dữ liệu smartphone nhiều góc; ChessReD gồm 10.800 ảnh/100 ván, ChessReD2K có 2.078 ảnh bổ sung annotation. Code MIT; dataset CC BY-NC-SA 4.0. [P3–P5] | Ảnh chụp sau nước đi không tương đương video đầu chuyển động. Không mặc định dùng dataset cho thương mại. |
| Mallasén Quintana và cộng sự, LiveChess2FEN (2020) | Code có previous FEN, so sánh ô thay đổi và suy ra nước đi; code AGPL-3.0, README nêu phiên bản sau. [P6][P7] | Có tối ưu tái dùng góc khi camera đứng yên; chưa có bằng chứng tương đương camera kính. Quyền dataset/checkpoint chưa xác minh. |

Ngày commit tìm được: chesscog 2025-01-11, End-to-End 2026-08-27 (thêm license), LiveChess2FEN 2024-11-19. Đây là ảnh chụp trạng thái nguồn động, không chứng minh bảo trì tích cực hoặc chất lượng runtime. Chưa chạy các repo này.

### Điều nên học từ nghiên cứu, không sao chép nguyên stack

- OpenCV có mẫu Lucas–Kanade optical flow, forward–backward check và homography/RANSAC. Dùng để bám mặt bàn giữa các lần AI đọc; không thay thế nhận dạng quân. [P8]
- Homography mô hình hóa mặt phẳng; không sửa parallax quân 3D hay khôi phục quân bị tay che. Nên giữ ảnh gốc cùng ảnh căn chỉnh cho AI. [P9; đề xuất]
- `findChessboardCorners` là detector mẫu calibration; bàn 8×8 tương ứng 7×7 góc trong. Không coi nó là bộ nhận diện bàn đầy quân/tay che hoàn chỉnh. [P9]
- Marker ArUco ở viền là lựa chọn hỗ trợ calibration ban đầu, không bắt buộc cho mọi người dùng; cần biết quan hệ marker–bàn và thông số camera nếu cần pose. [P10; đề xuất]
- Giữ premium vision. Bổ sung gate độ rõ/chuyển động cục bộ và kiểm tra định kỳ; không để gate loại nhầm frame khiến AI không bao giờ thấy nước mới. [Đề xuất]
- Tách tốc độ video/tracking khỏi tốc độ suy luận AI. Gắn frame ID, phiên, timestamp và phiên bản thế cờ; không áp kết quả cũ sau reset. Hai frame xác nhận phải khác nhau và đúng thứ tự, không lấy video đứng hình làm bằng chứng độc lập. [Đề xuất từ code và bài toán]
- Overlay chỉ bám khi hình học còn tin cậy; mất bàn hoặc dữ liệu quá cũ phải ẩn/cảnh báo, không giữ hình vẽ tại tọa độ cũ. [Đề xuất; `src/feed.ts:113–127` hiện tái sử dụng corners giữa các lượt locate]

### Đánh giá đúng bài toán trước khi chọn model/thư viện

- `DESIGN.md:100–125` chỉ báo kết quả ba nước. `evals/score.ts:131–144` phục hồi bằng các thế cờ lấy từ PGN đáp án: hữu ích chẩn đoán nhưng không đo recovery độc lập. [Code local]
- Tách oracle-assisted diagnostics và free-running. Trong free-running, PGN chỉ được bộ chấm dùng sau đó, không được inference/recovery đọc. [Đề xuất]
- Thu video nguyên ván, chia train/test theo ván và phiên quay, không chia ngẫu nhiên frame liền nhau. Phủ quay đầu, tay che, blur, video đóng băng, mất mạng, đổi bộ quân/ánh sáng, nhập thành, en passant, underpromotion và bỏ lỡ nhiều nước. [Đề xuất]
- Đo false commit, missed/duplicate move, chuỗi nước đúng liên tục, thời gian phục hồi, p50/p95 độ trễ, tuổi overlay và chi phí mỗi ván. Không chuyển accuracy của paper ảnh đơn thành hiệu năng kính. [Đề xuất]
- Ảnh đơn không xác định đầy đủ quyền nhập thành/en passant; occupancy không phân biệt loại quân phong cấp. Giữ lịch sử đáng tin hoặc yêu cầu xác nhận phần thiếu, không tự dựng đầy đủ FEN từ một ảnh mơ hồ. [Luật cờ; giới hạn biểu diễn hiện tại]

### Nguồn bổ sung: hệ thống và perception

- [O1] BlackHole official: https://existential.audio/blackhole/ ; https://github.com/ExistentialAudio/BlackHole
- [O2] Docker Desktop USB/IP: https://docs.docker.com/desktop/features/usbip/
- [O3] Docker Desktop networking: https://docs.docker.com/desktop/features/networking/networking-how-tos/
- [P1] chesscog paper: https://arxiv.org/html/2104.14963v2
- [P2] chesscog code: https://github.com/georg-wolflein/chesscog
- [P3] End-to-End Chess Recognition paper: https://arxiv.org/html/2310.04086v3
- [P4] Author code: https://github.com/tmasouris/end-to-end-chess-recognition
- [P5] ChessReD dataset/license: https://data.4tu.nl/datasets/99b5c721-280b-450b-b058-b2900b69a90f
- [P6] LiveChess2FEN paper: https://arxiv.org/html/2012.06858v1
- [P7] LiveChess2FEN code: https://github.com/davidmallasen/LiveChess2FEN
- [P8] OpenCV LK/homography sample: https://github.com/opencv/opencv/blob/4.x/samples/python/lk_homography.py
- [P9] OpenCV calibration API: https://github.com/opencv/opencv/blob/4.x/modules/calib3d/include/opencv2/calib3d.hpp
- [P10] OpenCV ArUco API: https://github.com/opencv/opencv/blob/4.x/modules/objdetect/include/opencv2/objdetect/aruco_detector.hpp

## 9. Thiết bị mở và giao thức: chuẩn hóa giao diện, không ép chung transport

### Transport theo nhu cầu

| Đường truyền | Bằng chứng | Đề xuất sử dụng |
| --- | --- | --- |
| JPEG/HTTP | esp32-camera có ví dụ trả image/jpeg. [T3] | MVP camera IoT/LAN, tương thích trực tiếp đầu vào JPEG hiện có. Push hoặc pull phải được định nghĩa rõ. |
| MJPEG/HTTP | Ví dụ Espressif dùng multipart/x-mixed-replace. [T3] | Preview từ camera LAN; giữ frame mới nhất, không tích hàng đợi. Không cung cấp audio/talkback. |
| JPEG/WebSocket | RFC 6455 có message text/binary hai chiều trên TCP. [T2] | Companion đẩy ảnh; tự định nghĩa sequence, timestamp, session, kích thước, backpressure và cơ chế ngừng gửi khi nghẽn. WSS cho đường truyền có TLS. |
| RTSP | MediaMTX hỗ trợ nhận/phát RTSP và các giao thức khác. [T5] | Tích hợp camera IP có sẵn. Browser cần gateway phù hợp; không mặc định có talkback. |
| WebRTC | Audio/video/data; signaling ngoài đặc tả, kết nối dùng ICE và có thể cần STUN/TURN. [T1][T4] | Khi cần video/thoại realtime hai chiều; không ép MCU nhỏ phải dùng ngay. |

Ảnh rời đủ cho một prototype theo dõi ván chậm, không đủ để hứa overlay mượt khi đầu chuyển động. Muốn overlay liên tục cần luồng preview/tracking tần suất cao hơn độc lập với nhịp gửi AI. [Đề xuất]

### Hai công cụ đáng giữ trong shortlist, chưa phải dependency bắt buộc

- **aiortc**: thư viện Python WebRTC có audio/video/data và xử lý frame; BSD-3-Clause. Phù hợp gateway media khi thực sự cần duplex; không phải server turnkey, thêm Python là một chi phí vận hành. [T4]
- **MediaMTX**: media router Windows/Linux/macOS/Docker, MIT; hữu ích RTSP routing/multiple viewers/protocol bridging. Remux/đổi giao thức không đồng nghĩa transcode; không mặc định nó xuất JPEG hoặc đổi MJPEG thành H.264. [T5]
- Chưa thêm cả hai cho MVP JPEG. Dùng aiortc khi yêu cầu duplex làm nó đáng giá; dùng MediaMTX khi cần camera RTSP/routing. [Đề xuất]
- Metadata nguồn tại lần kiểm tra: aiortc commit nhánh mặc định 2026-11-07; MediaMTX commit 2026-11-07, release v1.21.3 ngày 2026-10-25. Chưa chạy/benchmark công cụ nào. [T4][T5]

### Phần cứng tham khảo có nguồn

**Brilliant Labs Frame**

- Tài liệu nêu camera cảm biến 1280×720, pipeline crop 720×720; microphone, OLED 640×400 và Bluetooth 5.3. SDK có Python/Flutter/WebBluetooth và chia gói theo MTU. Đây không phải camera Wi-Fi/IP trực tiếp. [T6][T8]
- Đường khả thi: camera/mic qua BLE tới companion; text/bitmap trả về màn hình. Không suy từ microphone hoặc audio streaming rằng thiết bị có loa phát TTS. Có thể phát tiếng bằng điện thoại/tai nghe. [T6–T8; đề xuất]
- Thông số cảm biến không chứng minh video realtime qua BLE; tốc độ ảnh, mic đồng thời, pin và nhiệt phải đo. [Giới hạn]
- Firmware dùng ISC mặc định với ngoại lệ theo file/thư mục; SDK BSD-3-Clause. Firmware commit/release được tìm thấy 2025-10-05, SDK commit 2026-11-04; không gọi cả stack là cùng một license. [T7][T8]

**ESP32 DIY**

- esp32-camera hỗ trợ ESP32/S2/S3 và nhiều cảm biến, có JPEG/MJPEG HTTP. Tài liệu cảnh báo PSRAM và áp lực bộ nhớ khi RGB/YUV dùng cùng Wi-Fi. Driver Apache-2.0. Nó không cung cấp sẵn một chiếc kính, loa, màn hình hay thiết kế pin. [T3]
- Espressif WebRTC có demo local doorbell: video tới browser và audio hai chiều; cấu hình mặc định được kiểm tra dùng ESP32-P4 Function EV Board + SC2336. Không suy rộng sang mọi ESP32-CAM. [T9]
- `esp_peer` dùng Espressif Modified MIT với hạn chế theo sản phẩm Espressif: có source không đồng nghĩa giấy phép permissive độc lập hãng. Phải kiểm tra từng component trước khi tái sử dụng trên hardware khác. [T10]
- Metadata nguồn: esp32-camera commit nhánh mặc định 2026-10-30; esp-webrtc-solution 2026-11-03. Chưa thử phần cứng. [T3][T9]

### Khuyến nghị tổng hợp — chưa được người dùng duyệt

1. **Giữ lõi cờ và premium AI; xây một dịch vụ nhận observation độc lập hãng.** Không viết lại engine hoặc tự huấn luyện classifier từ đầu chỉ để giảm phụ thuộc app gọi điện.
2. **Một đường JPEG network + một client tham chiếu trước.** Client có thể là điện thoại hoặc ESP32 thử nghiệm; đăng ký capability riêng camera/mic/audio/display. Không yêu cầu camera và nơi phát kết quả là cùng thiết bị.
3. **Đầu ra là kết quả có cấu trúc**, không chỉ audio: nước, phiên bản thế cờ, câu nói, dữ liệu overlay. Client chọn phát TTS, hiện màn hình hoặc chỉ lưu PGN. Giữ khóa AI ở backend; không gửi khóa tới kính IoT.
4. **Backend chạy native hoặc Docker**, không để lõi phụ thuộc macOS `say`, `osascript`, Keychain, window capture. Platform adapter/companion quản lý quyền camera, BLE, microphone và playback.
5. **WhatsApp là adapter tương thích tùy chọn**, không phải kiến trúc gốc. App khác dùng API/SDK khi được cung cấp hoặc screen capture do người dùng chủ động cho phép; không hứa mọi app đều cho chèn audio trực tiếp.
6. **Bảo vệ biên mạng trước LAN:** ghép cặp/token có thể thu hồi, xác thực nguồn và quyền control, giới hạn kích thước/tần suất ảnh, backpressure, bảo vệ transport, không public mặc định. Đây là yêu cầu mới vì server hiện tại chỉ thiết kế cho localhost.
7. **Giữ hai nhịp độc lập:** video/hình học nhanh; AI đọc khi cần. Mỗi kết quả gắn frame/session/state version; loại ảnh trùng, ảnh quá hạn và kết quả sai phiên. Mất tracking thì hạ trạng thái thay vì vẽ overlay chắc chắn.
8. **Nghiệm thu bằng hai nguồn khác loại dùng cùng lõi**, cùng ván replay và một phiên live không oracle; đo cả đường nhận ảnh lẫn trả kết quả, không chỉ smoke test API.
9. **Thêm RTSP/WebRTC sau bằng chứng nhu cầu**, không dựng MediaMTX + aiortc + broker + orchestrator ngay. MQTT nếu có chỉ dành telemetry/control, không mặc định làm transport video. [Đề xuất kiến trúc]
10. **Overlay video khác AR trong mắt kính.** SVG/homography hiện tại vẽ lên ảnh camera. World-locked optical-see-through overlay cần quan hệ camera–display–mắt và tracking phù hợp, không tự có từ bốn góc bàn. Text HUD trên kính đơn giản hơn; phạm vi hiển thị chưa được người dùng chọn.

### Điều chưa được chứng minh

Chưa chạy code mới, test phần cứng, đo độ trễ/pin/nhiệt hoặc xác thực quyền phân phối SDK/dataset cho một sản phẩm cụ thể. Không khẳng định mọi kính đều truy cập camera được, mọi client có loa, mọi stream có timestamp camera tin cậy, hay mọi repo tham khảo có license giống nhau. Mục tiêu performance chỉ được chọn sau baseline thực tế. Các nguồn GitHub main là động.

### Nguồn thiết bị và media

- [T1] WebRTC peer connections: https://webrtc.org/getting-started/peer-connections
- [T2] WebSocket RFC 6455: https://www.rfc-editor.org/rfc/rfc6455.html
- [T3] Espressif camera driver: https://github.com/espressif/esp32-camera
- [T4] aiortc: https://github.com/aiortc/aiortc
- [T5] MediaMTX: https://github.com/bluenviron/mediamtx
- [T6] Frame hardware: https://github.com/brilliantlabsAR/docs/blob/main/frame/hardware.md
- [T7] Frame firmware: https://github.com/brilliantlabsAR/frame-codebase
- [T8] Brilliant SDK: https://github.com/brilliantlabsAR/brilliant_sdk
- [T9] Espressif WebRTC solution: https://github.com/espressif/esp-webrtc-solution
- [T10] esp_peer license: https://github.com/espressif/esp-webrtc-solution/blob/main/components/esp_peer/LICENSE

## 10. Bổ sung release/license — 2026-11-07

Phạm vi: chỉ đóng khoảng trống phát hành, không khảo sát lại media/perception. Đọc tài liệu sơ cấp và metadata; không tải/cài/chạy driver, cài dependency, sửa cấu hình/code hoặc commit. Đây là điều kiện cần kiểm chứng, không phải kết luận pháp lý cho sản phẩm.

### Windows: “signed” chưa đủ chứng minh dùng được ở production

- GitHub API trả latest release **25.7.14**, công bố **2025-07-14**, asset `Virtual.Audio.Driver.Signed.-.25.7.14.zip`; release chỉ nêu code signing qua SignPath.io, certificate từ SignPath Foundation. README hiện vẫn cảnh báo beta/test signing, nhưng phần cài đặt lại nói production-signed driver có thể bỏ bước đó. Hai thông tin có thể thuộc các build khác nhau; không đủ để kết luận bản release bắt buộc test mode, cũng không đủ để xác nhận production-ready. Chưa đọc asset. [R1]
- Microsoft nêu driver ảo chịu cùng yêu cầu như driver phần cứng; với driver kernel mới trên Windows 10 1607+, cần chữ ký Microsoft qua Hardware Dev Center, bằng đường certification hoặc attestation phù hợp. Chữ ký publisher/installer hay nhãn SignPath **không tự chứng minh** package có chữ ký kernel Microsoft đáp ứng máy đích. Không dùng ngoại lệ máy cũ hoặc hạ bảo vệ làm tiêu chuẩn phát hành. [R2]
- Bằng chứng cần ở đợt kiểm định được cho phép sau: xác định chính xác hash/version/architecture của INF–CAT–SYS; đối chiếu chuỗi ký, catalog và file tương ứng; có log xác minh theo kernel policy (Microsoft minh họa `SignTool verify /v /kp DriverFileName.sys` cho embedded signature), không chỉ kiểm tra chữ ký ZIP/installer. Với package ký qua catalog phải kiểm tra đường catalog tương ứng, không suy từ việc SYS thiếu embedded signature rằng package unsigned. [R2][R3]
- Chữ ký hợp lệ vẫn không chứng minh driver hoạt động, tương thích HVCI/Memory Integrity hoặc không bị policy/blocklist chặn. Gate runtime đề xuất: máy Windows được hỗ trợ, Secure Boot và Memory Integrity bật, test signing tắt; cài/gỡ, khởi động lại và thử đường audio thật. **Không thực hiện trong nghiên cứu này.** Windows x64/ARM64 phải có bằng chứng riêng; README liệt kê kiến trúc không thay thế test. [R1; đề xuất kiểm định]
- Kết luận lựa chọn: Virtual Audio Driver là **ứng viên miễn phí có điều kiện**, chưa duyệt làm dependency mặc định. README ghi code gốc MIT và Microsoft sample MS-PL; phải giữ notice tương ứng, không chỉ nhìn badge MIT. Chưa đối chiếu notice của release binary. Mặc định giữ playback trực tiếp ở client; loopback vào app khác là tính năng tùy chọn. [R1; đề xuất]

### macOS/Linux và ranh giới “miễn phí”

- **BlackHole:** LICENSE hiện ghi source GPLv3, nhưng official compiled binaries/installers “All rights reserved”; tên/logo/branding có hạn chế và yêu cầu prior written permission cho các trường hợp được nêu. Không lấy GPL source làm giấy phép blanket để bundle installer chính thức. Tự build cũng phải kiểm tra GPL, branding và đường phân phối/signing riêng; quyền bundle cụ thể chưa được xác nhận. [R4]
- **VB-CABLE:** không mặc định phải trả phí cho mọi bundle: trang chính thức cho phân phối standard package **AS IS**, kể cả trong commercial app, nếu donationware vẫn áp dụng và người dùng nhận biết nguồn/có cơ hội đóng góp. Tuy nhiên professional use có yêu cầu trả license; ở môi trường professional được mô tả, distributor phải mua số license phù hợp. A+B/C+D không được bundle/phân phối cùng sản phẩm khác. Vì thế không chọn làm công cụ hỗ trợ miễn phí mặc định; không suy “donationware” là quyền phân phối vô điều kiện. [R5]
- **Linux:** PipeWire loopback có thể tạo virtual sink/source khi host có PipeWire và module/session hoạt động. Tài liệu tính năng không chứng minh mọi distro, máy headless, container hay ALSA-only đều có sẵn. Nếu host đang dùng PulseAudio, `module-null-sink` có monitor source để định tuyến output→input; chỉ là fallback khi server/module và ứng dụng đích hỗ trợ chọn source đó. Nếu thiếu cả hai, giữ direct playback/text, không bắt người dùng đổi audio stack chỉ để chạy chức năng lõi. Chưa kiểm tra distro/app cụ thể. [R6][R7; đề xuất]

### Stockfish, FFmpeg và quyền của chính dự án

- **Stockfish GPLv3:** README cho phép phân phối, kể cả bán kèm gói lớn hơn, nhưng phải kèm license và full source hoặc đường dẫn tới source tạo ra **đúng binary phân phối**; thay đổi cũng phải cung cấp theo GPLv3. Kế hoạch đóng gói: pin phiên bản/build, lưu source/build inputs cần thiết (kể cả NNUE phù hợp) và notice cùng release; không trỏ chung vào nhánh mới nhất. Đây không phải kết luận rằng mọi GUI giao tiếp UCI/process đều phải GPL. [R8]
- **FFmpeg phụ thuộc build:** upstream mặc định LGPL-2.1-or-later; `--enable-gpl` đổi sang GPL, `--enable-version3` thay phiên bản áp dụng, và `--enable-nonfree` có thể tạo binary upstream gọi là **unredistributable**. Cần kiểm tra build flags, thư viện liên kết, source và notice của từng artifact/OS, không gán chung một license theo tên FFmpeg. Trang legal không tải được; đã dùng `FFmpeg/FFmpeg/LICENSE.md` chính chủ thay thế. [R9]
- **Đúng dependency của repo:** `D:/Code/ChessOnGlass/package.json:26` dùng `ffmpeg-static ^5.3.0`; lockfile dòng 2041–2054 chốt **5.3.0**. Metadata npm đúng phiên bản ghi **GPL-3.0-or-later**, install script `node install.js`, binary tag mặc định **b6.1.1**. Repo chính chủ lấy binary từ nhiều nhà build theo OS và chỉ trích license “when possible”. Không gọi wrapper này là MIT hoặc coi lockfile đã khóa/kiểm chứng mọi binary tải riêng. Các biến môi trường còn có thể đổi nguồn/tag/path. Chưa tải tarball hoặc kiểm tra binary thực tế của dự án. [R10; file local]
- Tách review **JS package được import** khỏi **FFmpeg executable chạy process**: không kết luận blanket “GPL lây sang mọi app gọi process”, nhưng process boundary cũng không tự miễn nghĩa vụ phân phối binary hoặc giải quyết license của wrapper. Phạm vi combined/derived work cần đánh giá theo cách đóng gói thực tế. [R8–R10; giới hạn kết luận]
- Không tìm thấy `LICENSE*`, `LICENCE*`, `COPYING*` trong workspace bằng glob và danh sách tracked; `D:/Code/ChessOnGlass/package.json` có `private: true`, không có trường `license`. Đây là thiếu bằng chứng cấp quyền, không tự chứng minh ai nắm toàn bộ quyền hay cấm mọi sử dụng. Người có thẩm quyền phải xác nhận tác giả/đóng góp và chọn điều khoản trước phân phối; **không tự tạo LICENSE hoặc đổi license thay chủ quyền**. [Kiểm tra local]

### Ba release gates — theo thứ tự, không phát sinh dependency trả phí mặc định

1. **Quyền phát hành:** chủ quyền xác nhận license ChessOnGlass; lập danh mục dependency/artifact và notice/source tương ứng. Tách quyền source, binary, branding; chặn bundle BlackHole/VB-CABLE khi chưa đáp ứng điều kiện cụ thể. Không tự “sửa” khoảng trống quyền.
2. **Artifact có thể kiểm toán:** pin hash/version/OS/CPU, source/build inputs và flags của Stockfish/FFmpeg; rà cả `ffmpeg-static` JS lẫn executable. Chuẩn bị license/notice và cách cung cấp corresponding source đúng bản; không phát hành artifact nonfree/unredistributable hoặc không rõ provenance.
3. **Cài đặt an toàn, fallback rõ:** bản lõi dùng công cụ hỗ trợ miễn phí và không cần virtual audio driver; premium AI vẫn là chi phí riêng được chấp nhận. Windows loopback chỉ mở sau bằng chứng chữ ký kernel/package và test với bảo vệ bật; Linux chỉ bật route phù hợp stack có sẵn; macOS không tự bundle installer chưa rõ quyền. Chưa đạt thì tắt adapter, vẫn cho direct playback/text. Không hứa “mọi camera/kính” chỉ vì gate OS đã đạt.

### Nguồn release/license

- [R1] https://github.com/VirtualDrivers/Virtual-Audio-Driver/releases/tag/25.7.14 ; https://github.com/VirtualDrivers/Virtual-Audio-Driver/blob/main/README.md ; https://github.com/VirtualDrivers/Virtual-Audio-Driver/blob/main/LICENSE
- [R2] Microsoft signing requirements: https://learn.microsoft.com/en-us/windows-hardware/drivers/install/kernel-mode-code-signing-requirements--windows-vista-and-later-
- [R3] Microsoft release-signature verification: https://learn.microsoft.com/en-us/windows-hardware/drivers/install/verifying-the-signature-of-a-release-signed-driver-file
- [R4] https://github.com/ExistentialAudio/BlackHole/blob/master/LICENSE (đọc qua GitHub contents API ở default branch)
- [R5] https://vb-audio.com/Services/licensing.htm (đối chiếu toàn văn, không dùng bản trích rút gọn để suy điều kiện bundle)
- [R6] https://docs.pipewire.org/page_module_loopback.html
- [R7] https://www.freedesktop.org/wiki/Software/PulseAudio/Documentation/User/Modules/
- [R8] https://github.com/official-stockfish/Stockfish/blob/master/README.md ; https://stockfishchess.org/about/
- [R9] https://github.com/FFmpeg/FFmpeg/blob/master/LICENSE.md
- [R10] https://registry.npmjs.org/ffmpeg-static/5.3.0 ; https://github.com/eugeneware/ffmpeg-static/blob/master/package.json ; https://github.com/eugeneware/ffmpeg-static/blob/master/README.md

## 11. Onboarding, deployment và giới hạn trình duyệt — 2026-11-07

- `getUserMedia` yêu cầu secure context và quyền người dùng. HTTP localhost là ngoại lệ vì cùng thiết bị, không áp dụng cho HTTP địa chỉ LAN của desktop được mở từ điện thoại; localhost trên điện thoại là điện thoại. Chứng chỉ tự ký chưa được điện thoại tin cậy không phải onboarding hoàn chỉnh. [U1]
- PWA phù hợp làm camera điện thoại foreground; cài lên màn hình chính không xóa hạn chế autoplay, background hoặc khóa màn hình. Phải thử thiết bị/browser cụ thể, không hứa hoạt động nền liên tục. [U2][U3]
- QR ghép đôi không tự giải quyết TLS. QR có thể chứa bí mật một lần, hết hạn ngắn, desktop xác nhận và cấp token thu hồi được; transport vẫn cần trust phù hợp. Không hướng dẫn bỏ cảnh báo HTTPS, cài CA im lặng hoặc tắt firewall. [Đề xuất]
- PWA không làm kính Meta/Frame tự trở thành webcam. SDK native/adapter BLE vẫn là đường riêng; Web Bluetooth có giới hạn tương thích và không thay thế toàn bộ SDK. [S4–S9; T6–T8; U5]
- Docker Desktop miễn phí cho các nhóm theo điều khoản, bao gồm doanh nghiệp nhỏ đồng thời dưới 250 nhân viên và doanh thu dưới 10 triệu USD/năm; doanh nghiệp lớn/cơ quan chính phủ có yêu cầu thuê bao. Vì vậy không dùng Docker Desktop làm điều kiện bắt buộc của sản phẩm hướng người dùng rộng. Backend native hoặc Docker Engine Linux là lựa chọn khác; điện/máy chủ/băng thông vẫn có chi phí. [U4]
- LAN không yêu cầu relay cloud. Remote access qua NAT/CGNAT là phạm vi riêng; nếu dùng WebRTC có thể cần TURN. Phần mềm TURN nguồn mở không làm hosting/băng thông tự miễn phí. [U6]
- TTS trình duyệt có thể là local hoặc remote; `SpeechSynthesisVoice.localService` phân biệt nguồn dịch vụ. Wizard phải liệt kê giọng sẵn có và phát thử; không cam kết mọi OS có cùng giọng, tiếng Việt hoặc offline chỉ vì API tồn tại. Không tự chuyển sang một dịch vụ TTS tính phí. [U7; đề xuất]

### Hành trình thử đầu tiên được khuyến nghị

1. Backend chạy native trên máy tham chiếu, mở dashboard localhost, cấu hình một provider AI và mức chi tiêu.
2. Chọn webcam của chính máy đó hoặc video replay. Camera được cấp quyền có chủ đích; thử preview, orientation và một câu TTS trước khi bắt đầu ván.
3. Chọn bên chơi và vị trí đầu ván; nếu bắt đầu giữa ván, nhập/kiểm tra thế cờ và thông tin lịch sử còn thiếu. AI không tự đoán quyền nhập thành/en passant.
4. Chơi luyện tập có đồng thuận; cho pause, lặp lời, sửa nước và lưu PGN. Hiển thị mất hình/mất dấu/phản hồi AI chậm thay vì âm thầm tiếp tục.
5. Sau khi đường local đạt gate, mới thêm nguồn mạng khác loại. Với phone PWA phải chốt và thử HTTPS/trust; nếu onboarding quá nặng, đánh giá companion native thay vì hạ bảo mật. Kính hãng và kính IoT là adapter sau, không buộc vào v1 local.

### Trạng thái lỗi phải có hướng phục hồi

| Lỗi | Phản hồi cần có |
| --- | --- |
| Camera không được cấp quyền/đang bị app khác giữ | Nêu đúng quyền hoặc xung đột; cho thử lại và đổi nguồn |
| Desktop/phone không kết nối | Kiểm tra cùng mạng, guest isolation và rule firewall cụ thể; không yêu cầu tắt firewall toàn bộ |
| Không nghe TTS | Nút phát thử lại, chọn output/voice; không coi callback thành công là bằng chứng người dùng đã nghe |
| Khóa màn hình/tab nền/stream đóng băng | Đánh dấu hình cũ, dừng suy luận/overlay dựa trên hình đó, cho khôi phục capture |
| Token/QR hết hạn hoặc thu hồi | Ghép lại có xác nhận; không tự hạ xuống truy cập vô danh |
| Cloud lỗi/chậm, hết ngân sách | Dừng/giới hạn retry; giữ ván và khả năng sửa thủ công, không phát kết quả quá hạn |
| Bàn thay đổi hoặc tracker mất dấu | Hỏi xác nhận/tái đồng bộ có bằng chứng; không ghi tiếp PGN sai mà không cảnh báo |

### Nguồn onboarding

- [U1] https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia
- [U2] https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay
- [U3] https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API
- [U4] https://docs.docker.com/subscription/desktop-license/
- [U5] https://developer.mozilla.org/en-US/docs/Web/API/Web_Bluetooth_API
- [U6] https://webrtc.org/getting-started/turn-server
- [U7] https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesisVoice/localService

## 12. Khoảng trống code và lộ trình đề xuất để dùng thật

**Trạng thái: đề xuất nghiên cứu, chưa được duyệt làm thiết kế/implementation plan.** Không sửa code sản phẩm, không cài dependencies, không chạy test/AI trả phí trong đợt nghiên cứu này. Không gán ước lượng thời gian hay hiệu năng chưa đo.

### A. Hiện trạng đã đối chiếu source

| Phần | Có gì và còn thiếu gì | Bằng chứng local |
| --- | --- | --- |
| Lõi cờ | Có Source, Reader, Advisor, Voice; không cần viết lại toàn bộ. Chưa có nhận hình mạng/session/capability negotiation | `src/capture.ts:19–26`, `src/main.ts:31–49`, `src/watch.ts:17–27` |
| Portability | Capture/call, voice, keychain, data path, download engine và mở browser còn macOS; build dùng POSIX shell commands | `src/cli.ts:162–178,233`, `src/keychain.ts:15–21`, `src/config.ts:24–27`, `src/speak.ts:81–86`, `src/engine.ts:15–20`, `package.json:15` |
| Điều khiển và thời gian | Controls áp giữa các frame, chờ vision xong; pause có thể chậm. Đây chưa phải race do parallel xử lý state | `src/main.ts:110–136,151–179,332–361` |
| Dữ liệu mới/cũ | Frame chỉ có JPEG và t; chưa có ID/session để chứng minh hai quan sát khác nhau; overlay reuse corners giữa các lần locate | `src/capture.ts:19–26`, `src/feed.ts:113–127` |
| Chi phí | Có bảng giá và max-cost, nhưng charge sau call; overlay cũng chi tiền. Không phải trần hóa đơn tuyệt đối | `src/pricing.ts:6–28`, `src/main.ts:260–279`, `src/feed.ts:121–123` |
| Bảo mật mạng | Server thiết kế loopback, kiểm tra JSON/origin chứ chưa xác thực thiết bị từ LAN | `src/web.ts:21,64–96` |
| Quyền riêng tư | Có tự lưu frame ở các trạng thái seen/committed/lost và PGN; chưa có chính sách retention/xóa dành cho người dùng rộng | `src/main.ts:299–310` |
| Test | Có HTTP server thật, FFmpeg synthetic clip và test Stockfish thật có điều kiện; không được gọi tất cả là unit mock | `tests/web.test.ts:13–36`, `tests/capture.test.ts:31–53`, `tests/engine.test.ts:20–44` |
| Live coverage | Game/vision/speech dùng fake trong test; engine suite skip nếu không có engine; eval recovery dùng PGN thật | `tests/main.test.ts:11–62`, `tests/engine.test.ts:20`, `evals/score.ts:131–144` |
| Release assets | Tracked fixtures chỉ có PGN; chưa tìm thấy CI/Docker/compose/LICENSE trong các vị trí đã kiểm tra; chưa có evidence cài sạch đa OS | `git ls-files tests fixtures .github Dockerfile docker-compose.yml compose.yml LICENSE LICENSE.md LICENSE.txt` |

### B. Ba hướng và khuyến nghị

1. **Khuyến nghị: local-first, device-independent.** Giữ lõi TypeScript, cung cấp local webcam/replay trước, sau đó network JPEG + output adapters. Ít thêm dịch vụ, kiểm thử được tại máy hiện có; đánh đổi là nguồn phone/kính đến theo giai đoạn.
2. **PWA phone-first.** Dễ thử giao diện không cần app store nhưng onboarding TLS/trust và foreground là giới hạn thực tế, không nên che giấu.
3. **Native companion-first.** Kiểm soát camera/audio và SDK thiết bị tốt hơn, nhưng phải chọn Android/iOS, duy trì app và kiểm thử/phân phối riêng; chưa phù hợp khi phần cứng đầu tiên chưa chọn.

Windows x64 là **đề xuất máy tham chiếu đầu tiên** vì workspace hiện ở Windows, không phải lựa chọn đã được người dùng chốt. Lõi phải giữ khả năng chạy macOS/Linux; chỉ công bố hỗ trợ sau khi test tương ứng. Không coi container chạy được là bằng chứng audio/camera native của host hoạt động.

### C. Các giai đoạn và cổng hoàn thành

| Giai đoạn | Đầu ra cần làm khi đã duyệt | Chỉ hoàn thành khi |
| --- | --- | --- |
| 0. Baseline tái lập | Kiểm tra dependency/engine thật, build/test hiện trạng, bộ video có quyền dùng và PGN chấm riêng; ghi version/hardware/model | Tái chạy được; engine thật không bị skip; phân biệt test mock, integration, replay và live; có báo cáo baseline chứ không dựa vào ba nước mẫu |
| 1. Bản local dùng được | Tách OS services, nguồn webcam/replay, chọn output TTS/text, dashboard/doctor theo capability thay vì mặc định WhatsApp | Chạy trên máy tham chiếu sạch không cần WhatsApp/BlackHole/Jev; camera, engine, AI và tiếng thử hoạt động; dữ liệu/khóa lưu đúng môi trường |
| 2. Tracking và điều khiển đáng tin | Frame/session identity, freshness, cancellation, kiểm soát kết quả muộn, xử lý mơ hồ/promotion, geometry tracker, ngân sách chung | Bộ test ảnh trùng/out-of-order/reset/pause/network freeze không làm ghi sai hoặc phát kết quả cũ; mất bàn thì ẩn overlay; không đọc PGN đáp án để recovery |
| 3. Nguồn mạng và thiết bị thứ hai | JPEG ingress có auth/pairing, capability camera/audio/display độc lập, output có cấu trúc; chốt trust strategy | Hai nguồn khác loại dùng cùng lõi; chưa ghép/đã thu hồi bị từ chối; reconnect không lẫn phiên; payload/fps/queue có giới hạn; khóa AI không tới IoT |
| 4. Pilot ngoài môi trường dev | Wizard, log chẩn đoán không lộ khóa, lưu/xóa dữ liệu, resume ván có xác nhận, hướng dẫn và ma trận hỗ trợ | Người thử tự setup được; lỗi có cách khôi phục; cài/gỡ/nâng cấp giữ dữ liệu; test máy sạch từng OS được quảng bá; đã qua release/license gates |
| 5. Mở rộng có nhu cầu | Adapter Meta/Frame/IoT cụ thể; RTSP hoặc WebRTC khi cần; loopback từng OS; coach/replay nâng cao | Mỗi adapter có hardware/firmware và đường audio/display đã thử; không dùng simulator để gắn nhãn hỗ trợ kính thật |

Các giai đoạn có thể chia nhỏ để xác minh, không xem đây là danh sách phải triển khai tất cả một lần. Quyền dùng source/dữ liệu phải làm rõ từ giai đoạn 0 trước thu thập/phân phối; gates license bắt buộc trước phát hành cho người khác. Không thêm dịch vụ paid mặc định.

### D. Ma trận nghiệm thu tối thiểu đề xuất

- **Chức năng:** webcam, replay; bắt đầu ván/midgame; trắng/đen; nhập thành, en passant, mọi promotion; pause/reset/undo và đổi nguồn.
- **Hình ảnh:** đầu chuyển động, tay che, bàn ra ngoài khung, blur, ánh sáng đổi, video lặp, nhiều nước giữa hai lần quan sát. Sai/không chắc phải được phân biệt, không quy mọi bỏ sót thành thành công.
- **Mạng/model:** mất kết nối, timeout, rate limit, từ chối request, model key sai, output hỏng, giới hạn chi phí và kết quả đến muộn.
- **Vận hành:** camera permission, output audio, engine restart, hết dung lượng/quyền ghi, lưu/xóa/resume, ghép cặp và thu hồi, clean install/update/uninstall.
- **Platform:** tách backend tests Windows/macOS/Linux khỏi camera/audio/browser/hardware E2E. Mỗi cặp OS–client được công bố phải có evidence riêng.
- **Metric:** false commit, missed/duplicate move, số nước đúng liên tục, số lần cần sửa tay, recovery duration, p50/p95 move-to-result, frame/overlay age, chi phí mỗi ván, peak RAM và thời gian setup. Với kính đo thêm nhiệt/pin/đứt kết nối.
- **Cổng an toàn có thể chốt ngay:** không áp kết quả sai session; không chấp nhận token bị thu hồi; không dùng ảnh trùng làm hai lần xác nhận; không tiếp tục phát gợi ý khi state không tin cậy; không mặc định tắt OS protections hay mở public ingress.
- **Ngưỡng chất lượng cần chốt trước pilot:** số ván/loại board đại diện, giới hạn latency/chi phí và tỷ lệ tự nhận nước. Chọn sau baseline nhưng trước đánh giá holdout; không đặt ngưỡng sau khi nhìn kết quả để hợp thức hóa bản build.

### E. Phạm vi nên hoãn và quyết định cần người dùng

Hoãn native AR world-lock trong kính, hỗ trợ mọi app gọi điện, mọi hãng kính cùng lúc, remote relay cloud mặc định, voice hội thoại liên tục và tự huấn luyện model mới. Overlay video hiện tại và text HUD là hai deliverable khác world-locked AR.

Cần chốt trước thiết kế chi tiết: đồng ý Windows local + webcam/replay làm bản đầu hay phải có kính cụ thể ngay; đầu ra overlay trên video hay trong mắt kính; client phone có chấp nhận native app; cách phân phối/quyền license dự án. Nghiên cứu không tự quyết thay người dùng.

**Bước kế tiếp:** người dùng chọn hướng/phạm vi đầu tiên → viết thiết kế ngắn có lựa chọn và trade-off → duyệt → mới lập implementation plan theo file/test và bắt đầu code. Không có commit hoặc thay đổi hệ thống nào được thực hiện trong đợt này.

## 13. Định danh PJChess và giới hạn bằng chứng — 2026-11-07

- **PJChess là chính repo này, không phải một codebase tham chiếu riêng.** Trang dự án [reverse.dev/pjchess](https://www.reverse.dev/pjchess) mô tả `chesshacker` v0.2.0, 23 file trong `src`, cùng pipeline: WhatsApp call → frame → Jev → vision model → chess.js → Stockfish → `say`/BlackHole. Vì vậy không có artifact đóng gói riêng để reverse-engineer; muốn dùng REA phải có bản build/package hoặc app phía điện thoại/kính. [PJ1]
- **Trang dự án tự nêu giới hạn:** "Tested end to end on glasses recordings. Not yet tried on a live WhatsApp call." Đây là tuyên bố của chủ dự án, không phải kết quả đo độc lập. Nó khớp với `DESIGN.md` (kết quả từ recording, 3 nước mẫu) và có nghĩa phần "live call" vẫn là giả thuyết cần kiểm chứng. [PJ1]
- **Stack trên trang dự án:** WhatsApp, Meta glasses, OpenAI (`gpt-6.1-sol`), Jev (tuỳ chọn), Stockfish `sf_19`, BlackHole 2ch, macOS, Node 22+, TypeScript, chess.js, `ffmpeg-static`. Đây là cùng stack trong `package.json` và `src/`. [PJ1]
- **Hệ quả cho phạm vi:** "phát triển ChessOnGlass dựa trên PJChess" = mở rộng chính repo này (hoặc fork), không phải port từ một PJChess khác. Các tuyên bố "đã chạy end-to-end" phải đọc là "đã chạy trên recording", trừ khi có bằng chứng live call mới.
- **Nguồn phụ không dùng làm bằng chứng:** các video YouTube/TikTok và bài báo lan truyền chỉ xác nhận sự tồn tại/độ phổ biến; không dùng để kết luận chất lượng, độ trễ hay an toàn. [PJ1]

## 14. Baseline chạy thử trên workspace Windows — 2026-11-07

Môi trường: Windows 11, Node 26.3.0, commit `b919506`, không có `node_modules` ban đầu. Đây là kiểm tra source/build/test, **không** phải live call, không gọi API trả phí, không chạy Stockfish.

| Kiểm tra | Kết quả | Ghi chú |
|---|---|---|
| `npm ci` | thành công | `prepare` chạy `npm run build` (tsc + copy static + chmod) thành công |
| `npm run typecheck` | pass | `tsc -p tsconfig.json --noEmit` |
| `npm test` | **133 test: 129 pass, 2 fail, 2 skip** | 15/16 file test pass |
| `npm run eval -- --simulate --noise 0 --unknown 0` | **33/33 nước đúng**, 0 sai, 0 bỏ sót | Chỉ kiểm tra matcher, không phải video thật |
| `npm audit --omit=dev` | **0 lỗ hổng đã biết** trong 37 dependency production | Không bao phủ binary tải riêng của `ffmpeg-static` |
| `npm audit` (cả dev) | 1 moderate: `vite@6.4.4`, GHSA-8g5g-mxqh-grgj | Dev-only; bản build phát hành không chạy Vite server |
| Kiểm tra giá model lạ | `cost("claude-unknown-9", 1e6, 1e6) === 0` | Model không có trong `PRICES` bị tính $0; đường fallback chưa được kích hoạt thật |

- **Hai test fail** là `tests/doctor.test.ts` vì `plutil` không có trên Windows (`spawn plutil ENOENT`); đây là phụ thuộc macOS, không phải lỗi logic cờ. **Hai test skip** là nhóm Stockfish vì máy không có engine.
- Sau khi chạy thủ công `node node_modules/ffmpeg-static/install.js` để lấy binary, `tests/capture.test.ts` + `tests/score.test.ts` đạt **10/10**. Lỗi ffmpeg ban đầu là do npm chặn install script (`hasInstallScript`), không phải code.
- **Kết luận baseline:** lõi cờ (match/tracker/game/vision parsing) là code thật, có test và chạy được trên Windows; phần live call, macOS capture, Keychain, `say`/BlackHole và WhatsApp chưa được kiểm chứng trong lượt này. Trang dự án cũng tự nêu "chưa thử live WhatsApp call". Vì vậy không thể gọi là "đã dùng được thực tế" hay "đã an toàn".
- **Độ phủ eval:** `--simulate` dùng reading sạch; `evals/score.ts` khi resync dùng PGN đáp án, nên không đo khả năng tự phục hồi trong ván thật. Các kết quả 3 nước trong `DESIGN.md` vẫn là mẫu nhỏ, không phải benchmark toàn ván.

## 15. Kiến trúc refactor: seam đa nền tảng cho ChessOnGlass

Ngày: **2026-11-07**. Phạm vi: nguồn sơ cấp cho các seam (chụp màn hình theo OS, TTS, keyring, định tuyến audio, nhận media, định danh phiên/frame) và bản đồ can thiệp theo file. Chỉ đọc source/tài liệu chính chủ; không cài, không build, không gọi API trả phí, không sửa RESEARCH.md. Không khảo sát lại transport/DAT/kính/giấy phép đã có trong RESEARCH.md §8–§14.
**Đề xuất nghiên cứu, chưa được duyệt; không phải thiết kế.**

Thang bằng chứng như RESEARCH.md: **Đã xác minh** (đọc trực tiếp source/tài liệu), **Chỉ mục** (chỉ trích tìm kiếm), **Suy luận/Đề xuất**. Nguồn đọc ngày 2026-11-07; link `main`/`master` là nguồn động. Nguồn cục bộ: các file trong `src/` đọc tại workspace này.

### 1. Phát hiện theo seam

#### 1.1 Chụp màn hình theo OS (Windows trước)

- **screenshot-desktop** (npm 1.15.8; metadata MIT, nhưng root repo không thấy file LICENSE — kiểm 2026-11-07): `index.ts` chọn backend theo `process.platform`; `lib/darwin/index.ts` gọi `screencapture`; `lib/win32/index.ts` trích `screenCapture_1.3.3.bat` + `app.manifest` ra thư mục riêng, file .bat tự tìm `csc.exe` (.NET Framework) để **biên dịch C# ngay lúc chạy** rồi chụp bằng GDI (cửa sổ foreground/desktop). Trên Windows nó **không tương đương `screencapture -l`** (chụp cửa sổ chỉ định kể cả khi bị che) mà repo đang dựa vào. [Đã xác minh; https://github.com/bencevans/screenshot-desktop]
- **node-screenshots** (0.2.8; **license không thống nhất: npm metadata ghi Apache-2.0, GitHub repo hiện detect MIT — phải đọc LICENSE thực tế trước khi dùng**): binding napi của XCap; prebuild `win32-x64/ia32/arm64-msvc`, `darwin-x64/arm64`, `linux-x64-gnu/musl`, arm64, loong64; API `Monitor.all()`/`Window.all()`, `captureImage()`, `toJpeg()`. README chỉ liệt kê Node 16/18/20. [Đã xác minh; https://github.com/nashaofu/node-screenshots]
- **XCap** (Apache-2.0, 0.9.8, Rust): Windows ≥ 8.1 chụp màn hình/cửa sổ ✓; Linux Wayland ⛔ "not fully supported"; Cargo feature `wgc` map tới `windows/Graphics_Capture` + `WinRT_Graphics_Capture`. [Đã xác minh; https://github.com/nashaofu/xcap]
- **windows-capture** (MIT, 2.0.1, Rust): Windows Graphics Capture API + DXGI Desktop Duplication; "updates frames only when required". Là crate Rust, không phải binding Node. [Đã xác minh; https://github.com/NiiightmareXD/windows-capture]
- **Microsoft Windows.Graphics.Capture**: lấy frame từ màn hình/cửa sổ; có UI chọn do hệ thống hiển thị + viền vàng quanh đối tượng đang bị chụp; chỉ desktop/MR headset. [Đã xác minh; https://learn.microsoft.com/en-us/windows/uwp/audio-video-camera/screen-capture]
- **OBS Studio** là bằng chứng cấu trúc "một interface source, nhiều backend theo OS": `win-capture` (BitBlt + "WindowsGraphicsCapture" trong `window-capture.c`; DXGI Desktop Duplication trong `duplicator-monitor-capture.c`), `mac-capture` (ScreenCaptureKit `SCStream`, `API_AVAILABLE(macos(12.5))`, trong `mac-sck-video-capture.m`; CGDisplayStream fallback), `linux-capture` (xshm) + `linux-pipewire` (portal). [Đã xác minh; https://github.com/obsproject/obs-studio]
- **python-mss** (thuần ctypes, không dependency): backend theo OS — `mss/darwin.py` (CoreGraphics), `mss/windows/gdi.py`, `mss/linux/{xlib,xcb,xgetimage,xshmgetimage}.py`. Tham khảo cách đóng gói seam mỏng. [Đã xác minh; https://github.com/BoboTiG/python-mss]
- **Đề xuất:** giữ seam `capture(windowId) → JPEG`; Windows-first chọn node-screenshots (đường napi sẵn cho Node) hoặc binding WGC riêng; không dựng lại helper csc.exe. [Suy luận/Đề xuất]

#### 1.2 TTS

- **Windows:** lớp `System.Speech.Synthesis.SpeechSynthesizer` (assembly `System.Speech`, tài liệu .NET) — đường không cần cài thêm. [Đã xác minh lớp/assembly; https://learn.microsoft.com/en-us/dotnet/api/system.speech.synthesis.speechsynthesizer — việc có giọng tiếng Việt trên mọi bản Windows là Suy luận cần thử]
- **macOS:** `say` (đang dùng, `src/speak.ts:81–86`); `AVSpeechSynthesizer` (AVFAudio, macOS 10.14+) nếu cần in-process. [Đã xác minh; https://developer.apple.com/documentation/avfaudio/avspeechsynthesizer]
- **Linux:** `espeak-ng` (GPL-3.0; CLI + shared library + DLL + bản SAPI5 cho Windows; >100 ngôn ngữ) và `speech-dispatcher` (GPL-2.0; lớp "device independent" qua giao thức SSIP; hỗ trợ ESpeak-NG, Piper, Edge TTS, Festival…). [Đã xác minh; https://github.com/espeak-ng/espeak-ng, https://github.com/brailcom/speechd]
- **Piper** (`piper-tts` 1.8.0, GPL-3.0-or-later): neural TTS chạy local, nhúng espeak-ng; wheels `win_amd64`, macOS x86_64/arm64, manylinux x86_64/aarch64; có CLI/HTTP/Python/C API. [Đã xác minh; https://github.com/OHF-Voice/piper1-gpl, https://pypi.org/pypi/piper-tts]
- **edge-tts** (7.3.1; repo license NOASSERTION): dùng dịch vụ TTS online của Edge qua websocket, **không phải API chính thức**, cần mạng; không nên làm default. [Đã xác minh; https://github.com/rany2/edge-tts]
- **Prior art tách dịch vụ:** Wyoming (MIT) — protocol TCP JSONL+PCM giữa các service voice, **không auth/không mã hóa theo thiết kế** (chỉ mạng tin cậy); Home Assistant dùng cho Piper. OVOS plugin manager: discovery TTS/STT bằng entry point. [Đã xác minh; https://github.com/rhasspy/wyoming, https://github.com/OpenVoiceOS/ovos-plugin-manager]
- **Đề xuất:** tách `TtsEngine { speak(text) → ok/fail }` khỏi `Route { target/device }`; adapter Windows (SAPI) trước, piper sau; Wyoming chỉ nên học cách tách service, không bê nguyên vì thiếu auth. [Suy luận/Đề xuất]

#### 1.3 Keyring

- **keytar**: repo `archived=true` (2022-12-12); README nêu macOS Keychain / Linux `libsecret` (Secret Service) / Windows Credential Vault → không dùng cho code mới. [Đã xác minh; https://github.com/atom/node-keytar + GitHub API]
- **@napi-rs/keyring** (2.1.2, MIT): binding napi của keyring-rs; `new Entry(service, account).setPassword()/getPassword()/deletePassword()`; Linux tự chọn Secret Service, **fallback keyutils trong kernel — chỉ trong RAM, mất khi reboot** (README cảnh báo); có thể pin store. [Đã xác minh; https://github.com/Brooooooklyn/keyring-node]
- **keyring-rs** (đang bảo trì): native store trên Mac/Windows/*nix; tách `keyring-core` + store crate riêng. [Đã xác minh; https://github.com/open-source-cooperative/keyring-rs]
- **Đề xuất:** interface `Secrets` giữ ngữ nghĩa hiện có (`readSecret`/`saveSecret` + đọc lại để kiểm tra, `src/keychain.ts:31–39`), implement bằng @napi-rs/keyring; khi không có store phải quyết định fallback rõ ràng, không âm thầm lưu file. [Suy luận/Đề xuất]

#### 1.4 Định tuyến audio ảo (bơm tiếng vào cuộc gọi)

- Driver và giấy phép Windows/macOS/Linux đã khảo sát ở RESEARCH.md §10 (Virtual Audio Driver, BlackHole, VB-Cable, PipeWire/PulseAudio) — không lặp lại.
- Bổ sung: Microsoft có **Application loopback** (`ActivateAudioInterfaceAsync`) giới hạn *thu* audio theo một process; system loopback *thu* toàn bộ audio của endpoint. Đây là API phía capture, không phải cơ chế bơm audio như một microphone ảo. [Đã xác minh; https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/]
- **Đề xuất:** coi đây là capability tùy chọn `AudioRoute("virtual-mic")`; mặc định phát ra thiết bị thường/tai nghe hoặc chỉ text; chỉ mở khi driver thỏa gate ký & license §10. [Suy luận/Đề xuất]

#### 1.5 Nhận media (transport)

- Transport đã khảo sát ở §9 (JPEG/MJPEG/WebSocket/RTSP/WebRTC) — không lặp lại.
- Hệ quả thiết kế mới: một interface source cần hai dạng — pull (webcam/replay: `grab()`) và push (ingress mạng: frame đến bất đồng bộ) — chuẩn hóa về "hộp thư frame mới nhất thắng" (bỏ frame cũ khi nghẽn). Prior art: OBS async source — `OBS_SOURCE_ASYNC`, đẩy frame bằng `obs_source_output_video`, mỗi frame có timestamp. [Đã xác minh; `libobs/obs-source.h` + `libobs/obs.h` trong repo OBS]
- `Source` hiện tại (`src/capture.ts:19–27`) đúng hướng pull nhưng thiếu khai báo capability (camera? audio? display?) — cần thêm vì yêu cầu (b). [Suy luận từ code local]

#### 1.6 Định danh phiên/frame & độ mới

- **RFC 3550 (RTP)**: mỗi packet có `sequence number` + `timestamp` + `SSRC`; sequence numbering/timestamping là dịch vụ chuẩn của protocol thời gian thực, cho phép bên nhận dựng lại thứ tự dù không bảo đảm giao hàng/không chống out-of-order. Từ vựng tham chiếu, không bê nguyên. [Đã xác minh; https://www.rfc-editor.org/rfc/rfc3550]
- **OBS**: `struct obs_source_frame` có trường `uint64_t timestamp`. [Đã xác minh; `libobs/obs.h`]
- **Local:** `Frame` chỉ có `{jpeg, t}` với t = giây từ lúc source bắt đầu (`src/capture.ts:19–22`); event dùng `frame_t` (`src/main.ts:285`); `feed.ts:113–127` giữ `corners` cũ giữa các lần locate; `newGame()`/`setBoard()` không có token thế hệ để vô hiệu kết quả async đang bay. [Đã xác minh code local; §12 đã nêu cùng điểm]
- **Đề xuất:** `FrameMeta = { sessionId, seq, sourceId, capturedAtMonotonic, capturedAtWall }`; mỗi tác vụ async (vision, locate, engine) chụp `(sessionId, seq)` khi bắt đầu và chỉ commit khi vẫn khớp session + state version hiện tại; kết quả quá tuổi bị loại. `new_game`/đổi nguồn/undo tăng `sessionId`. [Suy luận/Đề xuất]

### 2. Bản đồ seam theo file hiện tại

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

### 3. Điểm chưa biết & bằng chứng cần để chốt

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

## 16. Quyền phái sinh, clean-room và lựa chọn phát hành nguồn mở

**Ngày: 2026-11-07.** Phạm vi: (1) khi nào bản refactor vẫn là tác phẩm phái sinh; (2) thực hành clean-room có tài liệu; (3) các lựa chọn cho repo ChessOnGlass (bản sao "chesshacker" v0.2.0, không có LICENSE); (4) điều khoản reverse.dev cho "Clone this project"; (5) checklist phát hành OSS quốc tế. Chỉ đọc tài liệu công khai; không đăng ký tài khoản, không cài đặt, không liên hệ tác giả, không sửa repo (ngoài file này).

> **Thông tin tham khảo, không phải tư vấn pháp lý; hãy hỏi luật sư trước khi phát hành thương mại.**

### Cách đọc bằng chứng

- **Đã xác minh**: đã đọc trực tiếp trang/tài liệu (hoặc toàn văn trích xuất của tài liệu chính thức).
- **Chỉ mục**: mới thấy đoạn trích tìm kiếm, chưa đọc toàn văn.
- **Suy luận**: đánh giá/áp dụng cho ca này, chưa được chứng minh độc lập.

### 1. Refactor và tác phẩm phái sinh

- **Đã xác minh** — US Copyright Office, Circular 14 "Copyright in Derivative Works and Compilations" (toàn văn PDF tại https://www.copyright.gov/circs/circ14.pdf):
  - "A derivative work is a work based on or derived from one or more already existing works"; ví dụ được nêu đích danh gồm "**a new version of an existing computer program**".
  - "**Only the owner of copyright** in a work has the right to prepare, or to authorize someone else to create, an adaptation of that work"; "The unauthorized adaptation of a work may constitute copyright infringement."
  - Bản phái sinh chỉ được bảo hộ cho "the additions, changes, or other new material appearing for the first time"; bảo hộ "does not extend to any preexisting material". Dùng phần gốc khi chưa được phép thì bảo hộ không phủ phần dùng trái phép đó.
- **Đã xác minh** — 17 U.S.C. §102(b) (nguyên văn được trích trong syllabus SCOTUS): không bảo hộ "any idea, procedure, process, system, method of operation, concept, principle, or discovery". Ý tưởng/chức năng không thuộc độc quyền; nhưng mã nguồn cụ thể thường là "expression" được bảo hộ. Nguồn luật: https://www.copyright.gov/title17/92chap1.html#102
- **Đã xác minh** — EFF Reverse Engineering FAQ (https://www.eff.org/issues/coders/reverse-engineering-faq):
  - Sao chép có thể gồm "imitation of non-functional elements as well as verbatim duplication" — viết lại khác cú pháp không tự động xóa rủi ro.
  - Atari v. Nintendo: chương trình mở khóa bị coi không phải "independent creation" vì "substantially similar ... in ways not required to replicate the function", dù viết cho chip khác và bằng ngôn ngữ khác.
- **Suy luận — "refactor" đổi gì, không đổi gì:**
  - **Đổi**: code bạn tự viết có thể được bạn giữ quyền (chỉ phần mới); cấu trúc, đặt tên, nền tảng kỹ thuật có thể khác đi.
  - **Không đổi**: nghĩa vụ xin phép chủ sở hữu cho phần biểu đạt gốc còn lưu lại; tính phái sinh nếu bản mới còn "mang" phần sáng tạo gốc. Repo không có LICENSE **không** nghĩa là dùng tự do — GitHub ghi rõ: không license thì luật bản quyền mặc định áp dụng, "no one may reproduce, distribute, or create derivative works" (https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository); bài public vẫn cho người khác xem/fork theo GitHub ToS, nhưng không kèm quyền dùng (https://opensource.guide/legal/).
  - "Substantial similarity" là tiêu chí do tòa án xét trên phần biểu đạt được bảo hộ; phần trùng còn lại quyết định, không phải nhãn "refactor". Đây là đánh giá từng ca; không thể tự kết luận.

### 2. Clean-room: quy trình đã được ghi nhận

- **Đã xác minh** — EFF FAQ liệt kê thực hành chuẩn: chỉ tạo bản sao trung gian cần thiết; "Have the reverse engineering team that studies the code develop a **written manual** that describes the necessary interfaces in **purely functional terms**, then engage **separate developers** to build original code based on the manual and **without access to the copyrighted software**"; mua bản gốc hợp pháp; coi chừng điều khoản cấm reverse engineering.
- **Đã xác minh (nguồn thứ cấp)** — Phoenix BIOS: nhóm "contaminated" (đã đọc mã IBM) viết đặc tả API; nhóm "clean" (chưa từng thấy mã IBM) viết code từ đầu (https://www.historyofinformation.com/detail.php?id=3391 — trang tổng hợp, dẫn Wikipedia).
- **Đã xác minh** — Google v. Oracle (SCOTUS 2021, toàn văn: https://www.law.cornell.edu/supremecourt/text/18-956; PDF gốc: https://www.supremecourt.gov/opinions/20pdf/18-956_d18f.pdf): tòa **giả định** API có thể được bảo hộ nhưng chốt Google thắng fair use cho ~11.500 dòng declaring code **cần cho interoperability**; implementing code do Google **tự viết**. Đây là phán quyết theo tình huống API cụ thể, **không** phải giấy phép chung để sao chép code.
- **Đã xác minh** — Sega v. Accolade và Sony v. Connectix (theo bản tóm tắt EFF FAQ): copy trung gian để nghiên cứu interface có thể là fair use, nhưng sản phẩm cuối phải độc lập, không chứa mã gốc; Blizzard v. BnetD: hợp đồng (EULA/ToS có điều khoản cấm) có thể đánh bại fair use.
- **Suy luận — thực tế cho dev đơn độc:**
  - Wall hai nhóm khó với một mình: nếu bạn đã đọc code gốc, bạn khó tự tay chứng minh "clean". Thực hành giảm thiểu: viết đặc tả từ **hành vi quan sát được** (input/output, CLI, HTTP, trạng thái lỗi) trước; sau đó viết code mới, hạn chế đọc lại nguồn cũ; ghi provenance (ai đọc gì, ngày nào, quyết định nào).
  - Không sao chép phần phi chức năng (comment, tên biến đặc thù, cấu trúc, test suite) trừ khi cần cho tương thích — giữ chúng là dấu hiệu "không độc lập".
  - Clean-room chỉ giảm rủi ro **bản quyền**; không tự giải quyết thương hiệu, hợp đồng, sáng chế. Với repo này còn ràng buộc từ điều khoản reverse.dev (mục 4).

### 3. Ba lựa chọn cho repo ChessOnGlass

Bối cảnh: repo là bản sao chesshacker v0.2.0, không có LICENSE, `package.json` không có trường `license` (RESEARCH.md §10, §13).

#### (a) Xin phép tác giả

- **Đã xác minh** kênh công khai duy nhất tìm thấy: GitHub profile https://github.com/picklerpeej (tồn tại; ghi NYC; **không có repo công khai** tại ngày khảo sát). `https://www.reverse.dev/p/picklerpeej` trả **404**; trang dự án https://www.reverse.dev/pjchess không có form liên hệ; `support@reverse.dev` là kênh của Reverse (Bubble Group, Inc.) theo Terms §1(g), **không phải** kênh của tác giả.
- **Đã xác minh** — MIT vs Apache-2.0:
  - MIT: ngắn; chỉ yêu cầu giữ copyright + license notice; không có điều khoản patent riêng (https://choosealicense.com/licenses/mit/).
  - Apache-2.0: thêm patent grant; phải đánh dấu "state changes" khi sửa file; kèm NOTICE; không cấp quyền thương hiệu (https://choosealicense.com/licenses/apache-2.0/).
  - Cả hai GPLv3-compatible; Apache-2.0 **không** tương thích GPLv2; FSF khuyên Apache-2.0 hơn các giấy phép lax khác cho chương trình lớn (https://www.gnu.org/licenses/license-list.html); FSF nói chung vẫn ưu tiên copyleft cho hầu hết chương trình (https://www.gnu.org/licenses/license-recommendations.html).
- **Suy luận** — ưu: cơ sở pháp lý rõ, giữ được credit, mở đường publish công khai. Nhược: có thể không được trả lời hoặc bị từ chối; phải chốt license **trước** khi publish. Nếu xin: nêu rõ mục đích, repo/phiên bản, license mong muốn (MIT hoặc Apache-2.0), cách ghi công.

#### (b) Giữ riêng tư

- **Đã xác minh**: quyền tạo bản phái sinh thuộc chủ sở hữu (Circular 14) — để private không tạo ra license.
- **Suy luận**: giảm rủi ro bị phát hiện/takedown, tránh chính sách nền tảng; nhưng không đạt mục tiêu "publish international source project". Nếu chọn, nên coi đây là trạng thái trung gian để chuẩn bị clean-room (mục 2).

#### (c) Cứ phát hành

- **Đã xác minh** — GitHub DMCA (https://docs.github.com/en/site-policy/content-removal-policies/dmca-takedown-policy): chủ quyền gửi notice → GitHub có thể cho ~1 ngày làm việc để sửa/xóa, nếu không sẽ vô hiệu hóa repo; có counter-notice; chủ quyền có 10–14 ngày để khởi kiện trước khi nội dung được bật lại; tài khoản tái phạm bị khóa; notice/counter được công khai tại https://github.com/github/dmca; policy dẫn bối cảnh "statutory damages ... up to $150,000" cho một claim.
- **Đã xác minh** — reverse.dev Terms: §15 (takedown, khóa tài khoản tái phạm) và §4(g)(i) (cấm "connect any repository ... that you do not have the right to connect, access, or modify") — https://www.reverse.dev/terms.
- **Suy luận**: rủi ro nghiêng về phía người phát hành (mất repo, hậu quả tài khoản, danh tiếng; dự án đang hiển thị công khai trên reverse.dev với 40 clones). "Chưa bị kiện" không đồng nghĩa an toàn.

### 4. reverse.dev và "Clone this project"

- **Đã xác minh** — trang https://www.reverse.dev/pjchess có mục "Clone this project — Make this project your own and edit it easily with Reverse"; nút Clone trỏ tới `/signup?from=chess`, tức cần tài khoản.
- **Đã xác minh** — Terms (https://www.reverse.dev/terms; "Last revised September 16, 2026", hiệu lực 2026-09-21):
  - §3(a): license được cấp là "to access and use the Service" (giới hạn, thu hồi được); §3(b) cấm tạo derivative works **của Service** — không nói đến code của người dùng.
  - §6(f): người dùng "represent and warrant" có đủ quyền với Connected Repository; §4(g)(i) cấm kết nối repo không có quyền.
  - §8(b): giữa hai bên, **người dùng** giữ quyền với User Content của mình — không có điều khoản chuyển quyền giữa các nhà phát triển hay cấp quyền cho người clone.
- **Suy luận**: không có bằng chứng công khai nào cho thấy "Clone" cấp quyền sở hữu trí tuệ với code được clone; văn bản chỉ mô tả **quyền truy cập/dùng Service** và đặt trách nhiệm "bạn phải có quyền" lên người dùng. Muốn có quyền dùng code, phải xin từ tác giả (mục 3a). Luồng clone chi tiết sau đăng nhập chưa kiểm tra được (ràng buộc không đăng ký).

### 5. Checklist phát hành OSS quốc tế (ngắn)

Điều kiện tiên quyết: giải quyết quyền (mục 1–3). Checklist không thay thế tư vấn luật.

- **Chọn LICENSE** cho phần code bạn sở hữu: MIT hoặc Apache-2.0 (mục 3a); thêm trường `license` SPDX trong `package.json`. Nếu đóng gói chung với thành phần GPL (Stockfish GPLv3; ffmpeg-static 5.3.0 ghi GPL-3.0-or-later — RESEARCH.md §10 [R8]–[R10]), phải rà soát nghĩa vụ tương ứng trước khi chốt giấy phép và cách phân phối; RESEARCH.md §10 nêu chi tiết, không kết luận lại ở đây.
- **NOTICE/attribution**: giữ copyright/license của dependency; Stockfish cần license + đường tới source đúng bản phân phối; nếu dùng Apache-2.0, kèm NOTICE. README ghi công: "based on chesshacker by picklerpeej" (chuẩn mực; nhưng không thay thế quyền khi bản gốc không có LICENSE).
- **Hygiene trước publish**: CI cho build/test (repo hiện chưa thấy — RESEARCH.md §12); `SECURITY.md` (hướng dẫn báo lỗ hổng — https://docs.github.com/en/code-security/getting-started/adding-a-security-policy-to-your-repository); `CONTRIBUTING.md`; cân nhắc DCO thay CLA (https://opensource.guide/legal/); SBOM/khóa phiên bản dependency; kiểm secrets, file rác, và cân nhắc tách lịch sử git chứa code chưa được cấp phép.
- **Quốc tế**: Công ước Berne — bảo hộ tự động, đối xử quốc gia, độc lập khỏi nơi công bố; quyền chuyển thể và quyền nhân thân (ghi tác giả) được nêu trong hiệp ước (https://www.wipo.int/en/web/treaties/ip/berne/summary_berne). Việt Nam là thành viên (Chỉ mục, theo thông báo WIPO). Giữ attribution/notice không chỉ là lịch sự mà là điều kiện thực tế của nhiều license.

### Nguồn chính

- Circular 14: https://www.copyright.gov/circs/circ14.pdf · §102: https://www.copyright.gov/title17/92chap1.html#102
- Google v. Oracle: https://www.law.cornell.edu/supremecourt/text/18-956 · https://www.supremecourt.gov/opinions/20pdf/18-956_d18f.pdf
- EFF RE FAQ: https://www.eff.org/issues/coders/reverse-engineering-faq · Phoenix: https://www.historyofinformation.com/detail.php?id=3391
- GitHub: DMCA https://docs.github.com/en/site-policy/content-removal-policies/dmca-takedown-policy · license mặc định https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository
- reverse.dev: https://www.reverse.dev/terms · https://www.reverse.dev/pjchess · profile 404 đã kiểm chứng
- License: choosealicense https://choosealicense.com/licenses/mit/ https://choosealicense.com/licenses/apache-2.0/ · FSF https://www.gnu.org/licenses/license-list.html · https://www.gnu.org/licenses/license-recommendations.html
- OSS guide: https://opensource.guide/legal/ · Berne: https://www.wipo.int/en/web/treaties/ip/berne/summary_berne

### Bằng chứng còn thiếu

- Không rõ repo này được tạo bằng cách nào (tải về, clone qua reverse.dev hay cách khác) và ToS nào đã được chấp nhận khi lấy.
- Không có LICENSE của bản gốc; chưa kiểm tra tác giả có công bố license ở nơi khác không (GitHub không có repo công khai).
- Không xác minh ai là chủ sở hữu đầy đủ của cả 23 file gốc (đóng góp bên thứ ba/AI không kiểm chứng).
- Chưa xem được luồng clone sau đăng nhập (ràng buộc không đăng ký).
- Chưa liên hệ tác giả và chưa có phản hồi.
- Án lệ Sega/Connectix/Atari/Blizzard chỉ đọc qua tóm tắt EFF; Phoenix chỉ qua nguồn thứ cấp.
- Chưa có ý kiến luật sư cho trường hợp cụ thể (kể cả luật áp dụng: tác giả ở NYC, người dùng ở Việt Nam, nền tảng ở Hoa Kỳ).

### Cần người dùng quyết

1. Chiến lược tổng thể: (a) xin phép, (b) giữ private tạm, (c) clean-room rồi phát hành, hay (d) phát hành và chịu rủi ro.
2. Nếu xin phép: có liên hệ tác giả không; qua GitHub hay kênh khác; đề nghị MIT hay Apache-2.0; chờ bao lâu trước khi chuyển hướng nếu không phản hồi.
3. Có chấp nhận dùng nội bộ phần chưa có license không, hay chỉ tiếp tục khi có license hoặc clean-room hoàn chỉnh.
4. Có đầu tư clean-room thật (đặc tả hành vi trước, người thứ hai, hồ sơ provenance) hay chỉ refactor nội bộ.
5. Nơi phát hành (GitHub public, npm, cả hai), tên dự án (tách "ChessOnGlass" khỏi "chesshacker" thế nào) và thời điểm.
6. Có tách lịch sử git/xóa code gốc khỏi bản phát hành hay không (liên quan trực tiếp đến mục 1–2).
7. Ngân sách và thời điểm thuê luật sư trước khi phát hành thương mại.

> **Cập nhật 2026-11-07 (phiên làm việc):** người dùng cho biết hướng đã chọn là **refactor/viết lại toàn bộ — coi như viết lại code mới** (chưa phải clean-room đúng chuẩn vì đã đọc code gốc; chưa chốt có liên hệ tác giả hay không). Mảng research "international availability + release/CI" (A) tạm bỏ, để dành cho giai đoạn phân phối.
